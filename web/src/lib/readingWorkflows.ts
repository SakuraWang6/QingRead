import type { Book, Chapter, ReadingPosition, SourceSwitchPlan } from '../shared/types';

/** Conservative matching: punctuation/spacing and fullwidth forms do not change a title. */
export function normalizedTitle(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}
export function isChapterBook(book: Book): boolean {
  return !book.publicationFormat && !book.fileDownloadURL && book.sourceID !== 'local' && !book.sourceID.startsWith('local-');
}
export function sameEditionTitle(original: Book, candidate: Book): boolean {
  return isChapterBook(candidate) && normalizedTitle(original.title) === normalizedTitle(candidate.title)
    && (!original.author.trim() || !candidate.author.trim() || normalizedTitle(original.author) === normalizedTitle(candidate.author));
}
const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function chineseNumber(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  if (![...value].every(c => c in digits || '十百千万'.includes(c))) return undefined;
  if (![...value].some(c => '十百千万'.includes(c))) return Number([...value].map(c => digits[c]).join(''));
  let total = 0, section = 0, digit = 0;
  for (const char of value) {
    if (char in digits) { digit = digits[char]; continue; }
    const unit = ({ 十: 10, 百: 100, 千: 1000, 万: 10000 } as Record<string, number>)[char];
    if (unit === 10000) { total += (section + digit) * unit; section = 0; digit = 0; }
    else { section += (digit || 1) * unit; digit = 0; }
  }
  return total + section + digit;
}
export function chapterNumber(title: string): number | undefined {
  const match = title.normalize('NFKC').match(/^\s*(?:第\s*)?([0-9零〇一二两三四五六七八九十百千万]+)\s*(?:章|节|回)/u);
  return match ? chineseNumber(match[1]) : undefined;
}
function chapterTitle(title: string): string {
  return normalizedTitle(title.normalize('NFKC').replace(/^\s*(?:第\s*)?[0-9零〇一二两三四五六七八九十百千万]+\s*(?:章|节|回)\s*[\p{P}\s]*/u, ''));
}
export function matchChapter(current: Chapter | undefined, candidates: Chapter[]): Pick<SourceSwitchPlan, 'matchedChapterID' | 'match'> {
  if (!current) return { match: 'manual' };
  const title = normalizedTitle(current.title), exact = candidates.filter(chapter => normalizedTitle(chapter.title) === title);
  if (title && exact.length === 1) return { matchedChapterID: exact[0].id, match: 'title' };
  const body = chapterTitle(current.title), bodyMatches = body ? candidates.filter(chapter => chapterTitle(chapter.title) === body) : [];
  if (bodyMatches.length === 1) return { matchedChapterID: bodyMatches[0].id, match: 'title' };
  const number = chapterNumber(current.title), numbered = number === undefined ? [] : candidates.filter(chapter => chapterNumber(chapter.title) === number);
  return numbered.length === 1 ? { matchedChapterID: numbered[0].id, match: 'number' } : { match: 'manual' };
}
export function appendedChapters(baseline: { lastKnownChapterID?: string; lastKnownChapterTitle?: string }, next: Chapter[]): Chapter[] {
  if (!baseline.lastKnownChapterID && !baseline.lastKnownChapterTitle) return [];
  const ids = next.map((chapter, index) => chapter.id === baseline.lastKnownChapterID ? index : -1).filter(index => index >= 0);
  if (ids.length === 1) return next.slice(ids[0] + 1);
  const title = normalizedTitle(baseline.lastKnownChapterTitle || ''), titles = next.map((chapter, index) => title && normalizedTitle(chapter.title) === title ? index : -1).filter(index => index >= 0);
  return titles.length === 1 ? next.slice(titles[0] + 1) : [];
}
export function remappedPosition(chapter: Chapter, position: ReadingPosition | undefined, textLength: number): ReadingPosition {
  const fraction = Math.min(1, Math.max(0, position?.chapterFraction || 0));
  return { chapterID: chapter.id, chapterIndex: chapter.index, chapterFraction: fraction,
    characterOffset: Math.floor(fraction * Math.max(0, textLength - 1)), updatedAt: new Date().toISOString() };
}
