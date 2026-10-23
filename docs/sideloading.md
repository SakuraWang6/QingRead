# 免费无线续签

## 本机采用的 Xcode 方案

本机已实际验证：在 iPhone 数据线拔掉、Mac 连接该 iPhone 个人热点的情况下，使用已登录的 Xcode 账号获取新签名，确认到期时间确实延后，校验代码签名后无线安装清读，并成功无线启动。没有额外安装手机 App，没有导出签名密钥或保存新的 Apple 密码。

已验证后台完整续期和无线安装。当前源码为 0.11.0/build 15，设备安装与独立续签副本的最终版本以[验证记录](verification.md)为准；签名有效期以实际描述文件日期为准。后台任务每四小时检查，剩余三天以内才尝试续期。

安装后台任务（先完成一次签名构建及手机安装；设备标识由使用者在本机传入）：

```sh
python3 scripts/install-refresh-agent.py --device '<已配对的设备标识>'
```

任务在当前用户登录 Mac 后运行，每四小时检查一次；签名还剩三天以内才尝试续期。需要 Mac 开机、Xcode 账号仍可用，以及手机能通过当前网络连接 Mac。手机休眠或锁定时可能无法连接，后续检查会再次尝试。它不保证 Mac 离线时也能续签。

源代码和已有清读产物复制到 `~/Library/Application Support/QingReadRefresh` 独立运行，避开后台进程访问 Documents 的授权问题。任务是 `~/Library/LaunchAgents/app.qingread.refresh.plist`，日志位于运行目录 `work/logs/`。配置仅本机保存；设备标识、Team、描述文件和签名备份不提交仓库。更新清读版本后，重新执行安装器同步运行副本。

每次续期只临时移走清读自己匹配的缓存描述文件，备份可恢复；干净构建后同时检查新的签发时间、更晚的到期时间和严格代码签名。手机已卸载清读时不重装；检测到更新版本时不降级。失败不安装无效产物，旧缓存可以恢复。

停止后台任务并保留所有运行资料与备份：

```sh
python3 scripts/install-refresh-agent.py --uninstall
```

校园网相同 SSID 不代表设备可互访。本次校园网下手机拔线即不可达，换个人热点后实时连接和无线安装成功。因此在校园网内不能保证自动续期；需要在到期前让两台设备接入可互访的网络，或暂时把 Mac 连到手机个人热点。热点使用手机流量，不需要一直保持。

免费个人签名不具备原生 APNs 推送能力。原生追更使用系统允许的后台检查与本地通知；需要远程推送时，可在 iOS 16.4+ 将 HTTPS Web 添加到主屏幕，登录并主动开启 Web Push。推送不改变签名有效期，也不能用于应用后台保活，见[通知说明](reading-workflows.md)。

依据：[Apple 的 profile 缓存与重新请求规则](https://developer.apple.com/help/account/provisioning-profiles/edit-download-or-delete-profiles/)、[Personal Team 七天限制](https://developer.apple.com/help/account/basics/about-your-developer-account/)、[Device Hub 无线连接](https://developer.apple.com/documentation/xcode/managing-your-simulated-and-physical-devices-in-device-hub)。仅重复 build 并不能证明有效期延长；本工具核对实际 profile 日期后才安装。

## AltStore 备选方案

使用 AltStore **Classic**，Mac 安装官方 [AltServer](https://altstore.io/)。不需要付费 Apple Developer 会员。免费签名依然只有 7 天，AltStore 会尝试在到期前刷新；iOS 的后台调度并不保证每次成功。

### 首次配置

1. 用线连接并解锁 iPhone；访达选择该设备，在「通用」打开「接入 Wi-Fi 时显示此 iPhone」，应用更改。
2. 启动 `/Applications/AltServer.app`，从菜单栏选择 Install AltStore 和自己的设备。
3. 用户在官方 AltServer 窗口输入 Apple 账号和密码，并完成本人验证。不要把凭据发给开发者。
4. 在 iPhone 按系统提示信任个人开发签名，保持开发者模式开启。
5. 将清读 IPA 存入 iPhone「文件」，在 AltStore「My Apps」按「+」导入。应用必须出现在此处，AltStore 才能刷新它；原先的 Xcode 安装不会自动被接管。
6. 开启 AltStore 的 Background Refresh，以及 iOS 设置中的后台 App 刷新。允许它发现同一网络中的 AltServer。
7. Mac 的 AltServer 菜单打开 Launch at Login，保持 Mac 开机、AltServer 运行，手机与 Mac 接入同一 Wi-Fi。
8. 拔线后在 AltStore 点 Refresh All，确认清读和 AltStore 的有效期成功刷新。

首次改为 AltStore 安装前应备份清读自己的书架、阅读设置和缓存。若重签名改变 Bundle ID，系统会把它当成另一应用；确认数据迁移前保留原安装。IPA、证书、描述文件、设备标识和个人签名设置不要提交到仓库。

### 日常使用

AltStore 会尝试后台刷新。可以偶尔打开 My Apps 检查剩余天数或点 Refresh All；Mac 长期关机、网络隔离或后台任务没有运行时，仍可能到期。有效期不会因为安装了 AltServer 而永久延长。

账号输入框异常时，先在密码框按 Shift+Tab 回到账号框并切换 ABC 输入法；这是焦点排查，不代表账号已经验证。登录报错应按具体错误处理，不需要关闭 SIP、AMFI 或证书校验。

### 官方说明

- [macOS 安装步骤](https://faq.altstore.io/altstore-classic/how-to-install-altstore-macos)
- [AltServer 运行与同网要求](https://faq.altstore.io/altstore-classic/altserver)
- [AltStore 后台刷新设置](https://faq.altstore.io/altstore-classic/your-altstore)

本项目当前维护的是前文的 Xcode 续签路径；本机没有保留运行中的 AltServer。AltStore 的安装与后台刷新应按其官方当前文档单独配置，不能将 Xcode 安装的应用视为已由 AltStore 接管。
