# 手动部署移动 Web 与安卓书源服务

通用配置将网页与书源 API 放进一个 Node 24 容器，通过 HTTPS 反向代理访问。当前已经在 Ubuntu 的 `/srv/qingread` 部署独立生产 Compose，使用 [https://read.example.com](https://read.example.com)，原 80 服务保留；[实际配置、已测范围和回滚记录](DEPLOYMENT.md)。下面同时保留迁移到其他服务器或接入已有反向代理的手动步骤。

## 独立 HTTPS 部署（保留现有 80 端口）

`compose.production.yaml` 是实际部署使用的独立配置。运行镜像在工作电脑构建为 `linux/amd64` 后上传，服务器不执行 npm 安装或前端编译。清读 API 只对 Compose 私有网络开放；Caddy 2.11.7 单独监听公网 TCP 443，原有 80 端口服务不变。

部署目录的 `.env` 需要 `QINGREAD_IMAGE`、`QINGREAD_PUBLIC_HOST`（域名或公网 IPv4）、可选的 `QINGREAD_ACCESS_TOKEN`。当前共享实例设 `QINGREAD_PUBLIC_ACCESS=true` 且访问码留空；未明确开启公共模式时，对外监听仍要求访问码。文件权限设为 600，不提交 Git；将同目录的 `caddy-data`、`caddy-config`、`app-data` 创建为 UID/GID 1000、权限 700。复制本目录的 Caddyfile。若启用安装包直链，在 `downloads/` 放置已验签的 `QingRead-Android-0.6.0.apk`，该目录仅供 Caddy 只读访问。然后执行：

```sh
docker compose -f compose.production.yaml config --quiet
docker compose -f compose.production.yaml up -d
```

API 上限 384 MiB、0.75 CPU；HTTPS 上限 128 MiB、0.25 CPU，两者禁用容器 swap、限制 PID 和日志。上游并发固定 4、排队上限 32；普通网页请求总时限 25 秒，整本文件最多 10 分钟，闲置 30 秒仍会释放连接。先检查原服务健康与可用内存，再逐项验证部署，不同时跑压测。

公网 IPv4 使用 Let's Encrypt `shortlived` 证书，通过 TCP 443 的 TLS-ALPN 验证，不接管 80。Caddy 持久化证书并自动续期；公网 443 必须一直放行。先使用 staging 端点与独立 data 目录验证，再切换正式配置，避免无效申请。没有有效证书时不要让用户跳过浏览器安全警告。

部署验证应覆盖 `https://公网主机/api/health`、未授权接口 401、授权来源列表、网页搜索、安卓 Origin 预检及整本文件下载，再复查原服务健康、OOM 标记与内存。这是验证清单，不代表所有链路都已稳定通过；服务器到 Gutenberg 的部分整本下载存在连接重置，详见实际部署记录。回滚只在本项目目录执行 `docker compose -f compose.production.yaml down`，不加 `-v`，保留证书目录，不操作其他 Compose 项目。

依据：[Let's Encrypt 公网 IP 证书](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)、[Caddy TLS 配置](https://caddyserver.com/docs/caddyfile/directives/tls)。

## 已有 HTTPS 反向代理时的手动部署

需要现有 Docker Engine 与 Docker Compose 插件、一个指向服务器的域名，以及已配置证书的 HTTPS 反向代理。若目前没有这些，请先确认服务器现有服务与端口，再另行安排安装；下面步骤不会安装系统软件。

将仓库复制或拉取到服务器上的独立目录，例如 `/opt/qingread`。可以公开克隆源码；不要把私钥或 GitHub 令牌写进镜像、Compose 或聊天。

进入仓库的 `web/` 目录：

```sh
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

把刚生成的随机值填入 `.env` 的 `QINGREAD_ACCESS_TOKEN`，把 `QINGREAD_ALLOWED_ORIGINS` 改成网页实际地址，例如 `https://read.example.com`。不要把随机值粘贴到聊天或提交到 Git。默认对外监听要求令牌；若明确需要免访问码访问，设置 `QINGREAD_PUBLIC_ACCESS=true` 并将令牌留空。若 8787 已被使用，只修改 `QINGREAD_PORT`。

```sh
docker compose config --quiet
docker compose build --pull
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:8787/api/health
```

健康响应应包含 `ok: true`；`requiresToken` 表示当前是否需要访问码。若改过端口，请相应修改 `curl`。健康检查不需要令牌；设置了非空令牌时，搜索、目录、正文和封面 API 都需要令牌；明确开放且令牌为空时无需填写。用 `docker compose logs --tail 100 qingread` 查看启动错误，不要公开整份 Compose 展开结果，因为其中含令牌。

## 接入已有 HTTPS 反向代理

将 `read.example.com` 的现有 HTTPS 虚拟主机代理到 `http://127.0.0.1:8787`。下面仅是 **已有 Nginx HTTPS server 块内的 location 配置**，不是一份覆盖原配置的安装脚本；保留原有证书和其他站点。

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 200s;
    proxy_send_timeout 200s;
    client_max_body_size 128k;
}
```

如果代理运行在另一个 Docker 容器，容器内的 `127.0.0.1` 指向代理本身。此时需要把两者加入已有的专用 Docker 网络，并将上游改为 `http://qingread:8787`；请根据现有网络调整，不要开放公网 8787 作为替代方案。主机上运行的反向代理可以直接使用上述配置。

先执行 `nginx -t` 检查，再按现有服务管理方式重载。网页必须通过 HTTPS 访问，PWA、浏览器存储与音频功能才能得到正常的安全上下文。源服务不信任客户端转发头做鉴权；在反向代理之后，限流会按代理地址合并计数，适合个人使用。

验证 `https://read.example.com/api/health` 能正常返回，再打开网页的「设置 → 服务器」，输入访问令牌。网页与 API 部署在同域时，服务器地址可以留空；访问码默认只用于本次会话；用户可勾选“在此设备记住访问码”，并可在同一面板清除。访问码绑定完整服务地址，更换地址不会自动发送旧码。不要把令牌放进网址。

## 安卓连接

安卓 App 的「设置 → 服务器」填入 `https://read.example.com`（或带 `/api` 的地址），再输入同一个访问令牌。默认 CORS 已允许 Capacitor 的 `https://localhost`、`capacitor://localhost` 和 `http://localhost`，无需添加通配符。若将来修改了 App 的 WebView 主机或协议，需要把新的**完整 Origin**追加进 `QINGREAD_ALLOWED_ORIGINS`，然后重建容器环境：

```sh
docker compose up -d --force-recreate
```

不要填写服务器的 `127.0.0.1` 作为手机地址，那会指向手机本身。安卓默认使用 HTTPS；不建议为公网服务开启明文 HTTP。

## 运行限制与更新

容器以 UID 1000 非 root 运行，文件系统只读，只给 `/tmp` 64 MiB 临时空间，移除所有 Linux capabilities 并禁止提权。不挂载 Docker socket、主机目录或凭据。服务不需要持久卷：书架、阅读进度、文件和离线缓存目前保存在客户端，服务器只有可丢弃的书源缓存，**不会自动同步 iOS、网页与安卓书架**。

`web/compose.yaml` 通用配置将内存上限设为 384 MiB、Node 堆上限 192 MiB，CPU 上限 1 核；当前实际使用的 `compose.production.yaml` 则把 API 限为 384 MiB / 0.75 CPU、Caddy 限为 128 MiB / 0.25 CPU。请通过 `docker stats --no-stream` 观察实际负载；高并发或大目录可能需要调高限制，内存不足会被容器运行时重启。整本文件上限 250 MiB，下载采用流式转发，但服务器到部分海外书源的整本下载仍可能中断。

更新代码后在 `web/` 运行：

```sh
docker compose build --pull
docker compose up -d
docker compose ps
```

移除这一套服务用 `docker compose down`，它不会删除客户端的书架或阅读文件。部署前后都请检查现有站点与服务器资源；本配置不提供账号系统、跨设备同步、远程来源导入，也不绕过原站的登录、验证码或 DRM。

## 本地验证状态

2026-10-20 已在本机 OrbStack 完成 Node 24 多阶段镜像构建，以及临时 `127.0.0.1:8788` 容器验证：健康检查、静态首页与 PWA 清单、PDF worker、无令牌 401（含编码 API 路径）、授权获取 10 个书源、真实小说搜索均通过；请求全部 211 个静态文件之后，首次搜书仍成功，静态预缓存不会消耗 API 限额。实际进程 UID 为 1000，根目录只读、`/tmp` 可写，权限限制生效；一次搜索后的内存约 120 MiB，容器上限 384 MiB。临时容器已清理，镜像保留为 `qingread-web:local`。

上述本机测试镜像是 ARM64，不能直接当作 x86_64 镜像运行。当前公网生产镜像已另行在开发机构建为 `linux/amd64`，上传至 Ubuntu 并部署；生产部署不在服务器上执行编译。依赖或代码发生变化后，应重新构建并复核健康与鉴权，具体以 [实际部署记录](DEPLOYMENT.md) 为准。

## 持续验证

`.github/workflows/web.yml` 在 `web/` 或该工作流变化时运行 Node 24 的 `npm ci`、单元测试、TypeScript / PWA 构建和生产依赖审计，高风险生产依赖会阻止验证通过。构建产物保存 7 天，不发布网站或连接服务器。一般 CI 不依赖外部书源可用性；手动运行工作流时可以勾选 `live_sources`，额外执行真实书源测试。

本地对应命令是在 `web/` 运行 `npm ci`、`npm test`、`npm run build` 和 `npm audit --omit=dev --audit-level=high`。浏览器 PWA 首次预缓存、PDF 字体与其他静态文件不会消耗 `/api/` 的请求限额，API 自身仍保留限流。


## 账号数据库与备份

启动前创建可写目录（不要对现有目录递归修改其他服务权限）：

```sh
sudo install -d -o 1000 -g 1000 -m 700 app-data
```

Compose 将 `app-data` 挂载到 `/data`，容器根文件系统继续只读。数据不会写进镜像或代码。健康响应 `syncEnabled: true` 表示同步已启动。只更新清读容器，不删除数据目录。

用 SQLite 在线备份 API 生成一致快照，或只暂停清读容器后备份整个 `app-data`（数据库、WAL、SHM 必须一致），随后立即启动清读。备份包含私人书架和密码哈希，应限制为所有者可读，并加密异地保存。不能只复制运行中的主数据库文件；不要将备份上传 GitHub。保留原镜像、配置和迁移前数据快照，以便回滚。
