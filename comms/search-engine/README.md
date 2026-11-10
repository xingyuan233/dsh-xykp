# search-engine

一站式替换 DSH 的 `web_search` / `web_fetch` 后端，**不发模型请求**，所以不会产生
官方 `server-tool-search` 那笔检索费用；抓正文也不需要外部 API key。

注册两个 `dsh-web` provider：

| 类型 | id | 作用 |
| --- | --- | --- |
| search | `free` | 抓 Google / Bing / 百度的结果页，解析标题 / 链接 / 摘要并按优先级合并 |
| fetch | `reader` | 抓网页正文：去导航 / 广告 / 评论，优先取 `<article>`；被反爬拦时用本机 Chrome 渲染 |

## 为什么

官方搜索 `@deepseek-ai/dsh-web-search-deepseek` 每次检索都是一次带 `server-tool-search`
的模型请求（账单里那项就是它）。官方抓取 `@deepseek-ai/dsh-web-fetch-http` 虽然是本地的，
但只做裸 HTTP + 整页转 markdown，导航栏和广告全在里面，遇到 Cloudflare 直接失败。

代价：只有原始结果（标题 / 链接 / 摘要），没有模型替你综合作答；反爬限制是常态。

## 引擎优先级（默认 `[google, bing, baidu]`）

| 引擎 | 状态 | 说明 |
| --- | --- | --- |
| Google | ✅ 需要本机有 Chrome/Edge | 普通 HTTP 只拿到 enablejs 页，所以用无头浏览器 `--dump-dom` 渲染；结果链接被改写成 `/goto?url=<加密串>`，再逐条请求拿 302 里的真实地址。一次搜索约 +5–8s |
| Bing | ✅ 可用但排名差 | 走 RSS 出口（`&format=rss`）；这台机器上多词长尾只按第一个词给「官网/教程首页」 |
| 百度 | ✅ 可用 | 结果里带 `mu="真实地址"`，广告块有「广告」标记会被丢掉 |

## 启用方式

profile 的 `cordis.patch.yml` 里把 `web` 行指过来（两个 provider 都要显式选，否则会报
`WEB_PROVIDER_AMBIGUOUS`）：

```yaml
- id: web
  config:
    searchProvider: free
    fetchProvider: reader
```

换回官方：`searchProvider: deepseek-official`、`fetchProvider: http`。改完需重启 dsh web。

## 搜索怎么工作

1. 配置里的引擎**并发**请求，按 `engines` 的顺序做优先级。
2. 结果按 URL 去重、按名次交替合并（google 1 名、bing 1 名、baidu 1 名……）。
3. **首页/导航页排到最后**（路径为空、`/index.html`、标题基本等于站名）：Bing 偏爱这种结果。
4. 某引擎失败（超时 / 非 200 / 人机验证 / 解析 0 条）静默降级；命中人机验证的引擎冷却
   `cooldownMs`（默认 10 分钟）。全挂才报 `WEB_SEARCH_FAILED`，错误里带每家的原因。
5. 同一 query + 引擎缓存 10 分钟。

## 抓取怎么工作

1. 带浏览器头请求（`accept-language`、`upgrade-insecure-requests`），跟随重定向。
2. 判定「被拦」：403/429/503、Cloudflare / 人机验证文案、正文 < 300 字，
   或「段落 < 3 且脚本一堆」的空壳页 → 有 Chrome 就用无头浏览器渲染再取 DOM。
3. 清理：删 `<script>/<style>/<iframe>/<nav>/<footer>/<aside>/<form>` 和 class/id 命中
   ad/banner/sidebar/share/comment/related/cookie 的容器；有 `<article>` 取最长的那个，
   其次 `<main>`，否则整页。
4. 输出 `kind: 'html'`（交给工具转 markdown）或非 HTML 时 `kind: 'text'`；超过 `fetchMaxChars`
   截断并标记 `truncated`。正文 < 80 字直接报错，不返回垃圾。
5. SSRF 防护：只允许 http(s)，拒绝 localhost / 内网 / link-local 地址。

## 配置

