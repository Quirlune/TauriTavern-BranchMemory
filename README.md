# Branch Memory, Status & Images

面向 TauriTavern 的第三方前端扩展。它提供：

- 只把 `user` 消息计作楼层，AI 消息不计楼。
- 每 N 楼生成阶段小总结。
- 每 N 楼生成累计大总结。
- 最近 N 楼保留为原文，不立刻总结。
- 用累计消息链指纹识别共同前缀，在聊天分支之间复用分叉点以前的摘要。
- 状态栏只在 AI 回复完整落入聊天后进行另一笔独立模型调用，并可按深度插入聊天历史。
- 状态模型原始输出可通过独立正则与模板注入下一轮正文生成，不依赖界面渲染结果。
- 图片模块可在 AI 回复完成后独立规划插图位置，调用 BizyAir 生成图片并插回正文对应位置。
- 图片缓存按聊天、楼层、分支链和提示词配方绑定，历史楼层重新加载后也会回渲染已有图片。
- 图片模块可为不同角色保存独立外貌提示词，切换角色后自动加载对应档案。
- 图片模块可粘贴 BizyAir API 示例代码，自动解析并保存为可切换的 BizyAir 模板。
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

BizyAir 生图调用使用图片模块里的独立 BizyAir API Key 字段，不走 Connection Manager。当前版本支持填写多个 Key，但实际调用使用第一个。

## 分支规则

扩展不使用聊天文件名判断摘要是否有效。它按消息顺序计算累计链指纹：

1. 分支以前的消息完全相同，链指纹相同，原摘要直接复用。
2. 编辑、换 swipe 或进入新分支后，从首次变化的消息开始链指纹改变。
3. 变化点以前的摘要继续有效，变化点以后的摘要按新分支重新生成。

摘要结果保存在 TauriTavern 全局 Extension Store 中，当前聊天的运行快照保存在每聊天的 Chat Store 中。

## 叠层记忆

- 小总结覆盖一个固定楼层区间。
- 大总结是累计摘要，会读取上一份大总结、当前阶段的小总结和必要原文。
- 注入主对话时，只放入最新大总结以及它之后的小总结。

这样历史增长时，注入内容不会随所有旧摘要线性膨胀。

## 提示词宏

提示词条目支持：

```text
{{chat}}
{{floor_start}}
{{floor_end}}
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

## BizyAir 图片插入

图片模块是一条与记忆、状态栏并行的通路。它只在 AI 回复完成并落入聊天消息后触发自动规划和 BizyAir 请求；用户消息、编辑、删除和 swipe 不会进入图片管线。启动、切换聊天、加载更多历史和应用设置时才会回渲染已有图片缓存。

默认流程：

```text
AI 回复正文
  -> 正文提取正则
  -> 程序按段落切分并编号
  -> 图片规划提示词条目栈
  -> 图片规划模型输出 XML
  -> 解析位置标签与正面提示词标签
  -> BizyAir create/query
  -> 缓存图片
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

`position` 填 `segment id`。插件会用这个序号映射回程序切好的原文分片，再插入图片。找不到对应分片或渲染定位失败时，图片会回退追加到该消息末尾，避免生成结果丢失。若正文整体包在 `<content>...</content>` 中，并且你的渲染正则已把它美化成 `.gal-container > .gal-content`，插件会在插图位置拆开当前美化块，把图片作为裸图放在 `.gal-container` 外，再从图片下方开启下一段 `.gal-container`；最后一个分片会把图片放到美化块外侧末尾。

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

默认图片规划提示词会把 `{{character_prompt}}` 放入模型输入，并要求模型在每个 BizyAir prompt 中融合角色外貌。你可以改掉这段提示词，决定外貌提示词是完整复用、压缩、只当参考，还是完全不用。

