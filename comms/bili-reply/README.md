# dsh-bili-reply

B 站「被回复 / 被 @ / 收到私信」这一半（清单里的 `comms/bili-reply`）：
**绑定预设或会话（预设优先），定时拉 @、回复、私信，新条目推给绑定会话。**

> 主动查 B 站（搜索、字幕、截帧、评论、发评论、发私信……）在 **bili-rove**，不在这里。

## 做什么

1. 启动跑一次，之后每 `tickMinutes`（默认 **3 分钟**）处理一批
2. 绑定目标：`preset`（优先级最高，读 `storages/preset-binder.json` 里该预设的活跃会话）→ 查不到就用 `session`
3. 从 `/x/msgfeed/at`（@ 我的）、`/x/msgfeed/reply`（回复我的）、私信会话三路拉取，
   按 `seen` 表去重，只推没推过的
4. 推送 = `createUserMessage` 造消息 + `agent.followup(...)` —— **真的叫醒会话跑一轮**
5. 推送后记账（`seen` 只留最近 300 条，不会越滚越大）
6. `dryRun` 只报告，不推、不记账

## 配置

```yaml
- id: bili-reply
  name: 'dsh-xykp/comms/bili-reply'
  config:
    preset: alive              # 预设优先
    session: ''                # 预设查不到时用这个
    maxPerTick: 2              # 每次最多处理几条
    tickMinutes: 3             # 处理间隔（分钟）
    maxQueue: 120              # 本地队列最多留几条
    keepUids: [3546798887013093]   # 这些 B站 uid 的条目不会被随机淘汰（默认主人自己）
    queuePath: ''              # 空 = <DSH_HOME>/bili-duty/reply-queue.json
    namesTtlHours: 168         # 昵称缓存有效期（小时）
    namesMaxFetchPerRun: 5     # 每轮（拉取时补名 / 后台重读）最多查几个新昵称
    namesRefreshBatch: 0       # 后台重读每批查几个（0 = 跟 namesMaxFetchPerRun 一样）
    namesRefreshEveryMinutes: 2  # 后台重读每批的间隔（分钟）
    kinds: [at, reply, dm]     # 拉哪几路（默认 at / reply / dm 三路）
    source: bili               # 'bili' 真接口 | 'none' 空转
    dryRun: false
```

### 工作方式（2026-10-27 改）

1. **本地队列空了才去接口拉**：一次把 @ / 回复 / 私信全拉到本地 `reply-queue.json`，再慢慢消化
2. 每 `tickMinutes` 分钟处理一批，一批最多 `maxPerTick` 条
3. 队列超过 `maxQueue` 条 → **随机淘汰**（`keepUids` 里的人不淘汰），淘汰的记进 `seen`，不会再被拉回来
4. 推送失败重试 3 次，还不成就丢掉，不堵队列
5. 队列文件自带 `name` 字段（默认「B站收件箱（bili-reply 本地队列）」），一眼能认出来
6. 队列里早前没查到昵称的旧条目，缓存里有了会直接补上（只读缓存、不查接口、不占额度）

## 私信

- `dm.js` 接进主拉取（默认 `kinds: [at, reply, dm]`），只翻 `unread_count > 0` 的会话
- 分享卡片（`msg_type=7/8`）从 `content` 里解出 bvid / 标题 / UP 名，不会当空消息丢掉

## 昵称缓存

- `names.js` 缓存 uid → 昵称（默认 7 天过期），`GET /dsh-bili-reply/names` 可查、`POST /dsh-bili-reply/names/reset` 可清
- 拉取时给私信补昵称：at / 回复自带昵称**直接记缓存、不占额度**；只有私信缺昵称才去查，
  每轮最多 `namesMaxFetchPerRun` 个，缺了渲染成「B站用户 uid」占位
- `POST /dsh-bili-reply/names/refresh` **后台分批**：先把全部条目标过期（名字保留），
  立刻返回 `{ ok, mode: 'background', queued, batch, everyMinutes }`；后台每
  `namesRefreshEveryMinutes` 分钟查一批、每批 `namesRefreshBatch` 个，直到查完
  （单批失败最多重试 3 批）。中途重启不会丢：启动时发现 `at=0` 但还有名字的会自动续上。
- **不做定时 refresh**：过期的昵称等真的用到时再更新（主人定的）

## ⚠️ 现状（2026-10-27 15:10 核对）

- ✅ 绑定解析、去重、消息渲染、轮询调度、推送适配器：`node test/reply-test.mjs` **18 项全过**
- ✅ **拉取已接真接口**：`/x/msgfeed/at` + `/x/msgfeed/reply`，走 wbi 签名，`node test/fetch-test.mjs` **8 项全过**
- ✅ **真实拉取验证过**：用当前 cookie 拉一次拿到 23 条（@ + 回复）
- ✅ **私信**：接进主拉取，只翻未读会话；`node test/dm-test.mjs` **10 项全过**
- ✅ **昵称缓存**：`node test/names-test.mjs` **13 项全过**
- ✅ **昵称重读后台分批**：`node test/refresh-bg-test.mjs` **7 项全过**
- ✅ **叫醒会话**：`deliverDefault` 用 `agent.followup(message)` 真开一轮（此前只 append 不唤醒的问题已修）

## ⚠️ 注入消息必须带 source（2026-10-27 事故，参考号 MF-mvq18jvo4sut）

以前这里用裸对象 append：

```js
session.append('user/message', { role: 'user', content: [...] })   // ✗ 没有 source
```

宿主的 `sessionListMetadata` / `sessionTitle` / `turnOutline` projection，以及 agent-loop 的
`RuntimeContextProjection` 都会直接读 `event.data.source.kind`。一条没有 `source` 的
`user/message` 会让**整个会话** projection 抛
`Cannot read properties of undefined (reading 'kind')`：

- 网页里这个会话「历史加载失败：failed to project session …」
- 再接一轮时「模型回合出错」，`turn/end` 直接 error

现在统一用宿主的 `createUserMessage`（自动带 `id` 并冻结）+ `agent.followup`：

```js
const message = createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'plugin:bili-reply' },   // ✓ 和 onebot 的 plugin:dsh-onebot 一个套路
})
await agent.followup(message)              // ✓ followup 的 rejection 必须接住
```

裸对象还缺 `id`：宿主的 `adoptSessionEvent` 先查 `lacks an identified message`，
onebot 读到这种日志会把整份会话当坏档归档（7859 就这样被移进 `sessions-archive`）。
`createUserMessage` 自带 `randomUUID()` 的 id，两个雷一起拆掉。

> 旧的修坏档脚本原来在 `patches\plugins\dsh-bili-reply\repair-bili-reply-events.mjs`，
> 2026-10-27 清理时已删（备份在 `D:\askii\cache\` 的清理目录里）；真再遇到坏档，
> 用同样的思路：停宿主 → 给缺 source 的 `user/message` 补 `source: { kind: 'plugin:bili-reply' }` → 起宿主。

## ⚠️ 首次挂载的注意事项

第一次跑会把历史 @/回复**一次性全推**（seen 表是空的 → 全算新的）。建议先：

```powershell
# 用 dryRun 跑一轮，看会推什么（不写 seen、不推送）
# 或者在挂载前先手动把 seen 表铺满，再关掉 dryRun
```

或者把 `maxPerTick` 设小一点（默认 2），让它慢慢消化。

## 自测

```powershell
node test/reply-test.mjs
node test/fetch-test.mjs
node test/dm-test.mjs
node test/names-test.mjs
node test/refresh-bg-test.mjs
```
