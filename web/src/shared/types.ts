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
export interface ShelfEntry { book: Book; position?: ReadingPosition; addedAt: string }
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
export interface LibraryState { ready: boolean; shelf: ShelfEntry[]; settings: ReaderSettings; sources: SourceDefinition[]; disabledSourceIDs: string[]; storageError?: string }
export interface LocalPublication { book: Book; chapters: Chapter[]; contents: ChapterContent[]; file?: Blob; cover?: Blob }
