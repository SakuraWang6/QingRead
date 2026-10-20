# 清读 · QingRead

免费的原生 iPhone 阅读器。输入书名搜书，把找到的作品加入书架，安静地读下去。

SwiftUI / iOS 16+ / 本地优先 / 无账号 / 无广告 SDK / 无会员与内购。

## 第一版范围

- 多来源搜索，来源失败分别显示；可以启用、停用和导入书源。
- 书籍目录、逐章阅读、书架和继续阅读。
- 日夜阅读主题、字号和行距设置。
- 按章节缓存正文，已读缓存可离线打开；清除缓存保留书架与进度。
- 内置《桃花源记》离线样例，便于在网络不可用时体验阅读器。

当前内置在线来源面向中文经典文本，**还不是覆盖热门连载小说的小书亭替代品**。通用网站来源通过声明式 CSS 规则扩展。不会把本地样例或虚构数据当成联网搜索结果。

## 开发和运行

需要完整 Xcode 16 或以上、iOS 16 或以上的模拟器或设备。仅 Command Line Tools 可以验证解析核心，无法编译 iOS 界面。

1. 打开 `QingRead.xcodeproj`，选择 `QingRead` scheme。
2. 先选择 iPhone 模拟器运行，无需付费开发者账号。
3. 真机运行时，在 Signing & Capabilities 中选择自己的 Team，并将 Bundle Identifier 改成唯一值。
4. 连接 iPhone，按系统提示信任设备并启用开发者模式，然后运行。

普通 Apple 账号可以安装自用，签名有效期为 7 天。付费 Developer Program 可使用更长有效期的签名。项目不包含签名证书、账号凭据或开发团队标识。

重新生成工程（新增或删除 App Swift 文件后运行）：

```sh
python3 scripts/generate-project.py
```

核心测试与真实网络检查：

```sh
swift test
swift run reading-probe 三國演義
```

本机只有 Command Line Tools 时，使用 `bash scripts/verify-core.sh`；脚本会为该环境配置 Swift Testing 的框架搜索路径，所有缓存保留在仓库 `.build` 中。

`reading-probe` 会真正访问来源，并依次验证搜索、目录和第一章；网络或解析失败会返回非零退出码，不回退为示例数据。

无签名模拟器构建：

```sh
xcodebuild build -project QingRead.xcodeproj -scheme QingRead \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath .build/xcode CODE_SIGNING_ALLOWED=NO
```

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

来源的可访问性取决于网络，网站改版可能使规则失效。首版优先让失败原因可见，并保留已经缓存的章节。软件许可与各来源文本的许可是两回事，原始出处始终保留在作品资料中。

## 研究和验证

- [竞品研究](docs/market-research.md)
- [架构与首版决策](docs/architecture.md)
- [书源格式](docs/sources.md)
- [验证记录](docs/verification.md)

独立实现，参考竞品的产品行为，没有复制竞品客户端源码。代码采用 MIT 许可，HTML 解析依赖 SwiftSoup（MIT）。
