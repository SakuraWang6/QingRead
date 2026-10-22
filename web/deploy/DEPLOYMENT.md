# 部署维护基线

更新于 2026-10-23（Asia/Shanghai），Web/API 0.10.0 已上线，健康与共享服务检查通过。地址示例使用 `https://read.example.com`；部署者需替换为自己的主机，仓库没有默认公共共享服务器。

iPhone 原生版为 0.10.0/build 13，Android 源码为 0.10.0/versionCode 9。本轮加入通知与后台任务、书架整理与笔记、EPUB 原版、PDF 页笔记搜索和账号恢复；具体构建、安装与分发状态见[验证记录](../../docs/verification.md)。

## 当前配置

| 项目 | 配置 |
|---|---|
| 平台 | Ubuntu、`linux/amd64` Docker 镜像 |
| 部署目录与项目 | `/srv/qingread`，Compose 项目 `qingread` |
| 应用镜像 | `qingread-web:0.10.0`，健康；保留基础镜像修复，包含新增生产依赖 |
| Web 静态目录 | `downloads/sites/qingread-0100-final-20261023/`，`qingread-current` 指向该目录 |
| HTTPS | 共享 Caddy 入口，清读路径 `/qingread/`；根路径返回空白 404，不展示项目 |
| 应用入口 | Compose 私有网络 `qingread:8787` |
| 资源上限 | 应用 384 MiB / 0.75 CPU；Caddy 128 MiB / 0.25 CPU |
| 书源访问 | 显式 `QINGREAD_PUBLIC_ACCESS=true`、访问码留空 |
| 个人数据 | 账号、恢复码哈希、书架整理、笔记、进度、原文件及后台任务按账号隔离 |
| 云文件配额 | 单本 250 MiB、每账号 2 GiB、总计 10 GiB，预留 5 GiB 磁盘 |
| 个人 Android 包 | 0.10.0 / versionCode 9；最终 CI、固定 v2/v3 签名、版本、ZIP 与公网 latest 全字节哈希检查通过 |

前端与 `linux/amd64` 镜像在开发电脑构建，服务器不执行 npm 安装或前端编译。0.10 新增 `web-push` 生产依赖，必须把匹配锁文件的依赖层一起交付，保留运行实例已有基础镜像修复；不能照搬 0.9 仅 COPY 少量源码的步骤。子路径网页单独上传到静态版本目录，不依赖镜像内旧 dist。保留上一兼容镜像、静态目录和升级前一致数据备份。日志过滤访问码、Bearer 会话、恢复码与推送订阅密钥，不公开展开的 Compose 或私有环境。

共享 Caddy 已包含其他应用的路由和监听端口。**不要用仓库的独立主机 Caddyfile 或 Compose 覆盖生产配置**，也不要重新创建 HTTPS 容器来发布清读的网页更新。

## 必须保留的数据

| 路径 | 内容 |
|---|---|
| `.env` | 私有部署参数，权限 600 |
| `app-data/accounts.sqlite` 及 WAL/SHM | 账号、密码与恢复码哈希、会话哈希、书架整理、笔记、进度、云文件索引 |
| `app-data/notifications.sqlite` | 启用 Web Push 后的私有订阅与选书状态 |
| `app-data/offline-jobs.sqlite`、`jobs/` | 本账号云端准备任务和有限期正文暂存 |
| `app-data/files/` | 按账号存放的原文件，目录 700、文件 600 |
| `app-data/covers/` | 可重新获取的公共封面缓存 |
| `caddy-data/`、`caddy-config/` | HTTPS 证书与代理持久数据 |
| `downloads/` | 已验签 APK，以及 `sites/` 中的清读子路径网页与旧 PWA 兼容脚本；`qingread-current` 指向当前网页目录 |
| 私有备份目录 | 升级前配置及一致的数据快照 |

备份数据库和原文件时，应在低峰仅暂停清读应用服务，复制整个 `app-data` 后立即恢复；不要只复制运行中的 SQLite 主文件。还原使用同一份数据库与文件目录。保留上一版本镜像与配置，备份不进入 Git。完整步骤见 [部署说明](README.md)。

## 查看、更新与回滚

只在本项目目录操作：

```sh
cd /srv/qingread
sudo docker compose ps
sudo docker compose logs --tail 100 qingread https
```

更新前检查主机可用内存、磁盘和其他服务状态，保留一致备份与旧镜像，在私有 `.env` 修改 `QINGREAD_IMAGE`，然后只更新应用：

```sh
sudo docker compose config --quiet
sudo docker compose up -d --no-deps qingread
```

Web 更新应在开发电脑用 `QINGREAD_WEB_BASE=/qingread/ npm run build` 构建，上传 `dist/` 至新的 `downloads/sites/` 版本目录，再原子切换 `qingread-current`。仅更新应用镜像不会发布这个子路径网页；Android 打包使用默认根路径构建，不设置该变量。

验证健康接口的版本、账号隔离和下载后，复查容器健康、OOM 标记及所有原服务入口。回滚时将 `QINGREAD_IMAGE` 改为已保留的兼容版本，再执行同一条应用更新命令，并将 `qingread-current` 切回对应静态目录。不要删除 `app-data`、证书、卷或其他项目，也不要用旧的 0.5 镜像恢复当前同步功能。

清理只处理已加载成功的 `incoming` 安装归档和确认未被容器引用的过旧清读镜像，保留当前版本与一个回滚版本；不执行全局 Docker prune。

## HTTPS、连接与验证范围

