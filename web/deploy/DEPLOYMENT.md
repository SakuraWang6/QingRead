# 实际部署记录

更新于 2026-10-20（Asia/Shanghai）。访问地址：[https://read.example.com](https://read.example.com)。这是供自己和朋友直接访问的清读 Web 与书源服务，书架、阅读进度、导入文件和正文缓存仍保存在各设备本机，**不提供云同步**。

## 服务器

| 项目 | 实际配置 |
|---|---|
| 系统与运行方式 | Ubuntu，Docker Compose 项目 `qingread` |
| 部署目录 | `/srv/qingread` |
| Compose 文件 | `/srv/qingread/compose.yaml`（来自仓库 `compose.production.yaml`） |
| 生产应用代码版本 | `ce1dbca`（镜像 `qingread-web:0.5.1-public-ce1dbca`） |
| 对外入口 | TCP 443，Caddy `2.11.7-alpine` |
| 原有服务 | 原 TCP 80 服务保留，未替换其配置 |
| API | 私有容器网络 `qingread:8787`，不单独开放公网端口 |
| API 资源上限 | 384 MiB 内存、0.75 CPU |
| Caddy 资源上限 | 128 MiB 内存、0.25 CPU |
| 安卓安装包 | `/srv/qingread/downloads/QingRead-Android-0.5.1.apk`，Caddy 只读挂载 |

镜像在开发电脑构建为服务器所需的 `linux/amd64` 后上传，服务器不执行前端编译或 npm 安装。运行时日志会删除 `X-Qingread-Token` 字段；已用故障上游和假访问码验证。生产 `.env`、访问码与证书数据不放入 Git 或 APK；`.env` 权限为 600。Caddy 的 `caddy-data`、`caddy-config` 是持久目录，更新与回滚时保留。

## HTTPS 与访问方式

Caddy 使用 Let's Encrypt 的 `shortlived` 公网 IP 证书，通过 443 的 TLS-ALPN 验证，关闭占用 80 的 HTTP 验证及自动重定向。证书由 Caddy 持久保存并自动续期；这是已配置的自动续期机制，本次部署尚未跨完整续期周期验证。保持公网 443 可访问，勿删除证书目录或运行第二个争用此端口的代理。

当前按使用者要求关闭访问码：部署环境设置 `QINGREAD_PUBLIC_ACCESS=true`、`QINGREAD_ACCESS_TOKEN=`，Web 和 Android 直接连接。访问地址不变，不需要重新安装 APK；服务器连接设置里的访问码可留空。拿到网址的人可以使用服务，现有请求限流、来源白名单、上游并发和容器资源上限继续生效。

网页与 API 同源时，服务地址留空即可。Android 0.5.1 服务器版已预设上述 HTTPS 地址；APK 内的 `https://localhost` 只负责提供打包页面，不是书源服务器。书架与进度仍保存在当前设备。

启动器默认拒绝没有访问码的对外监听；只有明确设置 `QINGREAD_PUBLIC_ACCESS=true` 才允许。以后需要恢复访问码时，在私有 `.env` 填入 `QINGREAD_ACCESS_TOKEN` 并重建 API 容器；只要令牌非空，鉴权仍会执行。

## 已完成与尚未完成的验证

- 公网 HTTPS 页面、免访问码 API / Android CORS 检查及手机尺寸网页浏览已复核。实际搜书、1106 章目录、正文与后续 10 章预缓存通过。
- 较小的 Gutenberg 公版 EPUB（263,753 字节）已完整下载并成功解包；不代表所有海外大文件链路稳定。
- Web 的 TypeScript / 生产构建、阅读器与服务端回归检查已完成；页面、PWA、PDF 资源由应用提供。
- Android **0.5.1 / versionCode 2** 已通过 CI 编译、Lint、APK v2 签名验证与 ZIP 完整性检查。APK 内的默认 HTTPS API、版本、包名和 PDF 资源也已核对。
- 安卓尚未在模拟器或真机运行；不能把 CI 构建成功视为设备交互、后台听书或文件导出的验证。
- 服务器到 Gutenberg 的《红楼梦》EPUB 传输会被中途重置，**此来源的整本下载尚不稳定**。对比容器内原生 fetch、本机 API 和公网下载均复现；同文件在开发电脑可完整下载，已排除反向代理与清读流桥接为本次根因。上游书源可用性不由部署保证。

Android 的固定个人测试证书 SHA-256：

```text
ff9db7beba4dd6075e1e9f4d09dea86a8353d68811dd84f5d4f7026f1067cb70
```

[固定签名构建与验证记录](https://github.com/SakuraWang6/QingRead/actions/runs/39444094943)。构建前后均强制比对此公开指纹；私钥通过仓库加密 Secret 恢复到 Runner 私有临时路径，Gradle 显式使用该路径。这是个人测试签名，不是上架 release 签名。

早期 0.5.0 及首次 0.5.1 的 APK 曾使用其他临时签名。如果装过这些旧包，需先导出阅读备份并保留原电子书文件，再卸载一次，安装固定签名版后恢复备份。备份不包含原文件与正文缓存；以后同一固定签名下的更新可直接覆盖安装。

安装包直链：[QingRead Android 0.5.1](https://read.example.com/downloads/QingRead-Android-0.5.1.apk)。文件不含访问码，SHA-256 为 `f099c39acb417bdc3be5b5a48fdfb5505a504f6ffc7cd7ac9459f1bed8e8c436`。

部署后的状态抽查：原有三个容器均 healthy、restart=0、OOM=false，原 80 端口仍返回原有 307；服务器可用内存约 977 MiB，清读 API / Caddy 当时约 115 / 13 MiB。数值为本次抽查，不是长期监控承诺。

## 本机 SSH 连接

本次 Mac 的 VPN 虚拟路由曾让 SSH 在握手前关闭；经物理 Wi-Fi 接口 `en0` 连接已验证可用，未修改服务器 SSH 或系统代理。实际使用的 `scripts/ssh-en0-connector.py` 已保留为维护脚本，可通过 SSH 的 `ProxyCommand` 调用。它使用 macOS 的 `IP_BOUND_IF`，只适用于当前 Mac 的 `en0` 接口，不是服务器依赖，也不负责代理书源流量。私钥仍使用本机已有文件，不复制进项目。

## 查看、更新与回滚

只在本项目目录操作，不展开或公开含访问码的 Compose 环境：

```sh
cd /srv/qingread
sudo docker compose ps
sudo docker compose logs --tail 100 qingread https
```

更新时先保留上一镜像版本及当前配置，在私有 `.env` 修改 `QINGREAD_IMAGE` 后执行：

```sh
cd /srv/qingread
sudo docker compose config --quiet
sudo docker compose up -d
```

如需停止并回滚本次项目：

```sh
cd /srv/qingread
sudo docker compose down
```

不加 `-v`，不删除 `caddy-data`、`caddy-config` 或 `.env`，不停止其他项目，也不改原 80 服务。若要恢复上一应用镜像，将本项目的 `QINGREAD_IMAGE` 改回已保留版本，再执行 `up -d`。

通用部署步骤与配置说明见 [README](README.md)，安卓构建与限制见 [Android README](../android/README.md)。证书机制参考 [Let's Encrypt IP 证书说明](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)和 [Caddy TLS 配置](https://caddyserver.com/docs/caddyfile/directives/tls)。

恢复早于 `ce1dbca` 的镜像时，旧启动器不支持公共模式，须同时配置非空 `QINGREAD_ACCESS_TOKEN`；不要只回退镜像并保留空令牌。
