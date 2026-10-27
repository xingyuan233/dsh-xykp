# QQ 自研适配层 · 交接（2026-10-27 20:20 更新）

> 目标：在 `comms/qq-adapter` 里自己实现 QQ 通道，**不用 NapCat、不用 OneBot**。
> 依赖 QQ 客户端本体（NTQQ 的 native 协议库），用「DLL 注入 + 执行自己的 JS」的方式拿接口。
> 主人要求：接口可以抄（照 NapCat 的调用方式），实现自己写；不做跨平台通用，只做能用的最小集。

## 〇、当前状态（一句话）

**收 / 发 双向打通了。** 在注入的 QQ 主进程里自己 init 出 session，`getMsgService()` 可用，
C2C 文本发送成功（`result:0`），对方回复能通过 `onRecvMsg` 收到。

已验证：
- `engine.initWithDeskTopConfig(...)`
- `login.initConfig(...)` → `login.connect()` → `getQRCodePicture()`
- 扫码登录（樱 3793339506）
- `startup.create()` → `session.init(sessionInfo, msfL, dispL, sessL)` → `startup.start()`
- 回调：`onNTSessionCreate` → `onOpentelemetryInit{is_init:true}` → `onSessionInitComplete 0`
- `session.getMsgService()` 立刻可用（完整 300+ 方法）
- `ms.addKernelMsgListener({onRecvMsg, onAddSendMsg, onMsgInfoListUpdate})` 收到真实消息
- `ms.sendMsg('0', {chatType:1, peerUid, guildId:''}, [{elementType:1, elementId:'', textElement:{content, atType:0, atUid:'', atTinyId:'', atNtUid:''}}], new Map())` 发送成功

## 一、跑通的完整启动顺序（重要，照这个来）

在 QQ 主进程里（注入后拿到的 `napi_env` 里跑 JS）：

```js
// 0) 拿 wrapper（process.mainModule 在 run_script 环境里可用）
var wmod = process.mainModule.require('D:\\Program-Files\\QQ-dsh\\versions\\9.9.36-53644\\resources\\app\\wrapper.node');

// 1) 引擎初始化（返回 false 也不代表失败，NapCat 同样忽略返回值）
var eng = wmod.NodeIQQNTWrapperEngine.get();
eng.initWithDeskTopConfig({
  base_path_prefix: '',
  platform_type: 3,               // KWINDOWS
  app_type: 4,
  app_version: '9.9.36-53644',
  os_version: os.release(),
  use_xlog: false,
  qua: 'V1_WIN_NQ_9.9.36_53644_GW_B',
  global_path_config: { desktopGlobalPath: <自己的 global 目录> },
  thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 }
}, { onLog(){}, onGetSrvCalTime(){return 0}, onShowErrUITips(){}, fixPicImgType(){},
     getAppSetting(){return '{"maxSide":324,"minSide":48,"longLimit":6,"density":2}'},
     onInstallFinished(){}, onUpdateGeneralFlag(){}, onGetOfflineMsg(){} });

// 2) 登录服务配置
var login = wmod.NodeIKernelLoginService.get();
login.initConfig({ machineId:'', appid:537391628, platVer: os.release(),
                   commonPath: <自己的 global 目录>, clientVer:'9.9.36-53644',
                   hostName: os.hostname(), externalVersion:false });

// 3) 登录（二维码）——监听器实现 onQRCodeGetPicture / onQRCodeLoginSucceed 等
login.addKernelLoginListener(L);
login.connect();
setTimeout(() => login.getQRCodePicture(), 1500);   // 回调里给 qrcodeUrl + pngBase64QrcodeData

// 4) 登录成功回调里：init session
var session = wmod.NodeIQQNTWrapperSession.getNTWrapperSession('nt_1');  // 登录后才有
session.init(sessionInfo, msfListener, dispatchListener, sessionListener);
var startup = wmod.NodeIQQNTStartupSessionWrapper.create();
startup.start();       // → onNTSessionCreate / onSessionInitComplete

// 5) 用
var ms = session.getMsgService();
```

`sessionInfo`（照 NapCat `xse()` 的结构，字段都是真名）：

```js
{
  selfUin: '3793339506', selfUid: 'u_BsJrCaYeH77_OZ78H5pEXA',
  desktopPathConfig: { account_path: '<Tencent Files>/<uin>' },
  clientVer: '9.9.36-53644',
  a2:'', d2:'', d2Key:'', machineId:'',
  platform: 3, platVer: os.release(), appid: 537391628,
  rdeliveryConfig: { appKey:'', systemId:0, appId:'', logicEnvironment:'', platform:3,
    language:'', sdkVersion:'', userId:'', appVersion:'', osVersion:'', bundleId:'',
    serverUrl:'', fixedAfterHitKeys:[''] },
  defaultFileDownloadPath: <临时目录>,
  deviceInfo: { guid: login.getMachineGuid(), buildVer:'9.9.36-53644', localId:2052,
    devName: os.hostname(), devType: os.type(), vendorName:'', osVer: os.release(),
    vendorOsName: os.type(), setMute:false, vendorType:0 },
  deviceConfig: '{"appearance":{"isSplitViewMode":true},"msg":{}}'
}
```

三个监听器只要方法名齐了就行（空实现也能跑）：