```yaml
- id: search-engine
  name: 'dsh-xykp/comms/search-engine'
  config:
    enabled: true
    providerId: free              # 搜索 provider id
    engines: [google, bing, baidu]
    maxResults: 8
    timeoutMs: 12000
    cacheTtlMs: 600000
    cooldownMs: 600000
    locale: zh-CN
    userAgent: ''
    blockHosts: [google.com, gstatic.com, bing.com, baidu.com, bdstatic.com]
    fetchProviderId: reader       # 抓取 provider id
    fetchEnabled: true
    fetchMaxChars: 200000
    fetchTimeoutMs: 20000
    fetchBrowserFallback: true    # 被拦时用浏览器渲染
    browserPath: ''               # 空 = 自动找 Chrome/Edge
    browserProfileDir: ''         # 空 = %TEMP%\dsh-web-search-free-browser
    browserTimeoutMs: 15000
    debug: false
```

## 已知限制

- 引擎/网站改版会让解析失效，规则在 `engines.js`（`parseBingRss` / `parseBing` / `parseBaidu` /
  `parseGoogle`）和 `reader.js`（`cleanHtml`）。
- 搜索不能翻页，一次只取第一页。
- 不走系统代理；要过代理就用 `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY` 启动 dsh。
- Reddit 一类站点连无头浏览器都会挡（会明确报「没有可读正文」，不会静默返回空）。
- 试过在这台机器上不可用的引擎：DuckDuckGo / Brave / Yahoo / Searx 公共实例（连不上）、
  Mojeek（验证码）、Yandex（302）、Ecosia（403）、360 / 搜狗（人机验证）。

## 自测

```powershell
# 在 D:\AI\DeepseekHarness\workspaces\default-workspace 下
node probe\final.mjs "sqlite wal checkpoint"           # 搜索
node probe\fetch.mjs "https://www.sqlite.org/wal.html" # 抓正文
```

## 结果重排与富化（ranking.js）

抓完 SERP 后不再直接按引擎名次交替输出，而是做一轮本地「rerank」，尽量对齐官方
`api-docs.deepseek.com/zh-cn/guides/search` 的返回形态（rerank + summary + date）：

1. **关键词覆盖度**：中英文分词（拉丁词 + 中文 bigram），用文档频率算 IDF——品牌词
   （deepseek / cloudflare）权重自动变低，「发布 / release / 特定函数名」这类区分词权重变高。
2. **站点权威度**：docs.*、github、MDN、wikipedia、gov/edu 加分；CSDN 下载页、文库、
   聚合站、淘宝京东等降权，低于阈值的直接丢。
3. **导航页降权**：首页、GitHub 组织主页、GitHub 仓库主页（`/user/repo`，且 query 没有
   找库意图）基本不参与排位。
4. **同域限流**：默认每站最多 2 条（`perHost`），避免整屏 CSDN。
5. **字段富化**：抓前 N 条页面（`enrichLimit`，默认 min(limit,6)，并发、4.5s 超时），从
   meta / JSON-LD / URL / 正文里补 `publishedAt`，并把 snippet 换成「与 query 相关的那段
   正文」；页面抓不到就保持原 SERP snippet，不会变空。
6. **降级**：富化/重排任何一步失败，回退到旧的交替合并顺序，保证工具永远有结果。

重排/富化的阈值都是**代码内置默认**（enrich 开、top 6 条、4.5s 超时、每站 2 条），不新增配置项。
插件参数统一还是走 Web 设置页（写入 `home\xykp\config.yml` 的 `search-engine` 段），没有第二份配置文件。

已知限制：

- Google 结果链接是加密 `/url?q=`，需要逐条 302 + meta-refresh 解出真实地址，并把
  并发压到 3；单次通常只能稳定解出 5–10 条（Google 有速率限制），标题/摘要/日期本身是准的。
- Bing 在 CN 出口下长尾质量很差（只按首个词给结果），现在基本只做候选池补充。
- 语义层面的「X 和 Y 的区别」类查询仍不如官方模型级 rerank；但在「查文档/查数值/查发布」上
  已能给出官方风格的 4–8 条：干净 URL + 相关摘要 + 日期。

本地评测（不经过 dsh web）：

```powershell
node bench.mjs "cloudflare workers durable objects limit" "DeepSeek V4.1 Flash 发布"
```
