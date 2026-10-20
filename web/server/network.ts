import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import type { SourceDefinition } from '../src/shared/types.js';

export class ServiceError extends Error {
  constructor(message: string, public statusCode = 502) { super(message); }
}
export const MAX_DOWNLOAD = 250 * 1024 * 1024;
const MAX_PAGE = 8 * 1024 * 1024;
export const hostRules: Record<string, string[]> = {
  biequgei: ['www.biequgei.com', 'biequgei.com'],
  woshuge: ['www.woshuge.com', 'woshuge.com'],
  canghaishuge: ['www.canghaishuge.com', 'canghaishuge.com'],
  'biquge-tw': ['www.biquge.tw', 'biquge.tw'],
  piaotia: ['www.piaotia.com', 'piaotia.com'],
  gutenberg: ['www.gutenberg.org', 'gutenberg.org'],
  'standard-ebooks': ['standardebooks.org'],
  openstax: ['openstax.org', 'assets.openstax.org'],
  'chinese-classics': ['raw.githubusercontent.com'],
  'zh-wikisource': ['zh.wikisource.org', 'upload.wikimedia.org'],
};

/** Reject special-purpose, mapped IPv4, multicast and link-local addresses. */
export function isPublicIP(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 192 && b === 2) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    // Public global unicast only. Reject mapped IPv4 and documentation prefixes.
    return /^[23]/.test(value) && !value.startsWith('2001:db8:') && !value.startsWith('2001:0:');
  }
  return false;
}

export function validateSourceURL(value: string | URL, sourceID: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ServiceError('来源网址无效。', 400); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !hostRules[sourceID]?.includes(url.hostname.toLowerCase())) throw new ServiceError('网址不属于这个已启用书源，或不是 HTTPS。', 400);
  let pathname: string; try { pathname = decodeURIComponent(url.pathname); } catch { throw new ServiceError('来源网址编码无效。', 400); }
  if (sourceID === 'chinese-classics' && !pathname.startsWith('/luoxuhai/chinese-novel/master/resources/')) {
    throw new ServiceError('静态书源仅允许已登记的图书目录。', 400);
  }
  url.hash = '';
  return url;
}

const dnsCache = new Map<string, { address: string; family: number; expires: number }>();
async function publicAddresses(hostname: string): Promise<{ address: string; family: number }[]> {
  const known = dnsCache.get(hostname); if (known && known.expires > Date.now()) return [known];
  const resolved = await dns.lookup(hostname, { all: true });
  // Desktop VPNs commonly synthesize 198.18/15 addresses. Do not whitelist those
  // addresses: obtain a real A record over authenticated, fixed-IP DoH instead.
  if (resolved.length && resolved.every(item => /^198\.(18|19)\./.test(item.address))) {
    const answer = await new Promise<any>((resolve, reject) => {
      const request = https.get({ hostname: '1.1.1.1', servername: 'cloudflare-dns.com', path: '/dns-query?name=' + encodeURIComponent(hostname) + '&type=A', headers: { Accept: 'application/dns-json' } }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 32_768) response.destroy(new ServiceError('DNS 响应过大。')); else chunks.push(chunk); });
        response.on('error', reject); response.on('end', () => { try { if (response.statusCode !== 200) throw new Error('DNS'); resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new ServiceError('无法安全解析来源地址。')); } });
      });
      request.setTimeout(8_000, () => request.destroy(new ServiceError('安全 DNS 查询超时。', 504))); request.on('error', reject);
    });
    const addresses = (answer.Answer ?? []).filter((a: any) => a.type === 1 && net.isIPv4(a.data)).map((a: any) => ({ address: a.data as string, family: 4 }));
    if (addresses.length && addresses.every((a: { address: string }) => isPublicIP(a.address))) {
      if (dnsCache.size > 80) dnsCache.clear(); dnsCache.set(hostname, { ...addresses[0], expires: Date.now() + 300_000 });
      return addresses;
    }
    throw new ServiceError('来源解析到了不允许访问的网络地址。', 400);
  }
  return resolved;
}

