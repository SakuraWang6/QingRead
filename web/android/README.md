# 清读 Android

Android 壳使用 Capacitor 8，共享 `web/src` 的书架、搜索、阅读、目录、缓存、EPUB/PDF/TXT 导入与设置。原生工程已生成并同步；[首次 CI 构建、Lint 和 APK 签名验证已通过](https://github.com/SakuraWang6/QingRead/actions/runs/39438734922)。本机没有 Android SDK，尚未在模拟器或真机运行。

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

调试包在 `app/build/outputs/apk/debug/app-debug.apk`。仓库的 **Android debug APK** 工作流执行同样的构建和检查，并将 APK 保存为可下载 Artifact。手动运行时可填写公开的 HTTPS API 地址，或设置仓库变量 `QINGREAD_API_BASE`；不填也能构建，安装后再在 App 内配置。

CI 使用固定的个人测试签名，以便后续同签名调试包可以覆盖升级并保留设备上的 IndexedDB 数据。仓库必须配置 Secret `QINGREAD_ANDROID_DEBUG_KEYSTORE_B64`，内容为持久保存的个人测试 keystore 的 Base64；别名为 `androiddebugkey`，keystore 和密钥密码均为标准调试值 `android`。工作流将其恢复到 Runner 的临时私有路径，并通过 `QINGREAD_DEBUG_KEYSTORE_PATH` 显式传给 Gradle 的 debug 签名配置，不依赖 Android 默认 keystore 位置。构建前导出的公开证书、构建后 APK 的证书均必须与固定 SHA-256 `ff9db7beba4dd6075e1e9f4d09dea86a8353d68811dd84f5d4f7026f1067cb70` 一致，否则失败并拒绝上传 APK。工作流不会输出私钥，也不会临时生成替代签名。

早期 0.5.0 和首次 0.5.1 CI 产物曾实际使用其他临时调试签名，不能与本固定签名覆盖升级。如果安装过这些旧包，需先导出阅读备份，再卸载旧包、安装固定签名版本并恢复备份。临时私钥无法恢复，不能通过更改证书指纹绕过 Android 的签名检查。手动本地构建时也应将 `QINGREAD_DEBUG_KEYSTORE_PATH` 指向同一份保管的 keystore，才能保持签名一致。

这只是此私有仓库的个人测试签名，**不是上架用的 release 签名**。请备份原始 keystore；更换签名身份会导致旧安装包无法覆盖升级。正式分发前应另外配置私密、持久的 release 签名文件，并保管好密钥；不要将 keystore 或其 Base64 提交到仓库。

## 服务器与离线

APK 内的页面原点固定为 `https://localhost`，它提供打包的页面和 PDF 字体资源。**这个 localhost 是手机本机，不是 Mac 或远程书源服务器。** 首次打开后到「设置 → 服务器连接」输入可以从手机访问、证书有效的 HTTPS 域名。地址可带 `/api`，不包含用户名或密码；若服务启用访问码，在独立访问码栏填写。

服务端已允许 Capacitor 的 `https://localhost` Origin，并保留访问码与请求限制。App 不开启混合内容或明文 HTTP；服务器只使用 HTTP 时，应先通过反向代理配置 TLS。

原生壳不注册 PWA ServiceWorker；页面和 PDF 渲染资源直接来自 APK，因此启动不依赖服务器。已导入文件与已缓存章节继续通过 IndexedDB 离线读取。联网搜索、未缓存章节和整本下载需要服务器。更换 API 地址不会同步 iOS/Web/Android 的本地书架，现阶段同步依赖备份导入导出。

## 安卓交互

- 物理返回键依次关闭阅读设置/目录、阅读器、详情或设置面板，然后返回书架；已经在书架时将 App 放到后台。
- 使用 Capacitor 8 的 SystemBars 原生安全区处理，适配状态栏、底部手势条及较旧 WebView 的安全区缺陷。
- 听书仍通过系统 Web Speech 能力检测。部分 Android WebView 不提供该接口，会明确显示不可用；安卓原生听书、Kokoro 离线模型和锁屏持续播放尚未集成。
- 文件选择、导出下载、系统返回手势、长时间阅读与后台行为仍需安卓模拟器/真机复核；CI 编译成功不等于这些交互已验证。

官方参考：[Android 平台](https://capacitorjs.com/docs/android)、[Capacitor 8 升级要求](https://capacitorjs.com/docs/updating/8-0)、[配置和 HTTPS 原点](https://capacitorjs.com/docs/config)、[App 返回键](https://capacitorjs.com/docs/apis/app)、[SystemBars 安全区](https://capacitorjs.com/docs/apis/system-bars)。

PDF 兼容下限参考：[PDF.js 官方浏览器兼容表](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions#which-browsersenvironments-are-supported)（legacy：Chrome 125+、Safari 18+；未承诺更旧浏览器的 PDF 支持）。
