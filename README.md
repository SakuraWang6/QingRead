# 清读 · QingRead

无广告的多端阅读器，支持多源搜书、EPUB / PDF / TXT、听书、离线阅读与跨设备同步，提供 iPhone、Web、Android 和 HarmonyOS 客户端。

[下载与使用](#下载与使用) · [快速开始](#开始使用) · [文档](docs/README.md) · [版本发布](https://github.com/SakuraWang6/QingRead/releases) · [问题反馈](https://github.com/SakuraWang6/QingRead/issues)

## 界面预览

<table>
  <tr>
    <th>iPhone</th>
    <th>Web</th>
    <th>HarmonyOS</th>
  </tr>
  <tr>
    <td align="center"><img src="docs/previews/iphone-categories.png" alt="清读 iPhone 分类页" width="260" /></td>
    <td align="center"><img src="docs/previews/web-mobile-categories.jpg" alt="清读 Web 移动端分类页" width="260" /></td>
    <td align="center"><img src="docs/previews/harmony-categories.png" alt="清读 HarmonyOS 分类页" width="260" /></td>
  </tr>
</table>

[更多界面与截图说明](docs/previews/README.md)

## 核心功能

- **搜书与发现**：多来源搜索、分类浏览、推荐书单与作者作品。
- **阅读与听书**：滑动、覆盖、滚动翻页；调整字体、字号、行距、段距与背景；系统语音、语速和定时停止，iPhone 可选离线 AI 音色。
- **电子书导入**：支持 EPUB、PDF、TXT；EPUB 可查看保留插图和脚注的原版，PDF 保留原始页面。
- **离线与追更**：章节缓存、自动预读、下载队列、追更提醒与换源续读。
- **书架与笔记**：置顶、分组、阅读状态、书签、段落笔记与已缓存正文搜索。
- **跨设备同步**：通过自建服务同步书架、阅读进度、笔记和导入文件，各账号独立保存数据。
- **版本与帮助**：集中查看版本、检查更新、更新日志、使用说明与反馈入口。

## 下载与使用

安装包与 SHA-256 校验文件统一通过 [Releases](https://github.com/SakuraWang6/QingRead/releases) 发布。

| 平台 | 下载与安装 |
| --- | --- |
| Android | [下载 APK](https://github.com/SakuraWang6/QingRead/releases/download/v0.12.0/QingRead-Android-0.12.0.apk) · [构建指南](web/android/README.md) |
| iPhone | [Xcode 构建与安装](docs/development.md#iphone) |
| Web / PWA | [本地运行](web/README.md#本地运行) · [部署指南](web/deploy/README.md) |
| HarmonyOS | [HAP 测试包（需签名）](https://github.com/SakuraWang6/QingRead/releases/download/v0.12.0/QingRead-HarmonyOS-0.12.0-unsigned.hap) · [构建指南](docs/harmony-build.md) |

各平台的环境要求、签名步骤和功能支持范围见对应指南。

## 开始使用

### 本地运行 Web

需要 Node.js 24、npm 与 Python 3.10+。

```sh
git clone https://github.com/SakuraWang6/QingRead.git
cd QingRead/web
npm ci
npm run dev
```

打开 <http://127.0.0.1:5173>。开发命令同时启动网页与书源服务，内置公版《桃花源记》可用于体验阅读。

生产构建、PWA 与浏览器说明见 [Web 文档](web/README.md)。

### 部署同步服务

按[部署指南](web/deploy/README.md)配置 HTTPS 服务，在客户端连接同一服务并登录账号，即可同步书架、阅读进度、笔记和 EPUB / PDF / TXT 原文件。同步范围、冲突处理与备份见[云同步说明](docs/cloud-sync.md)。

## 文档

| 主题 | 文档 |
| --- | --- |
| 阅读与听书 | [阅读工具](docs/reading-tools.md) · [听书与离线 AI](docs/offline-voice.md) |
| 追更与离线 | [通知、换源与下载管理](docs/reading-workflows.md) |
| 书源 | [内置来源与规则格式](docs/sources.md) |
| 构建与开发 | [开发指南](docs/development.md) · [架构说明](docs/architecture.md) |
| 更新与维护 | [客户端更新](docs/app-updates.md) · [维护指南](docs/maintenance.md) |
| 贡献与反馈 | [问题反馈与贡献说明](CONTRIBUTING.md) |

完整索引见[文档导航](docs/README.md)。

## 项目结构

| 目录 | 内容 |
| --- | --- |
| `App/` | iPhone 原生界面、书架、阅读器与听书 |
| `Sources/ReadingCore/` | 书源、内容解析与阅读数据模型 |
| `Sources/ReadingProbe/` | 书源链路检查工具 |
| `Tests/` | Swift 核心测试 |
| `web/` | Web 客户端、API 服务与 Android 工程 |
| `harmony/` | HarmonyOS 工程与原生能力桥接 |
| `scripts/` | 构建、验证与维护脚本 |
| `docs/` | 使用、开发与部署文档 |

## 许可

本项目采用 [PolyForm Strict 1.0.0](LICENSE)。第三方依赖与模型的许可见[许可说明](docs/licensing.md)。
