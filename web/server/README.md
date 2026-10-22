# 清读书源服务

需要 Node.js 24（使用内置 SQLite）。当前 API 版本为 0.10.0。在 `web/` 运行 `npm run dev:api`，默认仅监听 `127.0.0.1:8787`。Vite 将同源 `/api` 代理到此服务；生产 `npm run build && npm start` 同时提供 `dist/` 页面。

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
| GET | `/api/author?name=...` | 按实际作者字段过滤的作品 |
| GET | `/api/cover` | `sourceID`、`bookURL`、可选 `url`；栅格图片 |
| POST | `/api/cover-metadata` | `{book}` → `{url}` |
| POST | `/api/download` | `{book}` → 整本 EPUB / PDF 文件流 |
| GET | `/api/offline/chapters?payload=...` | 原生后台批次，最多 10 章、5 MiB；仍受书源访问码校验 |

安全边界：鉴权、CORS 和 API 配额以 Fastify 匹配后的路由识别 API，编码路径不能绕过检查。仅内置来源主机，没有任意网址代理或客户端自定义来源接口；正文必须属于返回的书籍目录，静态资源限制到登记仓库；OpenStax 下载地址从出版者目录复核。所有连接使用 HTTPS，校验 DNS 的公网地址后固定连接 IP，TLS 仍校验原始主机；每次重定向重新验证。旧站同主机的 `http` 重定向仅升级为 `https`，不会发送明文请求。

开发机部分 VPN 使用 `198.18/15` 虚拟 DNS，此时仅对已登记主机使用固定公网 `1.1.1.1`、TLS 主机 `cloudflare-dns.com` 的加密 DNS A 记录查询，连接复核后的公网 IP；不会放行保留网段。普通 DNS 解析到其他内网地址直接拒绝。

限流仅统计 `/api/`：每 IP 每分钟 180 请求，整本下载 12 次；网页、PWA 预缓存和 PDF 字体等静态资源不消耗 API 额度。默认 4 个并行来源连接和最多 32 个排队任务；排队等待超过 25 秒或队列已满返回 503。页面 8 MiB、封面 5 MiB、文件 250 MiB 上限，压缩内容按解压后字节计数；取消或超限会同时关闭解压流与上游响应。页面响应总时限 25 秒，整本文件总时限 10 分钟（跨重定向累计）；页面和文件的连接空闲时限分别为 18 / 30 秒，不会因为下载连续超过 30 秒而中断。解析数据缓存最多 32 MiB，封面缓存 40 MiB，不记录阅读正文。解析数据缓存仅在本进程内存，重启即清空；公共封面另有下文所述的持久缓存。

书源可用性由原站决定。认证、验证码、DRM 和复杂客户端执行型来源不绕过；不支持的来源返回清楚错误。PDF 保留原版布局由客户端处理；EPUB / TXT 的导入与离线存储由客户端完成。维护实例在 Ubuntu `/srv/qingread` 通过 Caddy 2.11.7 的 443 HTTPS 入口部署，不公开容器 API 端口，原 80 服务保留。文档中的 `https://read.example.com` 是占位地址，部署时替换为自己的主机。API 上限 384 MiB / 0.75 CPU，Caddy 上限 128 MiB / 0.25 CPU。当前明确开启免访问码模式，Web 与安卓直接连接；账号、密码哈希、会话哈希、书架和当前位置保存在独立 SQLite 数据目录；网站章节缓存不上传；EPUB/PDF/TXT 原文件按账号保存到私有目录。部分海外书源大文件传输会中断，按使用者要求暂不继续排查，完整状态见 [实际部署记录](../deploy/DEPLOYMENT.md)。

回归测试 `npm test -- tests/server.test.ts`；真实网络测试需显式运行 `QINGREAD_LIVE_TESTS=1 npm test -- tests/server-live.test.ts`。后者覆盖两本网文、Gutenberg 整本 HTTP 下载、推荐分类、GBK、静态古典、维基、Standard Ebooks 和 OpenStax PDF。


