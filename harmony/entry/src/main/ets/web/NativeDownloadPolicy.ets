import { url } from '@kit.ArkTS';

export interface DownloadConfiguration {
  profile: string | null;
  apiBase?: string;
  authToken?: string;
  accessToken?: string;
}
export interface DownloadParameters {
  profile: string;
  id?: string;
  bookID?: string;
  sourceID?: string;
  sourceURL?: string;
  revision?: string;
  bytes?: number;
  offset?: number;
  limit?: number;
}
export interface DownloadTransfer {
  id: string;
  bookID: string;
  sourceID: string;
  sourceURL: string;
  revision: string;
  status: string;
  receivedBytes: number;
  totalBytes?: number;
  sha256?: string;
  error?: string;
}

export class NativeDownloadPolicy {
  static readonly MAX_BYTES: number = 128 * 1024 * 1024;
  static profile(value: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error('下载账号标识无效');
    }
    return value;
  }
  static base(value: string): string {
    if (typeof value !== 'string' || value.length > 1500 || value.trim() !== value) throw new Error('请填写 HTTPS 服务器地址');
    const address: url.URL = new url.URL(value);
    if (address.protocol !== 'https:' || address.username !== '' || address.password !== '' || address.search !== '' ||
      address.hash !== '' || /^(localhost\.?|127\..*|\[::1\])$/i.test(address.hostname) ||
      !/^\/(?:[a-zA-Z0-9_-]+\/)*api\/?$/.test(address.pathname)) throw new Error('后台下载需要有效的 HTTPS API 地址');
    return address.href.replace(/\/+$/, '');
  }
  static token(value: string): string {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(value)) throw new Error('请先登录云同步账号');
    return value;
  }
  static id(value: string | undefined): string {
    if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) {
      throw new Error('云端下载任务标识无效');
    }
    return value;
  }
  static identity(value: string | undefined): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error('下载书籍标识无效');
    }
    return value;
  }
  static revision(value: string | undefined): string {
    if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) {
      throw new Error('云端下载版本无效');
    }
    return value;
  }
  static source(value: string | undefined): string {
    if (typeof value !== 'string' || value.length > 4000) throw new Error('书源地址无效');
    const address: url.URL = new url.URL(value);
    if (!['https:', 'http:'].includes(address.protocol) || address.username || address.password) throw new Error('书源地址无效');
    return value;
  }
}