async function openURL(value: string | URL, sourceID: string, options: { signal?: AbortSignal; referer?: string; timeout?: number; totalTimeout?: number }, redirects = 0, deadlineAt = Date.now() + (options.totalTimeout ?? 25_000)): Promise<{ stream: Readable; url: URL; contentType: string; contentLength: number }> {
  const url = validateSourceURL(value, sourceID);
  if (redirects > 4) throw new ServiceError('来源重定向过多。');
  const addresses = await publicAddresses(url.hostname);
  if (!addresses.length || addresses.some(a => !isPublicIP(a.address))) throw new ServiceError('来源解析到了不允许访问的网络地址。', 400);
  const chosen = addresses.find(a => a.family === 4) ?? addresses[0];
  const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const request = https.request(url, {
      signal: options.signal,
      headers: {
        'User-Agent': 'QingRead/0.5 (+personal reading client)',
        Accept: '*/*', 'Accept-Encoding': 'gzip, deflate, br',
        ...(options.referer ? { Referer: validateSourceURL(options.referer, sourceID).href } : {}),
      },
      // Pin the validated resolution; TLS still validates the original hostname.
      lookup: ((_hostname: string, opts: { all?: boolean }, callback: (...args: any[]) => void) => opts.all ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family)) as any,
    }, resolve);
    request.setTimeout(options.timeout ?? 18_000, () => request.destroy(new ServiceError('来源连接超时，请稍后重试。', 504)));
    // Keep an absolute deadline across redirects, separate from socket idleness.
    const deadline = setTimeout(() => request.destroy(new ServiceError('来源响应超时，请稍后重试。', 504)), Math.max(1, deadlineAt - Date.now()));
    request.on('close', () => clearTimeout(deadline));
    request.on('error', reject); request.end();
  });
  const status = response.statusCode ?? 0;
  if (status >= 300 && status < 400 && response.headers.location) {
    response.resume();
    const target = new URL(response.headers.location, url);
    // Some legacy sources emit http Location headers while serving HTTPS.
    // Upgrade only same-host redirects; no plaintext request is ever sent.
    if (target.protocol === 'http:' && target.hostname === url.hostname) target.protocol = 'https:';
    return openURL(target, sourceID, options, redirects + 1, deadlineAt);
  }
  if (status < 200 || status >= 300) { response.resume(); throw new ServiceError(`来源暂时无法访问（HTTP ${status}）。`); }
  let stream: Readable = response;
  const encoding = response.headers['content-encoding'];
  if (encoding === 'gzip') stream = response.pipe(createGunzip());
  else if (encoding === 'br') stream = response.pipe(createBrotliDecompress());
  else if (encoding === 'deflate') stream = response.pipe(createInflate());
  // Destroying a pipe destination does not destroy its source. Closing a
  // canceled/oversized decoded stream must also release the upstream socket.
  if (stream !== response) stream.once('close', () => response.destroy());
  response.on('error', error => stream.destroy(error));
  return { stream, url, contentType: response.headers['content-type'] ?? '', contentLength: encoding ? 0 : Number(response.headers['content-length'] ?? 0) };
}

export function limitStream(stream: Readable, limit: number, signal?: AbortSignal): Readable {
  let received = 0;
  const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    received += chunk.length;
    callback(received > limit ? new ServiceError('来源文件超出允许大小。', 413) : null, chunk);
  }});
  stream.on('error', error => limiter.destroy(error));
  limiter.on('close', () => stream.destroy());
  if (signal) { const abort = () => { stream.destroy(); limiter.destroy(new ServiceError('请求已取消。', 499)); }; signal.addEventListener('abort', abort, { once: true }); limiter.on('close', () => signal.removeEventListener('abort', abort)); }
  return stream.pipe(limiter);
}

const configuredConcurrency = Number(process.env.QINGREAD_UPSTREAM_CONCURRENCY?.trim() || 4);
const upstreamConcurrency = Number.isFinite(configuredConcurrency) ? Math.max(1, Math.min(8, Math.trunc(configuredConcurrency))) : 4;
let activeRequests = 0;
const waiting: (() => void)[] = [];
async function acquireSlot(): Promise<() => void> {
  if (activeRequests < upstreamConcurrency) activeRequests += 1;
  else {
    if (waiting.length >= 32) throw new ServiceError('书源服务正忙，请稍后再试。', 503);
    await new Promise<void>((resolve, reject) => {
      const grant = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { const index = waiting.indexOf(grant); if (index >= 0) waiting.splice(index, 1); reject(new ServiceError('书源服务排队超时，请稍后再试。', 503)); }, 25_000);
      waiting.push(grant);
    });
  }
  let done = false;
  return () => { if (done) return; done = true; const next = waiting.shift(); if (next) next(); else activeRequests -= 1; };
}

export async function fetchStream(url: string | URL, sourceID: string, options: { signal?: AbortSignal; referer?: string; maxBytes?: number; timeout?: number; totalTimeout?: number } = {}) {
  const release = await acquireSlot();
  try {
    const result = await openURL(url, sourceID, options);
    const max = options.maxBytes ?? MAX_PAGE;
    if (result.contentLength > max) { result.stream.destroy(); throw new ServiceError('来源文件超出允许大小。', 413); }
    const stream = limitStream(result.stream, max, options.signal);
    stream.once('close', release); stream.once('end', release); stream.once('error', release);
    return { ...result, stream };
  } catch (error) { release(); throw error; }
}

export async function fetchBuffer(url: string | URL, source: SourceDefinition | string, options: { signal?: AbortSignal; referer?: string; maxBytes?: number } = {}) {
  const result = await fetchStream(url, typeof source === 'string' ? source : source.id, options);
  const chunks: Buffer[] = [];
  for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
  return { data: Buffer.concat(chunks), url: result.url, contentType: result.contentType };
}
