# dsh-qq-adapter

QQ 自研适配层（不用 NapCat、不用 OneBot）：在 QQ 客户端主进程里自己 init session，收/发消息，
再按分流规则把消息送进 DSH 的会话或预设。

配套的「桥」是 `bridge/qq-bridge-script.js`（跑在 QQ 进程里，暴露 `127.0.0.1:39273` 的 HTTP）；
本插件是 DSH 这边的另一半。

## 文件放哪（2026-10-30 起）

| 东西 | 位置 |
|---|---|
| 桥脚本 / 二维码重编码 / 壳加载器 | 插件包 `bridge/`（`qq-bridge-script.js`、`make-qr.py`、`dsh-loader.js`） |
| 运行时数据：日志、二维码、命令文件、媒体、成员缓存 | `<DSH_HOME>\xykp\qq-adapter\` |
| QQ 引擎数据 | `<DSH_HOME>\xykp\qq-adapter\nt\` |

**不要再往 `workspaces\alive-workspace` 里放任何桥文件**——工作区随时会被清理，桥会整条瘫掉。
`dsh-loader.js` 需要在 QQ 壳里部署一份：`<QQ-shell>\versions\<ver>\resources\app\dsh-loader.js`，
插件包里的 `bridge/dsh-loader.js` 是它的版本管理副本，改完两边同步。

## 分流规则（都在 Web 设置页里改，live 生效）

| 字段 | 说明 |
|---|---|
| `enabled` | 总开关（关掉不自动转发，工具还在） |
| `bridgeUrl` | 桥的地址，默认 `http://127.0.0.1:39272` |
| `selfUid` | 机器人自己的 uid，自己的消息不转发 |
| `defaultTarget` | 默认目标：`p-<预设名>` 或 `s-<会话id>` |
| `mode` | `blacklist`（默认，名单里的不转）/ `whitelist`（只转名单里的） |
| `blocked` | 黑名单：`u-<uid>`、`g-<群号>` |
| `allowed` | 白名单：同上 |
| `mappings` | 自定义映射，每项 `{ chat: 'u-xxx' 或 'g-xxx', target: 'p-xxx' 或 's-xxx' }`，**优先于名单** |
| `pollMs` / `maxPerTick` | 轮询间隔 / 一轮最多转几条 |

判定顺序：**映射 → 名单 → 默认目标**。

- 私聊的聊天标识是 `u-<peerUid>`
- 群聊是 `g-<群号>`（NTQQ 里群聊的 peerUid 就是群号）

## 工具

- `qq_send`：`{ chat: 'u-<uid>' | 'g-<群号>', text: '...' }` 发一条消息
- `qq_status`：看桥的状态（登录没登录、session/msgService、收件箱）

## 消息长什么样

转发进会话的是一段文本：

```
[QQ私聊 u-u_xxxx] 21:30 星鸢
在吗
```

群里是 `[QQ群 g-602173548] …`；图片/语音/文件会写成 `[图片 a.jpg → C:\...]` 这样的占位。

## 部署

1. 插件目录：`plugins/comms/qq-adapter`
2. 在 profile 里挂一个 junction：
   `home\profiles\web\node_modules\dsh-qq-adapter` → 本目录
3. `home\profiles\web\cordis.patch.yml` 里 insert 一行 `id: qq-adapter / name: dsh-qq-adapter`
4. 桥要在跑：`D:\Program-Files\QQ-shell\NapCatWinBootMain.exe`

## 测试

```powershell
node test/router-test.mjs     # 15 条分流用例
```
## 图片 / 历史（2026-10-27 23:0x）

| 能力 | 桥接口 | 插件工具 |
|---|---|---|
| 发图片 | `GET /sendpic?chatType=&peerUid=&path=` | `qq_send_image { chat, path }` |
| 收图片 | 桥收到图会自动落盘到 `workspace\qq-media\<msgId>_<elementId>.png`，事件里带 `pic.localPath` | —（消息里直接带路径） |
| 翻历史 | `GET /history?chatType=&peerUid=&count=&seq=` | `qq_history { chat, count?, seq? }` |

历史是**私聊和群聊都能查**的（之前 NapCat 那条只能查群）：

- 私聊：`getAioFirstViewLatestMsgs(peer, count)`（带 senderName，很好用）
- 群聊：同一个接口也行；`seq` 给定就用 `getMsgsBySeqAndCount(peer, seq, count, true, true)` 往前翻

发图片的实现（不抄 NapCat 的 highway）：
把文件按 md5 塞进 `ms.getRichMediaFilePathForMobileQQSend({...needCreate:true})` 给的路径，
再发一个 `picElement{ sourcePath, md5HexStr, fileSize, picWidth, picHeight }`，客户端自己上传
（尺寸从 PNG/JPEG 头直接读，读不到给 0 也能发）。

## 转发方式：steer / followup

`deliverMode` 配置项：`steer`（默认，插队，正在跑的这一轮也能看到）或 `followup`（排队，等这轮结束）。
宿主 agent 有 `agent.steer()`，NapCat 那条通道默认也是 steer，所以这里跟它对齐。
## 登录失效后的推码流程

1. 桥活着但没登录（stage=login）时，插件每 `notifyEveryMinutes` 分钟推一张码，最多 `notifyMax` 张（默认 2 分钟 × 3 张）。
2. **每张都是现要的新码**：推之前调桥的 `/qr`，等二维码文件 mtime 变新再推（自动换码已关，避免上一张被作废）。
3. 推满次数后，插件通过 `comms/ntfy` 的 `wait` 在同一个主题里等 `/post`。
4. 收到 `/post` → 再要一张新码、补推一张（不占那 3 次额度）；扫上登录成功（stage=ready）就自动停止等待。
5. 推送优先走 `ctx.get('ntfy')` 服务；ntfy 组件不在时退回自带的 fetch。

