# 清读 · QingRead

面向 iPhone、Web 和 Android 的免费无广告阅读器，支持多源搜书、EPUB / PDF / TXT、离线阅读与自建服务器同步。

[开始使用](#开始使用) · [自建服务器](web/deploy/README.md) · [文档](docs/README.md) · [反馈问题](https://github.com/SakuraWang6/QingRead/issues)

## 界面预览

iPhone 原生与 Web 0.10 的实际分类页，截图中可见封面均已加载。

<table>
  <tr>
    <th>iPhone · 分类</th>
    <th>Web · 手机分类</th>
  </tr>
  <tr>
    <td align="center"><img src="docs/previews/iphone-categories.png" alt="iPhone 0.10 玄幻奇幻分类，九张真实封面已加载" width="260" /></td>
    <td align="center"><img src="docs/previews/web-mobile-categories.jpg" alt="Web 0.10 修真武侠分类，六张真实封面已加载" width="260" /></td>
  </tr>
</table>

[截图与版本信息](docs/previews/README.md)

## 核心功能

- **搜书与发现**：多来源搜索、文学与开放教材、完结书单、作者作品。
- **阅读与听书**：滑动、覆盖、滚动翻页，调整字号、行距、段距与背景；系统语音与定时停止，iPhone 可选离线 AI 音色。
- **追更与离线**：新增章节提醒、换源保留进度、自动预读、可暂停和重试的下载管理。
- **书架与同步**：置顶、分组、在读／待读／读完；自建服务同步书架、阅读位置、笔记与原文件，账号各自隔离。
- **书签与搜索**：引用正文记笔记、搜索本机已缓存正文，PDF 支持页书签与本地文字搜索。
- **电子书**：EPUB 默认文字阅读，可进入「原版」查看插图、层级标题与脚注；PDF 保留页面图表，TXT 按章节阅读。

## 平台

| 平台 | 使用方式 | 说明 |
| --- | --- | --- |
| iPhone | SwiftUI 原生 App | PDFKit、系统后台传输、可选离线 AI 听书；通过 Xcode 构建安装 |
| Web | 手机或桌面浏览器 | 移动端布局、PWA、可选 Web Push 与云端准备章节 |
| Android | Capacitor App | 复用 Web 阅读器，接入前台下载服务、WorkManager、系统返回键与 KeyStore |

后台能力由系统控制：iPhone 免费个人签名不支持原生 APNs，远程推送请使用 iOS 16.4+ 的主屏幕 PWA，并登录、主动授权。浏览器关闭后，云端准备可继续，但需回到前台把正文保存到本机。Web / Android 听书使用系统语音；Android 尚无真机验证。详见[平台工作流](docs/reading-workflows.md)。

## 开始使用

### 本地运行 Web

需要 Node.js 24 与 npm：

```sh
git clone https://github.com/SakuraWang6/QingRead.git
cd QingRead/web
npm ci
npm run dev
```

打开 <http://127.0.0.1:5173>。命令会同时启动网页和书源服务；内置公版《桃花源记》，可直接体验阅读。

完整命令与浏览器说明见 [Web 指南](web/README.md)。

### 安装到手机

- **iPhone**：用 Xcode 打开 `QingRead.xcodeproj`，选择模拟器运行；真机安装需配置自己的 Apple Team，免费个人签名通常 7 天有效。见 [iPhone 构建](docs/development.md#iphone) 与 [签名和续签](docs/sideloading.md)。
- **Android**：按 [Android 指南](web/android/README.md) 构建 APK，或使用仓库的 Android debug APK 工作流。长期分发需自行保管固定签名。

### 开启跨设备同步

按 [部署指南](web/deploy/README.md) 自建 HTTPS 服务，让各设备连接同一服务器并登录同一账号。书架、整理状态、当前位置、书签笔记与 EPUB / PDF / TXT 原文件会同步，朋友使用独立账号即可分别保存数据。同步范围、冲突处理及备份见 [云同步说明](docs/cloud-sync.md)。

项目不预设公共共享服务器；不登录时，书架和文件保存在当前设备。

## 书源与文件

内置来源涵盖网络小说、经典文本、公版电子书与开放教材。来源列表、规则格式和验证范围见 [书源说明](docs/sources.md)。原站改版、限流或网络问题可能影响搜索与下载；已缓存正文仍可继续阅读。

EPUB 默认使用文字模式续读，并提供「原版」入口；原版禁止作者脚本和外部资源，特殊排版可能与出版者阅读器不同。PDF 暂不支持听书与图片文字识别（OCR）。加密或 DRM 文件不在当前支持范围内。

## 项目结构与文档

| 路径 | 内容 |
| --- | --- |
| `App/` | iPhone 原生界面、阅读器、书架与听书 |
| `Sources/ReadingCore/` | 书源模型、网络请求、搜索与正文解析 |
| `Sources/ReadingProbe/` | 实际书源链路检查工具 |
| `Tests/` | Swift 核心回归测试 |
| `web/` | Web 界面、API、账号同步与 Android 工程 |
| `scripts/` | 工程生成、诊断、签名与维护工具 |
| `docs/` | 使用、开发、部署及验证文档 |

- [文档导航](docs/README.md)
- [开发与验证](docs/development.md)
- [追更、换源与下载](docs/reading-workflows.md)
- [书架、笔记与电子书](docs/reading-tools.md)
- [已测范围与已知限制](docs/verification.md)
- [本地维护与清理](docs/maintenance.md)
- [问题反馈](CONTRIBUTING.md)

## 许可

本项目采用 [Polyform Strict 1.0.0](LICENSE)。第三方依赖与模型的许可见 [许可说明](docs/licensing.md)。
