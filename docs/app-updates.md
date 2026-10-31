# 关于清读与客户端更新

「设置 → 关于清读」集中显示当前安装版本、检查更新、更新日志、使用说明、问题反馈和本地许可。更新日志与说明随客户端打包，断网也能查看。反馈需要主动打开 GitHub；复制版本信息不会附带账号、书架、笔记、服务器地址或凭据。

## 检查更新

主动检查或确认网页更新时读取当前服务的公开版本清单；不要求登录，不发送账号凭据，不自动安装，也不删除本机阅读数据。无法访问清单时显示失败或重试，不把本地说明当作已经核实的最新版本。

| 平台 | 版本来源 | 有新版本时 |
| --- | --- | --- |
| iPhone | 当前 App 的实际版本与构建号 | 显示更新说明，通过已有 Mac / Xcode 签名流程覆盖安装；此入口不能解除个人签名有效期限制 |
| Web / PWA | 当前网页构建版本 | 检查新资源，待资源就绪后由用户确认更新页面；遵循现有 PWA 更新流程 |
| Android | 系统返回的实际安装版本与构建号 | 前台自动检查或手动检查；点击更新后在应用内下载、校验，再交给系统确认覆盖安装 |
| HarmonyOS | BundleInfo 的实际安装版本与构建号 | 显示更新日志与手动签名覆盖安装说明；不展示 APK 链接或自动安装未签名 HAP |

仓库默认清单不含 APK 下载项。只有实际安装包完成版本、包名及签名验证后，部署者才生成下载信息；没有发布安装包时，不显示可用下载。

## Android 应用内更新

0.12.2 起，应用打开、回到前台或恢复联网时会择机检查版本。连续使用同一服务器时，检查成功后的自动检查间隔为 12 小时；切换服务器会重新检查，失败后至少间隔 15 分钟再自动重试。在「设置 → 关于清读」仍可随时手动检查。后台不会依靠常驻定时器反复检查，也不会自动开始下载安装。

点击「更新至」后，独立前台服务下载 APK，应用和通知栏显示进度，可取消。下载可以在应用切到后台后继续；系统终止任务时需返回重试。安装包限 100 MiB，单次下载最长 15 分钟，不携带账号令牌、密码或书源访问码。下载与安装前校验长度、SHA-256、包名、当前签名证书、系统要求及版本；不匹配时停止，不要求卸载旧版。

包准备好且应用在前台时，进入 Android 系统安装流程。Android 8 及以上若尚未允许清读安装应用，会先打开系统「允许来自此来源的应用」设置；允许后返回，继续系统安装确认。未完成安装也可稍后在清读点击「安装更新」。系统保留最后的确认权，应用不能静默安装。进程重启后会恢复已下载包的状态，仍需用户继续安装；服务器切换会取消旧服务的更新任务。

