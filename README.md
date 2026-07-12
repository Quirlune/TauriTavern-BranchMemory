# Branch Memory, Status & Images

面向 TauriTavern 的第三方前端扩展。它提供：

- 只把 `user` 消息计作楼层，AI 消息不计楼。
- 每 N 楼生成阶段小总结，可额外读取后续 K 楼作为上下文，但摘要仍归档到原本 N 楼区间。
- 每 N 楼生成累计大总结。
- 最近 N 楼保留为原文，不立刻总结。
- 用累计消息链指纹识别共同前缀，在聊天分支之间复用分叉点以前的摘要。
- 状态栏只在 AI 回复完整落入聊天后进行另一笔独立模型调用，并可按深度插入聊天历史。
- 状态模型原始输出可通过独立正则与模板注入下一轮正文生成，不依赖界面渲染结果。
- 图片模块可在 AI 回复完成后独立规划插图位置，调用 RunPod Serverless Endpoint 生成图片并插回正文对应位置。
- 图片缓存按聊天、楼层、分支链和提示词配方绑定，历史楼层重新加载后也会回渲染已有图片。
- 图片模块可为不同角色保存独立外貌提示词，切换角色后自动加载对应档案。
- 同一轮的多张图片先连续提交到 Endpoint 队列，再统一轮询，减少重复冷启动和 GPU 空闲时间。
- 图片模块支持正面提示词永久前缀，自动拼接到 AI 输出的正面提示词前。
- 全局调用监控可观察正文及其它插件的生成事件、最终提示词、采样参数和底层网络请求。
- 记忆、状态栏和图片模块分别拥有输入正则和可排序提示词条目栈；记忆/状态栏仍支持输出正则，图片规划改为 XML 标签解析。
- 状态栏支持自定义 HTML 模板与 CSS。
- 记忆、状态栏和图片规划模块可以分别选择 Connection Manager 中的独立 Chat Completion 配置。

## 安装

把整个文件夹放入 TauriTavern 的任一第三方扩展目录：

```text
data/default-user/extensions/TauriTavern-BranchMemory
```

或：

```text
data/extensions/third-party/TauriTavern-BranchMemory
```

重启 TauriTavern，在扩展设置中打开 `Branch Memory, Status & Images`。

本扩展依赖：

- `window.__TAURITAVERN__.api.chat`
- `window.__TAURITAVERN__.api.extension.store`
- SillyTavern/TauriTavern 前端的 `generateRaw()` 与 `setExtensionPrompt()`
- 独立模型连接模式依赖内建 Connection Manager

## 独立模型连接

记忆、状态栏和图片规划各自提供两种调用来源：

1. 沿用当前聊天 API。
2. 选择 Connection Manager 中保存的 Chat Completion Profile。

独立模式只保存 Profile ID，API Key 仍由酒馆的密钥系统管理。记忆、状态栏和图片规划可以选择不同的 Profile，也不会切换当前聊天正在使用的模型连接。

RunPod 生图调用使用图片模块里的独立 API Key 与 Endpoint ID，不走 Connection Manager。图片规划模型仍沿用上述模型连接逻辑。

## 分支规则

扩展不使用聊天文件名判断摘要是否有效。它按消息顺序计算累计链指纹：

1. 分支以前的消息完全相同，链指纹相同，原摘要直接复用。
2. 编辑、换 swipe 或进入新分支后，从首次变化的消息开始链指纹改变。
3. 变化点以前的摘要继续有效，变化点以后的摘要按新分支重新生成。

摘要结果保存在 TauriTavern 全局 Extension Store 中，当前聊天的运行快照保存在每聊天的 Chat Store 中。

## 叠层记忆

- 小总结覆盖一个固定楼层区间。
- 小总结的 `额外读取 K 楼` 会让模型看到后续上下文；`{{summary_chat}}` 是实际要总结的 N 楼，`{{extra_chat}}` 是多读的 K 楼，`{{chat}}` / `{{context_chat}}` 是两者合并后的输入。
- 大总结是累计摘要，会读取上一份大总结、当前阶段的小总结和必要原文。
- 注入主对话时，只放入最新大总结以及它之后的小总结。

这样历史增长时，注入内容不会随所有旧摘要线性膨胀。

## 提示词宏

提示词条目支持：

