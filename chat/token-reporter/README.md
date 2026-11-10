# chat/token-reporter — token 用量与账号余额

给每个会话附带 token 信息，并提供 `token_report` 工具查余额和用量。

- **工具 `token_report` 是全局的**，一直可用，没有开关——工具定义只占系统提示词一次
  （KV 缓存友好），关掉反而会让工具集变化、整段提示词重传，纯浪费。
- **`presets` 决定「哪些预设想在每轮系统提示里看到 token 用量摘要」**：
  `presets.blacklist: false`（默认）是**白名单**，只有 `presets.list` 里的预设带摘要，
  `list` 空 = 都不注入；`blacklist: true` 是**黑名单**，`list` 里的预设不注入，其余都有。
- 摘要**每个字段一个开关**（`prompt.fields` 下的 bool），默认全开，想关哪个就设成 `false`。

## 配置

```yaml
- insert:
    - id: token-reporter
      name: 'dsh-xykp/chat/token-reporter'
      config:
        presets:                 # 注入范围；工具照样全局可用
          list: [alive]          # 预设 id，白名单/黑名单里意思见上
          blacklist: false       # false = 白名单（只注入 list）；true = 黑名单（list 不注入）
        prompt:                  # 摘要格式，字段每个一个开关，默认全开
          order: 880             # 提示里的顺序（越大越靠后）
          header: '[token]'
          fields:
            turn: true           # 上一步 in/out/cacheRead
            session: true        # 会话累计
            cache: true          # 缓存命中率
            context: true        # 上下文占用
            price: true          # 估算花费
        cost:                    # 可选：元 / 百万 token，用来估算（0 = 不显示费用）
          input: 2
          cacheRead: 0.2
          output: 3
        sessionsRoot: ''         # 默认 $DSH_HOME/sessions
```

### prompt.fields 可选项

| 字段 | 内容 |
|---|---|
| `turn` | 上一步的 in / out / cacheRead（tokenUsage.last） |
| `session` | 本会话累计（input + cacheRead + cacheWrite + output） |
| `cache` | 缓存命中率（cacheRead / prompt 总量） |
| `context` | 上下文占用 / 窗口大小（contextPressure） |
| `price` | 按 `cost` 单价估算的会话费用（单价为 0 时不显示） |

> `price` 叫 `price` 不叫 `cost`，是为了和上面 `cost` 单价那组不撞名（界面标签按字段名走）。
> 每个字段都是 bool：`true` 显示、`false` 隐藏，默认全开。
> 老写法（`fields: [turn, cost]` 列表）也还认——列出来的开，没列的关。

> 摘要每轮都会被新的一份替换（system prompt 节点是 replace 语义，不会累加），
> 所以不需要额外「折叠」；会被 `toolret-forget` 抹掉的是**工具结果**，见下。

## 工具 token_report

| 参数 | 说明 |
|---|---|
| `action` | `balance` 余额 / `usage` 时间段用量 / `session` 本会话 / `all`（默认） |
| `since` | `today` / `7d` / `24h` / `30m` / `YYYY-MM-DD` / ISO，默认 `7d` |
| `until` | 同上，默认现在 |
| `provider` / `model` | 子串过滤（如 `deepseek-account`、`deepseek-flash`） |
| `group_by` | `day`（默认）或 `model` |

### 余额来源（按顺序）

1. DSH 的 `deepseekAccount` 服务（平台登录态）：`getBalance()` 读
   `platform.deepseek.com/api/v0/users/get_user_summary`，充值/赠金分开。
2. 环境变量 `DEEPSEEK_API_KEY` → 官方 `GET https://api.deepseek.com/user/balance`
   （`is_available` + 各币种 total/granted/topped_up）。

### 用量来源

扫 `$DSH_HOME/sessions/<workspace>/<session>/session*.jsonl[.zstd]`：
每个 `assistant/message` 事件的 `data.usage` 是 provider 上报的精确用量，
`data.message.source` 带 provider/model。首次扫描 7 天约 1.2s，之后按文件 mtime 缓存。

> 为什么不用 `storages/preset-binder.json`：那张表只记配置里列出的预设
> （`standard`/`ptc`/`minimal`/`cordis` 被 ignore），而且 `maxSessions: 5`，
> 只覆盖最近几个会话。日志才是全量。

## 关于「官方用量接口」

- 余额：官方有 `GET /user/balance`（[文档](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/)）。
- 时间段用量：**官方没有公开接口**。平台后台的用量报表走的是私有接口
  `/api/v0/usage/cost`、`/api/v0/usage/amount`，需要浏览器里的 `userToken`
  （第三方项目 `dsh-deepseek-balance` 就是这么做的），未公开、可能随时变。
  所以本插件默认用本地会话日志统计 DSH 自己的用量；非 DSH 调用（别的客户端/脚本）
  不在统计范围内。

## 注意

- 工具全局可用；`presets` 只管摘要注入，不填就不注入。
- `token_report` 的结果只看当前那份，旧的不留：默认把它填进 `toolret-forget` 的
  `autoForget` 名单，回合结束就折叠，下一轮不会带着上一轮的 token 信息：

  ```yaml
  - insert:
      - id: toolret-forget
        name: 'dsh-xykp/chat/toolret-forget'
        config:
          presets: [alive]
          autoForget: [token_report]
  ```

  注意 `toolret-forget` 也按 `presets` 生效——要让别的预设也折叠，两边的 `presets` 得对得上。
- `usage` 只统计经过本机 DSH 的调用；换机器/换 home 目录后数字从那时开始。
- 订阅型 provider（官方返回 usage 不带价格）没有单价信息，费用只能按 `cost` 自己填的价估。

## prompt.transferHint（2026-10-27）

上下文占比到阈值时，摘要里多一句提醒（让她自己判断要不要用 `memory_movctx` 转移对话）：

```yaml
prompt:
  transferHint:
    enabled: true   # 默认开；false = 不提醒
    at: 0.5         # 占比阈值，0.5 = 一半（太长注意力会散、容易丢角色）
    text: ''        # 提醒文案，留空就用内置默认；支持 {pct} / {used} / {window}
```

`text` 现在可以直接在配置面板里改（换行也行），不动代码。

默认文案（等价于下面这行，也可以直接抄进配置）：

```yaml
text: '⚠ 上下文已用 {pct}%（{used}/{window}），再长下去注意力会散、容易丢角色 —— 想接着认真聊就调 memory_movctx 把交接带到一个新对话，或者先问问要不要转。'
```

渲染出来的样子：

> ⚠ 上下文已用 52%（104k/200k），再长下去注意力会散、容易丢角色 —— 想接着认真聊就调
> memory_movctx 把交接带到一个新对话，或者先问问要不要转。

