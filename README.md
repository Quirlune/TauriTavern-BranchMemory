# Branch Memory & Status

面向 TauriTavern 的第三方前端扩展。它提供：

- 只把 `user` 消息计作楼层，AI 消息不计楼。
- 每 N 楼生成阶段小总结。
- 每 N 楼生成累计大总结。
- 最近 N 楼保留为原文，不立刻总结。
- 用累计消息链指纹识别共同前缀，在聊天分支之间复用分叉点以前的摘要。
- 状态栏只在 AI 回复完整落入聊天后进行另一笔独立模型调用，并可按深度插入聊天历史。
- 状态模型原始输出可通过独立正则与模板注入下一轮正文生成，不依赖界面渲染结果。
- 全局调用监控可观察正文及其它插件的生成事件、最终提示词、采样参数和底层网络请求。
- 记忆模块和状态栏模块分别拥有输入正则、输出正则和可排序提示词条目栈。
- 状态栏支持自定义 HTML 模板与 CSS。
- 记忆模块和状态栏模块可以分别选择 Connection Manager 中的独立 Chat Completion 配置。

## 安装

把整个文件夹放入 TauriTavern 的任一第三方扩展目录：

```text
data/default-user/extensions/TauriTavern-BranchMemory
```

或：

```text
data/extensions/third-party/TauriTavern-BranchMemory
```

重启 TauriTavern，在扩展设置中打开 `Branch Memory & Status`。

本扩展依赖：

- `window.__TAURITAVERN__.api.chat`
- `window.__TAURITAVERN__.api.extension.store`
- SillyTavern/TauriTavern 前端的 `generateRaw()` 与 `setExtensionPrompt()`
- 独立模型连接模式依赖内建 Connection Manager

## 独立模型连接

记忆与状态栏各自提供两种调用来源：

1. 沿用当前聊天 API。
2. 选择 Connection Manager 中保存的 Chat Completion Profile。

独立模式只保存 Profile ID，API Key 仍由酒馆的密钥系统管理。记忆和状态栏可以选择不同的 Profile，也不会切换当前聊天正在使用的模型连接。

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
