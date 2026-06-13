# Branch Memory & Status

面向 TauriTavern 的第三方前端扩展。它提供：

- 只把 `user` 消息计作楼层，AI 消息不计楼。
- 每 N 楼生成阶段小总结。
- 每 N 楼生成累计大总结。
- 最近 N 楼保留为原文，不立刻总结。
- 用累计消息链指纹识别共同前缀，在聊天分支之间复用分叉点以前的摘要。
- 状态栏在每次 AI 输出后进行另一笔独立模型调用，并显示在聊天区最底部。
- 记忆模块和状态栏模块分别拥有输入正则、输出正则和可排序提示词条目栈。
- 状态栏支持自定义 HTML 模板与 CSS。

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

## 正则管线

每个模块按以下顺序处理：

```text
聊天原文 -> 输入正则 -> 提示词条目栈 -> 独立模型调用 -> 输出正则 -> 保存/渲染
```

正则使用 JavaScript `RegExp` 语法，规则按界面中的顺序执行。

## 开发检查

```powershell
npm test
npm run check
```
