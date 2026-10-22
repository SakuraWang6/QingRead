export type BookFormat = 'epub' | 'pdf' | 'txt';
export interface Book {
  id: string; title: string; author: string; summary: string; coverURL?: string | null;
  sourceID: string; sourceName: string; url: string; publicationFormat?: BookFormat | null;
  fileDownloadURL?: string | null;
  fileHash?: string;
}
export interface Chapter { id: string; title: string; url: string; index: number }
export interface ChapterContent { chapter: Chapter; paragraphs: string[] }
export interface SourceDefinition {
  id: string; name: string; summary: string; homeURL: string;
  kind: 'html' | 'mediaWiki' | 'staticCatalog' | 'gutenberg' | 'standardEbooks' | 'openStax';
  apiURL?: string; html?: HTMLSourceConfiguration; catalogBooks?: {title:string; author:string; summary:string; directoryURL:string}[];
}
export interface HTMLSourceConfiguration {
  searchURL: string; encoding?: 'utf8'|'gbk'|'gb18030'; resultSelector: string; titleSelector: string;
  linkSelector: string; authorSelector?: string; summarySelector?: string; coverSelector?: string;
  catalogLinkSelector?: string; chapterSelector: string; contentSelector: string; removeSelectors?: string[];
}
export interface SourceFailure { sourceID: string; sourceName: string; message: string }
export interface SearchResponse { books: Book[]; failures: SourceFailure[] }
export interface DiscoverySection { id: string; title: string; books: Book[] }
export interface Category { id: string; title: string }
export interface ReadingPosition {
  chapterID: string; chapterIndex: number; characterOffset: number; chapterFraction: number; updatedAt: string;
}
export interface ShelfOrganization { pinned: boolean; status: 'reading'|'later'|'finished'; group: string; updatedAt: string }
export interface ReadingAnnotation {
  id: string; kind: 'bookmark'|'note'; chapterID: string; chapterIndex: number; chapterTitle: string;
  characterOffset: number; characterLength: number; quote: string; note: string;
  sourceID: string; sourceURL: string; updatedAt: string; deletedAt?: string;
}
export interface ShelfEntry { book: Book; position?: ReadingPosition; addedAt: string; organization?: ShelfOrganization; annotations?: ReadingAnnotation[] }
export type ReadingTheme = 'paper'|'dusk'|'mint'|'gray'|'rose'|'night';
export interface ReaderSettings {
  fontSize: number; lineSpacing: number; paragraphSpacing: number; theme: ReadingTheme; isNightMode: boolean;
  turnMode: 'slide'|'cover'|'scroll'; font: 'song'|'system'|'rounded'; isBold: boolean;
  horizontalMargin: number; speechRate: number; speechVoiceIdentifier: string;
  speechEngine: 'system' | 'kokoro'; kokoroVoiceID: number;
}
export const defaultSettings: ReaderSettings = {
  fontSize:21, lineSpacing:9, paragraphSpacing:6, theme:'paper', isNightMode:false,
  turnMode:'slide', font:'song', isBold:false, horizontalMargin:24,
  speechRate:1, speechVoiceIdentifier:'', speechEngine:'system', kokoroVoiceID:46,
};
export interface LibraryState { ready: boolean; shelf: ShelfEntry[]; settings: ReaderSettings; sources: SourceDefinition[]; disabledSourceIDs: string[]; updates: Record<string, BookUpdateState>; checkingUpdates: boolean; downloads: ChapterDownloadJob[]; storageError?: string }
export interface LocalPublication { book: Book; chapters: Chapter[]; contents: ChapterContent[]; file?: Blob; cover?: Blob }

/** Account-local metadata. It is intentionally absent from the cloud sync schema. */
export interface BookUpdateState {
  knownChapterCount: number; lastKnownChapterID?: string; lastKnownChapterTitle?: string;
  unreadChapterIDs: string[]; checkedAt?: string; checking?: boolean; error?: string;
}
export interface UpdateCheckResult { checked: number; updated: number; failures: string[] }
export type ChapterDownloadStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export interface ChapterDownloadJob {
  engine?: 'native'|'server';
  storedOnDevice?: boolean;
  id: string; bookID: string; bookTitle: string; sourceID: string; sourceURL: string;
  status: ChapterDownloadStatus; chapterIDs: string[]; total: number; completed: number;
  completedChapterIDs: string[]; failedChapterIDs: string[]; error?: string;
  createdAt: string; updatedAt: string;
}
export type ChapterDownloadSelection = { kind: 'next'; count: 50 | 100 } | { kind: 'all' } | { kind: 'range'; from: number; to: number };
export interface SourceSwitchPlan {
  bookID: string; originalSourceID: string; originalURL: string; candidate: Book; chapters: Chapter[];
  position?: ReadingPosition; matchedChapterID?: string; match: 'title' | 'number' | 'manual';
}
