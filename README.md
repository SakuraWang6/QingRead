# 清读 · QingRead

面向 iPhone、Web 和 Android 的阅读器，支持多源搜书、EPUB / PDF / TXT、离线阅读与自建服务器同步。

把喜欢的书放进书架，在手机或浏览器里打开；换个设备，接着上次的位置读。

[开始使用](#开始使用) · [自建服务器](web/deploy/README.md) · [文档](docs/README.md) · [反馈问题](https://github.com/SakuraWang6/QingRead/issues)

## 界面预览

iPhone 0.8.2 原生 App（模拟器）与 Web 0.8.1 移动视口的实际截图。

<table>
  <tr>
    <th>iPhone · 书架</th>
    <th>iPhone · 阅读</th>
    <th>Web · 手机书架</th>
  </tr>
  <tr>
    <td align="center"><img src="docs/previews/iphone-library.png" alt="iPhone 0.8.2 三列封面书架" width="230" /></td>
    <td align="center"><img src="docs/previews/iphone-reader.png" alt="iPhone 0.8.2 沉浸阅读与底部页码" width="230" /></td>
    <td align="center"><img src="docs/previews/web-mobile-library.jpg" alt="Web 0.8.1 手机宽度下的书架" width="230" /></td>
  </tr>
</table>

<details>
<summary>阅读菜单、目录与桌面 Web</summary>

<table>
  <tr>
    <th>iPhone · 阅读菜单</th>
    <th>iPhone · 侧边目录</th>
    <th>Web · 阅读菜单</th>
  </tr>
  <tr>
    <td align="center"><img src="docs/previews/iphone-controls.png" alt="iPhone 页数进度条与阅读设置入口" width="230" /></td>
    <td align="center"><img src="docs/previews/iphone-catalog.png" alt="iPhone 左侧目录、逐章进度和缓存状态" width="230" /></td>
    <td align="center"><img src="docs/previews/web-mobile-controls.jpg" alt="Web 手机阅读菜单与页数进度条" width="230" /></td>
  </tr>
</table>

![Web 桌面阅读器](docs/previews/web-desktop-reader.jpg)

[全部截图与版本信息](docs/previews/README.md)

</details>

## 核心功能

- **搜书与找书**：多来源搜索、按书源筛选、分类与推荐；单个来源失败时保留其他搜索结果。
- **自己的书架**：三列封面、最近阅读、排序与管理，打开书籍即可继续阅读。
- **追更与换源**：书架显示新增章节，按需检查最新目录；切换同书来源时匹配章节并保留章内进度，匹配不确定时可手动选章。
- **自由调整阅读**：滑动、覆盖、上下滚动，配合夜间模式、背景、字体、字号、行距和独立段距设置。
- **目录与离线缓存**：侧边目录显示逐章进度和缓存状态，阅读时自动预读后续章节，已缓存正文可离线打开。
- **下载管理**：后续 50 / 100 章、整本或自选范围，集中暂停、继续和重试；下载任务按设备与账号独立保存。
- **电子书导入**：支持 EPUB、PDF、TXT，也可从已接入的整本书库下载；EPUB / TXT 重新排版，PDF 保留原始页面与图表。
- **跨设备续读**：通过自建服务同步书架、阅读位置与导入原文件，每个账号单独保存数据；不登录也能在本地阅读。
- **听书**：系统语音与语速调整；iPhone 可额外下载 Kokoro / Melo 离线 AI 声库，在设备上合成，无需 API key。

## 平台

| 平台 | 使用方式 | 说明 |
| --- | --- | --- |
| iPhone | SwiftUI 原生 App | 支持本地阅读、云同步及可选离线 AI 听书；通过 Xcode 构建安装 |
| Web | 手机或桌面浏览器 | 适配移动端，可自建服务；支持 PWA 离线资源 |
| Android | Capacitor App | 复用 Web 阅读器，接入系统返回键、安全区、电量与加密登录保存 |

Web 与 Android 的听书取决于浏览器或 WebView 能力，尚未移植 iPhone 的离线 AI 引擎。Android 已通过构建与 lint，真机交互仍待验证。

## 开始使用

### 本地运行 Web

需要 Node.js 24 与 npm：

```sh
git clone https://github.com/SakuraWang6/QingRead.git
cd QingRead/web
npm ci
npm run dev
```

打开 <http://127.0.0.1:5173>。命令会同时启动网页和书源服务；书架内置《桃花源记》，可直接体验阅读。

完整命令与浏览器说明见 [Web 指南](web/README.md)。

### 安装到手机

- **iPhone**：用 Xcode 打开 `QingRead.xcodeproj`，选择模拟器运行；真机安装需配置自己的 Apple Team。见 [iPhone 构建](docs/development.md#iphone) 与 [签名和续签](docs/sideloading.md)。
- **Android**：按 [Android 指南](web/android/README.md) 构建 APK，或使用仓库的 Android debug APK 工作流。长期分发需自行保管固定签名。

### 开启跨设备同步

按 [部署指南](web/deploy/README.md) 自建 HTTPS 服务，让各设备连接同一服务器并登录同一账号。书架、当前位置与 EPUB / PDF / TXT 原文件会同步，朋友使用独立账号即可分别保存数据。同步范围、冲突处理及备份见 [云同步说明](docs/cloud-sync.md)。

项目不预设公共共享服务器；不登录时，书架和文件保存在当前设备。

## 书源与文件

内置来源涵盖网络小说、经典文本、公版电子书与开放教材。来源列表、规则格式和验证范围见 [书源说明](docs/sources.md)。原站改版、限流或网络问题可能影响搜索与下载；已缓存正文仍可继续阅读。

EPUB 当前按文本重新排版，复杂版式、图片与脚注跳转尚未完整还原；PDF 按原始页面阅读，暂不支持听书。加密或 DRM 文件不在当前支持范围内。

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
- [已测范围与已知限制](docs/verification.md)
- [本地维护与清理](docs/maintenance.md)
- [问题反馈](CONTRIBUTING.md)

## 许可

本项目采用 [Polyform Strict 1.0.0](LICENSE)。第三方依赖与模型的许可见 [许可说明](docs/licensing.md)。
