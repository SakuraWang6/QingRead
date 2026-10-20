# 手动部署移动 Web 与安卓书源服务

这个配置将网页与书源 API 放进一个 Node 24 容器，默认只映射服务器的 `127.0.0.1:8787`，通过已有 HTTPS 反向代理访问。不会占用现有 80 端口，也不会修改其他服务。本目录仅提供部署文件，没有自动连接服务器或发布。

## 服务器准备

需要现有 Docker Engine 与 Docker Compose 插件、一个指向服务器的域名，以及已配置证书的 HTTPS 反向代理。若目前没有这些，请先确认服务器现有服务与端口，再另行安排安装；下面步骤不会安装系统软件。

将仓库复制或拉取到服务器上的独立目录，例如 `/opt/qingread`。仓库是私有的，使用你已有的 GitHub SSH 授权；不要把私钥或 GitHub 令牌写进镜像、Compose 或聊天。

进入仓库的 `web/` 目录：

```sh
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

把刚生成的随机值填入 `.env` 的 `QINGREAD_ACCESS_TOKEN`，把 `QINGREAD_ALLOWED_ORIGINS` 改成网页实际地址，例如 `https://read.example.com`。不要把随机值粘贴到聊天或提交到 Git。访问令牌不能为空，Compose 会拒绝空令牌。若 8787 已被使用，只修改 `QINGREAD_PORT`。

```sh
docker compose config --quiet
docker compose build --pull
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:8787/api/health
```

健康响应应包含 `ok: true` 和 `requiresToken: true`。若改过端口，请相应修改 `curl`。健康检查不需要令牌；搜索、目录、正文和封面 API 都需要令牌。用 `docker compose logs --tail 100 qingread` 查看启动错误，不要公开整份 Compose 展开结果，因为其中含令牌。

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

验证 `https://read.example.com/api/health` 能正常返回，再打开网页的「设置 → 服务器」，输入访问令牌。网页与 API 部署在同域时，服务器地址可以留空；令牌只保存在当前标签页的 sessionStorage，关闭标签页或重新打开时可能需要再次输入。不要把令牌放进网址。

## 安卓连接

安卓 App 的「设置 → 服务器」填入 `https://read.example.com`（或带 `/api` 的地址），再输入同一个访问令牌。默认 CORS 已允许 Capacitor 的 `https://localhost`、`capacitor://localhost` 和 `http://localhost`，无需添加通配符。若将来修改了 App 的 WebView 主机或协议，需要把新的**完整 Origin**追加进 `QINGREAD_ALLOWED_ORIGINS`，然后重建容器环境：

```sh
docker compose up -d --force-recreate
```

不要填写服务器的 `127.0.0.1` 作为手机地址，那会指向手机本身。安卓默认使用 HTTPS；不建议为公网服务开启明文 HTTP。

## 运行限制与更新

容器以 UID 1000 非 root 运行，文件系统只读，只给 `/tmp` 64 MiB 临时空间，移除所有 Linux capabilities 并禁止提权。不挂载 Docker socket、主机目录或凭据。服务不需要持久卷：书架、阅读进度、文件和离线缓存目前保存在客户端，服务器只有可丢弃的书源缓存，**不会自动同步 iOS、网页与安卓书架**。

Compose 将内存上限设为 384 MiB、Node 堆上限 192 MiB，预留原生 Buffer 与流式下载空间；CPU 上限 1 核。对于 2 核 2 GiB 的个人服务器，这是保守起点。请通过 `docker stats --no-stream` 观察实际负载；高并发或大目录可能需要调高限制，内存不足会被容器运行时重启。整本文件上限 250 MiB，但下载是流式转发，不会整本常驻服务内存。

更新代码后在 `web/` 运行：

```sh
docker compose build --pull
docker compose up -d
docker compose ps
```

移除这一套服务用 `docker compose down`，它不会删除客户端的书架或阅读文件。部署前后都请检查现有站点与服务器资源；本配置不提供账号系统、跨设备同步、远程来源导入，也不绕过原站的登录、验证码或 DRM。

## 本地验证状态

2026-10-20 已在本机 OrbStack 完成 Node 24 多阶段镜像构建，以及临时 `127.0.0.1:8788` 容器验证：健康检查、静态首页与 PWA 清单、PDF worker、无令牌 401（含编码 API 路径）、授权获取 10 个书源、真实小说搜索均通过；请求全部 211 个静态文件之后，首次搜书仍成功，静态预缓存不会消耗 API 限额。实际进程 UID 为 1000，根目录只读、`/tmp` 可写，权限限制生效；一次搜索后的内存约 120 MiB，容器上限 384 MiB。临时容器已清理，镜像保留为 `qingread-web:local`。

本机镜像是 ARM64；上面的服务器 `docker compose build` 会按服务器自身架构重新构建，不要直接将 ARM64 镜像当作 x86_64 镜像运行。这里没有进行远程服务器部署。依赖或代码发生变化后，应重新构建并复核健康与鉴权。

## 持续验证

`.github/workflows/web.yml` 在 `web/` 或该工作流变化时运行 Node 24 的 `npm ci`、单元测试、TypeScript / PWA 构建和生产依赖审计，高风险生产依赖会阻止验证通过。构建产物保存 7 天，不发布网站或连接服务器。一般 CI 不依赖外部书源可用性；手动运行工作流时可以勾选 `live_sources`，额外执行真实书源测试。

本地对应命令是在 `web/` 运行 `npm ci`、`npm test`、`npm run build` 和 `npm audit --omit=dev --audit-level=high`。浏览器 PWA 首次预缓存、PDF 字体与其他静态文件不会消耗 `/api/` 的请求限额，API 自身仍保留限流。
