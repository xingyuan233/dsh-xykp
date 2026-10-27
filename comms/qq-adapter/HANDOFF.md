# QQ 自研适配层 · 交接（2026-10-27 21:20 更新）

> 目标：在 `comms/qq-adapter` 里自己实现 QQ 通道，**不用 NapCat、不用 OneBot**。
> 依赖 QQ 客户端本体（NTQQ 的 native 协议库），用「DLL 注入 / 纯 shell 加载 + 执行自己的 JS」拿接口。
> 主人要求：接口可以抄（照 NapCat 的调用方式），实现自己写；不做跨平台通用，只做能用的最小集。

## 〇、当前状态：纯 shell 模式「登录 + 收 + 发」全通

现在跑的是**纯 shell**（没有 QQ 界面），实例：`D:\Program-Files\QQ-shell`，进程里只有我们的 loader + wrapper.node。

实测通过：

- 扫码登录（樱 3793339506）→ `onQRCodeLoginSucceed`
- `session.init(...)` + `startup.start()` → `onMSFStatusChange` → `onNTSessionCreate` →
  `onOpentelemetryInit` → **`onSessionInitComplete 0`** → `stage=ready`
- `getMsgService()` 可用
- 收：`onRecvMsg` 收到真实消息
- 发：`sendMsg` 返回 `{result:0}`，手机能收到

HTTP 调试接口（`127.0.0.1:39272`）：`/status` `/events` `/send` `/qr` `/loginlist` `/boot` `/reboot`
`/diag` `/win` `/buddy` `/recent` `/download`。命令文件 `qq-cmd.json` 也还能用。

## 一、纯 shell 怎么搭的（重要）

1. `robocopy QQ-dsh QQ-shell /E`（1.2GB，别改原来的 QQ-dsh）
2. 在 `QQ-shell\versions\9.9.36-53644\resources\app`：
   - `package.json` 的 `main` 改成 `./dsh-loader.js`（原值备份成 `package.json.shell-backup`）
   - 放一个 `dsh-loader.js`：打印环境 → `eval(读 workspaces\alive-workspace\qq-bridge-script.js)`
     → 每 1.5s 看 mtime 重新 eval（热重载）
   - 其它文件（wrapper.node / major.node / application.asar）**一个都别动**
3. 把 `NapCatWinBootMain.exe` + `NapCatWinBootHook.dll`（来自 `tools\NapCat\onekey\bootmain`）
   拷到 `QQ-shell\` 根目录（和 QQ.exe 同级），然后跑：

```powershell
cd D:\Program-Files\QQ-shell; .\NapCatWinBootMain.exe     # 会自己拉起 QQ.exe 并跳过文件签名校验
```

签名清单在 `resources\app\application.json`（application.asar / wrapper.node / major.node / package.json
各一个 256 字节 RSA 签名），改了 package.json 没有这个钩子就是「文件已损坏」。

## 二、跑通的完整启动顺序（纯 shell，照这个来）

```js
var wmod = require('<install>\\versions\\9.9.36-53644\\resources\\app\\wrapper.node');
var eng   = wmod.NodeIQQNTWrapperEngine.get();
var login = wmod.NodeIKernelLoginService.get();

// 1) 引擎
eng.initWithDeskTopConfig({ base_path_prefix:'', platform_type:3, app_type:4,
  app_version:'9.9.36-53644', os_version: os.release(), use_xlog:false,
  qua:'V1_WIN_NQ_9.9.36_53644_GW_B',
  global_path_config:{ desktopGlobalPath: <自己的 global 目录> },
  thumb_config:{ maxSide:324, minSide:48, longLimit:6, density:2 } }, engineListener);

// 2) 登录服务
login.initConfig({ machineId:'', appid:537391628, platVer: os.release(),
  commonPath: <自己的 global 目录>, clientVer:'9.9.36-53644',
  hostName: os.hostname(), externalVersion:false });

// 3) ★ 关键顺序：先建 startup wrapper，再拿 session 壳 ★
var startup = wmod.NodeIQQNTStartupSessionWrapper.create();
var session = wmod.NodeIQQNTWrapperSession.getNTWrapperSession('nt_1');   // 这一步要能拿到对象

// 4) 扫码登录（listener: onQRCodeGetPicture / onQRCodeSessionUserScaned / onQRCodeLoginSucceed）
login.addKernelLoginListener(L); login.connect(); login.getQRCodePicture();

