# 补丁：自带工具的描述精简（tool-wire-trims）

## 改了什么

在 `defineTool` 生成 wire 描述之前套一张表，按「工具名 → 描述 / 参数描述」覆盖
`@deepseek-ai` 自带工具的文案。表在 `tool-wire-trims.mjs` 顶部的 `TRIMS`。

原样（自带）：

```
params: (file_path<Path to read, resolved by the filesystem backend; offset?<1-based first line to return. Defaults to 1; limit?<Maximum number of lines to return. Defaults to 2000)
Read a UTF-8 text file and return line-numbered content.
```

精简后：

```
params: (file_path; offset?<从第几行开始（1 起）; limit?=2000<最多读几行（默认 2000）)
读 UTF-8 文本文件，返回带行号的内容。
```

`file_path` 这种「名字已经说清」的参数直接不给描述（等价 `showDesc: false`）。

## 效果（按当前 52 个工具的实测口径估算）

| | token |
|---|---:|
| 精简前 | 8,661 |
| 精简后 | **5,042**（−42%） |

单项最大的几个：`pwsh` 789→129、`workflow` 569→146、`schedule_create` 384→42、`subagent` 253→42。

## 规则

- 表里 `null` = 该参数不显示描述；字符串 = 用它替换；**不写** = 保持原样。
- 工具不在表里 → 完全不动（插件工具就没进表）。
- 表只覆盖文案，不碰校验：完整 schema 仍在闭包里。

## 依赖

必须先应用 `tool-wire-slim.mjs`（它负责把 description 换成 `params:` 行）。
顺序由文件名保证：`tool-wire-slim.mjs` < `tool-wire-trims.mjs`。

## 改文案

1. 改 `tool-wire-trims.mjs` 里的 `TRIMS`；
2. `pwsh -File patches\core\apply-all.ps1 -Restore` 然后 `apply-all.ps1`
   （已应用状态下会跳过，必须先还原再打）；
3. 重启 `dsh web`，新会话生效。

## 注意

- 描述就是模型对这个工具的全部认知（schema 已经不在提示词里），删描述前确认参数名真的自解释。
- 删掉的内容里有操作性约束的（比如 pwsh 的沙箱拒绝、EPERM 边界），确认别的地方还有覆盖，
  否则模型会重试错误做法。
