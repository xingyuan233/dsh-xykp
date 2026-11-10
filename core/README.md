# 宿主核心补丁（plugins\core）

**一个功能 = 一个 `.mjs` 文件，文件名就是功能名；旁边同名 `.md` 写清楚改了什么。**
没有入口列表、没有写死的名字：`apply-all.mjs` 扫这个目录，按文件名顺序应用。

```
plugins\core\
  apply-all.ps1        ← 总入口（-Check / -Restore）
  apply-all.mjs        ← 引擎：扫目录、幂等应用、备份、还原
  <功能名>.mjs         ← 一个功能补丁
  <功能名>.md          ← 这个补丁改了什么的说明
  .backup\             ← 被改文件的原始副本（有备份的补丁用它还原）
```

当前：

| 文件 | 改什么 |
|---|---|
| `tool-wire-slim.mjs` | 工具定义改成 `params:` 首行 + 散文，`input_schema` 压到 `{"type":"object"}` |
| `tool-wire-trims.mjs` | 自带工具的文案精简（表在文件顶部 `TRIMS`），省 42% 工具 token |
| `session-tolerance.mjs` | 单条会话日志读不出来时跳过它，不再拖垮整个会话列表 |
| `tool-desc-pin.mjs` | 工具说明/参数变了只记录（完整文本，不冻结）；前缀固定由 tooldesc-control 按会话做 |
| `injection-slot.mjs` | 每个 assistant step 正文前渲染 `conversation.chat.injection` 槽位（带 turn/step/answer），给 injection-shower 按步显示注入用 |
| `turn-tail-empty.mjs` | 空回复（只有思考、没有正文）的轮也保留底部栏：赞踩/用量/时间，隐藏复制 |

## 自动还原（装完就不用管了）

宿主和 profile 的 `package.json` 里各挂了一个 `postinstall`：

| 谁 | 什么时候触发 | 跑什么 |
|---|---|---|
| `DSH\npm\package.json`（宿主本体） | `npm install`（升级 dsh） | `plugins\core\auto-restore.cmd` → 只打 `plugins\core` |
| `HOME\profiles\web\package.json`（profile） | `pnpm install` | `plugins\core\auto-restore.cmd --full` → 核心补丁 + `plugins\core\restore-all.ps1` |

`auto-restore.cmd` 永远 `exit 0`，日志追加到 `plugins\core\auto-restore.log`——补丁失败也不会把安装搞崩。
补丁打完仍是**下次启动**才生效（宿主已经 import 过的模块改文件没用）。

缺口：`pnpm add`（`dsh plugin add` 走的就是它）**不会**触发根 `postinstall`，这是 pnpm 的行为。
不过 `dsh plugin add` 只动 profile 的 `node_modules`，不碰宿主的 `@deepseek-ai\*`，所以核心补丁不受影响；
真要保险，装完顺手跑一次 `restore-all.ps1 -Check`。

> 钩子被搞丢了（重装包、换 profile）就跑 `install-hooks.ps1` 重新装一次，幂等。

> 备份会随版本刷新：目标文件内容对不上旧备份时（升级/重装），旧备份改名成 `<名字>.<时间戳>.old` 留档，
> 再按当前版本重新备份，避免 `-Restore` 把旧版本源码写回去。

## 加一个新补丁

1. 建 `<功能名>.mjs`（名字要能一眼看出是干什么的），导出：

```js
export const id = '包名/功能名'            // 打印用
export const description = '一句话'        // 打印用
export const edits = [{
  target: 'D:\\...\\node_modules\\@deepseek-ai\\<包>\\lib\\index.js',
  marker: '唯一幂等标记',                  // 文件里有它就跳过
  apply(text) { /* 纯文本变换，返回新文本 */ },
  revert(text) { /* 可选：反推官方原文，供 -Restore 用 */ },
}]
```

2. 再写 `<功能名>.md`：改了什么、为什么、怎么验证、怎么还原。
3. 不用注册任何东西——`apply-all.ps1` 下次运行自动带上。

规则：

- `apply()` 必须只改自己那一段，锚点不唯一就 `throw`（引擎会拒绝写入）。
- 有 `revert()` 的补丁就算没有备份也能还原；两者都没有就只能重装 npm 包。
- 删掉 `.mjs` 等于撤掉这个补丁。

## 用法

```
pwsh -File apply-all.ps1           应用全部（幂等）
pwsh -File apply-all.ps1 -Check    只列状态
pwsh -File apply-all.ps1 -Restore  还原全部
```

`restore-all.ps1`（dsh 升级/装插件之后跑的那个）现在也只调用这里，不写死任何补丁名。

补丁打完要**重启 dsh web** 才生效；工具定义类的补丁只对**新会话**生效（工具目录会进会话历史）。