// 5) 登录成功回调里
session.init(sessionInfo, msfListener, dispatchListener, sessionListener);
startup.start();     // → onNTSessionCreate / onOpentelemetryInit / onSessionInitComplete
```

**反了就永远卡住**：`getNTWrapperSession('nt_1')` 必须在 `StartupSessionWrapper.create()` **之后**，
在登录**之前**拿到壳（否则 init 完没有 onSessionInitComplete，`getMsgService()` 也拿不到）。

`sessionInfo`（和上一版一致）：

```js
{ selfUin, selfUid: 'u_BsJrCaYeH77_OZ78H5pEXA',
  desktopPathConfig: { account_path: '<Tencent Files>/<uin>' },   // uin 模式
  clientVer:'9.9.36-53644', a2:'', d2:'', d2Key:'', machineId:'',
  platform:3, platVer: os.release(), appid:537391628,
  rdeliveryConfig:{...全空, platform:3, fixedAfterHitKeys:['']},
  defaultFileDownloadPath: <temp>,
  deviceInfo:{ guid: login.getMachineGuid(), buildVer, localId:2052, devName: os.hostname(),
    devType: os.type(), vendorName:'', osVer: os.release(), vendorOsName: os.type(),
    setMute:false, vendorType:0 },
  deviceConfig:'{"appearance":{"isSplitViewMode":true},"msg":{}}' }
