import { createApp } from './app.js';
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !process.env.QINGREAD_ACCESS_TOKEN) {
  throw new Error('对外监听前请配置 QINGREAD_ACCESS_TOKEN，防止书源服务被公开滥用。');
}
const app = await createApp();
await app.listen({ host, port });
console.log(`清读书源服务：http://${host}:${port}`);
const stop = async () => { await app.close(); process.exit(0); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
