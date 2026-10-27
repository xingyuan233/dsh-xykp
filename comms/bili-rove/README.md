# dsh-bili-rove

B 站**主动**那半边（清单里的 `comms/bili-rove`，原名 walk，改成 rove）：
搜视频、看详情、截帧、读评论/弹幕、回评论、私信、用户资料、收藏夹、热榜、三连、发动态。

> 被动那半边（别人 @ 我 / 回复我 / 私信我 → 推给会话）在 **bili-reply**，不在这里。
> 自动刷、定时轮询、子代理刷 B 站 —— 明确不做，什么时候刷由我自己判断。

## 工具

### `bili_rove`（一个工具，`action` 选）

| 分类 | action | 说明 |
|---|---|---|
| 读 | `search` | 搜视频（`keyword` / `page` / `pageSize` / `order`） |
| | `video` | 视频详情 |
| | `subtitles` | AI 字幕（带串号校验） |
| | `frames` | 截帧 → **真图片**，`mode`: `auto` / `extract`，`count` 1-12 |
| | `comments` | 热门评论（`num`） |
| | `danmaku` | 弹幕（`num`） |
| | `user` / `user_videos` | 用户资料 / 投稿列表 |
| | `favorites` | 收藏夹列表；带 `mediaId` 查某个收藏夹内容 |
| | `hot` / `rank` | 热门 / 排行（`rid` 分区） |
| | `received_at` / `received_replies` | 收到的 @ / 回复 |
| | `dm_sessions` / `dm_recent` | 私信会话列表 / 读某个会话 |
| | `crawl` | 批量：搜索 → 逐条读评论 + 字幕 |
| 写 | `reply` | 回评论（`bvid` + `text`，楼中楼带 `rpid`，根楼层带 `root`） |
| | `dm` | 带 `text` = 发私信，不带 = 读会话 |
| | `triple` | 点赞 / 投币 / 收藏 / 一键三连（`mode`: `like` `coin` `fav` `like_fav` `triple`；triple = 点赞+收藏，**不投币**） |
| | `dynamic` | 发纯文字动态（`text`） |

### `bili_login`

- `action: 'qr'` —— 生成二维码 → 推 ntfy（`whale-bilibili-login-channel`）→ 等扫码（默认 600 秒）→ 写凭证
- `action: 'check'` —— 用 nav 接口验证当前凭证

## 读写策略

```
读操作（search/video/comments/...）
  ├─ 带 cookie 成功 → 完事
  ├─ 失败（cookie 失效 / 风控）
  │    ├─ 是登录类错误 → 报错提示调 bili_login（可选：autoPushQr=1 顺手推一次二维码）
  │    └─ 回退【匿名】再试一次
  └─ 匿名也失败 → 报错

写操作（reply/dm/triple/dynamic）
  └─ 只带 cookie 试一次，失败**不重试、不回退匿名**（避免重复发评论 / 私信）
```

不做：定时轮询 cookie 是否过期（过期概率很低，经常登录几乎能一直用）。

## 数据（只碰数据，不碰代码）

默认目录 `<DSH_HOME>/bili-duty`：

| 文件 | 用途 |
|---|---|
| `bili_credential.json` | 登录凭证（`sessdata`/`bili_jct`/`buvid3`/`dedeuserid`） |
| `bili-login-state.json` | 上次登录检查 / 推送限流状态 |
| `config.json` | 旧配置（留着，bili-reply 等还读） |
| `names-cache.json` | 昵称缓存（bili-reply 用） |
| `out/` | 历史报告（bili-reply / 刷 B 站留下的数据） |

`dataDir` 可以覆盖；凭证读取优先级：**配置 `cookie` > 环境变量 `BILIBILI_SESSDATA` > `bili_credential.json`**。

## 配置

```yaml
- id: bili-rove
  config:
    dataDir: ''                    # 空 = <DSH_HOME>/bili-duty
    cookie: ''                     # 直接写死（不推荐）
    cookieEnv: BILIBILI_SESSDATA   # 环境变量名
    ntfyTopic: whale-bilibili-login-channel
    ntfyMinIntervalSec: 60         # 两次推二维码至少隔多久
    ntfyMaxPushes: 30              # 最多推几次
    qrWaitSeconds: 600             # bili_login qr 等扫码多久
    qrRegenSeconds: 180            # 二维码过期多久换新码
    qrImageService: 'https://api.qrserver.com/v1/create-qr-code/?size=420x420&data='
    autoPushQr: 0                  # 读操作遇到登录失效时要不要顺手推二维码（1 = 推）
```

## 保留的老坑（改的时候别丢）

- **字幕串号**：B站 AI 字幕接口会按请求随机返回别的视频的字幕；`vendor/provider.js` 做了三道校验（cid/aid、URL 前缀、时长），看到 `wrong subtitle track` 别当内容用
- **截帧**：`meta.source` 为 `preview` / `videoshot` 才是真帧，`cover` 只是封面；雪碧图用 ffmpeg 切单帧，黑空格子按体积判掉
- **请求节奏**：provider 自带最小间隔 + `-412` 退避阶梯，别在外面绕过它狂发
- 评论接口第一次经常吃风控 → 隔 1.5s 重试一次

## 自测

```bash
node test/backend-test.mjs     # 离线：action 映射 / 写接口 csrf / 参数校验
node test/fallback-test.mjs    # 离线：回退状态机 / 凭证优先级
node test/real-smoke.mjs       # 联网：读接口全跑（用本机 cookie）
```
