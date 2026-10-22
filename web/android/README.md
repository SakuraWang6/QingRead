# 清读 Android

Android 壳使用 Capacitor 8，共享 `web/src` 的书架、搜索、阅读、目录、缓存、EPUB/PDF/TXT 导入与设置。当前 **0.10.0 / versionCode 8**，支持书架整理、书签笔记、缓存正文搜索、EPUB 原版、PDF 页笔记与搜索、听书定时和账号安全。下载由原生前台服务执行，后台追更由 WorkManager 调度，见[章节工作流](../../docs/reading-workflows.md)。本机无 Android SDK，尚未在模拟器或真机运行；[最终 CI](https://github.com/SakuraWang6/QingRead/actions/runs/39808259963) 已通过编译、lint、JUnit、签名与 ZIP 检查；固定证书交付包与公网 latest 的版本、ZIP 和 SHA-256 核对均通过，详见[验证记录](../../docs/verification.md)。

安装系统下限沿用 Capacitor 的 Android 7 / API 24，但清读实际运行需要 **Android System WebView 125+**；系统不能更新到该版本的旧设备不在本版兼容范围。较低版本会打开本地更新提示页。PDF 使用与主依赖同版本的 `legacy` 构建，并在打开 PDF 时才加载，失败不会阻止普通书籍阅读。

## 构建

需要 Node 24、JDK 21、Android SDK Platform 36 / Build Tools 36.0.0。可以用 Android Studio 2025.2.1+，或在 GitHub Actions 构建，无需先购买手机。

```sh
cd web
npm ci
npm run android:sync
cd android
./gradlew --no-daemon assembleDebug lintDebug testDebugUnitTest
```

调试包在 `app/build/outputs/apk/debug/app-debug.apk`。仓库的 **Android debug APK** 工作流执行同样的构建和检查，并将 APK 保存为可下载 Artifact。手动运行时通过 `api_base` 输入项填写公开的 HTTPS API 地址；不填也能构建，安装后再在 App 内配置。

公开 CI 不读取个人签名 Secret，使用临时调试签名构建验证包。不同 Runner 的调试包可能不能覆盖升级；要长期分发和保留数据，请自行保管固定签名，在私有构建环境通过 `QINGREAD_DEBUG_KEYSTORE_PATH` 传给 Gradle。keystore、私钥及 Base64 都不能提交到仓库。已有个人固定签名保留在本地私有目录，历史包升级必须保持相同证书。

## 服务器、同步与离线

页面原点固定为 `https://localhost`，表示 APK 内页面，与远程服务器不同。在「设置 → 服务器连接」填写自己部署的 HTTPS 地址，再在「账号与同步」注册或登录。手动构建可通过 `VITE_API_BASE` 指定自己的默认服务，公开源码没有预设服务器。后端允许 Capacitor 的 `https://localhost` Origin，App 不开放明文 HTTP。

同一服务器、同一账号同步书架、置顶分组、阅读状态、书签笔记和当前位置。勾选记住登录时，令牌经 Android KeyStore 加密保存；密码不保存。账号页面支持修改密码、生成恢复码和凭码恢复，旧会话撤销后其他设备需重新登录。未登录书架需主动合并，账号切换使用独立本地存储。原文件按账号自动上传，另一设备按需下载继续读；章节缓存不做书架同步，见 [同步说明](../../docs/cloud-sync.md)。

原生壳不注册 PWA ServiceWorker，页面与 PDF 资源随 APK 打包，已导入文件和章节缓存可离线阅读。部分海外大文件下载可能受服务器网络限制。

## 安卓交互

- 物理返回键依次关闭阅读设置/目录、阅读器、详情或设置面板，然后返回书架；已经在书架时将 App 放到后台。
- 翻页时收起阅读控制栏，页码与进度条按当前排版估算；未缓存章节仍需联网加载。
- 使用 Capacitor 8 的 SystemBars 原生安全区处理，适配状态栏、底部手势条及较旧 WebView 的安全区缺陷。
- 听书仍通过系统 Web Speech 能力检测。部分 Android WebView 不提供该接口，会明确显示不可用；安卓原生听书、Kokoro 离线模型和锁屏持续播放尚未集成。
- 听书可设 15 / 30 / 60 分钟或本章结束停止；EPUB 原版与文字模式、PDF 页笔记和本地搜索共用 Web 实现，见[电子书说明](../../docs/reading-tools.md)。
- 文件选择、导出下载、系统返回手势、长时间阅读与后台行为仍需安卓模拟器/真机复核；CI 编译成功不等于这些交互已验证。

官方参考：[Android 平台](https://capacitorjs.com/docs/android)、[Capacitor 8 升级要求](https://capacitorjs.com/docs/updating/8-0)、[配置和 HTTPS 原点](https://capacitorjs.com/docs/config)、[App 返回键](https://capacitorjs.com/docs/apis/app)、[SystemBars 安全区](https://capacitorjs.com/docs/apis/system-bars)。

PDF 兼容下限参考：[PDF.js 官方浏览器兼容表](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions#which-browsersenvironments-are-supported)（legacy：Chrome 125+、Safari 18+；未承诺更旧浏览器的 PDF 支持）。

## 原生后台下载与通知

用户在应用内开始或继续下载时启动 `dataSync` 前台服务，通知栏显示进度并提供暂停。服务使用应用私有 SQLite 保存队列和暂存正文，不依赖 WebView 保持运行；请求单并发，每章最多三次尝试，持续失败会暂停。重新打开应用时把正文按当前账号、逻辑书籍及实际来源核对后写入 IndexedDB，写成功才确认删除暂存。暂存总量限制 256 MiB，单次桥接最多 2 MiB。切换账号暂停旧任务并清理旧通知、加密凭据；删除、换源、清缓存通过桥接终止旧任务。

追更通知需用户主动开启；Android 13+ 的通知权限只在点击按钮时申请。WorkManager 在联网且电量不低时约每小时尝试检查，不要求 FCM、Google Play 服务或付费接口。首次没有目录基线时只建立基线，不把整本算成更新。原生已读位置与前台追更状态合并，避免重复提醒。

系统可推迟后台检查；强行停止应用后不能承诺继续执行。Android 12+ 不允许普通应用任意从后台启动前台服务，因此新下载和继续都由应用内用户动作触发。Android 15+ 对 `dataSync` 后台运行累计限制为每 24 小时 6 小时，超时会安全暂停；不使用开机强启或无限保活。直接前台服务下载避免 Android 16 长 Worker 的作业配额问题，短周期追更仍受系统调度限制。

Android 原生壳不注册 PWA Worker，不使用 Web Push 或 FCM；通知权限与书架检查由原生接口管理。账号切换、书籍删除、换源和清缓存都会使旧来源任务失效。

原生代码静态语法和纯 Java 匹配规则已检查；通知授权、熄屏、移除最近任务、系统时限与厂商省电行为仍需 Android 真机验证。CI 必须执行 `./gradlew --no-daemon assembleDebug lintDebug testDebugUnitTest`；通过结果以最终源码提交的验证记录为准。

官方依据：[前台服务启动限制](https://developer.android.com/develop/background-work/services/fgs/launch)、[dataSync 类型](https://developer.android.com/develop/background-work/services/fgs/service-types#data-sync)、[后台运行时限](https://developer.android.com/develop/background-work/services/fgs/timeout)、[WorkManager 长任务与 Android 16 配额](https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/long-running)。