BizyAir API 参考了 [bizyair-tavern-plugin](https://github.com/dhdbv-cbs/bizyair-tavern-plugin) 的 OpenAPI 调用方式：

- `POST https://api.bizyair.cn/w/v1/webapp/task/openapi/create`
- `GET https://api.bizyair.cn/w/v1/webapp/task/openapi/query?task_id=...`

默认 Web App ID 为 `48570`，并预置了 zimage 模板常用的 `input_values` 字段。`input_values` 现在作为内部模板保存：解析 API 示例代码或切换已保存模板时，插件会自动生成并维护它，再结合设置页里的 seed、尺寸、steps、正负提示词等参数完成调用；设置页不再暴露手填 JSON 模板入口。

### API 示例解析与模板切换

在 BizyAir API 区域可以粘贴类似官方示例的 JavaScript 代码：

```js
const response = await fetch('https://api.bizyair.cn/w/v1/webapp/task/openapi/create', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer YOUR_API_KEY'
  },
  body: JSON.stringify({
    "web_app_id": 51978,
    "suppress_preview_output": true,
    "input_values": {
      "3:KSampler.seed": 95663262248077,
      "3:KSampler.steps": 26,
      "5:EmptyLatentImage.width": 1280,
      "5:EmptyLatentImage.height": 1560,
      "6:CLIPTextEncode.text": "masterpiece, very aesthetic, best quality",
      "7:CLIPTextEncode.text": "(worst quality:1.4), bad anatomy"
    }
  })
});
```

解析器支持 `body: JSON.stringify({ ... })`、`const payload = { ... }; body: JSON.stringify(payload)`、`const raw = JSON.stringify(payload); const requestOptions = { body: raw }` 这类网站原生 / Postman 风格写法，也可以直接粘贴只包含请求 body 的对象片段。它只静态读取对象字面量和变量引用，不会执行粘贴进去的 JavaScript。

点击“解析并保存为模板”后，插件会读取 `web_app_id`、`suppress_preview_output` 和 `input_values`，生成一个可切换模板。能对应到插件控件的字段会被抽出并同步：

```text
seed / steps / width / height / cfg / sampler / scheduler / denoise
正面提示词前缀 / 负面提示词
```

如果某个工作流没有 `cfg`、`sampler`、`denoise` 这类字段，就不会生成对应宏，也不会强行套用这些参数。没有对应插件控件的 `input_values` 字段会作为固定值保留在内部模板中，避免破坏工作流必需输入。切换“已保存模板”会立即应用该模板的 Web App ID、内部模板和已识别参数。

### 正面提示词前缀

“正面提示词永久前缀”会在调用 BizyAir 前拼接到 AI 输出的 `prompt` 前面：

```text
最终 positive_prompt = 正面提示词永久前缀 + AI 规划输出的 prompt
```

因此图片规划模型不需要负责固定质量词，也不需要负责负面提示词。负面提示词始终来自“负面提示词”输入框，并通过 `{{negative_prompt}}` 注入模板。

`BizyAir 并发数` 控制同一轮多张图片同时提交/轮询的数量，默认 `3`。当前规划最多 3 张图时，默认会并发生成；设为 `1` 可恢复逐张生成。

开启 `测试模式通知` 后，图片模块会通过 toast 报告调试事件，包括缓存回渲染、跳过原因、图片规划调用/返回、BizyAir create、task id、每轮等待/状态、生成成功/失败、data URL 缓存和插回正文等动作。它会比较吵，建议只在排查问题时打开。

图片缓存存储在全局 Extension Store 的 `image-v1` 表中，缓存键包含当前聊天 scope、用户楼层号、该楼层的累计消息链指纹和图片配方 hash。因此在第 100 楼进入第 70 楼分支时，分叉点以前楼层的图片仍然能复用；分叉后链指纹变化的楼层会按新分支重新生成。修改图片提示词、角色外貌提示词、正则、规划模型或 BizyAir 模板会形成新配方，旧配方图片仍保留在缓存表中，但不会作为当前配方结果回渲染。开启“把图片缓存为 data URL”时，插件会尽量把 BizyAir 返回的图片下载为 data URL；如果跨域或网络阻止下载，会保留远程 URL 作为回退。

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
