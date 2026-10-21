# 部署维护基线

更新于 2026-10-21（Asia/Shanghai），Web/API 版本 0.8.1，运行代码基线 `37955bc`。地址示例使用 `https://read.example.com`；部署者需替换为自己的主机，仓库没有默认公共共享服务器。

iPhone 原生版单独维护，当前为 0.8.2/build 10；原生阅读动画更新不改变服务器与 Android 的 0.8.1 版本号。

## 当前配置

| 项目 | 配置 |
|---|---|
| 平台 | Ubuntu、`linux/amd64` Docker 镜像 |
| 部署目录与项目 | `/srv/qingread`，Compose 项目 `qingread` |
| 应用镜像 | `qingread-web:0.8.1` |
| HTTPS | Caddy `2.11.7-alpine`，公网 TCP 443 |
| 应用入口 | Compose 私有网络 `qingread:8787` |
| 资源上限 | 应用 384 MiB / 0.75 CPU；Caddy 128 MiB / 0.25 CPU |
| 书源访问 | 显式 `QINGREAD_PUBLIC_ACCESS=true`、访问码留空 |
| 个人数据 | 用户名与密码注册，书架、进度、EPUB/PDF/TXT 按账号隔离 |
| 云文件配额 | 单本 250 MiB、每账号 2 GiB、总计 10 GiB，预留 5 GiB 磁盘 |
| 个人 Android 包 | 0.8.1 / versionCode 6，固定证书在私有环境签名 |

前端在开发电脑编译，生产服务器不执行 npm 安装或前端编译。0.8.1 与 0.7.0 的依赖和其余后端代码一致，核对锁文件后以现有 0.7.0 镜像为底，仅 COPY 编译后的 dist、健康版本信息和包元数据；禁用构建网络，没有 RUN 步骤。保留 0.7.0 镜像和升级前私有配置供回滚。原有 TCP 80 服务和其他 Compose 项目保持独立。运行日志过滤 `X-QingRead-Token` 与 `Authorization`，不得公开展开后的 Compose 配置或私有环境文件。

## 必须保留的数据

| 路径 | 内容 |
|---|---|
| `.env` | 私有部署参数，权限 600 |
| `app-data/accounts.sqlite` 及 WAL/SHM | 账号、密码哈希、会话哈希、书架、进度、云文件索引 |
| `app-data/files/` | 按账号存放的原文件，目录 700、文件 600 |
| `app-data/covers/` | 可重新获取的公共封面缓存 |
| `caddy-data/`、`caddy-config/` | HTTPS 证书与代理持久数据 |
| `downloads/` | 已验签的发布 APK；`QingRead-Android-latest.apk` 指向当前版本 |
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

验证健康接口的版本、账号隔离和下载后，复查容器健康、OOM 标记及原服务。回滚时将 `QINGREAD_IMAGE` 改为已保留的兼容版本，再执行同一条应用更新命令。不要删除 `app-data`、证书、卷或其他项目，也不要用旧的 0.5 镜像恢复当前同步功能。

清理只处理已加载成功的 `incoming` 安装归档和确认未被容器引用的过旧清读镜像，保留当前版本与一个回滚版本；不执行全局 Docker prune。

## HTTPS、连接与验证范围

Caddy 使用 Let's Encrypt `shortlived` 公网 IP 证书，通过 TCP 443 的 TLS-ALPN 验证并自动续期，不接管 80。保持 443 可访问，保留证书目录；没有有效证书时不要绕过浏览器警告。

Mac 上可用 `scripts/ssh-en0-connector.py` 作为 SSH 的 `ProxyCommand`，仅将连接绑定到当前 Mac 的 `en0`，不修改系统路由，也不代理书源流量。私钥由部署者在项目外自行保管。

本轮已验证的公网原文件隔离、跨会话续读、资源状态与 Android 构建记录见 [项目验证记录](../../docs/verification.md)。部分海外来源整本下载仍有连接重置，未继续排查；Android 尚无真机运行结论。

公开 CI 使用临时调试签名，不保存个人签名 Secret。长期分发的 APK 必须在私有环境使用固定证书签名，升级保持同一证书。早期临时签名包若无法覆盖升级，应先导出阅读备份并保留原文件，之后再处理卸载。

## 0.8.1 更新验证

公网 HTTPS 健康接口返回 0.8.1，来源列表接口正常返回 10 项，浏览器完成旧 PWA 更新。仅重建清读应用；更新后内存约 125 MiB / 384 MiB，清读及原有三个应用容器均健康、OOM=false。账号数据库、原文件和证书未迁移或清理。上传构建上下文与 APK 暂存已清除。

个人 Android 0.8.1 已通过 CI 测试、编译、lint、固定升级证书 v2 签名与 ZIP 校验；公网 latest 下载与本机包 SHA-256 相同。尚未在安卓设备运行。
