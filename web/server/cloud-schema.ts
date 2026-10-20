import type { Book, ReadingPosition, ShelfEntry } from '../src/shared/types.js';
import type { CloudMutation } from '../src/shared/sync.js';
import { ServiceError } from './network.js';

const fail = (): never => { throw new ServiceError('同步数据格式无效，请更新客户端后重试。', 400); };
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail(); }
function string(value: unknown, max: number, empty = false): string { return typeof value === 'string' && value.length <= max && (empty || value.length > 0) && !value.includes('\0') ? value : fail(); }
function id(value: unknown): string { const s = string(value, 8192); return ['__proto__', 'constructor', 'prototype'].includes(s) ? fail() : s; }
function integer(value: unknown): number { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fail(); }
function date(value: unknown): string {
  const parsed = Date.parse(string(value, 64));
  if (!Number.isFinite(parsed)) return fail();
  // A bad device clock must not permanently pin a future progress record.
  return new Date(Math.min(parsed, Date.now())).toISOString();
}
function url(value: unknown, cover = false): string {
  const s = string(value, 4000);
  try { const u = new URL(s); if (u.username || u.password || !(cover ? ['https:'] : ['https:', 'http:', 'qingread-local:', 'qingread-import:']).includes(u.protocol)) return fail(); return s; } catch { return fail(); }
}
function position(value: unknown): ReadingPosition {
  const p = object(value);
  const fraction = Number(p.chapterFraction);
  if (typeof p.chapterFraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) return fail();
  return { chapterID: id(p.chapterID), chapterIndex: integer(p.chapterIndex), characterOffset: integer(p.characterOffset), chapterFraction: fraction, updatedAt: date(p.updatedAt) };
}
export function parseEntry(value: unknown): ShelfEntry {
  const e = object(value), b = object(e.book);
  const format = b.publicationFormat;
  if (format != null && !['epub', 'pdf', 'txt'].includes(String(format))) return fail();
  const book: Book = {
    id: id(b.id), title: string(b.title, 400), author: string(b.author, 400, true), summary: string(b.summary, 4000, true),
    sourceID: string(b.sourceID, 100), sourceName: string(b.sourceName, 200, true), url: url(b.url),
    ...(format ? { publicationFormat: format as Book['publicationFormat'] } : {}),
    ...(b.coverURL && typeof b.coverURL === 'string' && b.coverURL.startsWith('https:') ? { coverURL: url(b.coverURL, true) } : {}),
    ...(b.fileDownloadURL ? { fileDownloadURL: url(b.fileDownloadURL, true) } : {}),
    ...(typeof b.fileHash==='string'&&/^[a-f0-9]{64}$/.test(b.fileHash)?{fileHash:b.fileHash}:{}),
  };
  return { book, addedAt: date(e.addedAt), ...(e.position ? { position: position(e.position) } : {}) };
}
export function parseMutations(value: unknown): CloudMutation[] {
  if (!Array.isArray(value) || value.length > 50) return fail();
  return value.map(raw => {
    const m = object(raw);
    if (Object.keys(m).some(key => !['id', 'action', 'bookID', 'baseRevision', 'changedAt', 'entry'].includes(key))) return fail();
    const operationID = string(m.id, 128);
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(operationID) || !['add', 'progress', 'remove'].includes(String(m.action))) return fail();
    const entry = m.action === 'remove' ? undefined : parseEntry(m.entry);
    const bookID = id(m.bookID);
    if (entry && entry.book.id !== bookID) return fail();
    return { id: operationID, action: m.action as CloudMutation['action'], bookID, baseRevision: integer(m.baseRevision), changedAt: date(m.changedAt), ...(entry ? { entry } : {}) };
  });
}
