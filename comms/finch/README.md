# dsh-finch · 雀语通道

把自建 IM **Finch（雀语）** 接进 DSH：好友在手机 App 上发来的消息会出现在指定会话里，
这一轮的回复自动发回来源聊天；也可以用工具主动发消息。

## 数据流

```
Android App ──HTTPS/WSS──> 114.215.205.181 (finch-server)
                                   ▲
                                   │ HTTPS/WSS（固定证书）
                            finch-bridge（本机 127.0.0.1:8710）
                                   ▲
                                   │ 长轮询 + POST
                            dsh-finch（本插件）
                                   │ agent.steer / followup
                              DSH 会话
```

- 服务器：`D:\devoding\Python\Finch\finch_server`
- 本地桥：`D:\devoding\Python\Finch\finch_bridge`（计划任务 `FinchBridge`，登录自启）
- 本插件只跟桥说话，不直接连服务器；桥挂了本插件静默重试，不会拖死宿主

## 配置（`%DSH_HOME%\xykp\config.yml` 的 `finch:` 段）

```yaml
finch:
  bridgeUrl: http://127.0.0.1:8710
  bridgeToken: <bridge.json 里的 api_token>
  target: p-alive          # p-<预设名> 或 session-<id>
  autoReply: true
  pollWait: 20
```

`target` 写 `p-<预设名>` 时会跟随 `preset-binder` 的当前绑定；
写死 `session-<id>` 则始终投到那个会话。

## 行为

1. 长轮询 `/v1/inbound?after=<cursor>&wait=<pollWait>`，每个聊天一次最多合并 `50` 条
2. 注入格式：`[雀语] 张三: 你好` / `[雀语·群「三人行」] 李四: ...`，附件显示成 `[图片:cat.png]`
3. 回复：监听 `session/event`，`turn/end` 之前的每段 `assistant/message` 都发回来源聊天；
   回复 `[[SILENT]]` 表示这一轮不说话；和 `finch_send` 刚发过的同文去重
4. 游标和「每个聊天投递到哪条」写在 `%DSH_HOME%\xykp\finch\state.json`，重启不重复
5. 单条超 `maxReplyChars`（默认 3200）自动分段

## 工具

| 工具 | 作用 |
|---|---|
| `finch_send` | `conversation_id` 或 `to=@用户名`，`text` 必填；可 `reply_to_id` |
| `finch_read` | 不带参数列聊天 + 未读；带 `conversation_id` 读最近消息 |
| `finch_status` | 桥连接状态、当前账号、排队数、插件游标 |

## 自测

`test/finch-test.mjs` 用一个假的 DSH 宿主（假 agents / 假会话事件）跑真实 bridge：

```powershell
node plugins/comms/finch/test/finch-test.mjs
```

## 注意

- 插件代码改完必须重启 `dsh web` 才生效（用户明确要求本轮不重启，配置已就绪，下次重启自动加载）
- 本插件目录要同时同步到 `home/profiles/web/node_modules/dsh-xykp/comms/finch`，
  否则 profile 加载的是安装副本、看不到新插件
