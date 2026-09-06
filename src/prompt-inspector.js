import { escapeHtml } from './core.js';

export function promptPayload(record) {
    const details = record?.details || {};
    if (record?.channel === 'native') return details.requestBody;
    if (details.messages) return details;
    if (details.body) return details.body;
    const event = details.args?.[0];
    if (event?.chat) return { messages: event.chat };
    return event || details;
}

export function parsePrompt(payload) {
    if (!payload) return [];
    const messages = [];
    const push = (role, content, extra = {}) => messages.push({ role, content, ...extra });
    if (payload.system) push('system', payload.system);
    if (payload.systemInstruction?.parts) push('system', payload.systemInstruction.parts);
    if (payload.instructions) push('system', payload.instructions);
    if (Array.isArray(payload.messages)) {
        for (const message of payload.messages) push(message.role || 'unknown', message.content, {
            name: message.name, toolCalls: message.tool_calls, toolCallId: message.tool_call_id
        });
    } else if (Array.isArray(payload.contents)) {
        for (const message of payload.contents) push(message.role || 'user', message.parts);
    } else if (Array.isArray(payload.input)) {
        for (const item of payload.input) push(item.role || item.type || 'unknown', item.content ?? item);
    } else if (typeof payload.input === 'string') push('user', payload.input);
    else if (typeof payload.prompt === 'string') push('text', payload.prompt);
    else if (typeof payload === 'string') push('text', payload);
    return messages.map((message, index) => ({ ...message, index: index + 1 }));
}

export function promptRecordVisible(record, filter = 'requests') {
    if (filter === 'all') return true;
    if (filter === 'native') return record.channel === 'native';
    if (filter === 'errors') return record.level === 'error' || record.level === 'warn';
    return record.channel === 'native' || ['model_request', 'fetch_request', 'xhr_request'].includes(record.type)
        && (record.type === 'model_request' || parsePrompt(promptPayload(record)).length > 0);
}

export function promptRecordTitle(record) {
    const details = record.details || {};
    if (record.channel === 'native') return `后端实际请求 · ${details.model || details.source || '模型'} · ${details.ok === false ? '失败' : '完成'}`;
    if (record.type === 'model_request') return `${details.label || details.scope} · 模板组装`;
    if (record.type === 'fetch_request' || record.type === 'xhr_request') return `前端提交 · ${details.body?.model || details.url || ''}`;
    return record.type;
}

function textPart(text, label) {
    const content = String(text ?? '');
    const preview = content.replace(/\s+/g, ' ').slice(0, 100);
    return `<details class="ttbm-prompt-part" ${content.length <= 1200 ? 'open' : ''}>
        <summary>${escapeHtml(label)} · ${content.length.toLocaleString()} 字符 <span>${escapeHtml(preview)}</span></summary>
        <pre class="ttbm-prompt-text">${escapeHtml(content)}</pre></details>`;
}

export function splitTextRoles(text, prefixes = {}) {
    const names = [...new Set(Object.values(prefixes).filter(value => typeof value === 'string' && value.trim()))];
    if (!names.length) return [];
    const pattern = new RegExp(`(^|\\n)(` + names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + `):[ \\t]*`, 'g');
    const matches = [...text.matchAll(pattern)];
    if (!matches.length) return [];
    const sections = [];
    if (matches[0].index > 0) sections.push({ label: '前导文本', text: text.slice(0, matches[0].index) });
    for (let index = 0; index < matches.length; index += 1) {
        const match = matches[index];
        sections.push({ label: `文本标签 ${match[2]}`, text: text.slice(match.index + match[1].length, matches[index + 1]?.index ?? text.length) });
    }
    return sections;
}

function contentHtml(content, prefixes) {
    if (typeof content === 'string') {
        const sections = splitTextRoles(content, prefixes);
        return sections.length > 1 ? `<p class="ttbm-hint">以下按行首文本标签解析；API 归属仍以上一级为准。</p>${sections.map(section => textPart(section.text, section.label)).join('')}` : textPart(content, '文本');
    }
    if (!Array.isArray(content)) return textPart(JSON.stringify(content ?? '', null, 2), '内容');
    return content.map((part, index) => {
        if (typeof part === 'string') return textPart(part, `分片 ${index + 1}`);
        if (typeof part.text === 'string') return textPart(part.text, `分片 ${index + 1} · ${part.type || 'text'}`);
        return textPart(JSON.stringify(part, null, 2), `分片 ${index + 1} · ${part.type || '多模态/工具'}`);
    }).join('');
}

export function promptDetailHtml(record, { prefixes = {} } = {}) {
    const payload = promptPayload(record);
    const messages = parsePrompt(payload);
    const groups = Map.groupBy ? Map.groupBy(messages, item => item.role) : messages.reduce((map, item) => {
        if (!map.has(item.role)) map.set(item.role, []);
        map.get(item.role).push(item); return map;
    }, new Map());
    const level = record.channel === 'native'
        ? 'TauriTavern 2.2 后端记录的 provider 请求原文；角色按实际 API 字段分组。'
        : '前端记录；宿主或其它扩展仍可能继续转换。以“后端实际请求”为最终核对依据。';
    const groupHtml = [...groups].map(([role, items]) => `<details class="ttbm-prompt-role" open>
        <summary><strong>${escapeHtml(role)}</strong> · ${items.length} 条消息</summary>
        ${items.map(item => `<details class="ttbm-prompt-message">
            <summary>#${item.index} ${escapeHtml(item.role)} ${item.name ? `· ${escapeHtml(item.name)}` : ''}</summary>
            ${contentHtml(item.content, prefixes)}
            ${item.toolCalls ? textPart(JSON.stringify(item.toolCalls, null, 2), '工具调用') : ''}
            ${item.toolCallId ? textPart(item.toolCallId, '工具调用 ID') : ''}
        </details>`).join('')}</details>`).join('');
    const parameters = payload && typeof payload === 'object' ? Object.fromEntries(Object.entries(payload)
        .filter(([key]) => !['messages', 'contents', 'input', 'prompt', 'system', 'systemInstruction', 'instructions'].includes(key))) : {};
    return `<p class="ttbm-hint">${escapeHtml(level)} 共 ${messages.length} 条；#编号是原始发送顺序。文本中的 Sophia/Gray 等标签仍属于该消息的 API 角色。</p>
        ${groupHtml || '<p class="ttbm-hint">无可识别的消息结构，可查看原始数据。</p>'}
        <details><summary>采样参数与工具定义</summary><pre class="ttbm-prompt-text">${escapeHtml(JSON.stringify(parameters, null, 2))}</pre></details>
        <details><summary>原始记录（脱敏）</summary><pre class="ttbm-prompt-text">${escapeHtml(JSON.stringify(record.details, null, 2))}</pre></details>`;
}
