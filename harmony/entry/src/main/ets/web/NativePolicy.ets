import { WatchedBook } from './UpdatePolicy';

export interface NativeParams {
  enabled?: boolean;
  books?: WatchedBook[];
  profile?: string | null;
  apiBase?: string;
  authToken?: string;
  accessToken?: string;
  id?: string;
  bookID?: string;
  sourceID?: string;
  sourceURL?: string;
  revision?: string;
  bytes?: number;
  offset?: number;
  limit?: number;
  slot?: string;
  value?: string;
  name?: string;
  size?: number;
  exportID?: string;
  content?: string;
  utteranceID?: string;
  text?: string;
  rate?: number;
  voiceIdentifier?: string;
}

export interface NativeRequest {
  id: string;
  method: string;
  params: NativeParams;
}

// No arbitrary download URLs, paths, storage keys, commands or native object names cross this boundary.
export class NativePolicy {
  static readonly MAX_MESSAGE: number = 140000;
  static readonly MAX_EXPORT: number = 16 * 1024 * 1024;
  static readonly MAX_CHUNK: number = 32768;

  static parse(raw: string): NativeRequest {
    if (typeof raw !== 'string' || raw.length > NativePolicy.MAX_MESSAGE) {
      throw new Error('请求过大');
    }
    const value: NativeRequest = JSON.parse(raw) as NativeRequest;
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key: string): boolean => !['id', 'method', 'params'].includes(key)) ||
      typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.id) ||
      typeof value.method !== 'string' || value.params === null || typeof value.params !== 'object' ||
      Array.isArray(value.params)) {
      throw new Error('请求格式不正确');
    }
    let keys: string[];
    switch (value.method) {
      case 'battery.get': case 'speech.voices': case 'speech.stop': keys = []; break;
      case 'credentials.load': case 'credentials.clear': keys = ['slot']; break;
      case 'credentials.save': keys = ['slot', 'value']; break;
      case 'export.begin': keys = ['name', 'size']; break;
      case 'export.append': keys = ['exportID', 'content']; break;
      case 'export.commit': case 'export.cancel': keys = ['exportID']; break;
      case 'speech.rate': keys = ['rate']; break;
      case 'speech.speak': keys = ['utteranceID', 'text', 'rate', 'voiceIdentifier']; break;
      case 'background.configure': keys = ['profile', 'apiBase', 'authToken', 'accessToken']; break;
      case 'downloads.enqueue': keys = ['profile', 'id', 'bookID', 'sourceID', 'sourceURL', 'revision', 'bytes']; break;
      case 'downloads.list': case 'downloads.clearCache': keys = ['profile']; break;
      case 'downloads.pause': case 'downloads.resume': case 'downloads.cancel': keys = ['profile', 'id']; break;
      case 'downloads.removeBook': keys = ['profile', 'bookID']; break;
      case 'downloads.read': keys = ['profile', 'id', 'revision', 'offset', 'limit']; break;
      case 'downloads.acknowledge': keys = ['profile', 'id', 'revision']; break;
      case 'updates.watch': keys = ['profile', 'enabled', 'books']; break;
      case 'updates.snapshot': keys = ['profile']; break;
      case 'updates.requestPermission': keys = []; break;
      default: throw new Error('不支持的功能');
    }
    if (Object.keys(value.params).some((key: string): boolean => !keys.includes(key))) {
      throw new Error('请求包含不支持的参数');
    }
    return value;
  }

  static slot(value: string | undefined): string {
    if (value !== 'cloud' && value !== 'connection') throw new Error('不支持的凭据类型');
    return value;
  }

  static rate(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.5 || value > 2) {
      throw new Error('语速应为 0.5–2 倍');
    }
    return value;
  }

  static exportName(value: string | undefined): string {
    if (typeof value !== 'string' || value.length < 6 || value.length > 100 ||
      /[\\/\u0000-\u001f\u007f]/.test(value) || !/^清读备份[\p{L}\p{N} _.-]*\.json$/u.test(value)) {
      throw new Error('备份文件名不正确');
    }
    return value;
  }
}