## 账号同步

需要 Node.js 24。`QINGREAD_DATA_DIR` 指向可写私有目录，默认 `.data`；生产 Compose 挂载 `./app-data:/data`，UID/GID 1000，目录 700，数据库 600。`QINGREAD_MAX_USERS` 默认 100，仅限制新注册；不影响现有登录。

- `POST /api/auth/register`、`POST /api/auth/login`：`{username,password}`，返回用户、随机会话令牌与 30 天有效期。
- `GET /api/auth/me`、`POST /api/auth/logout`：使用 `Authorization: Bearer <session>`；退出撤销当前会话。
- `POST /api/auth/password`：`{currentPassword,newPassword}`；验证当前密码，撤销旧会话并返回新会话。
- `POST /api/auth/recovery-code`：`{password}`；需登录并验证当前密码，只展示一次，轮换替换旧码。
- `POST /api/auth/recover`：`{username,recoveryCode,newPassword}`；恢复码使用一次即失效，撤销旧会话。
- `POST /api/sync`：使用相同会话认证，协议 `body-utf16-v1`，用户由会话确定，不能在请求中指定其他用户。

同步独立于可选的书源访问码；开放书源不等于开放个人数据。密码经独立随机盐的 scrypt 哈希；数据库仅保存会话令牌的 SHA-256。注册/登录每 IP 每路由每分钟 10 次，同时仅执行一次密码计算，避免小内存服务器被耗尽。每账号最多 1000 本书、每批 50 个操作。详见 [云同步](../../docs/cloud-sync.md)。


书架整理按独立修改时间合并，笔记按条目 ID 合并并保留删除标记。普通进度只更新位置，不能清空整理或笔记。跨来源换源需当前修订号，书籍和新位置整体替换；旧来源进度会被拒绝并返回权威记录。PDF 标注采用统一 `pdf-page-<0 起页码>`，搜索在客户端提取本地文字，不上传全文索引。

## 私有云文件

`GET /api/files` 返回当前账号可用文件、使用量和配额。`POST /api/files/:sha256?bookID=...&bytes=...` 使用 `application/octet-stream` 原始字节；`GET /api/files/:sha256` 下载。三者均要求当前账号的 Bearer 会话，不接受请求指定用户归属。书架资料必须先同步，文件必须与当前账号书籍的 SHA-256 和类型一致；原文件流式保存到私有 `app-data/files/<账号UUID>/<哈希>`，不开放静态文件 URL。

默认单本 250 MiB、每账号 2 GiB、服务器合计 10 GiB；环境变量 `QINGREAD_FILE_USER_GB` 和 `QINGREAD_FILE_TOTAL_GB` 调整容量，保留 5 GiB 可用磁盘的保护仍生效。上传 1 个并行任务、下载最多 2 个，闲置连接 65 秒、文件总传输 10 分钟。中断或校验失败清理临时文件；启动时清理中断写入残留。客户端按需下载，不把所有云文件一次性塞进设备存储。

公共书源封面缓存使用 `app-data/covers`，最大约 128 MiB、500 张、7 天；同一张正在加载的图只请求一次。响应头 `X-QingRead-Cover-Cache` 区分 miss/memory/disk，`Server-Timing` 显示服务端处理耗时。它只缓存书源公开图片，私有导入封面从当前账号原文件在客户端提取。


## 可选后台服务

- [Web Push](PUSH.md)：登录用户主动授权，免费 VAPID、选书检查、泛化通知、去重与限频；默认关闭，需私有环境配置和可达的浏览器推送服务。
- [云端准备章节](OFFLINE-JOBS.md)：本账号书架创建任务，全实例单并发、私有暂存与空间限额；关闭页面后可继续准备，回前台再保存到本机。

`notifications.sqlite`、`offline-jobs.sqlite` 及 `jobs/` 与账号库共同位于私有数据目录。部署和备份需包含整个目录；取消或过期清理只处理清读自己拥有的临时任务文件。后台检查和准备仍经过既有网络层与全局书源并发限制。
