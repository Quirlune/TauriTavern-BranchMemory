# 0.7.0 验证报告

目标宿主：TauriTavern v2.2.0。基线：BranchMemory `778b534`（0.6.8）。

## 行为确认

- 提示词控制默认开启，仅作用于正文，默认使用用户提供的 mergeEditor 提示词格式。
- 参考的后续 K 楼变化不作废总结；缓存仍按实际总结区间的累计历史链识别。
- 切换已有 swipe 只恢复缓存。新生成的回复完成后生成状态栏；完整 regenerate 即使生成相同文本也重新生成状态栏。
- 总结、状态栏的历史数据表和键版本保留，不清空已有全局缓存。旧版本以参考楼层为键的总结，通过记录里的实际区间锚点兼容读取。

## 自动化验证

`npm test`：75 项通过。`npm run check`：入口及全部源模块通过语法检查。

重点回归场景：

| 场景 | 验证结果 |
| --- | --- |
| 同一总结触发楼层连续重生成 10 次，参考 K 楼也变化 | 总结调用 1 次、状态调用 11 次 |
| 切换已有 swipe，再切回原回复 | 无模型调用，恢复原回复对应状态 |
| regenerate 删除旧回复 | 正文注入和新状态 previous_status 都排除旧回复对应状态 |
| 修改实际总结区间内第 3 楼 | 第 2 楼前缀缓存保留，后续依赖重算 |
| 新建分支但共同前缀相同 | 复用总结，不误用另一个分支的运行状态 |
| 状态生成期间编辑回复 | 不保存或显示过期状态 |
| 总结调用期间切换聊天 | 不向新聊天写入旧结果，不启动后续状态调用 |
| 总结 API 失败 | 状态仍独立完成，错误保留原始原因 |
| TauriTavern 2.2 渲染完成但聊天文件尚未保存 | 使用当前内存聊天，不读旧文件作为最新回复 |
| 宿主 ENDED 早于 RENDERED、重复完成事件、待执行任务被 swipe 取消 | 正确完成一次或取消，无重复状态调用 |
| 与其它插件的 fetch 包装叠加后暂停/恢复监控 | 不递归调用、不重复捕获、不改变返回值 |
| 后端 600,000 字符提示词 | 完整读取，无文本截断；按需读取一次 |
| OpenAI、Claude、Gemini、Responses 消息结构 | 按 API 角色、消息序号、内容分片展示 |

兼容测试的 11 组固定样例，先在隔离的 JS 上下文运行用户提供的原脚本生成期望结果，再与新实现比较。原脚本的数据捕获功能在对比时关闭。样例覆盖普通消息、示例消息、命名消息、保护标记、连续消息、禁用合并标记、空白标记、regex、位置迁移、分隔符与受保护系统消息。

## 页面验证

在真实浏览器中运行隔离的设置页测试环境，检查了默认范围、试处理、保护标记、规则新增及匹配、原脚本 JSON 配置导入、后端日志读取、角色分级、长文本默认折叠。控制台无错误或警告。测试环境的宿主日志为样例数据，未使用实际聊天或凭据。

## 2.2 接口依据

- [v2.2.0 Chat API](https://github.com/Darkatse/TauriTavern/blob/v2.2.0/src/tauri/main/api/chat.js)：`history.tail` 读取持久化 JSONL；`current.windowInfo()` 的 `mode: off` 表示完整前端聊天。
- [v2.2.0 Dev API](https://github.com/Darkatse/TauriTavern/blob/v2.2.0/src/tauri/main/api/dev.js)：`api.dev.llmApiLogs`。
- [v2.2.0 LLM 日志桥](https://github.com/Darkatse/TauriTavern/blob/v2.2.0/src/tauri/main/services/dev-logging/llm-api-log-bridge.js)：`index`、`subscribeIndex`、`getRaw`。
- [v2.2.0 日志返回类型](https://github.com/Darkatse/TauriTavern/blob/v2.2.0/src-tauri/crates/tauritavern/src/infrastructure/logging/llm_api_logs/types.rs)：`requestRaw`、`responseRaw` 和索引字段。
- [v2.2.0 生成生命周期](https://github.com/Darkatse/TauriTavern/blob/v2.2.0/src/script.js)：regenerate 删除顺序、流式渲染顺序、临时采样参数恢复。

## 实测边界

本轮没有连接实际运行的 TauriTavern 二进制，也没有发送真实付费模型请求。宿主接口和事件顺序以 v2.2.0 源码核对，并通过模拟宿主的集成测试验证。供应商实际格式、网络错误和其它第三方插件组合仍应在安装后用自己的连接做一次完整对话验证。

Connection Manager 请求支持 AbortSignal。宿主 `generateRaw` 没有单请求取消参数，因此取消时保证丢弃旧结果、跳过旧队列；已发出的 raw 请求可能仍在供应商端完成。插件不会自动重试付费请求。

后端日志是否仍可读取取决于宿主保留数量；日志轮换后会显示明确读取错误。前端无法把未捕获到的供应商请求推测为“最终提示词”。
