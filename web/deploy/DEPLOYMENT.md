# 部署维护基线

当前客户端源码为 0.12.2，API 接口版本保持 0.10.0。客户端静态发布不需要更换 API 镜像；修改服务器书源或解析时，按本文「API 更新与连接」单独构建并仅重建清读服务，不改共享 Caddy。客户端发布状态见[项目验证](../../docs/verification.md)，新增文学来源与旧版 iPhone 导入方式见[书源说明](../../docs/sources.md)。

地址示例使用 `https://read.example.com`，部署者应替换为自己的主机；仓库没有默认公共共享服务器。

## 运行配置

| 项目 | 配置 |
| --- | --- |
| 平台 | Ubuntu、`linux/amd64` Docker 镜像 |
| 目录与 Compose 项目 | `/srv/qingread`，项目 `qingread` |
| API 镜像 | `qingread-web:0.10.0` 基线及已验收的书源补丁；实际标签以私有 `.env` 的 `QINGREAD_IMAGE` 为准 |
| Web 发布 | `downloads/sites/` 中的版本目录，由 `qingread-current` 指向当前版本 |
| 共享入口 | 清读只使用 `/qingread/`；根路径空白 404，其他项目保持各自路由与端口 |
| 私有应用入口 | `qingread:8787` |
| 资源上限 | 应用 384 MiB / 0.75 CPU；Caddy 128 MiB / 0.25 CPU |
| 书源访问 | 显式 `QINGREAD_PUBLIC_ACCESS=true`，是否启用访问码由部署者决定 |
| 账号数据 | 书架、进度、笔记、文件、恢复码与后台任务按账号隔离 |
| 文件配额 | 单本 250 MiB、每账号 2 GiB、总计 10 GiB，预留 5 GiB 磁盘 |
| Android 分发 | 私有环境使用固定证书签名，升级需保持同一包名与证书 |
| 独立下载服务 | 固定安装包清单，96 MiB / 0.15 CPU，仅对共享代理开放；[防护与统计说明](../downloads/README.md) |

共享 Caddy 包含其他应用的规则。**不要用仓库独立主机的 Caddyfile 或 Compose 覆盖生产配置**，也不要为了网页更新重新创建 HTTPS 容器。

## 必须保留

| 路径 | 内容 |
| --- | --- |
| `.env` | 私有部署参数，权限 600 |
| `app-data/accounts.sqlite` 及 WAL/SHM | 账号、密码与恢复码哈希、会话、书架、笔记、进度和文件索引 |
| `app-data/notifications.sqlite` | 私有推送订阅与选书状态 |
| `app-data/offline-jobs.sqlite`、`jobs/` | 云端准备任务及有限期正文暂存 |
| `app-data/files/` | 按账号存放的原文件，目录 700、文件 600 |
| `app-data/covers/` | 可重新获取的公共封面缓存 |
| `caddy-data/`、`caddy-config/` | HTTPS 证书与代理持久数据 |
| `downloads/` | 已验签 APK、当前与回滚静态目录、旧 PWA 兼容脚本 |
| `download-protection/config/manifest.json` | 已登记安装包、实际文件校验值与 latest 映射 |
| `download-protection/stats/` | 独立下载统计 SQLite、WAL/SHM，保留原启用时间与计数 |
| 私有备份目录 | 配置、一致的数据快照与发布前状态 |

不要只复制运行中的 SQLite 主文件。整库备份需使用一致快照，或低峰短暂停止清读服务后复制完整 `app-data` 并立即恢复；不停止其他项目。还原时使用同一份数据库及原文件目录。具体步骤见[部署说明](README.md)。

## 静态网页更新与回滚

在开发电脑使用 `QINGREAD_WEB_BASE=/qingread/ npm run build` 构建；Android 与鸿蒙使用默认根路径构建。服务器不安装 npm 依赖或编译前端。

1. 记录可用内存、磁盘、全部容器的 ID、启动时间、重启数、健康及 OOM 状态，保存共享 Caddy/Compose 哈希。
2. 上传到全新版本目录，逐文件核对大小与 SHA-256；保留旧目录，尚未完成的上传不可作为当前版本。
3. 仅更新网页时原子切换 `qingread-current`，无需重启容器。安装包按[客户端发布顺序](../../docs/app-updates.md#发布顺序与回滚)先登记并校验固定版本，再切换 feed 与 latest；只有独立下载服务需要在空闲时重启，API 镜像和业务容器保持原样。
4. 检查 `/qingread/`、manifest、worker、PDF 辅助资源、API 健康、原账号数据、其他项目入口及根路径 404。公网下载包需重新读取全字节校验。
5. 对比前后容器状态与共享配置哈希，除计划内下载服务重启外，其他容器保持不变。异常时将链接、发布清单及下载别名切回上一完整版本，保留统计。

清理仅处理本项目已确认不再使用的上传归档，保留当前与至少一个回滚版本。不删除数据、证书、卷，也不执行全局 Docker prune。

## API 更新与连接

仅在业务 API 确实变化时才构建新镜像、备份数据并更新清读容器；静态页面更新不走此流程。先校验私有配置，再执行 `docker compose up -d --no-deps qingread`；不得将共享 HTTPS 服务一起重建。日志应过滤访问码、Bearer 会话、恢复码和推送订阅密钥，私有配置不进入 Git。

Caddy 使用 Let's Encrypt `shortlived` 公网 IP 证书，经 TCP 443 的 TLS-ALPN 验证自动续期；保留证书目录与 443 入站规则，不接管其他监听端口。没有有效证书时不要绕过浏览器警告。

Mac 可用 `scripts/ssh-en0-connector.py` 作为 SSH `ProxyCommand`，仅将该连接绑定到当前 `en0`，不修改系统路由或代理书源。私钥在项目外自行保管。共享路由、旧 PWA 迁移与独立服务约定见[多项目部署](shared-host/README.md)。

## 验证边界

Web Push 只向主动订阅的登录账号开放，密钥仅放私有配置；服务端和设备网络可能影响送达。云端准备受全局单并发、账号配额和过期时间约束，不能替代原文件备份。见[推送](../server/PUSH.md)与[云端准备](../server/OFFLINE-JOBS.md)。

公开 Android CI 使用临时调试签名；个人固定证书只在私有环境使用。鸿蒙 HAP 目前未签名，真机安装需自行配置签名。未验证的真机、旧系统或系统后台调度不应描述为已通过。各端实际交付版本、编译和运行证据统一记录在[项目验证](../../docs/verification.md)。