- msf：`onMSFStatusChange` / `onMSFSsoError` / `getGroupCode`
- dispatch：`dispatchRequest` / `dispatchCall` / `dispatchCallWithJson`
- session：`onNTSessionCreate` / `onGProSessionCreate` / `onSessionInitComplete` /
  `onOpentelemetryInit` / `onUserOnlineResult` / `onGetSelfTinyId`
- engine：`onLog` / `onGetSrvCalTime` / `onShowErrUITests`(实际名 `onShowErrUITips`) /
  `fixPicImgType` / `getAppSetting` / `onInstallFinished` / `onUpdateGeneralFlag` / `onGetOfflineMsg`
- login：`onLoginConnected` / `onLoginConnecting` / `onLoginDisConnected` /
  `onQRCodeGetPicture` / `onQRCodeLoginPollingStarted` / `onQRCodeSessionUserScaned` /
  `onQRCodeLoginSucceed` / `onUserLoggedIn` / `onLogoutSucceed`

## 二、关键结论：QQ 的 app 和 wrapper 是两套栈

- QQ 自己的 UI（`application.asar/app_launcher` + `major.node`）**完全不用** `NodeIQQNTWrapperSession`。
  实测：app 正常登录着，`getNTWrapperSession('nt_1')` 返回空壳，`getMsgService()` undefined，
  `engine.getDeviceInfo()` 全空。
- 所以想用 wrapper 这条门，必须**自己 init**（上面那套），等于「在 QQ 进程里跑一个 NapCat Shell」。
- 两套栈可以同进程共存：独立实例里 app 停登录页、我们的 session 自己扫码登录、收发正常。
- 数据要隔离：`global_path_config.desktopGlobalPath` 和 `login.initConfig.commonPath` 都指到
  自己的目录（现在是 `workspaces\alive-workspace\qq-nt\global`），别跟 app 抢同一份 msf 状态。

## 三、文件与路径

| 东西 | 路径 |
|---|---|
| QQ 副本（随便折腾） | `D:\Program-Files\QQ-dsh`（9.9.36-53644） |
| 正版 QQ（别动） | `D:\Program-Files\QQ2`（NapCat 在用） |
| 桥 DLL / 注入器源码 | `plugins\comms\qq-adapter\bridge\{qqbridge.cpp,injector.cpp,build.ps1}` |
| 当前桥脚本（热重载） | `workspaces\alive-workspace\qq-bridge-script.js` |
| 日志 | `workspaces\alive-workspace\qq-bridge.log`（每行前缀 `[pid]`） |
| 命令文件 / 结果 | `workspaces\alive-workspace\qq-cmd.json` / `qq-cmd-result.json` |
| 独立实例 user-data-dir | `workspaces\alive-workspace\qq-inst2` |
| 我们自己的 NT global | `workspaces\alive-workspace\qq-nt` |
| NapCat 参考 | `tools\NapCat\shell\napcat.mjs`（`FL()`≈83290、`n2e()`≈83256、`xse()`≈33027） |

跑法：

```powershell
# 起一个独立实例（不动主人日常那个 QQ-dsh）
cd D:\AI\DeepseekHarness\plugins\comms\qq-adapter\bridge
& .\injector.exe "D:\Program-Files\QQ-dsh\QQ.exe" "$PWD\qqbridge.dll" "--no-sandbox" "--user-data-dir=D:\AI\DeepseekHarness\workspaces\alive-workspace\qq-inst2"
```

## 四、调试机制（踩过坑，记住）

- **DLL 的 hot-reload 是「被动」的**：它挂在 `napi_create_string_utf8` 上，QQ 主进程安静时根本
  不触发。所以脚本里**必须自带 JS 自热重载定时器**（`fs.statSync(SELF).mtimeMs` + `eval`），
  改文件 1.5s 生效。第一版只有 DLL 那层，「改完没反应」浪费时间。
- **eval 会叠加闭包**：上个版本创建的 `setInterval` 里的回调还是旧代码。状态要放
  `global.__qqState` 并给定时器加版本号（`S.cmdVer !== 'v6c'` 时先 `clearInterval` 再重建）。
- 脚本必须整体 try/catch，否则 QQ 弹「A JavaScript error occurred in the main process」。
- 不能用裸 `require`，用 `process.mainModule.require(...)`。
- 登录后 `getNTWrapperSession('nt_1')` 才返回对象；登录前是 `undefined`。
- `getRecentContactListSnapShot(n)` / `getBuddyListV2('0', true, 0)` 是能用的取列表方式
  （`getRecentContactList()` 要 0 个参数，别乱传）。

## 五、已经排除的路（别再试）

1. 改 `resources/app/package.json` → QQ 报「文件已损坏」（256 字节签名清单）。
2. `--inspect` / `--remote-debugging-port` → fuse 关了，端口不开。
3. `--app-path=` → 启动器忽略。
4. C++ 独立进程 `LoadLibrary(wrapper.node)` → 能加载，但拿不到 JS 层接口。
5. hook `qq_magic_napi_register` 替换 `nm_register_func` → 「Module did not self-register」。
6. 指望 app 登录后白嫖它的 session → 不存在（见第二节）。

## 六、下一步

1. 群消息收发（`chatType: 2`，`peerUid` 是群号）
2. 图片发送（`elementType: 2`，`picElement` 的字段要试）
3. @ 别人（`atType/atUid/atNtUid` 组合）
4. 断线重连 / 掉线重扫 / 进程守护
5. 把这套搬进 `plugins\comms\qq-adapter` 的正式结构（dsh 工具 + 事件转发）
