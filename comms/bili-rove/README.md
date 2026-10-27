# dsh-bili-rove

B 站**主动**那半边（清单里的 `comms/bili-rove`，原名 walk，改成 rove）：
搜视频、看详情、截帧、读评论、回评论、私信 —— 默认全带 cookie。

## 回退策略（已实现并自测）

```
带 cookie 调用
  ├─ 成功 → 完事
  └─ 失败（cookie 失效 / 风控）
       ├─ 推二维码到 ntfy（只推一次），等 qrWaitSeconds 等扫码
       ├─ 扫码成功（cookie 变了）→ 重试
       └─ 继续失败到 maxCookieFailures → 回退【匿名】
             ├─ 匿名成功 → 完事（这次就这样）
             └─ 匿名也被限制 → BILI_ROVE_LIMITED 直接报失败
```

**不做**：定时轮询 cookie 是否过期（过期概率很低，经常登录几乎能一直用）。

## 配置

```yaml
- id: bili-rove
  name: dsh-bili-rove
  config:
    cookie: ''                    # 直接写死（不推荐）
    cookieEnv: BILIBILI_SESSDATA  # 环境变量名
    dutyConfigPath: ''            # 空 = <DSH_HOME>/bili-duty/config.json（扫码登录写这里）
    maxCookieFailures: 3
    maxAnonymousTries: 1
    qrWaitSeconds: 60             # 等扫码多久，0 = 不等直接回退
    qrPollSeconds: 5              # 等扫码时多久看一次 cookie 文件
    ntfyTopic: whale-bilibili-login-channel
```

cookie 读取优先级：**配置 > 环境变量 > bili-duty/config.json**。

## 工具

`bili_rove` 一个工具，`action` 选：`search` / `video` / `subtitles` / `frames` / `comments` / `reply` / `dm`。

## ⚠️ 现状（2026-10-27 06:05）

- ✅ 回退状态机、ntfy 二维码推送、cookie 读取、工具注册、失败流程：`node test/fallback-test.mjs` **11 项全过**
- ✅ **读能力已接**：`search` / `video` / `subtitles` 走 `lib/vendor/`（复制自 dsh-plugin-bilibili 的官方 provider），映射自测 `node test/backend-test.mjs` **9 项全过**
- ✅ **真实请求验证过**：用当前 cookie 跑了一次 `search("深海 未知生物")`，正常返回 3 条
- ❌ 还没接：`frames` / `comments` / `reply` / `dm`（调用会抛 `BILI_ROVE_NOT_WIRED`）
  - `frames` 要宿主 attachments，等插件挂载后接
  - `comments` / `reply` / `dm` 接 `dsh-bili-subagent` 那套（`mcp_server.py` 的 `bili_*`）
- 保留的老坑（接后端时别丢）：字幕串号校验、截帧用 videoshot 真帧、请求节奏别一分钟连发 3 个以上
