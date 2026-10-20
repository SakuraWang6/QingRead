import { createApp } from './app.js';
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !process.env.QINGREAD_ACCESS_TOKEN && process.env.QINGREAD_PUBLIC_ACCESS !== 'true') {
  throw new Error('对外监听请配置 QINGREAD_ACCESS_TOKEN；明确开放访问时设置 QINGREAD_PUBLIC_ACCESS=true。');
}
const app = await createApp();
const address = await app.listen({ host, port });
console.log(`清读书源服务：${address}`);
const stop = async () => { await app.close(); process.exit(0); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
