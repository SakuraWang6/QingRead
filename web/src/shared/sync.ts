import type { ReadingPosition, ShelfEntry } from './types';

export const anchorFormat = 'body-utf16-v1' as const;
export interface CloudUser { id: string; username: string }
export interface CloudSession { user: CloudUser; token: string; expiresAt: string; serverTime: string }
export interface CloudRecord { bookID: string; entry: ShelfEntry | null; revision: number; changedAt: string }
export interface CloudMutation {
  id: string;
  action: 'add' | 'progress' | 'remove';
  bookID: string;
  baseRevision: number;
  changedAt: string;
  entry?: ShelfEntry;
}
export interface CloudSnapshot {
  anchorFormat: typeof anchorFormat;
  cursor: number;
  records: CloudRecord[];
  acknowledged: string[];
  rejected: { id: string; reason: string }[];
  hasMore: boolean;
  serverTime: string;
}
export function newestPosition(a?: ReadingPosition, b?: ReadingPosition): ReadingPosition | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b.updatedAt) >= Date.parse(a.updatedAt) ? b : a;
}
