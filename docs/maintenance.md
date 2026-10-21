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


## 开源后的签名与同步数据

公开仓库及公共 CI 不保存个人签名 Secret。固定 Android keystore 只保留在 `.private/android-signing` 与用户自己的私有备份，个人升级安装包仍用原证书；公开 CI 产物用临时调试签名，不能据此覆盖个人包。iPhone 签名设置留在忽略的 `Config/local.xcconfig`，当前 iPhone 应用与后台续签副本均为 0.8.2/build 10。

服务器 `app-data` 保存持久化账号、书架数据库和 `files` 原文件，清理时必须完整保留；`caddy-data` 是证书，`caddy-config` 是代理配置，也必须保留。只删除已成功加载且有原镜像可回滚的 incoming 安装归档和确认可重建的本机构建缓存。`.private/backups/phone-before-sync-06` 保存同步升级前的手机数据，不进入 Git。


## 0.7 后的清理边界

- 可清理 `.build/out`、真机构建的 `Intermediates.noindex`、索引、日志和编译模块缓存；保留 `SourcePackages` 与当前 `Build/Products/Debug-iphoneos/QingRead.app`。
- 语音推理依赖、`web/node_modules` 是仍在使用的开发依赖，不按临时下载处理。全局 Docker 构建缓存还被其他项目使用，不做全局清空。
- 临时页面、封面测速副本、设备枚举和一次性部署脚本完成任务后移除；验证结论保留在 [验证记录](verification.md)。
- 当前交付件保留在工作区 outputs；较早截图、试听和旧版 APK 归档，服务器连接参数和设备日志进入私有目录。
- `.private` 目录权限应为 700，签名配置与密钥文件为 600。整理后仍需检查当前 App 严格签名校验与后台续签任务。

## 阅读修复后的整理（2026-10-21）

Web/API 与 Android 为 0.8.1，iPhone 为 0.8.2/build 10。本轮专用模拟器的重复构建目录（约 1.2 GB）、未签名 APK、传输归档与临时测试数据库已清理，本地 8791 测试服务已停止；当前设备构建、独立续签副本、固定签名与手机数据备份保留。诊断日志位于忽略的 `.private/audit/reader-08`，旧安装包和截图保留在工作区归档中。