```text
{{chat}}
{{summary_chat}}
{{context_chat}}
{{extra_chat}}
{{floor_start}}
{{floor_end}}
{{summary_floor_start}}
{{summary_floor_end}}
{{context_floor_start}}
{{context_floor_end}}
{{extra_floor_start}}
{{extra_floor_end}}
{{small_extra_floors}}
{{total_floors}}
{{eligible_floor}}
{{previous_large}}
{{small_summaries}}
{{memory}}
{{previous_status}}
{{last_user}}
{{last_assistant}}
```

记忆注入模板支持：

```text
{{large_memory}}
{{small_memory}}
{{memory}}
```

状态栏 HTML 模板支持：

```text
{{status}}
```

图片规划提示词支持：

```text
{{body}}
{{body_segments}}
{{segmented_body}}
{{source_segments}}
{{assistant}}
{{chat}}
{{floor}}
{{floor_start}}
{{floor_end}}
{{total_floors}}
{{status}}
{{previous_status}}
{{status_raw}}
{{status_injection}}
{{last_user}}
{{last_assistant}}
{{max_images}}
{{position_tag}}
{{prompt_tag}}
{{character_prompt}}
{{appearance_prompt}}
{{character_name}}
{{character_key}}
{{character_id}}
{{character_file}}
```

图片规划里的 `{{status}}` / `{{previous_status}}` 使用当前聊天最新状态栏的渲染内容，`{{status_raw}}` 使用状态模型原始输出，`{{status_injection}}` 使用状态栏“正文注入输出正则”处理后的内容。状态内容会进入图片缓存配方；状态变化后，同一楼层不会误用旧图片缓存。

状态栏正文注入模板同样支持 `{{status}}`，但它使用单独的“正文注入输出正则”。状态模型的原始输出会分别进入两条管线：

```text
状态模型原始输出 -> 渲染输出正则 -> 状态栏界面
状态模型原始输出 -> 正文注入输出正则 -> setExtensionPrompt -> 下一轮正文生成
```

两条输出正则互不复用。升级前已经生成的旧状态缓存没有保留原始输出，因此只继续用于显示；完成一次新的状态生成后才会参与正文注入。

## 正则管线

每个模块按以下顺序处理：

```text
聊天原文 -> 输入正则 -> 提示词条目栈 -> 独立模型调用 -> 输出正则 -> 保存/渲染
```

正则使用 JavaScript `RegExp` 语法，规则按界面中的顺序执行。

## RunPod 图片插入

图片模块是一条与记忆、状态栏并行的通路。它只在 AI 回复完成并落入聊天消息后触发自动规划和 RunPod 请求；用户消息、编辑、删除和 swipe 不会进入图片管线。启动、切换聊天、加载更多历史和应用设置时才会回渲染已有图片缓存。

默认流程：

```text
AI 回复正文
  -> 正文提取正则
  -> 程序按段落切分并编号
  -> 图片规划提示词条目栈
  -> 图片规划模型输出 XML
  -> 解析位置标签与正面提示词标签
  -> 确认消息仍处于当前前台分支
  -> 达到 5 张时要求用户确认费用
  -> 连续提交 RunPod /run，再统一轮询 /status
  -> 把 Base64 图片保存到本地 Extension Store
  -> 按分片序号插入到对应消息正文
```

图片规划前，插件会把正文注册为 `{{body_segments}}` / `{{segmented_body}}` / `{{source_segments}}`，格式类似：

```xml
<source_segments>
<segment id="1">第一段正文</segment>
<segment id="2">第二段正文</segment>
</source_segments>
```

图片规划模型只需要输出 XML。默认标签名是 `<position>` 和 `<positive_prompt>`，也可以在设置页改成自己的两个标签名：

```xml
<image>
  <position>2</position>
  <positive_prompt>girl looking at rainy night, cinematic</positive_prompt>
</image>
```

`position` 填 `segment id`。插件会用这个序号映射回程序切好的原文分片，再插入图片。找不到对应分片或渲染定位失败时，图片会回退追加到该消息末尾，避免生成结果丢失。若正文整体包在 `<content>...</content>` 中，最后一个分片的图片会优先插在结束标签之后。

### 角色外貌提示词

图片模块设置页中有“角色外貌提示词”区域。插件会根据当前聊天引用识别当前角色，并把文本保存到对应角色档案里；切换到另一个角色后，同一个输入框会自动显示另一个角色的外貌提示词。群聊或无法识别角色时会使用当前群聊/当前聊天 key，也可以填写“默认外貌提示词”作为兜底。

这些文本不会绕过你的提示词控制。它们只作为宏提供给图片规划提示词：

```text
{{character_prompt}}
{{appearance_prompt}}
{{character_name}}
{{character_key}}
{{character_id}}
{{character_file}}
```

