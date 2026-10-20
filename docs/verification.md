# 首版验证记录

日期：2026-10-20。

## 已完成

- 使用 Swift 6.4 Command Line Tools 构建 ReadingCore 与 reading-probe。
- `bash scripts/verify-core.sh`：13 个 Swift Testing 测试全部通过。涵盖 HTML 搜索→独立目录→正文、段落与去重、UTF-8/GBK、查询词编码、规则导入、HTTP/API 错误、来源隔离、取消和慢源未完成时先发布快源结果。
- `swiftc -frontend -parse App/*.swift App/Views/*.swift`：8 个界面源码文件语法解析通过。这不是 iOS 类型检查或运行测试。
- Xcode 工程 plist 语法检查通过，工程生成器无需外部依赖。
- 真实网络 `reading-probe 三国演义`：退出码 0，搜索 21 个结果（精选 1、本次维基 20），获取 120 章目录，首章正文 20 段。
- 真实网络 `reading-probe 桃花源記`：退出码 0，搜索 20 个结果，单章目录，正文 22 段。
- 独立静态复核后，已修复慢来源阻塞搜索、关闭目录误打开旧章、缓存写入失败阻止阅读及批量缓存误报成功问题。

本机 CLT 的 Swift Testing 需要额外框架路径和 native build-system；验证脚本对这个环境做了适配。测试出现 native build-system 弃用和 Testing.framework 最低 macOS 版本的工具链警告，不影响本次通过结果。

## iOS 构建和界面

本机未安装完整 Xcode/iOS SDK，不能声称已在本机编译或运行 iPhone 界面。仓库配置了 GitHub Actions 的 macOS 验证：运行测试、构建无签名 iPhone 模拟器 App、安装启动并截取实际界面。其结果将随首次运行更新。

## 尚需验证

- 真机文字位置恢复、后台切换、字号和行距调整、离线缓存、窄屏与辅助功能。
- 用户常看的现代网文来源；目前内置源以经典文本为主，不能当作热门小说覆盖率验证。
- 自定义网站的多页目录、登录与动态网页不是首版支持范围。
- 模拟器构建不包含签名；安装到用户真机还需要在 Xcode 选择自己的 Apple Team。
