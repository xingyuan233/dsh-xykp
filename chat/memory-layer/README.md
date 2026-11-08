# memory-layer

以概念为核心的联想记忆。一个预设一个库，存在 `$DSH_HOME/memory-layer/layers/<预设>.json`。

## 做什么

- 只扫 **user 正文** 和 **assistant 正文**：`reasoning`、工具返回、工具调用参数一律不扫
- 扫到命中概念就用 `systemPrompt.context` 每轮注入 —— 不改前缀、不多一轮回复
- 所有写操作收在 `memory_ctrl` 一个工具里，返回带 `eventId`

## 注入长什么样

```
【相关记忆】
event-12: ta 定的日记规约，一个文件一件事
event-7: 第一次做完整版视频 | 找工作/产出/README.md
```

没有详情的事件只有前半段。要展开就用 `memory_ctrl action=get eventId=12`。

## 工具

```
memory_ctrl action=add    brief=... concepts=[{key:'草莓',match:0.9}] detail=路径
memory_ctrl action=forget eventId=12
memory_ctrl action=get    eventId=12
memory_ctrl action=list   keyword=草莓
memory_ctrl action=stats
```

`forget` 是把各概念下这份 ce 清零，不真删 —— 沉到底部，检索不再走它。

## 配置

`$DSH_HOME/memory-layer/config.json`（没有就用默认值）：

```json
{
  "presets": ["test"],
  "injectOrder": 960,
  "eventBudget": 4,
  "charBudget": 320,
  "dailyAt": "04:00",
  "maxScanChars": 4000
}
```

- `presets`：绑哪些预设，`null` = 全部，`[]` = 都不生效
- `eventBudget` / `charBudget`：每轮注入几条、多少字

## 还没接的

- 日更新目前只在启动和每 10 分钟检查时落盘，**没有做全量推进 cm/cc**（cm 的回合项在扫描时按需更新）
- `dailyAt` 还没真正用上
