# web-search-free

给 DSH 的 `web_search` 换一个**不花钱**的搜索后端：直接抓 Google / Bing / 百度 的结果。

## 为什么

官方 `@deepseek-ai/dsh-web-search-deepseek` 走的是 DeepSeek 服务端的联网检索，每搜一次都是一次
带 `server-tool-search` 的模型请求，所以账单里会单独出现 `server-tool-search`。这个插件只发
普通 HTTP GET，不发模型请求，不烧 API 额度。

代价：只有原始结果（标题 / 链接 / 摘要），没有模型替你综合作答；反爬限制是常态。

## 引擎优先级（默认 `[google, bing, baidu]`）

| 引擎 | 状态 | 说明 |
| --- | --- | --- |
| Google | ⚠️ 本机 IP 被拦 | 普通 HTTP 拿到的是 enablejs 页，无头 Chrome 也会被甩 captcha。解析器已写好（`parseGoogle`），IP 干净时自动可用 |
| Bing | ✅ 可用但排名差 | 走 RSS 出口（`&format=rss`）；这台机器上多词长尾只按第一个词给「官网/教程首页」 |
| 百度 | ✅ 可用 | 结果里带 `mu="真实地址"`，广告块有「广告」标记会被丢掉 |

已从默认里删掉 360、搜狗（主人指定不用；广告/加密跳转多、还频繁人机验证），解析代码也一并删了。

## 装上之后怎么生效

它是 `dsh-web` 的一个 provider（默认 id `free`），`web_search` 工具本身不用动。profile 的
`cordis.patch.yml` 里把 `web` 行指过来：

```yaml
- id: web
  config:
    searchProvider: free
    fetchProvider: http
```

换回官方检索：`searchProvider: deepseek-official`。改完需重启 dsh web。

## 工作方式

1. 配置里的引擎**并发**请求，按 `engines` 的顺序做优先级。
2. 结果按 URL 去重、按名次交替合并（google 1 名、bing 1 名、baidu 1 名……）。
3. **首页/导航页排到最后**（路径为空、`/index.html`、标题基本等于站名）：Bing 偏爱这种结果，
   这层过滤就是为它写的。
4. 某引擎失败（超时 / 非 200 / 人机验证 / 解析 0 条）静默降级；命中人机验证的引擎冷却
   `cooldownMs`（默认 10 分钟）。全挂才报 `WEB_SEARCH_FAILED`，错误里带每家的原因。
5. 同一 query + 引擎缓存 10 分钟。

## 配置

```yaml
- id: web-search-free
  name: 'dsh-xykp/web/web-search-free'
  config:
    enabled: true
    providerId: free
    engines: [google, bing, baidu]   # 想跳过 Google 就写 [bing, baidu]
    maxResults: 8
    timeoutMs: 12000
    cacheTtlMs: 600000
    cooldownMs: 600000
    locale: zh-CN
    userAgent: ''
    blockHosts: [google.com, gstatic.com, bing.com, baidu.com, bdstatic.com]
    debug: false
```

## 已知限制

- 引擎改版会让解析失效，规则在 `engines.js`（`parseBingRss` / `parseBing` / `parseBaidu` / `parseGoogle`）。
- 不能翻页，一次只取第一页。
- 不走系统代理；要过代理就用 `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY` 启动 dsh。
- 试过在这台机器上不可用的：DuckDuckGo / Brave / Yahoo / Searx 公共实例（连不上）、
  Mojeek（验证码）、Yandex（302）、Ecosia（403）、360 / 搜狗（人机验证）。

## 自测

```powershell
# 在 D:\AI\DeepseekHarness\workspaces\default-workspace 下
node probe\final.mjs "sqlite wal checkpoint"
```
