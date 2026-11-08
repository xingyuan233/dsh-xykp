# 补丁：工具定义的 wire 形态（tool-wire-slim）

**一句话**：发给模型的 tool 定义从「完整 JSON Schema」改成散文，参数描述不再逐个塞进 JSON。

## 改了什么

`defineTool()` 现在同时产出两份 schema：

| 用途 | 内容 |
|---|---|
| 发给模型（wire） | `description` 散文 + `input_schema: {"type":"object"}` |
| 参数校验（本地） | 完整 JSON Schema，仍在闭包里，**一点没变** |

wire 的 `description` 长这样（参数和参数说明写在同一行，不再分开）：

```
params: (file_path<文件的绝对路径; offset?:number<从第几行开始; limit?=2000<最多读几行)
读取一个文件，返回带行号的内容。
```

- 一个参数一段，用 `; ` 分隔；格式 `name[?][:type][=默认值][<描述]`
- 必填不带 `?`，可选带 `?`
- `:类型` 只在作者标了 `showType: true` 时出现（**默认关**）
- `=默认值` 在参数声明了 `default` 时出现（**默认开**，`showDefault: false` 可关）
- `<描述` 默认出现（**默认开**，`showDesc: false` 可关）；描述末尾的句号会被去掉
- 第二行起是作者原本的 `description`，原样保留
- `input_schema` 压到上游允许的下限 `{"type":"object"}`

原始定义、执行逻辑、输出 schema、`presentCall` 都没动。完整 schema 另外挂在 `tool.parametersFull`（给以后 PTC / SDK 生成用）。

## 为什么可行（实测，不是推测）

探针结果见 `workspaces\default-workspace\dsh-api-probe-results.md`：

- `input_schema` 是**必填字段**，`{}` 会 400（`type: null`），最低形态就是 `{"type":"object"}`；
- 工具名只能是 `^[a-zA-Z0-9_-]+$`，所以签名行只能放 description；
- 只给 `{"type":"object"}`、参数全靠描述时，模型仍能正确传参（6 个核心工具 × 6 个任务，与完整 schema 逐条一致）。

## 省多少

| 范围 | 之前 | 之后 |
|---|---:|---:|
| 核心 31 个工具 | 6,670 | **4,857** |
| 全部 52 个（含插件） | 10,788 | **8,169** |

不可再压的部分：`name` 字段 263 + `input_schema` 壳 386（每个工具 7 token，API 必填）。

附带效果：工具前后缀变小后，**以后改任何工具描述，被作废的缓存前缀也小一半**（上游会自动缓存 tools 段，实测 1,920 token 从第一次就命中）。

## 开关

- 全局关：环境变量 `DSH_TOOL_WIRE=off`
- 单工具关：定义里写 `compressionParameter: false`
- 参数要显示类型：定义里给该参数加 `showType: true`（作者专用键，编译时剥掉，**千万别发到上游**，会 400）

## 已知限制

1. **PTC 模式**：SDK 生成读的是 wire schema，开 PTC 前要改成读 `parametersFull`。
2. **GUI 工具卡片**：参数列表可能显示不出来（wire 里已经没有 `properties`）。
3. **只对新会话生效**：工具目录会写进会话历史，中途换形状等于工具变更（缓存失效 + toolUpdate 语义）。

## 验证方法

```
pwsh -File patches\core\apply-all.ps1 -Check
```

重启宿主 → 开新会话 → 看会话日志里新会话的 `request/header.header.tools`：
- 每个工具的 `description` 第一行是 `params: (...)`
- `parameters` 只剩 `{"type":"object"}`
