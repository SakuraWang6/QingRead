# 清读书源服务

Node 22.12+。在 `web/` 运行 `npm run dev:api`，默认仅监听 `127.0.0.1:8787`。Vite 将同源 `/api` 代理到此服务；生产 `npm run build && npm start` 同时提供 `dist/` 页面。

服务器配置（环境变量）：

- `HOST` / `PORT`：默认 `127.0.0.1` / `8787`。
- `QINGREAD_ACCESS_TOKEN`：设置后，客户端用 `X-QingRead-Token` 传递访问码；访问码绑定服务地址，不进入 URL、代码或 APK。
- `QINGREAD_PUBLIC_ACCESS`：只有值为 `true` 才明确允许没有访问码的对外监听。默认关闭；令牌非空时仍要求令牌，不会因这个开关跳过鉴权。当前共享实例启用此模式，访问码为空。
- `QINGREAD_ALLOWED_ORIGINS`：允许的网页 Origin，以逗号分隔，须完整包含协议和端口；例如 `https://read.example.com`。不要写 `*`。默认仅同源和 Capacitor 的 `https://localhost`、`capacitor://localhost`、`http://localhost`。
- `QINGREAD_UPSTREAM_CONCURRENCY`：全局同时访问书源的连接数，默认 4；整数夹限在 1–8，非数字使用默认值。2 GiB 服务器建议保持 4，修改后重启服务生效。

API：

| 方法 | 地址 | 请求 / 响应 |
|---|---|---|
| GET | `/api/health` | 版本、来源数、是否需要令牌 |
| GET | `/api/sources` | 10 个内置来源 |
| POST | `/api/search` | `{query, sourceIDs?}` → `{books, failures}` |
| POST | `/api/search/stream` | 同上，NDJSON 每行是累计 `{books, failures}` |
| POST | `/api/chapters` | `{book}` → 目录 |
| POST | `/api/content` | `{book, chapter}` → 章节与段落 |
| GET | `/api/recommendations` | `{sections}`，来自真实站点推荐 |
| GET | `/api/categories` | 分类 |
| GET | `/api/categories/:id` | 该分类真实书目 |
| GET | `/api/cover` | `sourceID`、`bookURL`、可选 `url`；栅格图片 |
| POST | `/api/cover-metadata` | `{book}` → `{url}` |
| POST | `/api/download` | `{book}` → 整本 EPUB / PDF 文件流 |

安全边界：鉴权、CORS 和 API 配额以 Fastify 匹配后的路由识别 API，编码路径不能绕过检查。仅内置来源主机，没有任意网址代理或客户端自定义来源接口；正文必须属于返回的书籍目录，静态资源限制到登记仓库；OpenStax 下载地址从出版者目录复核。所有连接使用 HTTPS，校验 DNS 的公网地址后固定连接 IP，TLS 仍校验原始主机；每次重定向重新验证。旧站同主机的 `http` 重定向仅升级为 `https`，不会发送明文请求。

开发机部分 VPN 使用 `198.18/15` 虚拟 DNS，此时仅对已登记主机使用固定公网 `1.1.1.1`、TLS 主机 `cloudflare-dns.com` 的加密 DNS A 记录查询，连接复核后的公网 IP；不会放行保留网段。普通 DNS 解析到其他内网地址直接拒绝。

限流仅统计 `/api/`：每 IP 每分钟 180 请求，整本下载 12 次；网页、PWA 预缓存和 PDF 字体等静态资源不消耗 API 额度。默认 4 个并行来源连接和最多 32 个排队任务；排队等待超过 25 秒或队列已满返回 503。页面 8 MiB、封面 5 MiB、文件 250 MiB 上限，压缩内容按解压后字节计数；取消或超限会同时关闭解压流与上游响应。页面响应总时限 25 秒，整本文件总时限 10 分钟（跨重定向累计）；页面和文件的连接空闲时限分别为 18 / 30 秒，不会因为下载连续超过 30 秒而中断。解析数据缓存最多 32 MiB，封面缓存 40 MiB，不记录阅读正文。缓存仅本进程内存，重启即清空。

书源可用性由原站决定。认证、验证码、DRM 和复杂客户端执行型来源不绕过；不支持的来源返回清楚错误。PDF 保留原版布局由客户端处理；EPUB / TXT 的导入与离线存储由客户端完成。当前 API 已在 Ubuntu `/srv/qingread` 通过 Caddy 2.11.7 的 443 HTTPS 入口部署，地址为 [https://192.144.237.46](https://192.144.237.46)，不公开容器 API 端口，原 80 服务保留。API 上限 384 MiB / 0.75 CPU，Caddy 上限 128 MiB / 0.25 CPU。当前明确开启免访问码模式，Web 与安卓直接连接；书架和进度不在服务器保存。部分海外书源大文件传输会中断，按使用者要求暂不继续排查，完整状态见 [实际部署记录](../deploy/DEPLOYMENT.md)。

回归测试 `npm test -- tests/server.test.ts`；真实网络测试需显式运行 `QINGREAD_LIVE_TESTS=1 npm test -- tests/server-live.test.ts`。后者覆盖两本网文、Gutenberg 整本 HTTP 下载、推荐分类、GBK、静态古典、维基、Standard Ebooks 和 OpenStax PDF。
