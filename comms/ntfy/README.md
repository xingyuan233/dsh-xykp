# dsh-ntfy

ntfy 频道的通用小组件：**推消息**和**等消息**。给别的插件复用，也给模型当工具用。

## 能力

```js
const ntfy = ctx.get('ntfy')          // 别的插件里拿（本插件 ctx.provide('ntfy', service)）

await ntfy.push({ message: 'hello' })                       // 推文本
await ntfy.push({ filePath: 'D:/x/qr.png', title: '码' })   // 推文件（图片就是附件）
const r = await ntfy.wait({ match: '/post', timeoutMs: 60_000 })  // 等一条消息
if (r.ok) console.log(r.message.message)
```

`wait` 的 `match`：

- 纯文本 → 正文**完全相等**（去首尾空白）
- `re:...` → 正则
- 函数（只有服务端能用，工具只能传字符串）

## 模型工具

| 工具 | 参数 |
|---|---|
| `ntfy_push` | `topic` / `message` / `title` / `tags` / `priority` / `filePath` |
| `ntfy_wait` | `topic` / `match` / `timeoutSeconds` / `since` |

不传 `topic` 时用配置里的 `defaultTopic`。

## 配置

```yaml
- insert:
    - id: ntfy
      name: 'dsh-ntfy'
      config:
        baseUrl: 'https://ntfy.sh'        # 自建服务器改这里
        defaultTopic: ''                   # 留空则每次调用都要传 topic
        pollMs: 2000                       # wait 的轮询间隔
        defaultTimeoutSec: 300             # wait 不给超时时的默认值
        requestTimeoutMs: 15000            # 单次 HTTP 超时
```

## 注意

- 发**文件**时 ntfy 会把正文改成 `You received a file: <文件名>`，所以附件消息没法拿正文匹配——用函数匹配 `m.attachment?.name`，或在调用方记下消息 id。
- 中文标题按 latin1 塞 Header（ntfy 的 Header 只认 latin1），别自己再编码一次。
- `wait` 默认从「调用那一刻」开始等；要补看历史，传 `since`（unix 秒或 `all`）。

## 自测

```powershell
node test/ntfy-test.mjs
```
