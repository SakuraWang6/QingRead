# 开发与验证

[文档导航](README.md) · [项目首页](../README.md)

## iPhone

以下 iPhone 和 Swift 命令均在仓库根目录执行。Web 与 Android 的命令分别见本文后续入口。

当前 iPhone 源码版本为 0.12.2 / build 18；真机安装与续签基线以[验证记录](verification.md)为准。需要完整 Xcode 16 或以上、iOS 16 或以上的模拟器或设备。仅 Command Line Tools 可以验证解析核心，无法编译 iOS 界面。

1. 打开 `QingRead.xcodeproj`，选择 `QingRead` scheme。
2. 先选择 iPhone 模拟器运行，无需付费开发者账号。
3. 真机运行时，在 Signing & Capabilities 中选择自己的 Team，并将 Bundle Identifier 改成唯一值。
4. 连接 iPhone，按系统提示信任设备并启用开发者模式，然后运行。

本机签名设置也可以保存在 `Config/local.xcconfig`，工程会自动读取，该文件已被 Git 忽略：

```xcconfig
DEVELOPMENT_TEAM = 你的TeamID
```

若默认 Bundle Identifier 已被占用，也可在同一文件覆盖 `PRODUCT_BUNDLE_IDENTIFIER`。

普通 Apple 账号可以安装自用，签名有效期为 7 天。付费 Developer Program 可使用更长有效期的签名。项目不包含签名证书、账号凭据或开发团队标识。

后台续签的条件、配置和限制见 [签名与续签](sideloading.md)。

## 工程生成

新增或删除 App Swift 文件后，重新生成工程：

```sh
python3 scripts/generate-project.py
```

## Swift 核心与书源检查

在仓库根目录运行：

```sh
swift test
swift run reading-probe 三國演義
swift run reading-probe --source biequgei 这游戏也太真实了
swift run reading-probe --discovery
```

可统一使用 `bash scripts/verify-core.sh`；完整 Xcode 环境默认运行 Swift Testing 与 XCTest。只有 Command Line Tools 时，脚本才禁用不可用的 XCTest，并配置 Swift Testing 框架搜索路径；缓存保留在仓库 `.build` 中。

`reading-probe` 会真正访问来源，并依次验证搜索、目录和第一章；网络或解析失败会返回非零退出码，不回退为示例数据。`--source` 可限定内置来源的 ID；`--discovery` 会验证推荐、六类书目和推荐首本书的目录与正文。

## 模拟器构建与诊断

无签名模拟器构建：

```sh
xcodebuild build -project QingRead.xcodeproj -scheme QingRead \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath .build/xcode ARCHS=arm64 ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO
```

Debug 构建支持 `--qingread-preview search|sources|reader|recommendations|categories`；`reader` 打开真实的本地公版样例。可追加 `--reader-mode slide|cover|scroll`、`--reader-controls`、`--reader-settings`、`--reader-catalog`、`--reader-audio`、`--reader-night`、`--reader-listen`、`--reader-ai`。`--reader-self-test` 验证排版和语音状态；`--storage-self-test`、`--cover-self-test` 验证隔离存储与图片缓存；`--kokoro-self-test` 验证 Kokoro 男、女声合成与跨段播放；`--ai-self-test` 验证声库校验及已有模型的真实合成，显式附加 `--download-ai-model` 才会为诊断下载声库。Release 不包含这些入口。`scripts/simulator-preview.py` 运行确定性诊断并保存九张真实界面截图。

## Web 与 API

需要 Node.js 24。日常运行、生产预览及环境配置见 [Web 指南](../web/README.md)。

```sh
cd web
npm ci
npm test
npm run build
```

常规测试使用本地样例与模拟响应，不依赖书源在线。真实来源检查需显式启用，命令见 Web 指南。账号数据库、文件与部署参数的维护见 [服务端说明](../web/server/README.md) 和 [部署指南](../web/deploy/README.md)。

`tests/fixtures/workflow-preview.ts` 是仅本机使用的虚构书源服务，监听固定 `127.0.0.1:8791`，提供章节追加与指定失败控制，便于检查追更、换源和暂停。它不读真实账号、不请求外网，也不能作为生产书源部署；运行前先以默认根路径构建 Web，然后在 `web/` 执行 `node --import tsx tests/fixtures/workflow-preview.ts`。

## Android

Android 与 Web 共用界面代码。SDK、Java、Gradle、Capacitor 同步及固定签名要求见 [Android 构建指南](../web/android/README.md)。公开 CI 使用临时调试签名，个人证书、keystore 和账号数据保留在私有环境。

## HarmonyOS

鸿蒙版在 `harmony/` 使用 ArkTS Stage 和 ArkWeb，打包同一套 Web 阅读界面。目标 SDK 为 26.0.0 Release，最低兼容 HarmonyOS 5.0（API 12）。官方工具、离线资源生成、编译及签名步骤见 [HarmonyOS 构建指南](harmony-build.md)；系统能力与未验证项见 [原生工程说明](../harmony/README.md)。当前尚无可安装的已签名 HAP。

## 验证与维护

运行命令、已完成检查和设备限制分别保留在上述指南与 [验证记录](verification.md)。清理缓存前先阅读 [维护说明](maintenance.md)，保留当前签名应用、续签基线、电子书与账号数据。
