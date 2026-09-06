# Branch Memory, Status & Images

当前版本：**0.7.1**，按 TauriTavern **2.2.0** 的接口和生成事件顺序适配。

本次更新新增“提示词控制”、重写“提示词查看”，并修复 swipe/重新生成的状态栏触发、最新楼层读取和总结重复调用。验证范围见 [REGRESSION_REPORT.md](./REGRESSION_REPORT.md)。

设置界面也已重新整理：桌面使用侧栏导航，手机使用两行导航；常用设置直接显示，模型连接、正则、注入和样式按需展开。提示词条目以名称、角色、字数和启用状态展示，点击展开编辑；新增自动定位，排序和切页保留展开状态、滚动位置与试处理草稿。所有设置仍自动保存，支持 Esc 关闭和键盘导航。

升级后请先停用 JsRunner 中原来的 mergeEditor 脚本，以免重复转换提示词。默认仅对正文启用兼容处理；可在“提示词控制”页关闭，或分别启用总结、状态栏和图片规划范围。

面向 TauriTavern 的第三方前端扩展。它提供：

- 只把 `user` 消息计作楼层，AI 消息不计楼。
- 每 N 楼生成阶段小总结，可额外读取后续 K 楼作为上下文，但摘要仍归档到原本 N 楼区间。
- 每 N 楼生成累计大总结。
- 最近 N 楼保留为原文，不立刻总结。
- 用累计消息链指纹识别共同前缀，在聊天分支之间复用分叉点以前的摘要。
- 状态栏只在 AI 回复完整落入聊天后进行另一笔独立模型调用，并可按深度插入聊天历史。
- 状态模型原始输出可通过独立正则与模板注入下一轮正文生成，不依赖界面渲染结果。
- 图片模块可在 AI 回复完成后独立规划插图位置，调用 RunPod Serverless Endpoint 生成图片并插回正文对应位置。
- 图片缓存按聊天、楼层、稳定 AI 消息身份和提示词配方绑定；普通正文编辑不会改变身份，swipe/roll 会改变身份并保持分支隔离。
- 图片模块可为不同角色保存独立外貌提示词，切换角色后自动加载对应档案。
- 同一轮的多张图片先连续提交到 Endpoint 队列，再统一轮询，减少重复冷启动和 GPU 空闲时间。
- 魔法棒菜单在“附加文件”旁提供“暂停生图 / 启动生图”和“重新生图”快捷按钮；重新生图会清理当前最后一条 AI 消息的旧图与缓存，再执行完整的规划、RunPod 生成、缓存和插回流程。
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
3. 变化点以前的摘要继续有效，包含变化楼层及依赖它的后续摘要按新分支重新生成。

小总结的后续 K 楼仅作参考，不作为缓存有效性的锚点。因此在最新触发楼层反复 roll 不会反复生成已经覆盖旧楼层的总结。旧版本的总结缓存也会按其实际总结区间的历史锚点兼容读取，不会在升级或切换分支时全量清空。

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
  -> 把 XML 占位写入消息历史
  -> 宿主完成显示正则、Markdown 与 HTML 清理
  -> 用缓存图片替换最终 DOM 中仍存在的 XML 占位
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

`position` 填 `segment id`。插件会用这个序号映射回程序切好的原文分片，并把图片 XML 占位写到该位置。若正文整体包在 `<content>...</content>` 中，最后一个分片的占位会写在结束标签之后。

生成完成后，插件会把真实位置锚点写回 AI 消息源文本，例如：

```xml
<span data-ttbm-image-anchor="4f85..."></span>
```

该标签会先写入聊天原文 `mes` 及当前 swipe 的历史副本；若消息使用 `extra.display_text`，插件也会把同一占位同步到宿主实际采用的显示文本。它因此会像普通历史文本一样依次经过全局、预设和角色显示正则，而不是在正则之前变成图片。

宿主完成显示正则、Markdown、HTML 清理和同一轮 DOM 装饰后，图片模块才会查找最终 DOM 中仍存在的 `data-ttbm-image-anchor`，并在原位用缓存图片替换它。渲染器不会再按正文猜测位置，也不会在失败时把图片追加到消息末尾：正则移动占位，图片就跟随移动；正则删除占位，该图片就不渲染。插件本身不会主动添加或改写 `<content>`。例如正则可以捕获占位并替换为 `</content>$1<content>`，最终图片会出现在正则安排的新位置。

如果宿主稍后重新执行显示正则并重建 `.mes_text`，插件只监听重新出现的 XML 占位，并再次延后替换为本地缓存图片，不会重复请求 RunPod，也不会因自身插图触发循环。图片规划输入会先移除旧占位，避免标签干扰再次分段。缓存身份由聊天、楼层、消息 `send_date` 和 `swipe_id` 等稳定字段组成：编辑正文不会改变图片身份，swipe/roll 会生成不同身份。

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

