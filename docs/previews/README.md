# 界面截图

[项目首页](../../README.md) · [验证记录](../verification.md)

## 当前展示

采集日期：2026-10-23。项目首页使用分类页，不展示书架。

| 平台与页面 | 版本 | 原图尺寸 | 文件与检查 |
| --- | --- | --- | --- |
| iPhone 原生 · 玄幻奇幻分类 | 0.10.0 / build 13 | 1206 × 2622 | [iphone-categories.png](iphone-categories.png)，首屏九张真实来源 JPEG 封面全部加载，无加载圈或文字占位 |
| Web · 修真武侠分类 | 0.10.0 | 390 × 844 | [web-mobile-categories.jpg](web-mobile-categories.jpg)，首屏六张封面 complete 为真、naturalWidth 大于零，实际页面与截图均已核对 |
| HarmonyOS · 玄幻奇幻分类 | 0.11.0 / versionCode 1，开发中 | 1320 × 2232 | [harmony-categories.png](harmony-categories.png)，来自官方 HarmonyOS 7.0.0 / API 26 手机模拟器，可见四张来源封面已实际加载 |

所有展示图来自实际运行页面，不用生成图片或设计稿替代界面。截图均没有账号、私人服务器地址、令牌或设备标识；原图直接采集，未编辑封面或拼接页面。模拟器与响应式视口检查不代替真机兼容性验证；鸿蒙图不代表已有已签名发布包。

## 历史阅读界面

以下图片采集于 2026-10-21，保留对应版本标注，不代表 0.10 的当前界面。

### iPhone 0.8.2 / build 10

从专用 iPhone 模拟器中已安装的原生 App 采集，PNG 原图 1206 × 2622。阅读页使用公版《桃花源记》；没有操作真机或导出私人账号数据。

| 页面 | 原图 |
| --- | --- |
| 沉浸阅读 | [iphone-reader.png](iphone-reader.png) |
| 页数进度条与阅读菜单 | [iphone-controls.png](iphone-controls.png) |
| 侧边目录与缓存状态 | [iphone-catalog.png](iphone-catalog.png) |

### Web 0.8.1

从实际部署页面采集。手机尺寸图片使用浏览器 390 × 844 响应式视口，属于移动布局检查，不替代手机系统与浏览器的真机兼容性测试。桌面为默认 1280 × 720 视口。

| 页面 | 原图 |
| --- | --- |
| 手机沉浸阅读 | [web-mobile-reader.jpg](web-mobile-reader.jpg) |
| 手机阅读菜单 | [web-mobile-controls.jpg](web-mobile-controls.jpg) |
| 桌面阅读器 | [web-desktop-reader.jpg](web-desktop-reader.jpg) |

Web 图片为浏览器原始 JPEG 截图。阅读示例为《桃花源记》，电量显示取自浏览器能力检测；未加入模拟百分比。

## 维护

首页优先展示推荐或分类页，等待可见封面全部加载后采集，保留原始纵横比。更新时同步记录客户端版本、设备或浏览器视口；模拟器与响应式视口检查不能代替真机兼容性验证。历史记录仍引用的截图予以保留。

原生 Debug 可通过启动参数 `--qingread-preview categories --qingread-category 1` 打开真实分类页；此入口不更改正常启动或 Release 默认分类。
