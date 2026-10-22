# 部署维护基线

更新于 2026-10-22（Asia/Shanghai），Web/API 版本 0.9.0。地址示例使用 `https://read.example.com`；部署者需替换为自己的主机，仓库没有默认公共共享服务器。

iPhone 原生版为 0.9.0/build 11，Android 源码为 0.9.0/versionCode 7。本轮加入追更、换源保留进度和下载管理；具体构建、安装与分发状态见[验证记录](../../docs/verification.md)。

## 当前配置

| 项目 | 配置 |
|---|---|
| 平台 | Ubuntu、`linux/amd64` Docker 镜像 |
| 部署目录与项目 | `/srv/qingread`，Compose 项目 `qingread` |
| 应用镜像 | API 0.9.0；继承运行实例已有的基础镜像修复 |
| Web 静态目录 | `downloads/sites/qingread-090-final-20261022/`；`qingread-current` 指向当前目录 |
| HTTPS | 共享 Caddy 入口，清读路径 `/qingread/`；根路径返回空白 404，不展示项目 |
| 应用入口 | Compose 私有网络 `qingread:8787` |
| 资源上限 | 应用 384 MiB / 0.75 CPU；Caddy 128 MiB / 0.25 CPU |
| 书源访问 | 显式 `QINGREAD_PUBLIC_ACCESS=true`、访问码留空 |
| 个人数据 | 用户名与密码注册，书架、进度、EPUB/PDF/TXT 按账号隔离 |
| 云文件配额 | 单本 250 MiB、每账号 2 GiB、总计 10 GiB，预留 5 GiB 磁盘 |
| 个人 Android 包 | 0.9.0 / versionCode 7，CI、固定升级证书与公网下载校验通过 |

前端在开发电脑编译，生产服务器不执行 npm 安装或前端编译。0.9.0 的依赖与 0.8.1 相同，锁文件仅更新项目版本；以当前运行实例已有修复的镜像为底，只 COPY `server/cloud.ts`、`server/app.ts`、`package.json` 和锁文件。构建禁用网络，没有 RUN 或 npm 步骤。子路径网页单独上传至静态版本目录，不依赖应用镜像内的旧 dist。保留上一镜像、上一静态目录和升级前私有配置供回滚。原有 TCP 80 服务和其他 Compose 项目保持独立。运行日志过滤 `X-QingRead-Token` 与 `Authorization`，不得公开展开后的 Compose 配置或私有环境文件。

共享 Caddy 已包含其他应用的路由和监听端口。**不要用仓库的独立主机 Caddyfile 或 Compose 覆盖生产配置**，也不要重新创建 HTTPS 容器来发布清读的网页更新。

## 必须保留的数据

| 路径 | 内容 |
|---|---|
| `.env` | 私有部署参数，权限 600 |
| `app-data/accounts.sqlite` 及 WAL/SHM | 账号、密码哈希、会话哈希、书架、进度、云文件索引 |
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

## 0.9.0 更新验证

API/Web 已更新至 0.9.0。仅重建清读应用容器，Caddy 与 Compose 未改；网页发布到 `downloads/sites/qingread-090-final-20261022/` 并切换 `qingread-current`，保留旧版用于回滚。已清除本次上传暂存和被最终补丁替代的中间静态目录，保留上一回滚版本和升级备份。账号数据库、原文件与证书未迁移或清理。根地址继续为空白 404，不提供导航；清读仍从 `/qingread/` 访问，现有原生客户端继续使用 `/api/`。

本地完整 Web/API 测试为 112 通过、4 个实时来源测试跳过，根路径和子路径生产构建均通过。原生 6 项新增 XCTest、34 项既有 Swift Testing、存储与工作流自检、阅读器回归及模拟器／真机构建通过。

最终 iPhone 补丁已完成严格签名校验、保留数据覆盖安装及续签运行副本更新。真机已启动，已安装版本为 0.9.0/build 11。最终检查所有六个容器运行、无 OOM，课程签到与私人面板入口正常；清读约 160 MiB / 384 MiB，主机可用内存约 1 GiB、磁盘余量约 24 GiB。共享 Caddy 与两个 QQ 容器的 ID、启动时间未变。课程和面板在验证时已由并行维护更新为新容器，均运行正常；清读本次发布没有执行这些服务的更新命令。[Android 0.9.0 CI](https://github.com/SakuraWang6/QingRead/actions/runs/39793668067) 的测试、编译与 lint 日志已核对。固定证书 v2/v3 签名、版本、ZIP 完整性和公网 latest APK 的 SHA-256 校验均通过。Android 尚无模拟器或真机运行结论。

0.8.1 的既有账号、文件同步与固定证书分发已验证，本轮不将它们当作 0.9.0 APK 的验证结果。个人数据和网站章节缓存的边界保持不变；追更状态与下载队列保存在各设备的独立账号配置中。

## 共享入口路由修复（2026-10-22）

原 HTTPS 根路径的 catch-all 指向清读，导致服务器 IP 直接显示阅读器。现已将清读限定在 `/qingread/`，课程系统继续使用自身路径，两者各自分享链接。根路径与 `/index.html` 返回空白 404，不提供导航或项目列表；私人服务保留原地址与端口。其他未匹配的页面也返回 404，不再兜底到清读。

静态网页在开发电脑以 `QINGREAD_WEB_BASE=/qingread/` 构建，上传到 `downloads/sites/` 的版本目录，由 Caddy 只读提供。新 PWA scope、启动地址、PDF 辅助资源均限定在 `/qingread/`，原 `/sw.js` 提供注销脚本以处理旧根路径缓存，不删除用户存储。`/api/` 保留以兼容已安装的 iPhone / Android；课程系统更具体的 API 前缀先匹配。旧根静态资源暂留供已打开的旧网页使用。

共享 Caddy 配置已经包含其他项目维护的规则。此前入口修复仅热更新路由和静态网页，没有更换镜像或重启业务容器；路由拆分与撤掉导航的备份分别位于实例私有 `backups/routing-20261022/`、`backups/no-portal-20261022/`。后续部署需保留 `downloads/sites/`、全部共享路由、原端口及已有基础镜像修复。见[多项目部署与 PWA 迁移](shared-host/README.md)。

当时验证：子路径与默认根路径构建均通过；连接、静态服务、文件解析、启动相关 31 项测试通过（启动测试在允许本机监听的环境复跑）。浏览器实际完成旧根缓存退出、清读书架和课程访问验证页加载，清读手机 390×844 布局正常，原本机两本书仍在。撤掉导航后，根地址与 `/index.html` 均返回 404、正文 0 字节；两个分享入口、私人面板、清读健康与旧 PWA 注销脚本仍正常响应。PWA manifest / worker、PDF cmap、APK 下载均已验证。该次路由调整前后全部 6 个容器的 ID 和启动时间未变，无 OOM；这份历史记录不替代本轮 0.9.0 应用更新后的状态对比。
