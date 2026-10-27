# dsh-qq-adapter

QQ 自研适配层（不用 NapCat、不用 OneBot）：在 QQ 客户端主进程里自己 init session，收/发消息，
再按分流规则把消息送进 DSH 的会话或预设。

配套的「桥」是 `workspaces/alive-workspace/qq-bridge-script.js`（跑在 QQ 进程里，暴露
`127.0.0.1:39272` 的 HTTP）；本插件是 DSH 这边的另一半。

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
