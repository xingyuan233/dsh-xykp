# dsh-whaleisle（鲸屿 IM 通道）

自建 IM「鲸屿 WhaleIsle」的 DSH 适配层。原来叫 `dsh-finch`（雀语），2026-11-10 改名并接入了 qq-adapter 的分流能力。

## 干什么

1. 长轮询本地鲸屿桥（默认 `http://127.0.0.1:8710`）的 `/v1/inbound`，把新消息注入目标会话；
2. 这一轮的最终回复自动发回来源聊天（回 `[[SILENT]]` 就不发）；
3. 工具：`whaleisle_send` / `whaleisle_read` / `whaleisle_status` / `whaleisle_bind`；
4. 分流：名单（黑/白）+ 绑定 + 预设目标。

## 分流规则

1. `config.yml` 里 `whaleisle.mappings`（chat → target）优先；
2. 运行期 `bindings.json`（`whaleisle_bind` 写的）次之；
3. 名单：`mode: blacklist`（默认，名单里的不转发）/ `whitelist`（只转发名单里的）/ `off`（全放行）；
4. 都没命中走 `defaultTarget`。

聊天标识：私聊 `u-<用户名>`，群聊 `g-<会话 id>`。
目标写法：`p-<预设名>`（走 preset-binder 当前活跃会话）/ `s-<会话id>` / 裸会话 id。

## 数据

- `<DSH_HOME>/xykp/whaleisle/state.json`：游标 + 去重（首次启动会从旧 `xykp/finch/state.json` 迁移）；
- `<DSH_HOME>/xykp/whaleisle/bindings.json`：聊天 → 目标 的运行期绑定。

## 配置（`<DSH_HOME>/xykp/config.yml` 的 `whaleisle:` 段）

```yaml
whaleisle:
  bridgeUrl: http://127.0.0.1:8710
  bridgeToken: <bridge.json 里的 api_token>
  defaultTarget: p-alive
  mode: blacklist
  blocked: [u-someone]
  allowed: []
  mappings:
    - chat: g-c-1234
      target: p-alive
  adminUsers: []        # 指令功能（下一轮）用
  autoReply: true
  pollWait: 20
```

没配 `whaleisle.bridgeToken` 时会退回读旧的 `finch:` 段，所以老配置不用改也能跑。

## 测试

```powershell
node test/whaleisle-test.mjs   # 会打真实桥，需要桥在跑
```

## 指令（在聊天里直接发）

- `/help` 列表
- `/status` 看 mode / defaultTarget / 当前聊天绑定
- `/bind <目标>` 把**当前聊天**绑到 `p-<预设名>` 或 `s-<会话id>`（不用知道 id）
- `/unbind` 解除当前聊天的绑定
- `/preset [名字]` 列预设（名字→活跃会话）；带名字=绑到该预设
- `/session [数量]` 最近会话（带 id，可 `/bind s-<id>`）
- `/ver` 通道信息

指令只对 `adminUsers` 里的用户生效；留空=所有人都能用。