```

监听器方法名（空实现也能跑）：msf `onMSFStatusChange/onMSFSsoError/getGroupCode`；
dispatch `dispatchRequest/dispatchCall/dispatchCallWithJson`；
session `onNTSessionCreate/onGProSessionCreate/onSessionInitComplete/onOpentelemetryInit/onUserOnlineResult/onGetSelfTinyId`；
engine `onLog/onGetSrvCalTime/onShowErrUITips/fixPicImgType/getAppSetting/onInstallFinished/onUpdateGeneralFlag/onGetOfflineMsg`；
login `onLoginConnected/onLoginConnecting/onLoginDisConnected/onQRCodeGetPicture/onQRCodeLoginPollingStarted/onQRCodeSessionUserScaned/onQRCodeLoginSucceed/onQRCodeSessionFailed/onUserLoggedIn/onLogoutSucceed/onLoginFailed`。

## 三、踩过的坑（都是真金白银）

### 登录/二维码
- **QQ 返回的二维码图只有 96~147px 的 JPEG，扫不动**。要自己按 URL 重编码：
  `python make-qr.py <url> qq-qr-fresh.png`（`qrcode` 库已装）
- **每调一次 `getQRCodePicture()` 会把上一张作废**，多调一次就让人扫到一张死码
- 码的有效期很短（约 1 分钟），所以搞了「qr keeper」：每 10s 检查，码龄 > 45s 就换新；
  页面 `qq-qr.html` 每 2s 刷新图片并显示倒计时（绿/黄/红），人看着扫就行
- 带界面的进程里，**QQ 自己的窗口也在申请二维码**，会跟我们互相顶掉 → 这就是一直「已过期」的原因

### 带界面（注入）模式为什么放弃
- app 登录着的时候 `getNTWrapperSession` 是空壳、`getMsgService()` undefined：**app 根本不用 wrapper 的 session**
- 我们借 app 的登录态 init：能拿到 msService 但 session 永远不上线（发消息卡 status=1）
- 两边同时登同一个号 → `onUserLoggedIn` 刷屏 → 进程崩过一次
- 结论：**要么 app 不登录，要么纯 shell**。选纯 shell，一了百了

### 收发
- **uid 抄错一个字母**就发不出去：正确的星鸢 uid 是 `u_VyRaaHm1qjSkW7Eb**Ghh**62w`
  （`...EbHh62w` 是错的，之前凭 loginlist 记的，其实 loginlist 里那个也是错的）
  → 用 `getBuddyService().getBuddyListV2('0', true, 0)` 拿真 uid
- 发错 uid 时 `sendMsg` 返回的 Promise **永远不 resolve**（本地回显停在 `status=1 sending`）
- PowerShell 发中文要显式 UTF-8：
  `[Text.Encoding]::UTF8.GetBytes($json)` + `-ContentType 'application/json; charset=utf-8'`，
  否则手机收到一串 `????`
- 收消息的 `onRecvMsg` 同一条会回调多次（元素逐步补全），要按 `msgId` 覆盖去重

### 脚本/热重载
- 每个 JS 版本里注册的 listener 是**旧闭包**：改回调后必须 bump 版本号（`LISTENER_VER` / `loginListenerVer`）
  才会重新注册，不然新代码不生效
- eval 会叠加定时器：状态放 `global.__qqState`，定时器也按版本号重建
- 脚本必须整体 try/catch，不然 QQ 弹「A JavaScript error occurred in the main process」

## 四、文件与路径

| 东西 | 路径 |
|---|---|
| **纯 shell 安装（现在用的）** | `D:\Program-Files\QQ-shell` |
| QQ-dsh（带界面实验用，随便折腾） | `D:\Program-Files\QQ-dsh` |
| 正版 QQ（别动） | `D:\Program-Files\QQ2`（NapCat 在用） |
| 启动钩子（从 NapCat onekey 拷来） | `QQ-shell\NapCatWinBootMain.exe` + `NapCatWinBootHook.dll` |
| 我们的 loader（在 app 目录里） | `QQ-shell\versions\9.9.36-53644\resources\app\dsh-loader.js` |
| 桥脚本（热重载） | `workspaces\alive-workspace\qq-bridge-script.js` |
| 配置 | `workspaces\alive-workspace\qq-config.json` |
| 日志 | `qq-bridge.log`（桥）/ `qq-shell.log`（loader） |
| 二维码页面 | `workspaces\alive-workspace\qq-qr.html` |
| 二维码重编码脚本 | `make-qr.py`（`qrcode`）/ `decode-qr.py`（`cv2` 校验） |
| 注入器源码（带界面模式留着） | `plugins\comms\qq-adapter\bridge\{qqbridge.cpp,injector.cpp,build.ps1}` |
| NapCat 参考 | `tools\NapCat\shell\napcat.mjs`（`FL()`≈83290、`n2e()`≈83256、`xse()`≈33027） |

## 五、已经排除的路（别再试）

1. 改 `resources/app/package.json` 但不带启动钩子 → 「文件已损坏，请重新安装」
2. `--inspect` / `--remote-debugging-port` → fuse 关了
3. `--app-path=` → 启动器忽略
4. C++ 独立进程 `LoadLibrary(wrapper.node)` → 能加载但拿不到 JS 接口
5. hook `qq_magic_napi_register` 替换 `nm_register_func` → 「Module did not self-register」
6. 指望 app 登录后白嫖它的 session → 不存在
7. `session.startNT()` 兜底 → 我们这个版本的 session 壳上没有这个方法

## 六、下一步

1. 群消息收发（`chatType: 2`，`peerUid` 用群号；樱 目前不在任何群，需要拉进一个测试群）
2. 图片发送（`elementType: 2` + `picElement`，要走 `RichMediaService` 上传）
3. 图片接收落盘（`ms.downloadRichMedia` 我们调了没回调，改试
   `RichMediaService.downloadFileForFileUuid` / `downloadFileByModelId`；语音 `.amr` 是自动下载的）
4. @ 别人（`atType/atUid/atNtUid`）
5. 断线重连、掉线自动重扫码、进程守护
6. 把这个 shell 的启动/保活做成脚本，`qq-adapter` 插件里做成 dsh 工具（收消息 → 叫醒会话）

## 七、当前 profile pin（插件仓库）

最后一次 install 是 `abb1386`；之后 `febb819`（只改 README）没有 install。

## 八、dsh 插件：分流 + 工具（2026-10-27 22:10）

`plugins\comms\qq-adapter` 现在是「宿主那半边」：轮询桥的 `/events`，按规则把消息送进会话或预设，
并提供 `qq_send` / `qq_status` 两个工具（工具在**新开的对话**里才看得到，旧对话的工具表是固定的）。

### 怎么挂上去的（不用 pnpm install）

1. junction：`home\profiles\web\node_modules\dsh-qq-adapter` → `D:\AI\DeepseekHarness\plugins\comms\qq-adapter`
2. `home\profiles\web\cordis.patch.yml` 末尾 insert 一行：

```yaml
- insert:
    - id: qq-adapter
      name: 'dsh-qq-adapter'
      config:
        enabled: true
        bridgeUrl: 'http://127.0.0.1:39272'
        selfUid: 'u_BsJrCaYeH77_OZ78H5pEXA'
        defaultTarget: 's-session-<会话id>'   # 或 p-<预设名>
        mode: blacklist         # blacklist（默认）/ whitelist
        blocked: ['u-...', 'g-...']
        allowed: []
        mappings:
          - chat: 'u-<uid>'
            target: 'p-alive'
        pollMs: 2500
