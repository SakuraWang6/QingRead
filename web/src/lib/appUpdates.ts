export type UpdatePlatform = 'ios' | 'web' | 'android' | 'harmony';
export interface ClientIdentity { platform: 'web' | 'android' | 'harmony'; version: string; build?: string }
export interface ReleaseArtifact { url: string; sha256: string; size: number }
export interface PlatformRelease { version: string; build?: number; notes: string[]; artifact?: ReleaseArtifact }
export interface ReleaseManifest { schemaVersion: 1; publishedAt: string; platforms: Record<Exclude<UpdatePlatform, 'harmony'>, PlatformRelease> & { harmony?: PlatformRelease } }
const invalid = () => new Error('版本信息格式无效，请稍后重试');
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function versionParts(version: string): number[] {
  if (!/^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){0,3}$/.test(version) || version.length > 40) throw invalid();
  const parts = version.split('.').map(Number);
  if (parts.some(value => !Number.isSafeInteger(value))) throw invalid();
  return parts;
}
function buildNumber(build: unknown): number {
  if (!(typeof build === 'number' || typeof build === 'string' && /^\d{1,15}$/.test(build))) throw invalid();
  const value = Number(build);
  if (!Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
}
/** Negative means an older release; a higher build can never override a lower version. */
export function compareRelease(current: Pick<ClientIdentity, 'version' | 'build'>, release: PlatformRelease): number {
  const installed = versionParts(current.version), available = versionParts(release.version);
  for (let index = 0; index < Math.max(installed.length, available.length); index++) {
    const difference = (available[index] ?? 0) - (installed[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return current.build === undefined ? 0 : Math.sign(buildNumber(release.build) - buildNumber(current.build));
}
export function resolveManifestURL(platform: ClientIdentity['platform'], baseURL: string, pageURL: string, apiAddress: string, manifestPath: string): string {
  if (platform === 'web') {
    const page = new URL(pageURL), url = new URL('releases.json', new URL(baseURL, page));
    if (url.origin !== page.origin || !['https:', 'http:'].includes(url.protocol)) throw invalid();
    return url.href;
  }
  const server = new URL(apiAddress);
  if (server.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(server.hostname) || server.hostname.endsWith('.localhost') || server.username || server.password || !manifestPath.startsWith('/') || manifestPath.startsWith('//')) throw new Error('检查更新需要有效的 HTTPS 服务器');
  const url = new URL(manifestPath, server.origin);
  if (url.origin !== server.origin || url.search || url.hash) throw invalid();
  return url.href;
}
function artifact(value: unknown, manifestURL: string): ReleaseArtifact {
  if (!record(value) || typeof value.url !== 'string' || typeof value.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.size) || Number(value.size) <= 0) throw invalid();
  const manifest = new URL(manifestURL), url = new URL(value.url, manifest);
  if (url.protocol !== 'https:' || url.origin !== manifest.origin || url.username || url.password || url.search || url.hash || !/^\/downloads\/[A-Za-z0-9][A-Za-z0-9._-]*\.apk$/.test(url.pathname)) throw new Error('安装包地址无效，请稍后重试');
  return { url: url.href, sha256: value.sha256.toLowerCase(), size: Number(value.size) };
}
export function parseReleaseManifest(value: unknown, manifestURL: string): ReleaseManifest {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.publishedAt !== 'string' || value.publishedAt.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value.publishedAt) || !Number.isFinite(Date.parse(value.publishedAt)) || !record(value.platforms)) throw invalid();
  const platforms = {} as ReleaseManifest['platforms'];
  for (const platform of ['ios', 'web', 'android', 'harmony'] as const) {
    const item = value.platforms[platform];
    if (platform === 'harmony' && item === undefined) continue;
    if (!record(item) || typeof item.version !== 'string' || !Array.isArray(item.notes) || item.notes.length > 30 || item.notes.some(note => typeof note !== 'string' || note.length > 1000)) throw invalid();
    versionParts(item.version);
    const release: PlatformRelease = { version: item.version, notes: item.notes as string[] };
    if (platform !== 'web') release.build = buildNumber(item.build);
    if (item.artifact !== undefined) { if (platform !== 'android') throw invalid(); release.artifact = artifact(item.artifact, manifestURL); }
    platforms[platform] = release;
  }
  return { schemaVersion: 1, publishedAt: value.publishedAt, platforms };
}
/** This deliberately sends no account credentials and never falls back to bundled metadata. */
export async function fetchReleaseManifest(url: string, options: { signal?: AbortSignal; timeoutMs?: number; fetcher?: typeof fetch } = {}): Promise<ReleaseManifest> {
  const controller = new AbortController();
  const abort = () => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? 10_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await (options.fetcher ?? fetch)(url, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal });
    if (!response.ok) throw new Error('暂时无法获取版本信息，请稍后重试');
    if (Number(response.headers.get('content-length')) > 65_536) throw invalid();
    if (!response.body) throw invalid();
    reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const part = await reader.read();
      if (controller.signal.aborted) throw new DOMException('已取消检查', 'AbortError');
      if (part.done) break;
      size += part.value.byteLength; if (size > 65_536) throw invalid(); chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalid(); }
    return parseReleaseManifest(value, url);
  } catch (error) {
    if (options.signal?.aborted) throw new DOMException('已取消检查', 'AbortError');
    if (timedOut) throw new Error('检查更新超时，请重试');
    if (error instanceof Error && /^(版本信息|安装包地址|暂时无法获取)/.test(error.message)) throw error;
    throw new Error('暂时无法获取版本信息，请检查网络后重试');
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort); await reader?.cancel().catch(() => {});
  }
}