默认图片规划提示词会把 `{{character_prompt}}` 放入模型输入，并要求模型在每个生图 prompt 中融合角色外貌。你可以改掉这段提示词，决定外貌提示词是完整复用、压缩、只当参考，还是完全不用。

### RunPod 队列与费用保护

每个提示词对应一个独立 `/run` 请求。插件会先把同一轮的所有请求连续提交到同一个 Endpoint，再开始轮询状态；Endpoint 可用 `Max workers = 1` 在服务端逐个执行这些排队任务。

付费请求前有三层保护：

- 单条消息硬限制最多 12 张。
- 实际规划达到 5 张时必须在确认框中同意，取消时不会提交任何 `/run`。
- 规划模型返回后、确认后和入队前都会检查目标消息是否仍是当前聊天前台分支的最新 AI 回复；若已 swipe、编辑、删除或切换聊天则停止。事件触发的取消也会调用 RunPod `/cancel/{jobId}`，尽量终止已排队或运行的任务。

规划模型还可返回：

```xml
<stop_image_generation>正文是错误提示或没有有效配图内容</stop_image_generation>
```

此时不会调用 RunPod。当前 Endpoint 只开放 `positive_prompt`、`width`、`height` 和 `seed`；负面提示词固定在服务端工作流中，插件不会发送无效的动态负面提示词参数。

### 正面提示词前缀

“正面提示词永久前缀”会在调用 RunPod 前拼接到 AI 输出的 `prompt` 前面：

```text
最终 positive_prompt = 正面提示词永久前缀 + AI 规划输出的 prompt
```

因此图片规划模型不需要负责固定质量词。负面提示词由 Endpoint 工作流固定配置。

开启 `测试模式通知` 后，图片模块会通过 toast 报告调试事件，包括缓存回渲染、跳过原因、图片规划调用/返回、RunPod 入队、轮询、取消、生成成功和插回正文等动作。它会比较吵，建议只在排查问题时打开。

图片缓存存储在全局 Extension Store 的 `image-v1` 表中。RunPod 返回的 Base64 PNG 会直接转换为 data URL 本地保存 90 天；启动、切换聊天或回渲染缓存时会清理过期图片。缓存键包含当前聊天 scope、用户楼层号、该楼层的累计消息链指纹和图片配方 hash，因此分叉前的图片可复用，分叉后的图片不会串到当前分支。即使生成结束时目标消息刚好离开前台，完整结果也只会保存到对应分支缓存，不会错误插入当前界面。

## 状态栏渲染位置

状态栏宿主节点位于 `#chat` 内，和普通消息处在同一个可滚动消息流中。`显示深度` 决定它从当前已加载消息末尾向前插入多少条：

```text
#chat
  消息 1
  消息 2
  ...
  最后一条消息（深度 0）
  #ttbm-status-host
```

深度 `0` 表示紧接最后一条消息，深度 `1` 表示插在最后一条消息之前；超过当前消息数量时会插在最前面。它没有 `fixed`、`sticky` 或输入框锚定定位，新消息渲染后会按配置重新定位，并随聊天历史一起滚动。

状态栏生成使用酒馆的生成事件门控：斜杠指令、静默生成、用户消息渲染、编辑、删除和 swipe 都不会单独触发状态模型；只有实际 AI 生成通过命令阶段并完成助手消息渲染后才会触发。设置页中的“立即同步”仍可用于手动刷新。

渲染流程：

```text
模型输出 -> 状态栏输出正则 -> HTML 转义（默认） -> HTML 模板 -> 自定义 CSS
```

开启“把状态输出按 HTML 渲染”后会跳过 HTML 转义，适合由你自己的提示词输出结构化状态栏 HTML。

## 全局调用监控

“调用监控”按钮位于“立即同步”旁边。打开后会记录最近 300 条事件：

- 酒馆生成生命周期事件。
- Chat Completion 最终消息数组、模型、温度、token 上限、tools 等请求参数。
- Text Completion 最终参数。
- 页面内所有 `fetch` 和 `XMLHttpRequest` 的 URL、方法、headers、请求体、状态、耗时和非流式响应体。

条目默认收起，可逐条或全部展开/收回，也可以暂停和清空。Authorization、API Key、密码、访问令牌、Cookie 等凭据会递归脱敏；流式响应不复制整条数据流，最终正文可从生成事件和消息事件查看。监控只覆盖开启按钮之后发生的调用；暂停监控、重新加载页面或清理扩展数据时会恢复原始网络函数。

## 开发检查

```powershell
npm test
npm run check
```
