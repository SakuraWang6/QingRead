# 构建 HarmonyOS 版

清读鸿蒙版使用 ArkTS Stage 工程和 ArkWeb，打包同一套 Web 阅读界面。已使用官方 SDK 实际编译，并在 HarmonyOS 7.0.0（API 26）本地模拟器安装、运行未签名 HAP；尚未进行鸿蒙真机或旧系统验证，也没有自动构建鸿蒙安装包的 CI。工程入口和原生能力说明见 [harmony/README.md](../harmony/README.md)。

## 工具链

从[华为官方下载中心](https://developer.huawei.com/consumer/cn/download/)选择 macOS ARM 对应的 Command Line Tools，或安装 DevEco Studio。下载需要登录华为账号；按页面要求自行确认协议，并核对官方工具完整性校验值。Command Line Tools 包含 HarmonyOS SDK、Hvigor、ohpm 和 hdc，不需要用第三方 SDK 镜像。实测 macOS ARM 26.0.0.851 包未包含默认 `tool/node`，需通过 `DEVECO_NODE_HOME` 指向已有 Node.js 24。

当前工程依据 [26.0.0 Release 配套表](https://developer.huawei.com/consumer/en/doc/harmonyos-releases/deveco-studio-new-features-2600)，使用 `modelVersion: "26.0.0"` 和目标 SDK `26.0.0`，最低兼容版本保留 `5.0.0(12)`。选择官方下载中心当前提供的 26.0.0 Release 工具链补丁，使用包内配套的 SDK、Hvigor、ohpm；如果包内未提供 Node.js，按工具要求配置已有 Node.js 24，不混用其他补丁的工具组件。使用更高版本 API 时须检查兼容边界。[官方流水线说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-command-line-building-app)推荐 CLT 26 使用 JDK 21；可以复用已有 JDK 21，例如 IntelliJ IDEA 所带 JBR，无需重复安装。

在当前终端设置路径，不修改系统级 Java 或 Node 配置：

```sh
export JAVA_HOME="/absolute/path/to/jdk-21/Contents/Home"
export DEVECO_CLI_CLT_PATH="/absolute/path/to/command-line-tools"
export DEVECO_NODE_HOME="/absolute/path/to/node-24"
export DEVECO_SDK_HOME="$DEVECO_CLI_CLT_PATH/sdk"
export PATH="$JAVA_HOME/bin:$DEVECO_CLI_CLT_PATH/bin:$DEVECO_NODE_HOME/bin:$PATH"
java -version
node -v
ohpm -v
hvigorw -v
```

华为另提供 `@deveco/deveco-cli@stable` 统一命令入口，但它依赖已安装的 Studio / Command Line Tools，单独安装 npm 包不能代替 SDK。可选用 `DEVECO_CLI_CLT_PATH` 指定独立工具链；CLI 的 `create` 模板默认兼容版本不等于本工程的最低兼容版本。

Apple Silicon 可以使用[本地模拟器](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-emulator-requirements)，镜像和实例需另行下载、创建。官方列出最低 8GB 内存和 16GB 磁盘空间，建议 16GB / 32GB；真实下载、解压和构建仍需预留额外空间。没有华为手机时可以先验证模拟器，不能据此宣称已完成真机测试。

## 同步资源与编译

在仓库根目录安装 Web 锁定依赖，然后生成根路径资源：

```sh
cd web
npm ci
QINGREAD_WEB_BASE=/ npm run harmony:sync
cd ../harmony
ohpm install --all
hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
```

`harmony:sync` 先执行完整 Web 构建，再由 `scripts/prepare-harmony.py` 校验并复制离线资源。它拒绝 `/qingread/` 等前缀构建、缺失资源、符号链接、私有文件后缀及超限文件，生成资源清单和 SHA-256。不要手动把 `.env`、账号数据、证书或签名目录复制到 rawfile。生成的 Web 资源和构建产物不提交 Git。

2026-10-23 已使用官方 CLT 26.0.0.851 / Hvigor 6.26.8 实际编译出 `entry/build/default/outputs/default/entry-default-unsigned.hap`。该工具的模块 SemVer 检查拒绝主版本为 `0`，因而对 `0.x` 版本输出警告；未为消除警告而修改版本或厂商工具。未配置签名也会输出相应提示。当前源码为 0.12.0 / versionCode 2，原生能力与实际验证分别见[工程说明](../harmony/README.md)和[验证记录](verification.md)。

在仓库根目录可运行不依赖鸿蒙 SDK 的检查：

```sh
python3 -m unittest discover -s scripts -p 'test_release_manifest.py' -v
python3 -m unittest discover -s scripts -p 'test_prepare_harmony.py' -v
node --test harmony/tests/*.test.mjs
```

## 本地模拟器

以下参数已对照实际 CLT 26.0.0.851 的 `Emulator -help` 核验。先查询镜像，再使用返回的完整 `osVersion`；本次测试值为 `HarmonyOS 7.0.0(26.0.0)`。镜像与实例目录使用独立目录，避免覆盖其他项目的模拟器。

```sh
export PATH="$DEVECO_SDK_HOME/default/openharmony/toolchains:$PATH"
QINGREAD_EMU_IMAGES="/absolute/path/to/qingread-images"
QINGREAD_EMU_INSTANCES="/absolute/path/to/qingread-instances"
QINGREAD_EMU_NAME="QingReadPhone"
QINGREAD_EMU_OS="HarmonyOS 7.0.0(26.0.0)"
QINGREAD_HAP="/absolute/path/to/QingRead/harmony/entry/build/default/outputs/default/entry-default-unsigned.hap"

mkdir -p "$QINGREAD_EMU_IMAGES" "$QINGREAD_EMU_INSTANCES"
Emulator -help
Emulator -imageList -deviceType phone -downloaded false
Emulator -install -deviceType phone -osVersion "$QINGREAD_EMU_OS" \
  -imageRoot "$QINGREAD_EMU_IMAGES"
Emulator -create "$QINGREAD_EMU_NAME" -deviceType phone \
  -osVersion "$QINGREAD_EMU_OS" -imageRoot "$QINGREAD_EMU_IMAGES" \
  -instancePath "$QINGREAD_EMU_INSTANCES" -memory 4 -storage 8
Emulator -start "$QINGREAD_EMU_NAME" -imageRoot "$QINGREAD_EMU_IMAGES" \
  -instancePath "$QINGREAD_EMU_INSTANCES" -bootMode coldboot

hdc list targets
QINGREAD_HDC_TARGET="<上一步列出的模拟器设备ID>"
hdc -t "$QINGREAD_HDC_TARGET" install "$QINGREAD_HAP"
hdc -t "$QINGREAD_HDC_TARGET" shell aa start \
  -a EntryAbility -b app.qingread.harmony -m entry
```

镜像下载与首次启动可能分别显示 SDK 许可、HarmonyOS 软件许可与服务协议，需使用者本人阅读并确认；不自动传入同意协议的参数。若所选镜像要求开发者账号授权或实名认证，应按官方界面完成，本次模拟器成功记录不代表所有镜像都免授权。具体命令见[官方模拟器 CLI 说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-emulator-command-line)。

本次已实际走通系统文件选择器导入 EPUB、PDF、TXT 并阅读，分类书目与封面显示、安装版本读取，以及覆盖安装后保留书架和阅读进度。未签名 HAP 可在**本次使用的模拟器**安装；此结论不适用于真机、其他系统版本或需要特殊签名的 Kit。旧系统、真机、耗电和后台运行仍需分别验证，交付范围见[验证记录](verification.md)。

## 签名与发布边界

未配置签名时只能得到未签名构建，不能承诺可以直接在朋友的手机安装。真机调试需要开发者账号申请的调试证书、Profile 与对应设备配置；上架或分发须按华为官方签名、分发流程处理。私有签名配置、`.p12`、`.cer`、`.p7b` 和本机路径保存在忽略目录，不写入源码或发布清单。

`harmony/AppScope/app.json5` 使用标准 JSON，包名固定为 `app.qingread.harmony`。发布清单生成器在该文件存在时验证版本与 AppInfo、iPhone、Web、Android 一致，验证 `versionCode` 为正整数且小于 2³¹，再写入 `platforms.harmony` 的版本、构建号和说明。该记录**不含 HAP 下载项**，也不表示已签名安装包可下载；旧工程没有此文件时继续生成原三端清单。

本地生成 HAP、更新版本清单都不需要更改服务器 API、数据库、容器或其他服务路由。实际静态发布顺序和回滚方式见[客户端更新说明](app-updates.md)。