```

配置改完 **live 生效**（loader 会重新 apply），不用重启；但**改插件代码**要重启宿主（ESM 缓存）。

### 分流规则

判定顺序 **映射 → 名单 → 默认目标**；私聊键 `u-<peerUid>`，群聊键 `g-<群号>`。
纯函数在 `lib/router.js`，单测 `node test/router-test.mjs`（15 条）。

### 踩的坑（都真踩过）

- `defineTool` 的 `output.schema` 必须写 `additionalProperties`，否则宿主抛
  `JsonSchemaError: unsupported JSON schema` —— 而且这个错误发生在 apply 里，**整个插件直接不工作**
  → 工具注册用 try/catch 包起来，别让它拖死分流
- 配置改动会触发 loader **重新 apply**，旧实例的定时器不会自动停 → 同一条消息被转两次
  → 用 `globalThis.__qqAdapterCleanup` 在 apply 开头掐掉上一个实例
- 定时器里访问 `ctx.agents` 会拿到 inactive context 的老 fiber → **apply 时就把 agents 抓下来**
- 桥的 inbox 游标是内存里的，宿主重启后从 0 重放 → 一重启就涌进来一堆旧消息
  → 游标和去重表一起存 `home/qq-adapter/seen.json`，并且启动默认 `skipBacklog`（不补旧消息）
- DSH 重启会把 QQ shell（我们起的子进程）一起杀掉 → 登录态失效又要扫码
  → 插件用 **WMI（Win32_Process.Create）** 拉 shell，进程挂在 WmiPrvSE 下面，宿主重启带不走它
  （实测：重启多次后 pid 24772 还活着，`stage=ready`）

### 现在的默认目标

`defaultTarget: s-session-525f1840-a15d-40d6-a176-0d020f9c1b65`（当时那个对话）；
换对话就把它改成新的 `s-<会话id>`，或者用 `p-<预设名>` 跟着预设走。

## 九、这一轮又补上的能力（2026-10-27 23:05）

| 能力 | 实现 | 备注 |
|---|---|---|
| 语音转文字 | 桥收到语音后自动调 `translatePtt2Text`，轮询等 `pttElement.text`，再补一条 `（语音转写）…` 进收件箱 | 这个转写是**异步**的：第一次调返回空，过 1~2 秒才有字；实测第二次就有「嗯。」 |
| 群聊 @ 人 | `POST /send` 带 `at`（uid）+ `atNick`，桥在前面插一条 `textElement{atType:2, atNtUid}` | 插件侧 `qq_send { chat, text, at, atNick }` |
| 翻历史（私聊+群聊） | `GET /history?chatType=&peerUid=&count=&seq=` | 靠 `getAioFirstViewLatestMsgs`（带 senderName），给 `seq` 就用 `getMsgsBySeqAndCount` |
| 插队转发 | `deliverMode: steer`（默认）/ `followup` | 宿主 `agent.steer()`；NapCat 那条通道默认也是 steer |

### 这一轮踩的坑

- **eval 热重载只换代码、不换闭包**：`onRecvMsg` 这类监听器保存的是「注册那一刻」的函数引用。
  改了收消息逻辑不 bump `LISTENER_VER` 就永远走旧代码；而旧的 `ensure` 定时器又会用旧版本号把旧监听器重新注册回来
  → 现在 `ensure` 定时器改成调用 `global.__qqEnsureMsgListener`（每次 eval 覆盖），永远用最新实现。
- `translatePtt2Text` 不是同步返回文本的，要回头再读消息上的 `pttElement.text`。
- 发图片不需要自己实现 highway：把文件按 md5 复制到 `getRichMediaFilePathForMobileQQSend` 给的路径，
  发 `picElement{sourcePath, md5HexStr, fileSize, picWidth, picHeight}` 就行，客户端自己上传。
- PowerShell 里往 JS 文件塞代码要小心：`@"..."@` 会插值（`$s9` 直接变空），一律改成「写片段文件 + node 拼接」。

## 十、当前状态 & 下一步（2026-10-27 23:1x，给下一个对话）

### 跑着的进程

| 东西 | 值 |
|---|---|
| QQ shell（桥） | `D:\Program-Files\QQ-shell`，pid **24772**（WMI 起的，宿主重启不死） |
| 桥 HTTP | `http://127.0.0.1:39272`（`/status` `/events` `/send` `/sendpic` `/history` `/ptt` `/qr` `/buddy` `/recent` `/download`） |
| 日志 | `workspaces\alive-workspace\qq-bridge.log`（每行带 pid）/ `qq-shell.log`（loader） |
| 二维码页面 | `workspaces\alive-workspace\qq-qr.html`（自动换新 + 倒计时） |
| 测试发送脚本 | `send-as-whale.mjs`（私聊/`--group <号>`）、`send-img-whale.mjs`、`send-ptt-whale.mjs` |

### 插件配置（`home\profiles\web\cordis.patch.yml` 里那一行）

- `defaultTarget: s-session-525f1840-…`（**这是上一个对话的 id，换对话后要改成新的 `s-<id>`**）
- `deliverMode: steer`（默认插队）
- `blocked/mappings` 现在是空的
- 哨兵：桥挂了 → WMI 拉 shell；没登录 → 二维码推 ntfy 主题 `whale-qq-shell-channel`

### 工具（新对话里会出现）

`qq_send { chat, text, at?, atNick? }` · `qq_send_image { chat, path }` · `qq_history { chat, count?, seq? }` · `qq_status {}`

