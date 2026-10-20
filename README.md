# 清读 · QingRead

免费的原生 iPhone 阅读器。输入书名搜书，把找到的作品加入书架，安静地读下去。

SwiftUI / iOS 16+ / 本地优先 / 无账号 / 无广告 SDK / 无会员与内购。

## 当前功能（0.2）

- 多来源搜索，来源失败分别显示；可以启用、停用和导入书源。
- 三列封面书架，点击直接继续阅读，长按查看详情或管理。
- 推荐与六类书库，实时读取来源站书目，可打开目录、收藏和阅读。
- 点击正文中央呼出菜单；左右滑动、覆盖翻页、上下滚动三种模式。
- 五种背景、独立夜间模式、字号、行距、页边距、字体、粗体及亮度设置。
- 目录跳章、文字位置恢复；从屏幕左右边缘向内滑动退出阅读。
- 系统中文听书、暂停、语速、段落与章节切换，支持后台音频和锁屏控制。
- 按章节缓存正文，已读缓存可离线打开；清除缓存保留书架与进度。
- 内置《桃花源记》离线样例，便于在网络不可用时体验阅读器。

内置 7 个来源（5 个网络小说站点与 2 个经典文本来源）；已针对《超神机械师》《这游戏也太真实了》核实站内搜索、目录和首章。各新增来源的实测记录见[书源说明](docs/sources.md)。站点可用性与内容质量仍需持续验证，**不承诺全网覆盖或每一章均已核对**。通用网站来源通过声明式 CSS 规则扩展，本地样例不插入联网搜索结果。推荐与分类当前来自笔趣阁，停用该来源后不会继续请求。

## 开发和运行

需要完整 Xcode 16 或以上、iOS 16 或以上的模拟器或设备。仅 Command Line Tools 可以验证解析核心，无法编译 iOS 界面。

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

本机已通过官方 Xcode 工具完成真正的无线续期：新签发时间和到期时间均延后，严格校验签名后无线安装成功。提供 Mac 用户后台任务，每四小时检查、剩余三天内尝试续签，不需要 AltStore。Mac 需登录 Xcode 账号并能通过网络连接手机；本次校园网无法互通，个人热点实测可用。安装、停止和日志见[无线续签](docs/sideloading.md)。免费签名仍为 7 天，断网、Mac 关机或账号需要重新验证时可能刷新失败。

重新生成工程（新增或删除 App Swift 文件后运行）：

```sh
python3 scripts/generate-project.py
```

核心测试与真实网络检查：

```sh
swift test
swift run reading-probe 三國演義
swift run reading-probe --source biequgei 这游戏也太真实了
swift run reading-probe --discovery
```

本机只有 Command Line Tools 时，使用 `bash scripts/verify-core.sh`；脚本会为该环境配置 Swift Testing 的框架搜索路径，所有缓存保留在仓库 `.build` 中。

`reading-probe` 会真正访问来源，并依次验证搜索、目录和第一章；网络或解析失败会返回非零退出码，不回退为示例数据。`--source` 可限定内置来源的 ID；`--discovery` 会验证推荐、六类书目和推荐首本书的目录与正文。

无签名模拟器构建：

```sh
xcodebuild build -project QingRead.xcodeproj -scheme QingRead \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath .build/xcode ARCHS=arm64 ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO
```

Debug 构建支持 `--qingread-preview search|sources|reader|recommendations|categories`；`reader` 打开真实的本地公版样例。可追加 `--reader-mode slide|cover|scroll`、`--reader-controls`、`--reader-settings`、`--reader-night`、`--reader-listen`。`--reader-self-test` 在 UIKit 中验证旧设置迁移、含 emoji 的分页完整性、字号重排锚点及停止取消续播意图。Release 不包含这些诊断入口。`scripts/simulator-preview.py` 保存实际模拟器截图。

## 仓库结构

| 目录 | 职责 |
| --- | --- |
| `App/` | SwiftUI 界面、阅读进度、书架与本机缓存 |
| `Sources/ReadingCore/` | 来源模型、网络请求、并发搜索和正文解析 |
| `Sources/ReadingProbe/` | 真实网络端到端检查工具 |
| `Tests/ReadingCoreTests/` | 确定性解析与搜索行为测试 |
| `docs/` | 竞品研究、架构、书源格式与验证记录 |

## 书源和限制

第一版使用自己的声明式书源格式；不能宣称完整兼容安卓阅读／Legado 的 JSON 与 JavaScript 引擎。已有阅读书源通常需要改写，复杂登录、动态网页、验证码与多页目录还需要后续适配。

Z-Library 当前未接入在线搜书或章节阅读；它属于整本电子书检索和文件下载服务，本轮没有确认可信的匿名章节接口，未添加空配置。

来源的可访问性取决于网络，网站改版可能使规则失效。首版优先让失败原因可见，并保留已经缓存的章节。软件许可与各来源文本的许可是两回事，原始出处始终保留在作品资料中。

## 研究和验证

- [竞品研究](docs/market-research.md)
- [架构与首版决策](docs/architecture.md)
- [书源格式](docs/sources.md)
- [验证记录](docs/verification.md)
- [无线续签](docs/sideloading.md)

实际 iPhone 模拟器截图：[书架](docs/previews/library.png) · [搜书](docs/previews/search.png) · [书源](docs/previews/sources.png) · [阅读器](docs/previews/reader.png)。阅读器截图使用随包提供的公版样例，不是虚构网络结果。

本地 iPhone 17 已验证两本用户书单的搜索、目录、首章及重启后继续阅读，见[本地书架截图](docs/previews/local-library.png)。

独立实现，参考竞品的产品行为，没有复制竞品客户端源码。代码采用 MIT 许可，HTML 解析依赖 SwiftSoup（MIT）。