更新使用同一包名和签名证书直接覆盖安装，保留书架、阅读进度、导入文件和本地阅读数据库。请勿先卸载；安装来源或签名不一致时，不应以卸载作为升级步骤。尚无应用内更新功能的旧版，可从关于页或 Releases 下载新版 APK 覆盖安装一次。安装行为与数据保留依据见 [Android 官方更新说明](https://developer.android.com/google/play/app-updates)及[覆盖安装说明](https://developer.android.com/tools/adb#pm)。

### 卸载与备份

Android 10 / API 29 起，清读通过 `hasFragileUserData` 请求系统卸载页提供「保留应用数据」选项。选项及文案由系统或厂商实现，旧系统及不同卸载入口不保证显示；应用不能拦截系统卸载或替换系统卸载对话框。普通卸载会删除应用私有数据，系统保留选项不能替代备份。见[官方属性说明](https://developer.android.com/guide/topics/manifest/application-element#fragileuserdata)及[应用私有存储说明](https://developer.android.com/training/data-storage/app-specific)。

「导出阅读备份」的 JSON 保存书架、笔记、阅读进度和阅读设置，不包含 EPUB / PDF / TXT 原文件、章节正文缓存或原生后台下载暂存。导入原文件需另行保存，或确认已经同步到自己的云端账号；换设备后按账号重新下载。系统 `allowBackup` 也不代表所有本地文件都能在卸载后自动恢复。

## 清单地址与响应头

Web 从当前网页基础路径读取 `releases.json`，共享实例为 `/qingread/releases.json`。iPhone / Android 使用已配置 HTTPS 服务的 **origin**，再拼接 `App/Resources/AppInfo.json` 中的 `update.manifestPath`（默认 `/qingread/releases.json`）；例如服务填 `https://read.example.com/api`，检查地址仍是 `https://read.example.com/qingread/releases.json`。

清单由静态文件提供，不增加 API、账号表或后台任务。该文件需要：

```http
Content-Type: application/json
Cache-Control: no-store
Access-Control-Allow-Origin: *
```

Android WebView 的 origin 是 `https://localhost`，因此只对这个公开 JSON 开放跨域读取。客户端使用 `credentials: omit`；不添加 `Access-Control-Allow-Credentials`，也不把这些公开响应头扩展到账号、同步或云文件 API。安装包 URL 仅接受同一 HTTPS origin 下固定版本的 `/downloads/QingRead-Android-<version>.apk`。

共享 Caddy 已有 `/qingread/` 静态 handler 时，在其移除前缀后仅给 `/releases.json` 加上述两个 header；先 validate，再按现有方式热加载。保留其他路由、端口和证书，不用独立站点配置替换共享入口。APK 与网页保持已有访问范围。

## 生成与验证

唯一说明源是 `App/Resources/AppInfo.json`。生成器读取平台真实版本配置：

- iPhone：`Config/App.xcconfig` 的版本和构建号。
- Web：`web/package.json` 的版本。
- Android：`web/android/app/build.gradle` 的版本和 versionCode。
- HarmonyOS（工程存在时）：`harmony/AppScope/app.json5` 的版本和 versionCode；只记录版本，不提供 HAP 下载项。构建与签名边界见[鸿蒙构建说明](harmony-build.md)。

各平台必须与 AppInfo 当前版本一致。许可资源 `App/Resources/ProjectLicense.txt` 必须与根 `LICENSE` 逐字一致；第三方许可仍单独保留。生成器使用 Python 标准库，不读取个人配置、服务器 IP 或签名私钥。

在仓库根目录运行：

```sh
python3 -m unittest discover -s scripts -p 'test_release_manifest.py' -v
python3 scripts/generate-release-manifest.py
```

默认原子生成 `web/public/releases.json`，各平台都有版本与更新说明，但不生成安装包 `artifact`。默认发布时间取当前版本日志日期的 `00:00:00+08:00`，相同输入得到相同文件；正式发布可用 `--published-at` 显式指定带时区的 ISO 时间。`npm run build` 和本地网页开发入口会先生成清单，再准备 PDF 资源。

生成含安装包的部署专用清单时，提供已签名的真实 APK、精确版本 URL 和私有输出目录：

```sh
python3 scripts/generate-release-manifest.py \
  --android-apk /absolute/private/path/QingRead-Android-0.12.2.apk \
  --android-url /downloads/QingRead-Android-0.12.2.apk \
  --apksigner /absolute/path/to/apksigner.jar \
  --published-at 2026-11-01T12:00:00+08:00 \
  --output /absolute/private/path/release-site/releases.json
```

`--apksigner` 支持现有 Android SDK 可执行文件或官方 JAR（经系统 Java 运行）；未指定时从 PATH / Android SDK 查找，不下载工具。只有 APK 模式需要它。生成器检查 ZIP、DEX、二进制 manifest 的包名、版本和构建号，并调用 `apksigner verify`；失败时不发布下载项。清单只写同源相对 URL、实际文件 SHA-256 与字节数，不写本地文件路径、证书或私钥。它不替代分发者对固定签名证书的独立核对。

生成器拒绝跨站 URL、编码或目录穿越、可变 latest 地址、版本不符及伪 APK。generic 生成也会拒绝覆盖已有 APK 下载项的清单，避免本地 build 撤掉正式下载；部署清单保存在私有输出目录，仓库继续保留不含下载承诺的 generic 文件。

## 发布顺序与回滚

客户端页面和版本清单更新不需要重建 API 或迁移数据库。在开发电脑构建；共享站点使用 `QINGREAD_WEB_BASE=/qingread/`，Android 打包使用默认根路径。已接入[独立下载服务](../web/downloads/README.md)时，安装包由它的私有文件清单管理。

1. 检查资源余量，记录原容器 ID / 启动时刻、共享配置哈希及当前静态链接，保留旧静态目录和备份。
2. 上传新 Web 版本至独立静态目录；上传并重新核对固定签名的版本 APK。固定版本文件一旦发布就不得覆盖，用新版本文件名发布新内容，保留旧文件用于已发布清单和回滚。无 APK 时保留 generic 清单。
3. 使用独立下载服务时，在私有下载清单登记新文件的实际普通文件名、字节数、SHA-256 与固定版本公开名称，保留已有文件和旧 latest 映射。原子替换私有清单，**仅重启下载服务**使其执行启动校验；不重启清读 API 或共享代理。验证新固定版本 URL 的完整哈希、Range 和统计。
4. 确认文件可下载后，**最后**发布与实际文件匹配的 `releases.json`、原子切换清读静态链接。使用独立下载服务时，再将私有下载清单的 latest 别名切到新文件；latest 清单变化也只需重启下载服务，客户端更新清单始终引用固定版本 URL。不要用文件系统符号链接代替清单映射。
5. 验证公开清单、响应头、网页资源、版本与 latest 文件哈希、其他服务入口及容器状态。首次接入下载代理或补充清单响应头时，先验证并热加载 Caddy；后续发布不改共享路由。账号 API 的鉴权应保持原样。

回滚切回旧静态目录与版本清单；使用独立下载服务时，恢复私有下载清单的旧别名并仅重启该服务。保留所有固定版本安装包和统计目录。客户端更新失败不清空书架或原文件；iPhone 的签名备份与自动续签运行副本应另行保留。