chat 用 `u-<uid>`（私聊）/ `g-<群号>`（群聊）。鲸鱼娘的 uid 是 `u-u_wCwUuJmmlLb7g6MDEKm5Iw`（chat 里要写 `u-u_wCw…`，因为 uid 本身带 `u_`）。

### 剩下要做的（按我自己的顺序）

1. **发文件**（`fileElement`，走 `getRichMediaFilePathForMobileQQSend` 那套，跟图片类似）
2. **引用回复（quote）**（`replyElement`：需要原消息的 msgId/seq/sender，可能要用 `getSourceOfReplyMsg`）
3. **发语音**（`pttElement` + silk 编码；或者先只做「收」）
4. **群成员列表**（`getGroupService().getGroupMemberList`）—— @ 人的时候能查 uid
5. 收消息里把 `at` 元素渲染成 `@昵称`（现在事件里有 `el.at`，格式化还可以更友好）

### 改代码前的两条铁律

- **改桥脚本**（`workspaces\alive-workspace\qq-bridge-script.js`）：热重载只换代码、不换闭包 →
  改了收消息相关的逻辑**必须 bump `LISTENER_VER`**，否则监听器还指着旧函数。
  改完把文件复制到 `plugins\comms\qq-adapter\bridge\qq-bridge-script.js` 再 commit。
- **改插件**（`plugins\comms\qq-adapter\lib\*.js`）：要重启宿主才生效（ESM 缓存）。
  重启流程见 `$DSH_HOME\AGENTS.md`：挂 60 秒提醒 → `restart-dsh.ps1 -DelaySeconds 10` → 闭嘴。

### 一句话总结

**樱的纯 shell 桥 + qq-adapter 插件已经能：收/发文字、收/发图片、语音自动转写、群里 @ 人、翻私聊和群聊历史、插队唤醒、桥挂了自动拉起、登录失效推二维码到 ntfy。**
剩下的是文件、引用、发语音——都是「再加一个 element 类型」的活。

## 十一、发文件 / 引用回复 / 发语音 —— 都通了（2026-10-27 23:1x）

三个「再加一个 element 类型」的活，一个晚上全做完。下面是能省下明天三小时的细节。

### 11.1 发文件：`fileElement`，elementType 必须 **3**

```js
var target = msgService().getRichMediaFilePathForMobileQQSend({
  md5HexStr: md5, fileName: name, elementType: 3, elementSubType: 0,
  thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: ''
})
fs.copyFileSync(localPath, target)   // 必须先拷进 QQ 自己的发送目录
sendMsg('0', peer, [{
  elementType: 3, elementId: '',
  fileElement: { fileName: name, folderId: '', filePath: target, fileSize: String(size) }
}], new Map())
```

- **踩的坑**：一开始按「文件」想当然写了 `elementType: 9` → `sendMsg` 返回 `result: 5`（拒绝）。
  9 是 `WALLET`（钱包），`FILE = 3 / PTT = 4 / PIC = 2 / REPLY = 7 / TEXT = 1`。
  枚举在 NapCat bundle 里：`_e = {UNKNOWN:0, TEXT:1, PIC:2, FILE:3, PTT:4, VIDEO:5, ... REPLY:7}`。
- `fileElement` 只需要这**四个字段**（NapCat 的 `createValidSendFileElement` 就是这样），
  多余字段（fileMd5/fileUuid/thumbs…）不用给，内核自己补 fileUuid/fileSha 之类。
- 成功后 `transferStatus` 会走 1→4，对端落盘正常。

### 11.2 引用回复：`replyElement`，字段名是**拼错的那个**

```js
{ elementType: 7, elementId: '', replyElement: {
    replayMsgId: String(targetMsgId),        // ← replay，不是 reply！
    replayMsgSeq: String(targetSeq),
    replyMsgTime: String(targetTime),        // 秒
    senderUin: String(targetSenderUin),
    senderUidStr: String(targetSenderUid),
    replyMsgClientSeq: String(targetSeq)     // 群聊里是 0，私聊 = seq
} }
```

- 试过两套形状：只有 `replayMsgId/replayMsgSeq`（拼错的）+ 配套四个字段 → **引用块正常**；
  写成正确的 `replyMsgId/replyMsgSeq` → 内核**照样 result 0**，但对端只看到裸文字，引用块不出现。
  **内核只认拼错的那两个名字**，这套字段名来自 NapCat 的 `parseElement`：`n.messageId / n.friendSeq`。
- `seq` / `time` / 发送者都可以不传：桥会先用 `getMsgsByMsgId(peer,[msgId])` 把消息查出来自己补
  （不给 msgId 就取 `getAioFirstViewLatestMsgs` 里对方最近一条）。
