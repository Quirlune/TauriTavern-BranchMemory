import { legacyMerge } from './legacy-merge.js';

export const DEFAULT_PROMPT_CONTROL = {
    enabled: true,
    scopes: { body: true, memory: false, status: false, image: false },
    mode: 'legacy',
    merge: 'all',
    mergedRole: 'assistant',
    roles: { system: 'system', user: 'user', assistant: 'assistant', example_user: 'original', example_assistant: 'original' },
    prefixes: { user: 'Sophia', assistant: 'Gray', example_user: 'H', example_assistant: 'A', system: 'SYSTEM' },
    separator: '',
    separator_system: '',
    protectedMarkers: '<|no-trans|>',
    removeMarkers: true,
    mergeUsers: true,
    rules: []
};

export function promptControlRecipe(config, scope) {
    return config?.enabled && config.scopes?.[scope] ? config : null;
}

function sourceRole(message) {
    return ['example_user', 'example_assistant'].includes(message.name) ? message.name : message.role;
}

function plainMessage(message) {
    // Tool calls, multimodal parts and provider fields must survive verbatim.
    return typeof message?.content === 'string'
        && ['system', 'user', 'assistant'].includes(message.role)
        && Object.keys(message).every(key => ['role', 'content', 'name'].includes(key));
}

function markerList(config) {
    return String(config.protectedMarkers || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}

function extractSystem(message, separator, trimRemainder = false) {
    const index = separator ? message.content.indexOf(separator) : -1;
    if (index <= 0) return [message];
    const remainder = message.content.slice(index + separator.length);
    return [
        { role: 'system', content: message.content.slice(0, index + separator.length) },
        { ...message, content: trimRemainder ? remainder.trim() : remainder }
    ].filter(item => item.content.trim());
}

export function transformPrompt(messages, config = DEFAULT_PROMPT_CONTROL, scope = 'body') {
    if (!Array.isArray(messages)) return messages;
    if (!promptControlRecipe(config, scope)) return structuredClone(messages);
    const result = [];
    const markers = markerList(config);
    let block = [];
    const flush = () => {
        if (!block.length) return;
        if (config.mode === 'legacy') {
            const merged = legacyMerge({ ...config.prefixes, separator: config.separator }, block);
            if (merged.content.trim()) result.push(...extractSystem({ ...merged, role: config.mergedRole }, config.separator_system));
        } else if (config.merge === 'all') {
            result.push({ role: config.mergedRole, content: block.map(item => item.content).join(config.separator || '\n\n') });
        } else {
            result.push(...block);
        }
        block = [];
    };
    for (const original of messages) {
        const message = structuredClone(original);
        if (!plainMessage(message)) {
            flush();
            result.push(message);
            continue;
        }
        const role = sourceRole(message);
        const rule = (config.rules || []).find(item => item.enabled !== false
            && (!item.source || item.source === '*' || item.source === role)
            && (!item.contains || message.content.includes(item.contains)));
        const protectedItem = markers.some(marker => message.content.includes(marker)) || rule?.target === 'keep';
        if (protectedItem) {
            flush();
            if (config.removeMarkers) {
                for (const marker of markers) message.content = message.content.split(marker).join('');
                message.content = message.content.trim();
            }
            if (message.content) result.push(...(message.role === 'system' ? extractSystem(message, config.separator_system, true) : [message]));
            continue;
        }
        const configured = rule?.target || config.roles?.[role];
        const target = ['system', 'user', 'assistant'].includes(configured) ? configured : message.role;
        const mapped = target !== message.role;
        message.role = target;
        if (mapped && ['example_user', 'example_assistant'].includes(message.name)) delete message.name;
        // A protected entry always forms a boundary, including in adjacent mode.
        if (config.mode !== 'legacy' && config.merge === 'adjacent') {
            const previous = block.at(-1);
            if (previous?.role === message.role && previous.name === message.name) {
                previous.content += (config.separator || '\n\n') + message.content;
            } else block.push(message);
        } else if (config.mode === 'legacy' && config.merge !== 'all') {
            if (config.merge === 'none' || (block.length && block.at(-1).role !== message.role)) flush();
            block.push(message);
        } else block.push(message);
    }
    flush();
    if (config.mode !== 'legacy' || config.merge === 'none' || !config.mergeUsers) return result;
    // Matches mergeEditor's final consecutive-user pass.
    return result.reduce((output, message) => {
        const previous = output.at(-1);
        if (message.role === 'user' && previous?.role === 'user' && plainMessage(message) && plainMessage(previous)) previous.content += message.content;
        else output.push(message);
        return output;
    }, []);
}

export class PromptController {
    constructor({ eventSource, eventTypes, getSettings, onTransform = () => {} }) {
        Object.assign(this, { eventSource, eventTypes, getSettings, onTransform });
        this.seen = new WeakSet();
        this.handler = payload => {
            if (!payload || !Array.isArray(payload.messages) || this.seen.has(payload)) return;
            // generateRaw uses quiet; profile calls are handled explicitly by ModelClient.
            if (!['normal', 'regenerate', 'swipe', 'continue'].includes(payload.type || 'normal')) return;
            const settings = this.getSettings();
            if (!settings.enabled || !promptControlRecipe(settings.promptControl, 'body')) return;
            const before = structuredClone(payload.messages);
            payload.messages = transformPrompt(payload.messages, settings.promptControl, 'body');
            this.seen.add(payload);
            this.onTransform({ scope: 'body', before, messages: payload.messages });
        };
    }

    start() {
        const event = this.eventTypes.CHAT_COMPLETION_SETTINGS_READY;
        if (event) this.eventSource.on(event, this.handler);
    }

    stop() {
        const event = this.eventTypes.CHAT_COMPLETION_SETTINGS_READY;
        if (event) this.eventSource.removeListener(event, this.handler);
    }
}
