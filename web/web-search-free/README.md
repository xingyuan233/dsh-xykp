# web-search-free

给 DSH 的 `web_search` 换一个**不花钱**的搜索后端：直接抓 360 / Bing 的搜索结果。

## 为什么

官方 `@deepseek-ai/dsh-web-search-deepseek` 走的是 DeepSeek 服务端的联网检索，每搜一次都是一次
带 `server-tool-search` 的模型请求（服务端还会自己抓页面、生成摘要），所以账单里会单独出现
`server-tool-search` 这一项。这个插件只发普通 HTTP GET 去搜索引擎，不发模型请求，不花 API 额度。

代价先说清楚：

- 只有原始结果（标题 / 链接 / 摘要），**没有模型替你综合作答**。要读正文就配合 `web_fetch`。
- 结果质量不如商业搜索 API：中文技术查询经常被 CSDN 一类站占位，Bing 从这个网络看排名很「导航化」
  （多词长尾基本只按第一个词给官网/百科）。适合快速定位链接，不适合要高质量综述的场合。
- 360 访问多了会弹人机验证，插件会把它冷却 10 分钟（`cooldownMs`），期间只剩 Bing。
- 真想要高质量又不花这份钱，可以在 `blockHosts` 里屏蔽采集站，或者自己接一个带 key 的搜索 API
  （Tavily / 博查 / Serper 这些都测过，网络能通，只是没 key）。

## 装上之后怎么生效

它是 `dsh-web` 的一个 provider（默认 id `free`），`web_search` 工具本身不用动。在 profile 的
`cordis.patch.yml` 里把 `web` 行指过来：

```yaml
- id: web
  config:
    searchProvider: free
    fetchProvider: http
```

想换回官方检索：`searchProvider: deepseek-official`。两个 provider 可以同时注册，配置说了算
（不配置且两个都可用时会报 `WEB_PROVIDER_AMBIGUOUS`，所以必须显式选一个）。

改完需重启 dsh web 才会生效。

## 工作方式

1. 配置里的引擎**并发**请求（默认 `[so, bing]`，360 排前面是因为它的长尾结果更对题）。
2. Bing 走 RSS 出口（`&format=rss`），结构固定、体积小；偶尔退回 HTML 时用 `b_algo` 解析兜底。
   360 解析 `<li class="res-list">` 的 `data-mdurl`（它的 href 是加密跳转，不能用）。
3. 按 URL 去重（抹掉 `utm_*`、`spm` 之类的跟踪参数），两个引擎的结果**按名次交替**合并，
   避免某一家霸占前几条。
4. `blockHosts` 里的域名直接丢掉（默认滤掉 360 自家的导流位和搜索引擎域名）。
5. 某引擎失败（超时 / 非 200 / 人机验证 / 解析 0 条）就静默降级；全挂才报
   `WEB_SEARCH_FAILED`，错误里带每个引擎的原因。同一个 query + 引擎缓存 10 分钟。

## 配置

```yaml
- id: web-search-free
  name: 'dsh-xykp/web/web-search-free'
  config:
    enabled: true
    providerId: free          # 注册成哪个 provider id
    engines: [so, bing]       # 并发；只想用一个就 [bing] 或 [so]
    maxResults: 8             # web_search 未指定 maxResults 时的上限（1–20）
    timeoutMs: 12000          # 单个引擎超时
    cacheTtlMs: 600000        # 同 query 缓存时长，0 = 关
    cooldownMs: 600000        # 触发人机验证后歇多久再试
    locale: zh-CN             # 影响 Bing 的 setlang 与 Accept-Language
    userAgent: ''             # 空 = 内置 Chrome UA
    blockHosts: [so.com, 360kan.com, 360doc.com, hao.360.cn, bing.com]
    debug: false              # true 时把每次降级原因打到 stderr
```

## 已知限制

- 引擎改版会让解析失效，规则集中在 `engines.js`（`parseBingRss` / `parseBing` / `parseSo`）。
  `debug: true` 会把「没有解析出结果」打到 stderr。
- 不能翻页，一次只取第一页。
- 不走系统代理；机器能直连 `www.so.com` / `cn.bing.com` 即可（要过代理就用
  `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY` 启动 dsh）。
- 试过在这台机器上不可用的免费引擎（别再踩）：Google 要 JS、DuckDuckGo / Brave / Yahoo /
  SearX 公共实例连不上、Mojeek 和 360 会给人机验证、Yandex 302、Sogou 结果全是加密跳转链接。

## 自测

```powershell
# 在 D:\AI\DeepseekHarness\workspaces\default-workspace 下
node probe\final.mjs "sqlite wal checkpoint"   # 走 createSearchProvider()，不依赖 cordis context
```

（`probe/` 是工作区里的临时脚本，看着有用于是留了一份。）
