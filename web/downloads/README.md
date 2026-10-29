# 安装包下载防护与统计

这是独立的 Node.js 24 服务，不依赖 npm 包，不启动阅读 API，也不打开账号数据库。它只分发部署者明确登记的安装包。原有下载 URL 可以保持不变。

## 文件清单

复制 [manifest.example.json](manifest.example.json) 到私有部署目录的 `download-config/manifest.json`，填入实际文件名、字节数和 SHA-256。示例中的长度与全零校验值必须替换。`names` 可以同时登记固定版本与 `latest` 别名，两者计入同一 `id`；别名直接映射实际普通文件，不使用文件系统符号链接。

启动时逐个校验文件类型、长度和完整 SHA-256。文件名只允许 ASCII 字母、数字、点、下划线和短横线，不允许路径或 `..`。安装包和根目录不能是符号链接；每次 GET 再核对文件的 inode、长度与时间戳。文件被覆盖或替换后会停止分发，需更新清单并重启下载服务。读取文件采用流式传输，单次缓冲为 64 KiB。

## 资源限制

默认每个 IP 每 10 分钟 60 次请求，全局每 10 分钟 600 次；单 IP 最多 2 个下载，全局最多 4 个下载。全局速率上限 512 KiB/s，单 IP 256 KiB/s，允许初始单块 64 KiB 突发。单次传输最长 120 秒，超时或客户端断开会释放连接与下载名额。IP 限流记录只存在内存，最多 4096 项，到期回收。

只接受 GET 和 HEAD。支持 ETag、If-None-Match、单段 Range 和匹配强 ETag 的 If-Range；不支持多段 Range。HEAD 忽略 Range，不传文件正文。非法路径、编码路径、查询参数及未登记文件均不能读取磁盘上的其他内容。

这些限制用于控制下载占用，不能阻止超过服务器公网带宽的大规模攻击；需要时仍应使用云厂商的网络防护。校园网等共用出口的用户共享该 IP 的限额。

## 共享主机部署

[compose.example.yaml](compose.example.yaml) 只包含新增服务，需合并到现有部署网络。复用主机已存在的清读 Node 24 镜像，不需要在线安装依赖。将 `server.mjs`、`stats.mjs` 放进 `download-service/`。`download-stats/` 使用独立目录，属主 UID/GID 1000、权限 700；不要与 `app-data/` 混用。示例不发布任何新的公网端口。

`QINGREAD_DOWNLOAD_PROXIES` 是 Caddy 在共享 Docker 网络中的精确 IP，可用逗号配置多个，不接受网段。代理 IP 发生变化时需更新此值并仅重建下载服务。服务不信任 X-Forwarded-For；下载请求只有来自这些代理且携带有效 `X-QingRead-Client-IP` 才会被接受。本机回环地址可以读取 `/health`，没有公开的统计 HTTP 接口。

保留共享 Caddy 的全部其他路由，只替换清读安装包的 handler；不要用本例替换整个站点：

```caddyfile
handle /downloads/QingRead-Android-*.apk {
    reverse_proxy downloads:8790 {
        header_up X-QingRead-Client-IP {http.request.remote.host}
        flush_interval -1
    }
}
```

这里必须用单值覆盖客户端传来的同名请求头，不能使用追加语法。若增加鸿蒙分发，另加明确的清读 HAP 路径匹配，并在私有清单登记实际文件；不要开放整个 `/downloads/` 目录。

发布前备份 Caddy 与 compose，记录现有路由和容器状态；先启动并验证下载服务，再 `caddy validate` 和 `caddy reload`。核对原 URL 的文件哈希、Range、统计、其他项目入口和容器启动时间。回滚只恢复下载 handler、停用新增服务，保留统计目录和原安装包。

## 查看统计

在部署目录通过 SSH 执行（容器服务名按实际配置替换）：

```sh
docker compose exec -T downloads node /service/stats.mjs /stats/downloads.sqlite
```

CLI 以只读模式打开独立 SQLite，输出启用时间 `enabledAt` 和每日、每个安装包的汇总，日期使用 UTC，保留最近 365 个 UTC 日期。固定版本和 latest 别名不会分开计数，不保存 IP、User-Agent、账号或请求日志。

| 字段 | 含义 |
| --- | --- |
| `requests` | 此安装包的请求数，包括 HEAD、304 和拒绝 |
| `full_downloads` | 完整发送并结束的 HTTP 200 文件响应次数，不代表独立人数或实际安装数 |
| `range_requests` | 已接受的 Range GET 次数，HTTP 206 不重复计入完整下载 |
| `bytes_sent` | 写入连接的文件正文总字节，不代表客户端已保存的字节 |
| `interrupted` | 已开始但因断开、超时或错误未完成的文件响应 |
| `rejected` | 被拒绝或文件检查失败的请求 |

未知路径统一计入 `unknown`，避免请求路径产生无限统计行。完整下载和传输计数即时写入；拒绝计数每秒合并事务写入，正常退出会刷新，异常掉电最多丢失最近一秒的拒绝计数。统计存储失败后服务停止接受下载并让健康检查失败，修复存储后重新启动；已发送完成的响应无法撤回。没有实施历史数据回填，统计从启用时间开始。

## 本地验证

```sh
node --test web/downloads/server.check.mjs
```

测试使用临时文件、临时 SQLite 和回环 HTTP 端口，覆盖清单校验、路径边界、代理身份、伪造转发头、限流恢复、并发、限速、断开和超时、Range、统计故障及重启持久化，不接触阅读账号数据库。
