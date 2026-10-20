# 首版验证记录

日期：2026-10-20。

## 已完成

- 使用 Swift 6.4 Command Line Tools 构建 ReadingCore 与 reading-probe。
- `bash scripts/verify-core.sh`：13 个 Swift Testing 测试全部通过。涵盖 HTML 搜索→独立目录→正文、段落与去重、UTF-8/GBK、查询词编码、规则导入、HTTP/API 错误、来源隔离、取消和慢源未完成时先发布快源结果。
- `swiftc -frontend -parse App/*.swift App/Views/*.swift`：8 个界面源码文件语法解析通过。这不是 iOS 类型检查或运行测试。
- Xcode 工程 plist 语法检查通过，工程生成器无需外部依赖。
- 真实网络 `reading-probe 三国演义`：退出码 0，搜索 21 个结果（精选 1、本次维基 20），获取 120 章目录，首章正文 20 段。
- 真实网络 `reading-probe 桃花源記`：退出码 0，搜索 20 个结果，单章目录，正文 22 段。
- 用户书单：笔趣阁·biequgei 使用实际 Swift URLSession 验证《超神机械师》1493条目录／首章102段，《这游戏也太真实了》1106条目录／首章98段。连续查询曾短暂为空，重试恢复；没有逐章抓取全书验证。
- 新默认适配 `reading-probe --source woshuge 超神机械师`：退出码0，目录1463章，首章97段。
- 新默认适配 `reading-probe --source biequgei 这游戏也太真实了`：退出码0，搜索精确结果1条、目录1106章、首章98段。
- 独立静态复核后，已修复慢来源阻塞搜索、关闭目录误打开旧章、缓存写入失败阻止阅读及批量缓存误报成功问题。

本机 CLT 的 Swift Testing 需要额外框架路径和 native build-system；验证脚本对这个环境做了适配。测试出现 native build-system 弃用和 Testing.framework 最低 macOS 版本的工具链警告，不影响本次通过结果。

## iOS 构建和界面

本机现已安装 Xcode 27.1，并在 iOS 27.0 的专用 iPhone 17 模拟器中完成无签名构建、安装和运行。通过实际界面验证《超神机械师》1493章目录与首章、《这游戏也太真实了》1106章目录与首章；两本书已加入书架，各缓存首章，重新启动应用后书架及阅读进度保留。首次安装后运行库曾重新挂载，重连 CoreSimulator 后恢复。此次还修复了书架中自定义箭头与系统 NavigationLink 箭头重复显示的问题。[本地书架截图](previews/local-library.png)来自此次运行。

GitHub Actions 此前已通过核心测试、无签名 iPhone 模拟器构建和安装启动。已实际检查书架、搜书、书源、阅读器四张模拟器截图，修复了标题截断、List白底和正文的重复段落空行；Debug 预览参数也已启用正确的编译条件。

截图来自实际原生界面，见 [书架](previews/library.png)、[搜书](previews/search.png)、[书源](previews/sources.png)、[阅读器](previews/reader.png)。它们不是 HTML 设计稿或手绘效果图。首版代码 `d34f2d3` 的[完整 GitHub Actions 验证](https://github.com/SakuraWang6/QingRead/actions/runs/39386533440)已成功：13个测试通过、iPhone模拟器构建通过、安装启动与四页截图成功。模拟器截图在一次实际启动后保存，不能代替真机交互和长期阅读测试。

## 真机安装

已在 iPhone 17（iOS 26.6.1）完成 Personal Team 免费签名、签名校验、描述文件设备匹配校验和实际安装。用户开启开发者模式并信任个人开发签名后，`devicectl` 已成功启动 `app.qingread.personal`。签名配置通过被 Git 忽略的 `Config/local.xcconfig` 保留在本机；证书、描述文件、Team ID 和设备标识未提交。

此项验证覆盖签名、安装和启动；真机联网搜书、长期阅读和离线使用仍需继续体验。

## 尚需验证

- 真机文字位置恢复、后台切换、字号和行距调整、离线缓存、窄屏与辅助功能。
- 更广泛的现代网文来源、章节完整性与连续查询稳定性；目前仅针对用户两本书验证了目录和首章。
- 中文维基文库的全文搜索可能返回判决书等非小说文本，搜索结果相关性仍需改进。
- 自定义网站的多页目录、登录与动态网页不是首版支持范围。
- 模拟器构建不包含签名；安装到用户真机还需要在 Xcode 选择自己的 Apple Team。
