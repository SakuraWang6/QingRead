const baseKey = 'qingread.apiBase';
const legacyTokenKey = 'qingread.accessToken';
const sessionKey = 'qingread.connection.session.v1';
const rememberedKey = 'qingread.connection.remembered.v1';
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Credential = { address: string; token: string };
export type ServerConnection = Credential & { base: string; remember: boolean };

/** Include the path: two services on one host must never share a credential. */
export function normalizeApiAddress(base: string, origin: string): string {
  const url = new URL(base.trim() || '/api', origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('请输入不含账号、密码、查询参数的 HTTP 或 HTTPS 服务地址');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/api') ? path : path + '/api';
  return url.href.replace(/\/+$/, '');
}

function credential(storage: StorageLike, key: string): Credential | undefined {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) || 'null');
    if (value && typeof value === 'object' && 'address' in value && 'token' in value && typeof value.address === 'string' && typeof value.token === 'string' && value.token.trim()) {
      return { address: value.address, token: value.token.trim() };
    }
  } catch { /* Ignore an incomplete record rather than sending an unbound token. */ }
  return undefined;
}

export class ConnectionStore {
  constructor(private local: StorageLike, private session: StorageLike, private origin: string, private defaultBase = '') {}

  apiAddress(): string { return normalizeApiAddress(this.local.getItem(baseKey)?.trim() || this.defaultBase, this.origin); }

  private migrateLegacy(): void {
    const token = this.session.getItem(legacyTokenKey)?.trim();
    if (!token) return;
    // The old app had only one token. Bind it once to the current service before
    // removing the old key, so later address changes cannot reuse it.
    if (!credential(this.session, sessionKey)) this.session.setItem(sessionKey, JSON.stringify({ address: this.apiAddress(), token }));
    this.session.removeItem(legacyTokenKey);
  }

  tokenFor(address: string): string {
    this.migrateLegacy();
    const normalized = normalizeApiAddress(address, this.origin);
    const active = credential(this.session, sessionKey);
    if (active?.address === normalized) return active.token;
    const remembered = credential(this.local, rememberedKey);
    if (remembered?.address === normalized) {
      // Once opened, this session can keep reading if the user unchecks remember.
      this.session.setItem(sessionKey, JSON.stringify(remembered));
      return remembered.token;
    }
    return '';
  }

  load(): ServerConnection {
    const address = this.apiAddress();
    const token = this.tokenFor(address);
    return { base: this.local.getItem(baseKey) || '', address, token, remember: credential(this.local, rememberedKey)?.address === address && !!token };
  }

  save(base: string, token: string, remember: boolean): void {
    const address = normalizeApiAddress(base.trim() || this.defaultBase, this.origin);
    const value = { address, token: token.trim() };
    // Always replace both records, including when changing service or clearing a
    // token, instead of retaining a stale remembered credential for another host.
    this.clearToken();
    base.trim() ? this.local.setItem(baseKey, base.trim().replace(/\/+$/, '')) : this.local.removeItem(baseKey);
    if (value.token) {
      this.session.setItem(sessionKey, JSON.stringify(value));
      if (remember) this.local.setItem(rememberedKey, JSON.stringify(value));
    }
  }

  forgetRemembered(): void { this.local.removeItem(rememberedKey); }
  clearToken(): void { this.session.removeItem(legacyTokenKey); this.session.removeItem(sessionKey); this.local.removeItem(rememberedKey); }
}

export function serverConnectionStore(): ConnectionStore {
  return new ConnectionStore(localStorage, sessionStorage, location.origin, import.meta.env.VITE_API_BASE || '');
}

export const authenticationRequiredEvent = 'qingread:server-auth-required';
export class ServerAuthenticationError extends Error {
  constructor() { super('服务器需要有效访问码，请前往「设置 → 服务器连接」填写或更新。'); this.name = 'ServerAuthenticationError'; }
}
