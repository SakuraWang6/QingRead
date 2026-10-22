import { registerPlugin } from '@capacitor/core';
import type { Book, BookUpdateState, Chapter, ChapterContent, ChapterDownloadJob } from '../shared/types';

export interface NativeDownloadRequest { id: string; book: Book; chapters: Chapter[]; completedChapterIDs?: string[] }
export interface NativeCachedChapter { id: string; book: Book; content: ChapterContent }
export interface NativeWatchedBook { book: Book; baseline?: BookUpdateState; readChapterID?: string }
export interface AndroidBackgroundBridge {
  setProfile(options: { profile: string | null; apiBase?: string; accessToken?: string; authToken?: string }): Promise<void>;
  enqueue(options: { profile: string; job: NativeDownloadRequest }): Promise<{ job: ChapterDownloadJob }>;
  list(options: { profile: string }): Promise<{ jobs: ChapterDownloadJob[] }>;
  pause(options: { profile: string; id: string }): Promise<void>;
  resume(options: { profile: string; id: string }): Promise<void>;
  cancel(options: { profile: string; id: string }): Promise<void>;
  removeBook(options: { profile: string; bookID: string }): Promise<void>;
  clearCache(options: { profile: string }): Promise<void>;
  readCompleted(options: { profile: string; limit?: number }): Promise<{ items: NativeCachedChapter[] }>;
  acknowledge(options: { profile: string; ids: string[] }): Promise<void>;
  replaceWatchedBooks(options: { profile: string; enabled: boolean; books: NativeWatchedBook[] }): Promise<void>;
  updates(options: { profile: string }): Promise<{ updates: Record<string, BookUpdateState> }>;
  checkNotificationPermission(): Promise<{ notifications: 'granted' | 'denied' | 'prompt' }>;
  /** Invoke only from an explicit user action. Never called automatically on startup. */
  requestNotificationPermission(): Promise<{ notifications: 'granted' | 'denied' | 'prompt' }>;
}
export const nativeBackground = registerPlugin<AndroidBackgroundBridge>('QingReadBackground');
