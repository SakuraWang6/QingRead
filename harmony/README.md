# 清读 HarmonyOS

原生 ArkTS Stage 应用，使用 ArkWeb 加载应用内打包的清读 Web 界面。面向 HarmonyOS 5.0（API 12）及以上的手机和平板，不包含 Android 兼容层或内嵌 Node 服务。

## 构建

1. 安装华为官方正式版 DevEco Studio 和配套 HarmonyOS SDK，在 IDE 中打开本目录。工程目标配置为官方 26.0.0 Release，最低兼容版本为 5.0.0（API 12）；编译 SDK 使用 IDE 配套版本。
2. 在 `web/` 目录安装依赖后执行 `QINGREAD_WEB_BASE=/ npm run harmony:sync`。它先按应用根路径构建 Web，再生成 `entry/src/main/resources/rawfile/web/` 和 `qingread-assets.json`，不要手工维护这些产物。已有构建产物时也可在项目根目录执行 `python3 scripts/prepare-harmony.py --web-dist web/dist`。
3. 在 DevEco Studio 配置自己的调试签名，使用真实鸿蒙设备或 HarmonyOS 模拟器运行 `entry`。ArkWeb 不支持 IDE 的静态 Previewer。

应用标识为 `app.qingread.harmony`，安装版本以 `AppScope/app.json5` 为准。签名证书、设备信息、本机 SDK 路径和用户服务器地址不进入仓库。当前目录没有预置签名；没有实际构建记录时，不应将源码工程描述为已验证的安装包。

工具链安装、命令行构建和签名边界见[构建说明](../docs/harmony-build.md)。

只验证资源地址规则可在已安装 Web 开发依赖后运行：

```sh
node --test harmony/tests/resource-policy.test.mjs
```

## 已接入的原生能力

- 固定 `https://localhost/` 来源，精确匹配打包时生成的静态资源白名单。它是资源拦截用的虚拟地址，不会启动本地服务器。未知路径、异常路径、非 GET 请求及其他回环地址返回 404。
- `<input type="file">` 调起系统文档选择器，导入 EPUB、PDF、TXT 和 JSON。取消选择会正常结束文件请求，不申请广域文件读写权限。旧系统的选择器可能不显示后缀筛选，实际文件格式仍由 Web 导入逻辑校验。
- 系统返回键优先关闭 Web 阅读器或弹层；Web 没有处理时将应用退到后台，API 12 使用关闭根页面的兼容路径。外部 HTTPS 链接由系统打开，不在阅读容器中加载。
- 页面启动前注入只读 `__QINGREAD_HARMONY__` 元数据，版本来自系统 BundleInfo。自定义 UA 标记为 `QingReadHarmony/1`。

书架、阅读、书源、下载管理和云同步复用 Web。设备本地数据保存在固定来源的 ArkWeb 存储中；卸载或清除应用数据会删除未同步的内容。联网需要在设置中填写自己部署的 HTTPS 服务地址，服务端须允许 `https://localhost` 的 CORS 请求。

## 当前边界

没有注册 JavaScriptProxy 或任意文件访问接口。只读元数据不具备钥匙串、通知、后台任务、保存文件或原生听书能力；界面须按实际能力显示入口，不以元数据标记冒充这些功能。首版登录令牌保留在当前 Web 会话的 `sessionStorage`，不启用持久登录；它不等同于系统加密凭据存储。

Blob 文件导出尚未接原生保存选择器，界面应禁用对应操作。后续保存功能应由用户主动选择目标 URI，限定文件类型、大小和消息协议，分块写入后立即关闭文件；不接受网页指定沙箱路径，也不提供通用原生执行接口。

原生系统听书、电量、通知、后台下载、加密会话持久化、HAP 更新安装均需另行实现并在真机验证。现有 Web 听书能力仍取决于 ArkWeb 的实际支持情况，不保证锁屏或切换后台后持续运行。原生页面切换前后台时会尽力发送 `qingread:harmony-active` / `qingread:harmony-background` 事件，让 Web 保存阅读位置和暂停前台任务；这不是后台运行许可。

已使用官方 CLT 26.0.0.851 / SDK 26.0.0 / Hvigor 6.26.8 编译生成未签名 HAP，并成功安装、运行于官方 HarmonyOS 7 手机模拟器。已验证联网分类及封面、样例阅读和翻页、系统返回、EPUB / PDF / TXT 系统选择导入与阅读；PDF 实际完成页面渲染。覆盖安装后，原有书籍及 79% 阅读位置保留。

文件导入保持 `.fileAccess(false)`，只读取用户在系统选择器选定的文件。较早鸿蒙系统、真实设备、不同尺寸和复杂电子书仍需验证；最低 API 12 是兼容配置，不代表已经跑过所有系统版本。

## 安全与资源约定

`qingread-assets.json` 结构为 `{ "schemaVersion": 1, "assets": [{ "path": "/index.html", "mime": "text/html", "size": 123, "sha256": "…" }] }`。原生只读取白名单中的 `path` 与 `mime`，不枚举目录，不将请求 URL 拼接为任意文件路径。清单由构建脚本校验和生成，应用签名保证包内资源完整性。

JavaScript、DOM 存储启用，通用文件访问、地理位置和混合 HTTP 内容关闭。SSL 错误直接取消，网页权限请求拒绝。远程 API 使用普通 HTTPS 请求和浏览器 CORS 规则，资源拦截器不转发 API，也不代传账号或凭据。

应用声明 `INTERNET` 用于联网，以及 `GET_NETWORK_INFO` 用于 ArkWeb 的真实网络状态检测。后者是系统自动授予的普通权限；按[官方网络状态 FAQ](https://github.com/openharmony/docs/blob/master/en/application-dev/faqs/faqs-arkui-web.md)，缺少它可能使 `navigator.onLine` 一直为 `false`。容器没有硬编码在线状态，也不申请修改网络的权限。

原生代码依据华为和 OpenHarmony 官方接口实现，参考：[本地资源跨域方案](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/web-cross-origin)、[资源请求拦截](https://gitcode.com/openharmony/docs/blob/master/zh-cn/application-dev/web/web-resource-interception-request-mgmt.md)、[文件选择器](https://gitcode.com/openharmony/docs/blob/master/zh-cn/application-dev/reference/apis-core-file-kit/js-apis-file-picker.md)、[UIAbilityContext](https://gitcode.com/openharmony/docs/blob/master/zh-cn/application-dev/reference/apis-ability-kit/js-apis-inner-application-uiAbilityContext.md)。项目许可见根目录 LICENSE。
