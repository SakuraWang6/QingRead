# 可选追更推送

Web Push 默认关闭。仅已登录、主动授权并选择图书的用户会进入检查队列；没有订阅就没有目录请求。它不要求 Apple Developer Program，也没有付费推送中介或遥测 SDK。iPhone 需要 iOS 16.4+，先添加到主屏幕并从图标打开，再点击开启通知。[WebKit 官方说明](https://webkit.org/blog/13878/)

浏览器 Service Worker 可能被系统终止，普通 Background Sync 不适合长时间下载，Background Fetch 兼容性也有限。推送用于提醒，不能当作 iOS 网页后台下载的保活方式。[MDN Background Fetch](https://developer.mozilla.org/en-US/docs/Web/API/Background_Fetch_API)

## 私有配置

开发电脑可用已锁定的 `web-push` CLI 生成一组 VAPID 密钥。将它们放到私有环境配置并备份，不能提交仓库或输出到公开日志。只有公钥会返回客户端；更换密钥需要浏览器重新订阅。

| 变量 | 内容 |
| --- | --- |
| `QINGREAD_WEB_PUSH_ENABLED` | 明确设为 `true` 才开启 |
| `QINGREAD_VAPID_PUBLIC_KEY` | P-256 公钥 |
| `QINGREAD_VAPID_PRIVATE_KEY` | 对应私钥 |
| `QINGREAD_VAPID_SUBJECT` | 维护者的 `mailto:` 或有效公开 HTTPS 联系地址 |

应用在 `QINGREAD_DATA_DIR` 下创建权限 600 的 `notifications.sqlite`，保存订阅密钥、所属账号、会话哈希和选书状态；应与账号数据库一起私下备份。原账号库只读查询会话有效期，不增加账号字段或保存明文令牌。会话注销／过期、浏览器订阅过期、推送服务返回 404/410 时清理订阅。最后一个订阅失效后清理该账号的检查队列。

`web-push` 是新增运行依赖；部署前需将更新后的生产依赖加入镜像，不能复用先前只 COPY 业务源码的增量步骤。保留已有基础镜像修复、共享代理和其他项目的路由，不在低配置服务器上执行前端构建。

## 接口与客户端集成

- `GET /api/push/config`：是否开启、公钥和限额。
- `GET /api/push/status`：本账号设备数量、订阅哈希和所选书籍 ID。
- `POST /api/push/subscribe`，`{ subscription }`：绑定当前登录会话。
- `POST /api/push/unsubscribe`，`{ endpoint }`：仅移除本账号的对应订阅。
- `POST /api/push/books`，`{ bookIDs }`：仅接受本账号已同步书架中的网络小说，最多 20 本；空数组关闭检查。

除公钥配置外均需 `Authorization: Bearer …`。每账号最多 5 个设备，实例总计最多 200 个订阅。不同账号不能覆盖或移除对方的订阅；不提供按用户名查询或发送任意消息的接口。

独立组件 `PushNotificationsPanel` 接受 `{ auth: { apiAddress, session } | null, books, onSync? }`。在退出或切换账号前调用 `disablePush(auth)`，断网也会先关闭本机订阅和通知；服务器还会根据会话失效自行清理。`cancelPendingPushChanges()` 可取消尚在权限交互中的订阅操作。

权限只在用户点击时申请。PWA 保留现有 Workbox Worker，导入同路径的 `push-worker.js`；根路径和 `/qingread/` 的订阅与点击目标均检查自己的 scope。默认通知只显示“清读／书架有新章节，打开查看”，不含书名、账号或图书地址。

## 负载与验证边界

每分钟全实例至多处理一个目录，同一本书通常每小时检查；失败指数退避到最多 24 小时。所有目录读取使用既有受限书源网络层，不下载正文。首次目录、换源及无法找到旧目录尾锚点时只建立基线；追加章节才触发通知。每账号每小时最多一条合并通知，失败发送至少冷却 15 分钟。推送目标仅允许受支持浏览器的 HTTPS 推送域名，并校验、固定公网 DNS 结果；不跟随重定向，使用绝对发送超时。

自动化使用注入的目录与发送函数，不请求外网、不发送真实设备通知。实际交付受服务器到 Apple／Google／Mozilla 推送服务的网络、浏览器权限、系统专注模式及节电策略影响，需由部署者另行验证。

实现依赖与配置参考：[web-push 官方维护库](https://github.com/web-push-libs/web-push)、[MDN PushManager.subscribe](https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe)。原生 APNs 的签名能力与 Web Push 独立，不能因为 PWA 可用就向免费 Personal Team 的原生 App 添加 APNs entitlement；见 [Apple 支持能力表](https://developer.apple.com/help/account/reference/supported-capabilities-ios/)。