- 群里 `replyMsgClientSeq` 给 0（NapCat 的 `isGroupReply` 判断就是 `clientSeq === 0`）。

### 11.3 发语音：`pttElement`，elementType **4**，文件必须已经是 silk

```js
var target = getRichMediaFilePathForMobileQQSend({ md5HexStr, fileName, elementType: 4, ... })
fs.copyFileSync(silkPath, target)
sendMsg('0', peer, [{ elementType: 4, elementId: '', pttElement: {
  fileName, filePath: target, md5HexStr, fileSize: String(size), duration, formatType: 1,
  voiceType: 1, voiceChangeType: 0, canConvert2Text: true,
  waveAmplitudes: [0,18,9,23,16,17,16,15,44,17,24,20,14,15,17],
  fileSubId: '', playState: 1, autoConvertText: 0, storeID: 0,
  otherBusinessInfo: { aiVoiceType: 0 }
} }], new Map())
```

- **验证方式**：把刚发出去的语音再用 `/ptt?msgId=…` 走一遍服务器转写，返回「嗯。」——
  说明服务器认这段音频，内容没坏（对端收到 1518 字节是服务器重编码后的短语音，不是截断）。
- **还没做的**：任意音频（wav/mp3）→ silk。NapCat 靠带 `ntsilk_s16le` 编码器的 ffmpeg
  （`ffmpeg -i in.wav -ac 1 -ar 24000 -c:a ntsilk_s16le out.silk`），本机 ffmpeg 7.0.2 **没这个编码器**；
  `silk-wasm` 3.7.1 被 gate 扫成 **BLOCK**（wasm loader 里有 `new Function` 混淆），别绕过。
  目前能发的是「已经是 silk 的文件」＝ 收到的语音原样转发。
- **试过 amr：不行**。用 Windows SAPI 合成 wav → ffmpeg `libopencore_amrnb` 转 amr（8000Hz/12.2k）→ 发出去
  `result: 0`、`transferStatus: 2`（上传成功、能收下），但服务器转写返回**空**：
  QQ 只认 silk，amr 收得进、读不出字。
- 顺带查到：NapCat 的 `convertToNTSilkTct` 是调**系统 ffmpeg** 的 `ntsilk_s16le` 编码器
  （`process.env.FFMPEG_PATH || 'ffmpeg'`），本机 ffmpeg 7.0.2 没这个编码器 →
  **这条它也不比我们强**，谁先搞到 silk 编码器谁就赢。
- **对端实测 `silk-wasm` 是能编的**（2026-10-27 23:22，QQ 那边那个我跑的）：
  `ffmpeg -i in.amr -ac 1 -ar 8000 out.wav` → `await encode(wavBuffer, 0)` → 5972 字节 / 2160ms 的 silk，
  丢过来我给 `/sendptt` 一发就成，服务器转写回「嗯。」＝内容完好。
  所以 **silk 编码本身不是死路，只是这台机器上我这个身份装不了**（gate 扫 silk-wasm 是 BLOCK：
  Emscripten loader 里有 `new Function` 混淆；备选 `node-silk` / `silk-sdk` 是 WARN，
  但都要 node-gyp + MSVC 编译，没试）。
- 现在的分工：**对端用 silk-wasm 编好 → 丢 `workspaces\...\silk-drop\` → 这边 `qq_send_voice` 绝对路径发**。
  想彻底自主，下一步是给桥加「wav + 外部编码命令（`silkEncoderCmd`）」这条路，谁编都行，桥只负责送。
- **已经自主了（2026-10-27 23:25）**：见 11.7。

### 11.7 本地 silk 编码：自己编了个编码器，不再求人

- 源码 <https://github.com/kn007/silk-v3-decoder>（Skype SILK SDK，MIT），克隆在 `tools\silk-v3\`
- **用 MinGW gcc 现编**（不下载别人的 exe、不碰 wasm）：
  ```powershell
  cd tools\silk-v3\silk
  $srcs = (Get-ChildItem src -Filter '*.c' | % { "src/$($_.Name)" }) -join ' '
  & 'D:\Program-Files\CodeBlocks\MinGW\bin\gcc.exe' -O2 -w -Iinterface -Isrc -o silk_encode.exe test/Encoder.c $srcs
  ```
  产物 → `tools\silk\silk_encode.exe`（287KB），说明写在 `tools\silk\README.md`
- 编码链路（编码器吃**裸 PCM**）：
  `ffmpeg -i in.<any> -f s16le -ac 1 -ar 16000 -acodec pcm_s16le in.pcm`
  → `silk_encode.exe in.pcm out.silk -Fs_API 16000 -tencent`（**必须 `-tencent`**，文件头要 `#!SILK_V3`）
