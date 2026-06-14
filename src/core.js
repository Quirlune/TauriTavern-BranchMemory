const ROLE_ORDER = ['system', 'user', 'assistant'];

export function deepMerge(base, incoming) {
    if (Array.isArray(base)) {
        return Array.isArray(incoming) ? structuredClone(incoming) : structuredClone(base);
    }

    if (!isPlainObject(base)) {
        return incoming === undefined ? base : structuredClone(incoming);
    }

    const output = structuredClone(base);
    if (!isPlainObject(incoming)) {
        return output;
    }

    for (const [key, value] of Object.entries(incoming)) {
        output[key] = key in base ? deepMerge(base[key], value) : structuredClone(value);
    }

    return output;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function roleOf(message) {
    if (message?.is_system) return 'system';
    if (message?.is_user) return 'user';
    return 'assistant';
}

function normalizeText(value) {
    return String(value ?? '').replace(/\r\n?/g, '\n');
}

export function canonicalMessage(message) {
    return JSON.stringify({
        role: roleOf(message),
        name: normalizeText(message?.name),
        text: normalizeText(message?.mes),
        sendDate: normalizeText(message?.send_date),
        swipeId: Number.isFinite(Number(message?.swipe_id)) ? Number(message.swipe_id) : null
    });
}

function mix32(state, text, prime) {
    let value = state >>> 0;
    for (let index = 0; index < text.length; index += 1) {
        value ^= text.charCodeAt(index);
        value = Math.imul(value, prime) >>> 0;
        value ^= value >>> 13;
    }
    return value >>> 0;
}

export function hashString(text) {
    const source = normalizeText(text);
    const left = mix32(0x811c9dc5, source, 0x01000193);
    const right = mix32(0x9e3779b9, source, 0x85ebca6b);
    return `${left.toString(16).padStart(8, '0')}${right.toString(16).padStart(8, '0')}`;
}

export function stableStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }

    if (isPlainObject(value)) {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }

    return JSON.stringify(value);
}

export function recipeHash(value) {
    return hashString(stableStringify(value));
}

export function buildSnapshot(messages) {
    let left = 0x811c9dc5;
    let right = 0x9e3779b9;
    let floor = 0;
    const rows = [];
    const floors = [];

    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        const role = roleOf(message);
        if (role === 'user') {
            floor += 1;
        }

        const canonical = `${index}\u001f${canonicalMessage(message)}\u001e`;
        left = mix32(left, canonical, 0x01000193);
        right = mix32(right, canonical, 0x85ebca6b);
        const chain = `${left.toString(16).padStart(8, '0')}${right.toString(16).padStart(8, '0')}`;
        rows.push({ index, floor, role, chain, message });

        if (role === 'user') {
            floors.push({ number: floor, startIndex: index, endIndex: index, chain, userRowIndex: rows.length - 1 });
        } else if (floors.length > 0) {
            const current = floors[floors.length - 1];
            current.endIndex = index;
            current.chain = chain;
        }
    }

    return {
        messages,
        rows,
        floors,
        totalFloors: floor,
        chain: rows.at(-1)?.chain || hashString('empty-chat')
    };
}

export function getFloor(snapshot, floorNumber) {
    return snapshot.floors[floorNumber - 1] || null;
}

export function messagesForFloorRange(snapshot, startFloor, endFloor) {
    const first = getFloor(snapshot, startFloor);
    const last = getFloor(snapshot, endFloor);
    if (!first || !last || startFloor > endFloor) {
        return [];
    }
    return snapshot.messages.slice(first.startIndex, last.endIndex + 1);
}

export function transcriptForFloorRange(snapshot, startFloor, endFloor, regexRules = []) {
    const messages = messagesForFloorRange(snapshot, startFloor, endFloor);
    return messages.map((message) => {
        const role = roleOf(message).toUpperCase();
        const name = normalizeText(message?.name).trim();
        const label = name ? `${role}/${name}` : role;
        const text = applyRegexRules(normalizeText(message?.mes), regexRules);
        return `[${label}]\n${text}`;
    }).join('\n\n');
}

export function boundaries(interval, eligibleFloor) {
    const step = Math.max(1, Math.floor(Number(interval) || 1));
    const limit = Math.max(0, Math.floor(Number(eligibleFloor) || 0));
    const output = [];
    for (let floor = step; floor <= limit; floor += step) {
        output.push(floor);
    }
    return output;
}

export function applyRegexRules(input, rules = []) {
    let output = String(input ?? '');
    for (const rule of rules) {
        if (!rule?.enabled || !rule.pattern) continue;
        try {
            output = output.replace(new RegExp(rule.pattern, rule.flags || 'g'), rule.replacement ?? '');
        } catch (error) {
            throw new Error(`正则“${rule.name || rule.id || rule.pattern}”无效：${error.message}`);
        }
    }
    return output;
}

export function processStatusOutput(rawOutput, renderRules = [], injectionRules = []) {
    const rawContent = String(rawOutput ?? '').trim();
    return {
        rawContent,
        renderContent: applyRegexRules(rawContent, renderRules).trim(),
        injectionContent: applyRegexRules(rawContent, injectionRules).trim()
    };
}

export function renderTemplate(template, values) {
    return String(template ?? '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => String(values?.[key] ?? ''));
}

export function promptEntriesToMessages(entries, values) {
    return (entries || [])
        .filter(entry => entry?.enabled && entry?.content)
        .map(entry => ({
            role: ROLE_ORDER.includes(entry.role) ? entry.role : 'user',
            content: renderTemplate(entry.content, values)
        }));
}

export function makeCacheKey({ scopeHash, floor, chain, recipe }) {
    return `v1.${scopeHash}.${Math.max(0, Number(floor) || 0)}.${chain}.${recipe}`;
}

export function selectActiveMemory({ largeRecords, smallRecords, eligibleFloor }) {
    const eligible = Math.max(0, Number(eligibleFloor) || 0);
    const large = [...largeRecords]
        .filter(record => record.endFloor <= eligible)
        .sort((a, b) => b.endFloor - a.endFloor)[0] || null;
    const largeEnd = large?.endFloor || 0;
    const small = [...smallRecords]
        .filter(record => record.endFloor > largeEnd && record.endFloor <= eligible)
        .sort((a, b) => a.endFloor - b.endFloor);
    return { large, small };
}

export function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

export function clampInteger(value, minimum, maximum, fallback) {
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, number));
}

export function statusInsertionIndex(messageCount, depth) {
    const count = Math.max(0, Math.floor(Number(messageCount) || 0));
    const resolvedDepth = Math.max(0, Math.floor(Number(depth) || 0));
    return Math.max(0, count - resolvedDepth);
}

export class AssistantGenerationGate {
    constructor() {
        this.accepted = false;
    }

    start(type, dryRun = false) {
        if (dryRun || type === 'quiet') {
            return false;
        }
        this.accepted = false;
        return true;
    }

    afterCommands(type, dryRun = false) {
        if (dryRun || type === 'quiet' || type === 'impersonate') {
            return false;
        }
        this.accepted = true;
        return true;
    }

    shouldTrigger(type) {
        return this.accepted && type !== 'first_message' && type !== 'impersonate';
    }

    reset() {
        this.accepted = false;
    }
}

export function uniqueId(prefix = 'item') {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
