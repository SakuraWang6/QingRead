import { createApp } from './app.js';
import { CloudDatabase } from './cloud.js';
import { join } from 'node:path';
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !process.env.QINGREAD_ACCESS_TOKEN && process.env.QINGREAD_PUBLIC_ACCESS !== 'true') {
  throw new Error('对外监听请配置 QINGREAD_ACCESS_TOKEN；明确开放访问时设置 QINGREAD_PUBLIC_ACCESS=true。');
}
process.umask(0o077);
const cloud = new CloudDatabase(join(process.env.QINGREAD_DATA_DIR ?? '.data', 'accounts.sqlite'), Number(process.env.QINGREAD_MAX_USERS) || 100);
const app = await createApp({ cloud });
const address = await app.listen({ host, port });
console.log(`清读书源服务：${address}`);
const stop = async () => { await app.close(); process.exit(0); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
