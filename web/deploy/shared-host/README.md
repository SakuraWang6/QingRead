# 同一主机部署多个应用

清读可以放在独立域名，也可以使用 `/qingread/` 路径。共享 IP 的根路径应由统一导航或已有项目拥有，不应默认反向代理到清读。每个新项目部署前都需要核对整个 HTTPS 路由表；保留其他容器不代表保留了它们的网页入口。

## 构建子路径网页

在开发电脑执行：

```sh
cd web
QINGREAD_WEB_BASE=/qingread/ npm run build
```

将 `dist/` 上传至代理的只读静态目录。HTML、脚本、图标、PDF 辅助文件、PWA 启动地址与 Service Worker scope 均位于 `/qingread/`。默认构建仍使用 `/`，Android 打包不要设置这个子路径变量。

API 默认保留 `/api/`，因此同源书架数据库、登录状态及现有手机同步地址无需迁移。`QINGREAD_WEB_BASE` 只影响网页资源路径，不会修改 API 地址；如果改变 API 地址，需另行核对原生客户端与账号凭据绑定。

## 合并路由

下面是共享 Caddy 站点内部的片段，静态目录使用示例路径。现有其他项目的路由应先保留，再添加清读路由；有更具体的 `/api/其他项目` 路由时，要置于清读 `/api/*` 之前。

```caddyfile
redir /qingread /qingread/ 308

handle_path /qingread/* {
    root * /srv/www/qingread
    @entry path / /index.html /sw.js /manifest.webmanifest
    header @entry Cache-Control "no-cache"
    file_server
}

# Existing native clients continue using this API address.
@qingread_api path /api /api/*
handle @qingread_api {
    reverse_proxy qingread:8787 {
        flush_interval -1
    }
}

# Keep the host's own root/navigation and other app routes here.
```

路径分流不等于浏览器安全来源隔离；需要严格隔离不同应用的 Cookie、存储和脚本权限时，应使用各自的域名。导航页只列出适合公开的入口，免登录可操作的管理面板不自动列出。

## 从根路径迁移旧 PWA

仅修改反向代理不足以处理以前 scope 为 `/` 的清读 Service Worker；旧缓存可能继续把根页面显示为清读。

迁移期间在原 `/sw.js` 地址提供 [retire-root-sw.js](retire-root-sw.js)，设置 `Cache-Control: no-store`。它只注销原注册、重新加载受其控制的根页面，不删除 IndexedDB、localStorage 或图书。新清读只注册 `/qingread/sw.js`，scope 为 `/qingread/`。保留旧根路径的 `/assets/` 与 PDF 静态资源一段时间，以便已打开的旧网页完成保存；不要再将未知路径兜底交给清读。

如旧主屏幕图标仍以 `/` 启动，可在 `/manifest.webmanifest` 暂时提供新的清读 manifest。新添加的图标会从 `/qingread/` 启动；旧图标的更新时机取决于浏览器。

## 切换检查

1. 备份共享代理配置，记录全部容器的 ID、启动时间、健康状态与资源占用。
2. 在工作电脑编译，上传至新的版本目录，保留旧网页和业务数据。
3. 用 `caddy validate` 校验候选配置，确认没有删除其他项目的端口或路由，再用 `caddy reload` 热更新。只改静态目录和路由时不需要重启业务容器。
4. 验证根页面、每个项目入口、清读 API、PWA scope、PDF 资源及 APK 直链。不存在的页面和资源应返回 404，不能伪装成阅读器 HTML。
5. 复查容器 ID、启动时间、健康与 OOM。失败时恢复已备份配置并重新 reload，不改数据库或证书。
