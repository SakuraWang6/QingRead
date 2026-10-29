# 清读 HarmonyOS

原生 ArkTS Stage 应用，使用 ArkWeb 加载应用内打包的清读 Web 界面。面向 HarmonyOS 5.0（API 12）及以上的手机和平板，不包含 Android 兼容层或内嵌 Node 服务。

## 构建

1. 安装华为官方正式版 DevEco Studio 和配套 HarmonyOS SDK，在 IDE 中打开本目录。工程目标配置为官方 26.0.0 Release，最低兼容版本为 5.0.0（API 12）；编译 SDK 使用 IDE 配套版本。
2. 在 `web/` 目录安装依赖后执行 `QINGREAD_WEB_BASE=/ npm run harmony:sync`。它先按应用根路径构建 Web，再生成 `entry/src/main/resources/rawfile/web/` 和 `qingread-assets.json`，不要手工维护这些产物。已有构建产物时也可在项目根目录执行 `python3 scripts/prepare-harmony.py --web-dist web/dist`。
3. 在 DevEco Studio 配置自己的调试签名，使用真实鸿蒙设备或 HarmonyOS 模拟器运行 `entry`。ArkWeb 不支持 IDE 的静态 Previewer。

应用标识为 `app.qingread.harmony`，当前源码 **0.12.1 / versionCode 3**，安装版本以 `AppScope/app.json5` 为准。签名证书、设备信息、本机 SDK 路径和用户服务器地址不进入仓库。工程不预置签名；构建及设备验证范围见[验证记录](../docs/verification.md)。

工具链安装、命令行构建和签名边界见[构建说明](../docs/harmony-build.md)。

只验证资源地址规则可在已安装 Web 开发依赖后运行：

```sh
node --test harmony/tests/*.test.mjs
```

## 原生能力与共享界面

- 固定 `https://localhost/` 来源，精确匹配打包时生成的静态资源白名单。它是资源拦截用的虚拟地址，不会启动本地服务器。未知路径、异常路径、非 GET 请求及其他回环地址返回 404。
- `<input type="file">` 调起系统文档选择器，导入 EPUB、PDF、TXT 和 JSON。取消选择会正常结束文件请求，不申请广域文件读写权限。旧系统的选择器可能不显示后缀筛选，实际文件格式仍由 Web 导入逻辑校验。
- 系统返回键优先关闭 Web 阅读器或弹层；Web 没有处理时将应用退到后台，API 12 使用关闭根页面的兼容路径。外部 HTTPS 链接由系统打开，不在阅读容器中加载。
- 页面启动前注入只读安装版本和实际能力；版本来自 BundleInfo，自定义 UA 为 `QingReadHarmony/1`。v2 宿主通过 WebMessagePort 提供系统离线听书、电量、备份保存和安全存储；旧 v1 宿主仍按原能力降级。
- Core Speech Kit 只列设备已安装的离线音色。采用短句播放，语速在下一句生效；定时停止沿用共用阅读器，切后台暂停。
- 备份通过系统保存选择器导出，分块传输、总量限 16 MiB；大文件主动节流，不关闭原生限流。
- 登录信息可保存到 ASSET 的 cloud / connection 两个固定槽，设备解锁后可读；每项限 1024 UTF-8 字节。保存失败或超限仍可使用本次会话，不降级到明文持久存储。
- 登录自建服务后，云端准备好的章节通过 request.agent 后台传输到私有暂存；回到前台核对账号、来源、SHA-256 与正文，再写入本机缓存。支持暂停、继续和取消，继续时重新下载完整文件。
- API 23 及以上可主动开启 WorkScheduler 定期追更与本地通知，无需 AGC；至少两小时间隔、每轮最多三本和 80 秒，由系统尽力调度。通知不显示书名或地址，关闭或退出账号使旧任务失效。

书架、阅读、书源、下载管理和云同步复用 Web。设备本地数据保存在固定来源的 ArkWeb 存储中；卸载或清除应用数据会删除未同步的内容。联网需要在设置中填写自己部署的 HTTPS 服务地址，服务端须允许 `https://localhost` 的 CORS 请求。

## 当前边界

锁屏控制和 Melo / Kokoro 离线 AI 引擎尚未接入。系统音色以设备实际安装内容为准，不保证每台设备都有男声或相同声线。切后台暂停听书；系统任务可能延迟或终止，强制退出后不保证继续执行。

远程追更 Push 仍需另行配置 AGC 项目、推送服务及签名，当前只提供本地通知。API 12–22 不开启后台检查，避免旧网络接口的自动重定向泄露访问码。系统后台下载最多两个活动任务、20 条保留记录，单文件 128 MiB；云端已准备、系统已下载和本机已缓存分别显示。没有登录云服务时沿用前台下载，不把系统传输完成当作已完成正文缓存。

工程不预置签名证书；Release 中的 HAP 测试包需配置签名后用于真机调试，步骤见[构建说明](../docs/harmony-build.md)。最低 API 12 是工程兼容配置，实际已测系统与设备范围见[验证记录](../docs/verification.md)。

文件导入保持 `.fileAccess(false)`，只读取用户在系统选择器选定的文件。云同步复用共用客户端，真机账号、文件同步与复杂电子书仍需验证；当前证据见[验证记录](../docs/verification.md)。

## 安全与资源约定

`qingread-assets.json` 结构为 `{ "schemaVersion": 1, "assets": [{ "path": "/index.html", "mime": "text/html", "size": 123, "sha256": "…" }] }`。原生只读取白名单中的 `path` 与 `mime`，不枚举目录，不将请求 URL 拼接为任意文件路径。清单由构建脚本校验和生成，应用签名保证包内资源完整性。

桥接仅注入固定来源的顶层文档，随机握手值与端口保留在闭包。方法和参数白名单拒绝任意路径、URL、对象名或系统命令；消息大小、并发和速率均有限制。页面重载关闭旧端口；旧凭据保存的异步回调也不得复活旧账号。未注册 JavaScriptProxy。

JavaScript、DOM 存储启用，通用文件访问、地理位置和混合 HTTP 内容关闭。SSL 错误直接取消，网页权限请求拒绝。远程 API 使用普通 HTTPS 请求和浏览器 CORS 规则，资源拦截器不转发 API，也不代传账号或凭据。

应用声明 `INTERNET` 用于联网，以及 `GET_NETWORK_INFO` 用于 ArkWeb 的真实网络状态检测。后者是系统自动授予的普通权限；按[官方网络状态 FAQ](https://github.com/openharmony/docs/blob/master/en/application-dev/faqs/faqs-arkui-web.md)，缺少它可能使 `navigator.onLine` 一直为 `false`。容器没有硬编码在线状态，也不申请修改网络的权限。

原生代码依据华为和 OpenHarmony 官方接口实现，参考：[本地资源跨域方案](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/web-cross-origin)、[资源请求拦截](https://gitcode.com/openharmony/docs/blob/master/zh-cn/application-dev/web/web-resource-interception-request-mgmt.md)、[文件选择器](https://gitcode.com/openharmony/docs/blob/master/zh-cn/application-dev/reference/apis-core-file-kit/js-apis-file-picker.md)、[UIAbilityContext](https://gitcode.com/openharmony/docs/blob/master/zh-cn/application-dev/reference/apis-ability-kit/js-apis-inner-application-uiAbilityContext.md)。项目许可见根目录 LICENSE。
