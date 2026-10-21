# 清读 Android

Android 壳使用 Capacitor 8，共享 `web/src` 的书架、搜索、阅读、目录、缓存、EPUB/PDF/TXT 导入与设置。当前 **0.8.0 / versionCode 5**，支持账号同步、Android KeyStore 加密登录保存与阅读页真实电量显示。本机无 Android SDK，尚未在模拟器或真机运行。

安装系统下限沿用 Capacitor 的 Android 7 / API 24，但清读实际运行需要 **Android System WebView 125+**；系统不能更新到该版本的旧设备不在本版兼容范围。较低版本会打开本地更新提示页。PDF 使用与主依赖同版本的 `legacy` 构建，并在打开 PDF 时才加载，失败不会阻止普通书籍阅读。

## 构建

需要 Node 22+、JDK 21、Android SDK Platform 36 / Build Tools 36.0.0。可以用 Android Studio 2025.2.1+，或在 GitHub Actions 构建，无需先购买手机。

```sh
cd web
npm ci
npm run android:sync
cd android
./gradlew --no-daemon assembleDebug lintDebug
```

调试包在 `app/build/outputs/apk/debug/app-debug.apk`。仓库的 **Android debug APK** 工作流执行同样的构建和检查，并将 APK 保存为可下载 Artifact。手动运行时通过 `api_base` 输入项填写公开的 HTTPS API 地址；不填也能构建，安装后再在 App 内配置。

公开 CI 不读取个人签名 Secret，使用临时调试签名构建验证包。不同 Runner 的调试包可能不能覆盖升级；要长期分发和保留数据，请自行保管固定签名，在私有构建环境通过 `QINGREAD_DEBUG_KEYSTORE_PATH` 传给 Gradle。keystore、私钥及 Base64 都不能提交到仓库。已有个人固定签名保留在本地私有目录，历史包升级必须保持相同证书。

## 服务器、同步与离线

页面原点固定为 `https://localhost`，表示 APK 内页面，与远程服务器不同。在「设置 → 服务器连接」填写自己部署的 HTTPS 地址，再在「账号与同步」注册或登录。手动构建可通过 `VITE_API_BASE` 指定自己的默认服务，公开源码没有预设服务器。后端允许 Capacitor 的 `https://localhost` Origin，App 不开放明文 HTTP。

同一服务器、同一账号同步书架和当前阅读位置。勾选记住登录时，令牌经 Android KeyStore 加密保存；密码不保存。未登录书架需要主动合并，账号切换使用独立本地存储。整本原文件按账号自动上传，另一设备点击书籍会下载原文件后继续读；网站章节缓存不上传，见 [同步说明](../../docs/cloud-sync.md)。

原生壳不注册 PWA ServiceWorker，页面与 PDF 资源随 APK 打包，已导入文件和章节缓存可离线阅读。部分海外大文件下载可能受服务器网络限制。

## 安卓交互

- 物理返回键依次关闭阅读设置/目录、阅读器、详情或设置面板，然后返回书架；已经在书架时将 App 放到后台。
- 使用 Capacitor 8 的 SystemBars 原生安全区处理，适配状态栏、底部手势条及较旧 WebView 的安全区缺陷。
- 听书仍通过系统 Web Speech 能力检测。部分 Android WebView 不提供该接口，会明确显示不可用；安卓原生听书、Kokoro 离线模型和锁屏持续播放尚未集成。
- 文件选择、导出下载、系统返回手势、长时间阅读与后台行为仍需安卓模拟器/真机复核；CI 编译成功不等于这些交互已验证。

官方参考：[Android 平台](https://capacitorjs.com/docs/android)、[Capacitor 8 升级要求](https://capacitorjs.com/docs/updating/8-0)、[配置和 HTTPS 原点](https://capacitorjs.com/docs/config)、[App 返回键](https://capacitorjs.com/docs/apis/app)、[SystemBars 安全区](https://capacitorjs.com/docs/apis/system-bars)。

PDF 兼容下限参考：[PDF.js 官方浏览器兼容表](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions#which-browsersenvironments-are-supported)（legacy：Chrome 125+、Safari 18+；未承诺更旧浏览器的 PDF 支持）。