开启 `测试模式通知` 后，图片模块会通过 toast 报告调试事件，包括缓存回渲染、跳过原因、图片规划调用/返回、RunPod 入队、轮询、取消、生成成功和占位渲染等动作。它会比较吵，建议只在排查问题时打开。

图片缓存存储在全局 Extension Store 的 `image-v1` 表中。RunPod 返回的 Base64 PNG 会直接转换为 data URL 本地保存 90 天；启动、切换聊天或回渲染缓存时会清理过期图片。新版缓存键使用聊天身份、用户楼层、稳定 AI 消息身份和图片配方 hash；普通文字编辑继续命中旧图，swipe/roll 因 `swipe_id` 或消息时间变化而隔离。没有历史 XML 占位的旧缓存不会直接渲染，需要重新生成一次以建立可被正则处理的稳定占位。

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

## 提示词控制

“详细设置 → 提示词控制”支持：

- 正文、总结、状态栏、图片规划分别启用。默认只有正文启用。
- `mergeEditor 兼容`：按原脚本将消息转换为 Sophia / Gray / SYSTEM 等文本标签，默认整块归于 `assistant`。示例标签 H / A 可单独设置。
- `直接调整 API 角色`：直接改变消息的 system / user / assistant 归属。
- 整块合并、仅相邻同角色合并、不合并，以及合并后的 API 角色。
- 按来源角色和“包含文本”匹配的有序规则；第一个匹配生效，可改归属或保护该消息。
- 自定义保护标记，每行一个。默认 `<|no-trans|>`；可以选择发送前是否移除标记。
- 原脚本分隔符、系统分界、禁用合并标记、regex、位置迁移及空白标记的兼容处理。原脚本数据捕获/存储替换功能未移植。
- 粘贴 messages JSON 试处理，以及导入原脚本的格式配置 JSON。

保护标记按请求中的消息生效。工具调用、多模态内容与附带额外协议字段的消息保留完整结构。正文控制接在 `CHAT_COMPLETION_SETTINGS_READY`，插件自己的独立调用则通过统一模型客户端按所选范围处理；`quiet` 不会被默认正文规则误处理。

例如，直接调整模式下，将默认 `system` 归于 `user`；加入“来源任意、包含 `<keep-role>`、目标保护”的规则，即可让特定消息仍保留原角色。

## 提示词查看

“提示词查看”优先接入 TauriTavern 2.2 的 `api.dev.llmApiLogs`，读取 Rust 后端记录的供应商请求原文。打开时读取最近 50 条宿主索引，再订阅新记录；请求通常在完成后出现。展开时才读取原文，日志轮换后的不可用记录会显示错误。

查看层级分为“后端实际请求”“全部模型请求（含前端中间态）”“错误与告警”和“事件诊断”。后端接口不可用时仍可查看前端记录，但不会把它标成供应商最终请求。

每笔请求按实际 API 角色 → 原始发送序号 → 内容分片展开。兼容合并后的文本还可按已配置的角色标签继续分段，明确标识这是文本解析。支持 OpenAI、Claude、Gemini、Responses 的常见消息结构，长文本默认折叠，采样参数和原始 JSON 单独展开。请求文本不截断；敏感凭据脱敏。native 响应诊断最多保留 500,000 字符，截断标记在原始记录中明确显示。

前端诊断记录生成事件、插件模型调用和 fetch/XHR。暂停/清理时解除自身监听及包装；其它插件后装的网络包装保留。此查看页不发送额外模型请求。

## 重新生成与状态绑定

切换已有回复只恢复该分支、楼层和回复对应的缓存，没有缓存时不自动补生成。向右生成新回复或完整“重新生成”完成后才调用状态模型；重复完成事件只触发一次。完整 regenerate 会再次生成状态，即使新回复文本与旧回复相同。

状态模型的 `previous_status` 只从当前分支以前楼层的有效缓存读取；重新生成前注入正文的状态也排除正在被替换的回复。总结模板的 `last_user` / `last_assistant` 限定于本次读取范围，状态的全部聊天宏统一使用状态输入正则。

总结调用失败不阻断状态栏调用，错误保留底层原因。切换聊天、编辑、删除或重生成会取消旧队列；返回结果在保存/显示前再次核对楼层内容。TauriTavern 2.2 的完整前端聊天数组用于读取最新楼层，避免聊天文件尚未保存造成串层。

## 开发检查

测试使用 Node.js 22.15 或更新版本（包含模块钩子和测试计时器）；插件本身仍为浏览器 ES Modules，无构建步骤。

```powershell
npm test
npm run check
```

生图延迟分析与本轮优化记录见 [IMAGE_PERFORMANCE_REPORT.md](./IMAGE_PERFORMANCE_REPORT.md)。
