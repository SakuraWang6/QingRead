# 书源格式 v1

本格式是清读首版的声明式配置，不是 Legado 完整兼容层。导入一次来源后，读者输入书名搜索即可，不需要逐本粘贴网址。

## 内置来源

- **笔趣阁 · biequgei**：通过网站真实 GET 搜索接口查找小说，已验证用户指定的两本书；解析完整目录区域，避免把顶部倒序更新列表误当正序目录。
- **我书阁**：真实 GET 站内搜索，作为另一小说来源。已验证《超神机械师》，《这游戏也太真实了》本次未命中。不能据此认为该书不存在于所有来源。
- **古典小说精选**：本机匹配预置书名与作者，按需从 `luoxuhai/chinese-novel` 获取真实目录与章节。目前包括《三国演义》《西游记》《红楼梦》。搜索不需要联网，阅读尚未缓存的章节需要联网。
- **中文维基文库**：通过 MediaWiki Action API 真正远程搜索。不同版本或单篇也可能作为结果出现；目录按书页子页面提取，短文按单章处理。网络可达性因地区而异。

来源的名称和主页保存在每个结果中，可以打开原始网页核对。关闭某来源只影响后续搜索，不主动删除缓存。

## 导入 JSON

在“书源”中选择文件，或粘贴 JSON。支持单个来源对象、来源数组，或者 `{"sources": [...]}`。`id` 必须唯一且不能覆盖内置 ID。一次最多 100 个来源。

HTML 站点的格式如下。`example.com` 是说明占位符，不是可用小说来源；需要换成目标站点实际地址和选择器。

```json
{
  "id": "my-site",
  "name": "我的来源",
  "summary": "根据目标站点结构填写的规则",
  "homeURL": "https://example.com/",
  "kind": "html",
  "html": {
    "searchURL": "/search?keyword={query}",
    "encoding": "utf8",
    "resultSelector": ".book-item",
    "titleSelector": ".title",
    "linkSelector": "a.title",
    "authorSelector": ".author",
    "summarySelector": ".summary",
    "catalogLinkSelector": "a.catalog",
    "chapterSelector": ".chapters a",
    "contentSelector": "#chapter-content",
    "removeSelectors": [".ads", ".navigation"]
  }
}
```

| 字段 | 含义 |
| --- | --- |
| `searchURL` | 绝对地址或相对主页路径，必须有 `{query}` 占位符；首版为 GET 请求 |
| `encoding` | `utf8`（默认）或 `gb18030`，对应网页解码与搜索词编码 |
| `resultSelector` | 搜索结果中每本书的容器 |
| `titleSelector` | 在每个结果容器内提取书名 |
| `linkSelector` | 在结果容器内选择书籍链接，提取 `href` |
| `authorSelector` / `summarySelector` | 可选作者、简介选择器 |
| `coverSelector` | 可选封面 `img` 选择器；首版 App 不请求网络封面 |
| `catalogLinkSelector` | 可选；书籍页另有目录链接时填写，否则直接在书籍页提取目录 |
| `chapterSelector` | 目录中的章节链接选择器，按页面出现顺序读取 |
| `contentSelector` | 章节正文容器 |
| `removeSelectors` | 从正文移除的节点，默认空数组；脚本和样式始终清理 |

HTTP 来源受 iOS App Transport Security 限制。首版工程使用系统默认安全网络策略，实际使用请提供 HTTPS 来源。不会为导入规则全局关闭系统网络安全检查。

## 尚未支持

首版不执行 JavaScript，不支持 XPath、JSONPath、带脚本的 Legado 规则、POST 搜索、自定义 Cookie 登录、验证码自动处理、目录翻页和正文跨页拼接。导入其他软件的复杂书源可能因格式不匹配而失败，需要为本站编写声明式规则。

## 回归检查

修改规则时，至少核实搜索结果、相对链接、目录顺序、正文分段和空内容失败信息。不要只验证能打开首页。真实网站会改版，应把可公开的最小 HTML 样本放进测试 fixtures，避免依赖持续联网的测试。
