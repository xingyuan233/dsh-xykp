# bili-audio-live

盯 B 站直播间，把**主播说的话**和**弹幕**攒成一批，投递到绑定的对话。

和 `bili-reply` 的区别：那边是轮询收件箱，这边是长连接——弹幕走 WebSocket，语音从直播流里抽音轨、本地 SenseVoice 识别，全程不碰麦克风、不碰虚拟声卡、不影响你的系统音量。

## 数据来源

| 源 | 怎么拿 | 成本 |
|---|---|---|
| 弹幕 | `getDanmuInfo`（wbi 签名）换 token → `wss://…/sub`，protover 3 / brotli | 0 token，纯文本 |
| 语音 | `getRoomPlayInfo` → HLS → ffmpeg 抽 16k 单声道 → 能量 VAD 切句 → SenseVoice 识别 | 本地 CPU，0 API 费用 |
| SC | 弹幕流里的 `SUPER_CHAT_MESSAGE` | 同上 |

画面不采。理由是立绘基本不动，信息全在这两路里。

## 配置

`<DSH_HOME>/xykp/bili-audio-live/config.yml`（直接是顶层 key，不用外层行 id）：

```yaml
enabled: true            # 装载即启动
dryRun: false            # true = 只把批写进日志，不投递（先看效果）

rooms:                   # 纯静态目录：房间号 + 名字
  - { roomId: 1967225563, name: 果莓 }

bindings:                # 真正的绑定：一条 = 一个房间 → 一个对话/预设
  - target: s-bcd904a3-…    # s-<会话id> 或 p-<预设名>
    roomId: 1967225563
    enabled: true
    danmaku: true           # 这条要不要弹幕
    audio: true             # 这条要不要语音
    # windows: ['20:00-02:00']   # 可选：条目级时段，覆盖全局

sources:
  danmaku: true          # 全局总开关
  audio: true            # 关掉 = 纯弹幕模式

pacing:
  # 硬限制（先判这两条）
  minIntervalSec: 120    # 距上次投递不到这么久，一律不发
  maxWaitSec: 420        # 攒超过这么久，只要有内容就发
  # 软限制（过完硬限制后，满足任意一条就发）
  minSentences: 5
  maxSentences: 40
  minDanmaku: 8
  maxDanmaku: 60
  # 渲染
  maxChars: 1500
  renderDanmakuCap: 80

schedule:
  windows: ['20:00-02:00']   # 全局时段；空 = 一直开；支持跨零点
asr:
  modelDir: 'D:/AI/DeepseekHarness/home/xykp/bili-audio-live/models/sensevoice'
  ffmpegPath: 'ffmpeg'
  numThreads: 4
  minSpeechMs: 400
  cutSilenceMs: 800
  vadThreshold: 0.55
  mergeGapMs: 600          # 相邻片段停顿小于这个就并成一句再识别

pushGift: true
pushGuard: true

send:                      # 主动发送（写操作，默认全关）
  enabled: false
  gift:
    enabled: false
    minYuan: 1
    maxYuan: 50
    maxPerSend: 1
    allow: []              # 只允许这些礼物（名字或 id）；空 = 不限制种类
```

**同一个 target 只能绑一个房间**，第二条会被跳过并告警——否则两路消息会串进同一个对话。

改完直接生效（控制台保存 → `entry.update` 重跑 apply），但改 `lib/*.js` 必须重启宿主。

## 用法

- 工具 `bili_audio_live`：`action=status | start | stop | flush`
- HTTP：`GET /dsh-bili-audio-live/status`、`POST /start|/stop|/flush`

投递格式：

```
【B站直播·攒够】20:13~20:15　语音 6 句 / 弹幕 31 条

— 说了什么 —
20:13:05 这波有点秀
...

— 弹幕 —
20:13:12 用户：哈哈哈（×4）
```

## 已知边界

- **歌回没法识别**：歌声走 ASR 出来的是乱码，那段时间只能靠弹幕
- 一首歌一停就是几十秒静音，VAD 不会切句，所以歌回期间实时性最差
- ASR 在 **worker 线程**里跑（8 秒语音约 0.5~1 秒），不阻塞宿主事件循环
- ffmpeg 只从直播流抽音轨；`fmp4` 那几路 CDN 偶尔 TLS 重置，所以优先选 `ts`
- 模型 228MB，`model.int8.onnx` + `tokens.txt`，放 `<DSH_HOME>/xykp/bili-audio-live/models/sensevoice`