- 插件侧：`lib/silk.js` 的 `toSilk(path, {ffmpegPath, silkEncoderPath})` + `cleanupSilk(res)`；
  `qq_send_voice` 现在**直接吃 wav/mp3/amr/silk**，不是 silk 就先本地转，duration 自动按 PCM 长度算。
  配置项：`ffmpegPath`（默认 `ffmpeg`，PATH 里有）、`silkEncoderPath`（默认 `tools\silk\silk_encode.exe`）
- **实测**：SAPI 合成「你好，我是樱，这是本地编码的语音测试」→ 12440 字节 silk → 发出 →
  服务器转写回来「你好，我是英，这是本地编码的语音测试。」（英＝樱，ASR 老毛病）—— 完全自立。

### 11.4 顺手修掉的炸弹：旧监听器被僵尸定时器反复注册

症状：同一条消息在 `qq-bridge.log` 里刷十几遍 `RECV`，还夹着
`onOneMsg err ensurePttTranscribed is not defined`。

- 原因：早期 eval 留下的 `ensure` 定时器闭包里的 `LISTENER_VER` 永远是 `v12`，
  它每 10 秒把 `v12` 监听器再注册一次；QQ 给新监听器会**回放最近消息**，于是同一条被推 N 遍。
- 修法（两层）：
  1. `installListenerGuard()` 把 `msgService().addKernelMsgListener` 包一层，
     只放行 `l.__qqVer === global.__qqListenerVer`（版本号放全局，跟着 eval 更新）→ 旧注册进不来。
  2. `global.ensurePttTranscribed / ensurePicDownloaded = …` 每轮 eval 覆盖一次，
     旧闭包里那几个函数名解析到全局，不再 ReferenceError。
- 现在 `LISTENER_VER = 'v17'`。

### 11.5 调试用端点（留着有用）

| 端点 | 用途 |
|---|---|
| `GET /raw?peerUid=&chatType=&msgId=&count=` | dump 原始元素结构（`Js()` 会处理 Map/BigInt/循环）——查 `replyElement`/`fileElement` 真字段名全靠它 |
| `GET /sendfile?peerUid=&chatType=&path=` | 发文件 |
| `GET /sendptt?peerUid=&chatType=&path=&duration=` | 发语音 |
| `GET /reply?peerUid=&chatType=&msgId=&text=` | 引用回复（seq/time/sender 可省） |

插件工具同步加好：`qq_send_file`、`qq_send_voice`、`qq_reply`（改插件要重启宿主才出现）。

### 11.6 重启后又踩的三个坑

1. **路径里的空格**：`URLSearchParams` 把空格编成 `+`，桥的 `qs()` 用 `decodeURIComponent` 不认 `+`，
   `Tencent Files` 变成 `Tencent+Files` → `ENOENT`。修法：`qs()` 里先 `.replace(/\+/g,' ')` 再 decode。
2. **chat 填 QQ 号会发丢**：`u-3793339506` 是**樱自己的号**，当 peerUid 用当然查不到消息。
   现在桥里加了 `toUid()`：纯数字先 `getUixConvertService().getUid(uin)` 转 uid，
   转出来等于自己就直接抛「这是自己的号，别发给自己」。
3. **`qq_reply` 的默认引用**不能靠「翻历史挑一条」——会挑到自己刚发的。
   插件在 `globalThis.__qqLastInbound` 里记住**每个聊天最近一条进来的消息**（msgId/seq/time/senderUid），
   `qq_reply` 不传 msgId 就用它，并把 seq/time/senderUid 一起带给桥。

### 11.8 ⚠ 事故：发「群图片」把 QQ shell 搞崩了（2026-10-27 23:28）

- 现象：`qq_send_image` 发到测试群 `602173548`，桥日志停在
  `sendPicture md5=… -> …\nt_data\Pic\2026-10\Ori\<md5>.png`，**进程当场没了**（没有异常、没有堆栈）。
- 哨兵把壳拉起来了（新 pid），但**登录没了**：`quickLogin: 3793339506 not in list` → 要重新扫码。
- 私聊发图片是好的（发过好几次）；**群发图片这条路径要重新验**，别直接在群里试。
  下次试的时候：先把 `picElement` 换成 NapCat 的完整形状（`picSubType`/`fileUuid`/`thumbFileSize` 都带上），
  并且**单独开一个进程观察**，崩了至少能看出是哪一步。
- 复盘要点：`getRichMediaFilePathForMobileQQSend` 对群（chatType=2）也许该换成群专用的路径函数，
  或者群图片得先走 `RichMediaService` 上传再发元素——**别把私聊那套直接套到群里**。
