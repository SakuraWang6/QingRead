# 本地维护与清理

当前 Web / Android 使用已部署的 HTTPS 服务，免访问码直接连接。清理本机的构建缓存不会影响服务器；当前维护版本和运行参数见 [部署记录](../web/deploy/DEPLOYMENT.md)。

## 必须保留

| 路径或环境 | 用途 |
|---|---|
| `.private/android-signing/` | 固定 Android 测试签名；覆盖升级需要同一密钥，不能重新生成替代 |
| `.private/backups/` | 历次 iPhone 阅读数据备份，已从临时构建目录移入 |
| `.private/server/production.env` | 本机保管的服务器部署参数，当前显式启用公共访问 |
| `Config/local.xcconfig` | 本机 iOS 签名配置，不提交 Git |
| `work/signing-backup/` | 原生 iOS 续签基线，由维护脚本使用，不能当普通临时文件删除 |
| `.build/device/Build/Products/Debug-iphoneos/QingRead.app` | 当前签名应用，安装或重新配置后台续签时可复用 |
| `~/Library/Application Support/QingReadRefresh` | 独立后台续签运行副本及签名基线，不依赖仓库编译缓存 |
| `~/Library/LaunchAgents/app.qingread.refresh.plist` | 当前 Xcode 自动续签任务 |

以上私有文件仍被 Git 忽略。Apple 账号、钥匙串、服务器 SSH 私钥及手机/模拟器里的阅读数据不属于构建垃圾；本次没有删除这些内容。

## 可重新生成

Swift 模块缓存、除当前签名应用之外的旧 `.build` 产物、临时抓取页面、旧下载和测试日志可在对应任务结束后清理。不要直接删除整个 `work/` 或 `.build/`：先检查上表中的签名基线、当前应用和备份是否需要保留。

Web 依赖 `web/node_modules` 保留供继续开发。`web/dist`、`web/public/pdfjs`、Vite 缓存都是生成文件，首次运行 `npm run dev` 或 `npm run build` 时会按项目脚本重建资源。生产本地预览需先执行 `npm run build` 再运行 `npm start`；日常开发运行 `npm run dev`。

2026-10-20 已移除约 3.46 GiB 的本地中间产物，保留当前签名 APK、iOS 应用和必要开发工具。删除了三个旧 QingRead Docker 镜像；没有全局执行 Docker prune，也没有清理其他项目镜像或共享构建缓存。

AltServer 路线已停用，本机 App 及配置已移入废纸篓，可恢复。当前续签使用 Xcode，参见 [续签说明](sideloading.md)；Xcode 和自动续签任务保留。

服务器当前只保留正式配置、证书目录、发布 APK、运行镜像和上一版回滚镜像。清理上传压缩包和 HTTPS staging 目录，不删除正式 `caddy-data` / `caddy-config`，不操作其他服务。

部署时若需让 Mac 的 SSH 绕开本机 VPN 虚拟路由，可使用已保存的 `scripts/ssh-en0-connector.py` 作为 `ProxyCommand`；脚本仅用于当前 Mac 的物理 `en0` 接口连接，不会修改系统路由或服务器网络。
