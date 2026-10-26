# storage/preset-loader

从文件夹加载人格预设：`<dir>/<id>/preset.yml`，文件夹名必须等于预设 id。

## 做什么

- 把目录里的预设注册进 DSH 的 `agentPresets` 注册表
- 每个 preset.yml 算 sha256，跟 `.lock.json` 里的对比；变了就往 `.changelog.log` 追一行
- **每个预设文件夹里有一份 `.last-read.json`**：记着上次读到的内容（sha256 + mtime + 原文）。
  下次发现 mtime/指纹变了，就用它和当前文件做一次行级 diff，把 `@@ … @@` 的改动
  打进宿主日志和 `.changelog.log`，然后才更新这份快照
- 监听目录：改完 preset.yml 自动重注册，**不用重启宿主**
- 新版本装载失败 → 自动回滚，并记住「这份指纹坏过」，文件不再变就不反复重试

## 热重载的语义

跟原来「改 cordis.patch.yml 自动重载」是一个意思：

- 已经在跑的会话留在旧版本上（旧 generation 要等最后一个会话放手才卸载）
- 新开的会话用新版本
- 新版本 YAML 不合法 / 装载成 broken → 自动回滚到上一个能用的定义

`.lock.json` / `.changelog.log` / `.last-read.json` 都是点文件；监听会忽略它们，不会自己触发自己。

## 配置

```yaml
- insert:
    - id: preset-loader
      name: 'dsh-xykp/storage/preset-loader'
      config:
        dir: 'D:\AI\DeepseekHarness\home\profiles\web\presets'
        # watch: true          # 默认开；关了就只能重启生效
        # debounceMs: 400
        # lockPath / changelogPath 默认都在 dir 里
```

## 不抢

如果某个预设 id 已经在 `cordis.patch.yml` 里声明过，这里只记指纹、不重复注册——
切换期间人格不会因为加载器出问题而消失。

## 依赖

- DSH 服务：`agentPresets`（注册表）
- npm：`js-yaml@4.3.2`（仓库自己的依赖，`pnpm install` 会装到仓库的 node_modules；找不到就整层跳过，不报错）