Caddy 使用 Let's Encrypt `shortlived` 公网 IP 证书，通过 TCP 443 的 TLS-ALPN 验证并自动续期，不接管 80。保持 443 可访问，保留证书目录；没有有效证书时不要绕过浏览器警告。

Mac 上可用 `scripts/ssh-en0-connector.py` 作为 SSH 的 `ProxyCommand`，仅将连接绑定到当前 Mac 的 `en0`，不修改系统路由，也不代理书源流量。私钥由部署者在项目外自行保管。

本轮已验证的公网原文件隔离、跨会话续读、资源状态与 Android 构建记录见 [项目验证记录](../../docs/verification.md)。部分海外来源整本下载仍有连接重置，未继续排查；Android 尚无真机运行结论。

公开 CI 使用临时调试签名，不保存个人签名 Secret。长期分发的 APK 必须在私有环境使用固定证书签名，升级保持同一证书。早期临时签名包若无法覆盖升级，应先导出阅读备份并保留原文件，之后再处理卸载。

## 0.10.0 发布核对

升级前保留完整 `before-10` 备份，开发机离线构建包含 `web-push` 的镜像，仅切换清读应用与静态目录。`qingread-web:0.10.0` 健康，API 返回 0.10.0；`/qingread/`、manifest、Service Worker 与 push worker 均返回 200，scope 限定正确。根路径与 `/index.html` 仍为正文 0 字节的 404。

共享 Caddy 配置逐字未改，其他五个容器的 ID 与启动时间均未变；既有课程入口经认证跳转后为 200，独立端口服务仍为 200。无 OOM，清读约 115.1 MiB / 384 MiB，主机可用内存从 713 MiB 变为 699 MiB，磁盘约 24 GiB 可用。

`/api/push/status` 与 `/api/offline/jobs` 未登录返回 401。Web Push 已启用，VAPID 密钥仅放私有环境；Apple 推送端点 TLS 可达、HTTP 405，尚未验证真实订阅送达。EPUB 默认文字阅读补丁已切至 `qingread-0100-final-20261023`，本次仅换静态目录链接，无容器重启，Caddy 仍完全相同。Android 最终 CI、固定证书 v2/v3 签名、manifest 0.10.0/code 9 与 ZIP 检查通过；公网 latest 重新下载的 7,819,583 字节与本地已验签包 SHA-256 一致。本地与设备检查见[验证记录](../../docs/verification.md)。

线上旧 PWA 已实测点击更新后保留原有两本书架，显示新增筛选与 Web 0.10 版本；默认文字补丁再次更新后，实际主脚本 URL/哈希与公网构建逐字一致，原有两本仍保留。390 × 844 布局正常。未登录的通知面板要求先登录，不自动弹出系统权限。

可选推送只向主动授权的登录账号开放；软件默认关闭，本实例已配置启用，无订阅就没有目录轮询。VAPID 私钥保存在私有配置并备份，新增环境只传给清读。云端准备全局单并发并限额，不扫描未启用用户书架；临时正文不能替代原文件备份。文档详见 [Push](../server/PUSH.md) 与 [云端准备](../server/OFFLINE-JOBS.md)。

## 上一兼容基线

0.9.0 已完成账号、原文件隔离、保留数据安装和固定证书 Android 分发验证，静态目录为 `downloads/sites/qingread-090-final-20261022/`。共享入口与其他服务当时正常、无 OOM；这些结果仅属于上一版本，不能替代本轮复核。[0.9 验证归档](../../docs/history/reader-0.9-verification.md)。

## 共享入口路由修复（2026-10-22）

原 HTTPS 根路径的 catch-all 指向清读，导致服务器 IP 直接显示阅读器。现已将清读限定在 `/qingread/`，课程系统继续使用自身路径，两者各自分享链接。根路径与 `/index.html` 返回空白 404，不提供导航或项目列表；私人服务保留原地址与端口。其他未匹配的页面也返回 404，不再兜底到清读。

静态网页在开发电脑以 `QINGREAD_WEB_BASE=/qingread/` 构建，上传到 `downloads/sites/` 的版本目录，由 Caddy 只读提供。新 PWA scope、启动地址、PDF 辅助资源均限定在 `/qingread/`，原 `/sw.js` 提供注销脚本以处理旧根路径缓存，不删除用户存储。`/api/` 保留以兼容已安装的 iPhone / Android；课程系统更具体的 API 前缀先匹配。旧根静态资源暂留供已打开的旧网页使用。

共享 Caddy 配置已经包含其他项目维护的规则。此前入口修复仅热更新路由和静态网页，没有更换镜像或重启业务容器；路由拆分与撤掉导航的备份分别位于实例私有 `backups/routing-20261022/`、`backups/no-portal-20261022/`。后续部署需保留 `downloads/sites/`、全部共享路由、原端口及已有基础镜像修复。见[多项目部署与 PWA 迁移](shared-host/README.md)。

当时验证：子路径与默认根路径构建均通过；连接、静态服务、文件解析、启动相关 31 项测试通过（启动测试在允许本机监听的环境复跑）。浏览器实际完成旧根缓存退出、清读书架和课程访问验证页加载，清读手机 390×844 布局正常，原本机两本书仍在。撤掉导航后，根地址与 `/index.html` 均返回 404、正文 0 字节；两个分享入口、私人面板、清读健康与旧 PWA 注销脚本仍正常响应。PWA manifest / worker、PDF cmap、APK 下载均已验证。该次路由调整前后全部 6 个容器的 ID 和启动时间未变，无 OOM；这份历史记录不替代本轮应用发布后的状态对比。