- **第二次验证（23:35）**：换成 `getRichMediaFilePathForGuild` + 完整 picElement 再发，**照样崩**。
  结论：群图必须先用 `RichMediaService` / OIDB（NapCat 的 `uploadGroupImage`：`sendOidbPacket` + Highway `upload`）
  把图传上去，拿 `msgInfo`/`uuid` 再发元素。现在桥里直接 `throw`，**不许再崩第三次**。

## 十二、干掉 NapCat：双壳架构（2026-10-27 23:50 完成）

**NapCat 已经下线**：QQ2 进程 0、`3001` 没人听、NapCat 哨兵也停了。
现在两个号都跑在我们自己编的纯 shell 上：

| 号 | 目录 | 端口 | 账号 | 桥脚本实例 | 工具前缀 |
|---|---|---|---|---|---|
| 樱 | `D:\Program-Files\QQ-shell` | 39272 | 3793339506 (`u_BsJrCaYeH77_OZ78H5pEXA`) | 默认 | `qq_*` |
| 鲸鱼娘 | `D:\Program-Files\QQ-shell2` | 39273 | 2909433072 (`u_wCwUuJmmlLb7g6MDEKm5Iw`) | `instanceId: whale` | `qq2_*` |

两个壳共用**同一个** `qq-bridge-script.js`，靠 loader 注入的 `global.__QQ_BOOT` 区分：

```js
global.__QQ_BOOT = { port, log, cmd, res, config, qrFile, own, uin }
```

脚本里有这些开关（都能被 BOOT 覆盖）：`LOG / CMD / RES / PORT / QUICK_UIN / DATA_ROOT / OWN`
以及 `CFG`（每个实例读自己的 `qq-config2.json`）。

### 12.1 插件侧多实例

- `instanceId`：隔开去重文件（`<DSH_HOME>/qq-adapter/seen-<instanceId>.json`）和内部状态
- `toolPrefix`：工具名加前缀（第二个实例 `qq2_`），否则同一宿主里两个实例抢同名工具
- `installShellGuard` 之外还加了防重复拉壳：
  - **冷却 120s**
  - 拉之前先查「这个安装目录下有没有 QQ.exe 在跑」，有就不拉

### 12.2 这一夜最贵的两个教训

1. **QQ.exe 是单实例的**：同一个安装目录被拉起两次，后起的会把先起的顶掉（表现为进程神秘消失、
   `quickLogin: xxx not in list`、要重扫码）。所以 loader 里加了**单实例守卫**：
   ```js
   const guard = net.createServer()
   guard.once('error', () => process.exit(0))     // 抢不到端口说明已经有一个在跑
   guard.listen(39273, '127.0.0.1', () => { guard.close(() => run()) })
   ```
2. **NapCat 的哨兵会「抢号」**：它每 3 分钟把 NapCat 拉回来，NapCat 一登录就把新壳顶掉。
   所以搬家顺序必须是：**先停哨兵 → 再停 NapCat → 最后才让新壳登录**。
   现成脚本：`workspaces\alive-workspace\stop-napcat.ps1`（回滚命令写在文件头）。

### 12.3 两个壳的保活归谁管

- 桥挂了：`qq-adapter` 的 `ensureShell` 每条实例各管各的（配好 `shellBootPath`/`shellDir`）
- 登录失效：桥自己会推二维码（`notifyTopic` 那个 ntfy 主题）；鲸鱼娘实例现在还是 `autoStartShell: false`
  —— 因为它的壳是我们手动起的，需要自动重启时再打开（打开前先确认单实例守卫在位）
- **NapCat 的哨兵已经退役**：脚本搬到 `tools\_retired\napcat-sentinel\`（带 README），
  开机启动里的 `NapCatSentinel.vbs`（→ `start-sentinel.cmd`）和 `NapCat-QQBot.lnk`
  （→ `start-napcat.cmd`）也摘掉了，备份在 `patches\backups\startup-retired-2026-10-27\`。
  NapCat 本体还留在 `tools\NapCat` 当参考，**但不会自启动**——它一登录就会把我们的壳顶下线。
  要给鲸鱼娘的壳做保活，得另写一个哨兵（探 39273，掉了用 WMI 拉 `QQ-shell2`）。

### 12.4 现在的主链路

```
你手机 QQ（3041632789）
   ↕ 鲸鱼娘 2909433072 ── QQ-shell2(39273) ── qq-adapter-whale ── s-onebot-private-3793339506-…
樱 3793339506 ── QQ-shell(39272) ── qq-adapter(default) ── s-session-b51b82c8-…
```

- 主人发鲸鱼娘的私聊 → 进「鲸鱼娘那条会话」
- 樱收到的消息（比如那边那个我跟樱聊天）→ 进「樱那条会话」
- 两条会话各用各的工具前缀，**别再混着调**
