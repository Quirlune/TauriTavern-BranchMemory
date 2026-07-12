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

export function appendMessagesToSnapshot(snapshot, messages) {
    const additions = (messages || []).filter(Boolean);
    if (!additions.length) return snapshot;
    if (!snapshot?.messages?.length) return buildSnapshot(additions);

    let left = Number.parseInt(String(snapshot.chain).slice(0, 8), 16);
    let right = Number.parseInt(String(snapshot.chain).slice(8, 16), 16);
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
        return buildSnapshot([...(snapshot.messages || []), ...additions]);
    }

    let floor = Math.max(0, Number(snapshot.totalFloors) || 0);
    const outputMessages = [...snapshot.messages];
    const rows = [...snapshot.rows];
    const floors = snapshot.floors.map(item => ({ ...item }));

    for (let offset = 0; offset < additions.length; offset += 1) {
        const index = outputMessages.length;
        const message = additions[offset];
        const role = roleOf(message);
        if (role === 'user') {
            floor += 1;
        }

        const canonical = `${index}\u001f${canonicalMessage(message)}\u001e`;
        left = mix32(left, canonical, 0x01000193);
        right = mix32(right, canonical, 0x85ebca6b);
        const chain = `${left.toString(16).padStart(8, '0')}${right.toString(16).padStart(8, '0')}`;
        outputMessages.push(message);
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
        messages: outputMessages,
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

export function summaryContextEndFloor(totalFloors, endFloor, extraFloors = 0) {
    const total = Math.max(0, Math.floor(Number(totalFloors) || 0));
    const end = Math.max(0, Math.floor(Number(endFloor) || 0));
    const extra = Math.max(0, Math.floor(Number(extraFloors) || 0));
    return Math.min(total, end + extra);
}

export function statusInjectionTargetFloor(snapshot, { reason = '', generationType = '' } = {}) {
    const currentFloor = Math.max(0, Math.floor(Number(snapshot?.totalFloors) || 0));
    const lastRole = snapshot?.rows?.at?.(-1)?.role || '';
    const type = String(generationType || '').toLowerCase();
    if (
        reason === 'before_generation'
        && lastRole === 'assistant'
        && currentFloor > 0
        && type !== 'continue'
    ) {
        return currentFloor - 1;
    }
    return currentFloor;
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

export function statusRecordOutputs(record, settings = {}) {
    if (!record) return { rawContent: null, renderContent: '', injectionContent: '' };
    if (record.rawContent === undefined || record.rawContent === null) {
        return {
            rawContent: null,
            renderContent: String(record.content || '').trim(),
            injectionContent: String(record.injectionContent || '').trim()
        };
    }
    return processStatusOutput(record.rawContent, settings.outputRegex || [], settings.injection?.outputRegex || []);
}

function escapeXmlText(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

function normalizeLocatorText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function stripOuterContentTags(value) {
    const text = normalizeText(value).trim();
    const match = text.match(/^<content\b[^>]*>\s*([\s\S]*?)\s*<\/content>\s*$/i);
    return {
        text: match ? match[1] : text,
        contentWrapped: Boolean(match)
    };
}

export function segmentImageSource(source) {
    const { text, contentWrapped } = stripOuterContentTags(source);
    const trimmed = text.trim();
    if (!trimmed) {
        return { contentWrapped, segments: [], formatted: '<source_segments></source_segments>' };
    }

    const delimiter = /\n\s*\n/.test(trimmed) ? /\n\s*\n+/ : /\n+/;
    const seen = new Map();
    const segments = trimmed
        .split(delimiter)
        .map(item => item.trim())
        .filter(Boolean)
        .map((item, index) => {
            const normalized = normalizeLocatorText(item);
            const occurrence = (seen.get(normalized) || 0) + 1;
            seen.set(normalized, occurrence);
            return {
                id: index + 1,
                text: item,
                normalized,
                occurrence
            };
        });

    const lines = ['<source_segments>'];
    for (const segment of segments) {
        lines.push(`<segment id="${segment.id}">`);
        lines.push(escapeXmlText(segment.text));
        lines.push('</segment>');
    }
    lines.push('</source_segments>');

    return {
        contentWrapped,
        segments,
        formatted: lines.join('\n')
    };
}

function cleanXmlTagName(value, fallback) {
    const raw = String(value || '').trim()
        .replace(/^<\s*\/?/, '')
        .replace(/\s*\/?>$/, '')
        .split(/\s+/)[0];
    return /^[A-Za-z_][\w:.-]*$/.test(raw) ? raw : fallback;
}

function escapedRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeXmlText(value) {
    return String(value ?? '')
        .trim()
        .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/i, '$1')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .trim();
}

function xmlTagValues(source, tagName) {
    const tag = escapedRegExp(tagName);
    const pattern = new RegExp(`<\\s*${tag}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\s*\\/\\s*${tag}\\s*>`, 'gi');
    const values = [];
    let match;
    while ((match = pattern.exec(source))) {
        values.push(decodeXmlText(match[1]));
    }
    return values;
}

export function parseImagePlan(rawOutput, { maxItems = 3, positionTag = 'position', promptTag = 'positive_prompt' } = {}) {
    const source = String(rawOutput ?? '').trim();
    if (!source) return [];
    if (imagePlanRequestsStop(source)) return [];

    const resolvedPositionTag = cleanXmlTagName(positionTag, 'position');
    const resolvedPromptTag = cleanXmlTagName(promptTag, 'positive_prompt');
    const positions = xmlTagValues(source, resolvedPositionTag);
    const prompts = xmlTagValues(source, resolvedPromptTag);
    const limit = Math.max(1, Math.min(12, Math.floor(Number(maxItems) || 3)));
    const count = Math.min(positions.length, prompts.length, limit);

    if (!count) {
        throw new Error(`图片规划输出没有找到 XML 标签 <${resolvedPositionTag}> 和 <${resolvedPromptTag}>。`);
    }

    const items = [];
    for (let index = 0; index < count; index += 1) {
        const match = positions[index].match(/\d+/);
        const segmentIndex = Math.max(1, Math.floor(Number(match?.[0]) || 0));
        const prompt = prompts[index].trim();
        if (!segmentIndex || !prompt) continue;
        items.push({
            id: `image-${index + 1}`,
            segmentIndex,
            prompt,
            placement: 'after',
            reason: ''
        });
    }
    return items;
}

export function imagePlanRequestsStop(rawOutput) {
    const source = String(rawOutput ?? '').trim();
    if (!source) return false;
    const values = [
        ...xmlTagValues(source, 'stop_image_generation'),
        ...xmlTagValues(source, 'stop')
    ];
    return values.some(value => /^(?:1|true|yes|stop|skip|停止|跳过)$/i.test(value.trim()) || value.trim().length > 0);
}

function extractJsonLike(text) {
    const source = String(text ?? '').trim();
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return fenced[1].trim();

    const arrayStart = source.indexOf('[');
    const objectStart = source.indexOf('{');
    const start = [arrayStart, objectStart].filter(index => index >= 0).sort((a, b) => a - b)[0];
    if (start === undefined) return source;
    const open = source[start];
    const close = open === '[' ? ']' : '}';
    const end = source.lastIndexOf(close);
    return end >= start ? source.slice(start, end + 1) : source.slice(start);
}

function parseImagePlanLegacy(rawOutput, { maxItems = 3 } = {}) {
    const text = extractJsonLike(rawOutput);
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new Error(`图片规划输出不是有效 JSON：${error.message}`);
    }

    const items = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.images)
            ? parsed.images
            : Array.isArray(parsed?.slots)
                ? parsed.slots
                : [];
    if (!items.length) return [];

    const allowedPlacements = new Set(['before', 'after', 'replace']);
    return items
        .map((item, index) => {
            const prompt = String(item.prompt ?? item.description ?? item.imagePrompt ?? '').trim();
            const anchor = String(item.anchor ?? item.locator ?? item.text ?? item.marker ?? '').trim();
            const placement = allowedPlacements.has(String(item.placement || '').toLowerCase())
                ? String(item.placement).toLowerCase()
                : 'after';
            const occurrence = Math.max(1, Math.floor(Number(item.occurrence) || 1));
            return {
                id: String(item.id || `image-${index + 1}`),
                anchor,
                prompt,
                placement,
                occurrence,
                reason: String(item.reason || '').trim()
            };
        })
        .filter(item => item.prompt && item.anchor)
        .slice(0, Math.max(1, Math.min(6, Math.floor(Number(maxItems) || 3))));
}

function readBalancedBlock(text, startIndex, openChar = '{', closeChar = '}') {
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let index = startIndex; index < text.length; index += 1) {
        const char = text[index];
        if (quote) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === quote) {
                quote = '';
            }
            continue;
        }

        if (char === '"' || char === "'" || char === '`') {
            quote = char;
            continue;
        }
        if (char === openChar) depth += 1;
        if (char === closeChar) {
            depth -= 1;
            if (depth === 0) return text.slice(startIndex, index + 1);
        }
    }
    return '';
}

function stripJsComments(text) {
    let output = '';
    let quote = '';
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];
        if (quote) {
            output += char;
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === quote) {
                quote = '';
            }
            continue;
        }
        if (char === '"' || char === "'" || char === '`') {
            quote = char;
            output += char;
            continue;
        }
        if (char === '/' && next === '/') {
            while (index < text.length && text[index] !== '\n') index += 1;
            output += '\n';
            continue;
        }
        if (char === '/' && next === '*') {
            index += 2;
            while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
            index += 1;
            continue;
        }
        output += char;
    }
    return output;
}

function readJsStringLiteral(text, startIndex) {
    const quote = text[startIndex];
    let value = '';
    let escaped = false;
    for (let index = startIndex + 1; index < text.length; index += 1) {
        const char = text[index];
        if (escaped) {
            if (char === 'n') value += '\n';
            else if (char === 'r') value += '\r';
            else if (char === 't') value += '\t';
            else if (char === 'b') value += '\b';
            else if (char === 'f') value += '\f';
            else value += char;
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (char === quote) {
            return { value, endIndex: index };
        }
        value += char;
    }
    return { value, endIndex: text.length - 1 };
}

function normalizeJsStrings(text) {
    let output = '';
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (char !== '"' && char !== "'" && char !== '`') {
            output += char;
            continue;
        }
        const literal = readJsStringLiteral(text, index);
        output += JSON.stringify(literal.value);
        index = literal.endIndex;
    }
    return output;
}

function copyJsonString(text, startIndex) {
    let output = '"';
    let escaped = false;
    for (let index = startIndex + 1; index < text.length; index += 1) {
        const char = text[index];
        output += char;
        if (escaped) {
            escaped = false;
        } else if (char === '\\') {
            escaped = true;
        } else if (char === '"') {
            return { output, endIndex: index };
        }
    }
    return { output, endIndex: text.length - 1 };
}

function quoteUnquotedObjectKeys(text) {
    let output = '';
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (char === '"') {
            const copied = copyJsonString(text, index);
            output += copied.output;
            index = copied.endIndex;
            continue;
        }

        if (char === '{' || char === ',') {
            output += char;
            index += 1;
            while (index < text.length && /\s/.test(text[index])) {
                output += text[index];
                index += 1;
            }

            const match = text.slice(index).match(/^([A-Za-z_$][\w$]*)\s*:/);
            if (match) {
                output += JSON.stringify(match[1]);
                index += match[1].length - 1;
            } else {
                index -= 1;
            }
            continue;
        }

        output += char;
    }
    return output;
}

function removeTrailingCommas(text) {
    let output = '';
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (char === '"') {
            const copied = copyJsonString(text, index);
            output += copied.output;
            index = copied.endIndex;
            continue;
        }
        if (char === ',') {
            let nextIndex = index + 1;
            while (nextIndex < text.length && /\s/.test(text[nextIndex])) nextIndex += 1;
            if (text[nextIndex] === '}' || text[nextIndex] === ']') continue;
        }
        output += char;
    }
    return output;
}

function parseJsObjectLiteral(literal) {
    const jsonLike = removeTrailingCommas(quoteUnquotedObjectKeys(normalizeJsStrings(stripJsComments(literal))));
    return JSON.parse(jsonLike);
}

function skipWhitespace(text, index) {
    while (index < text.length && /\s/.test(text[index])) index += 1;
    return index;
}

function readJsonStringifyArgument(text, callIndex) {
    const openParen = text.indexOf('(', callIndex + 'JSON.stringify'.length);
    if (openParen < 0) return '';
    const call = readBalancedBlock(text, openParen, '(', ')');
    return call ? call.slice(1, -1).trim() : '';
}

function expressionObjectBlock(expression, assignments) {
    const text = String(expression || '').trimStart();
    if (!text) return '';
    if (text[0] === '{') return readBalancedBlock(text, 0);

    if (text.startsWith('JSON.stringify')) {
        const argument = readJsonStringifyArgument(text, 0);
        return expressionObjectBlock(argument, assignments);
    }

    const match = text.match(/^([A-Za-z_$][\w$]*)\b/);
    return match ? assignments.get(match[1]) || '' : '';
}

function collectObjectAssignments(text) {
    const assignments = new Map();
    const declarations = [];
    const declarationPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
    let match;
    while ((match = declarationPattern.exec(text))) {
        declarations.push({ name: match[1], valueIndex: declarationPattern.lastIndex });
    }

    for (const declaration of declarations) {
        const start = skipWhitespace(text, declaration.valueIndex);
        if (text[start] === '{') {
            const block = readBalancedBlock(text, start);
            if (block) assignments.set(declaration.name, block);
        }
    }

    let changed = true;
    while (changed) {
        changed = false;
        for (const declaration of declarations) {
            if (assignments.has(declaration.name)) continue;
            const block = expressionObjectBlock(text.slice(declaration.valueIndex), assignments);
            if (!block) continue;
            assignments.set(declaration.name, block);
            changed = true;
        }
    }

    return assignments;
}

function pushCandidate(candidates, seen, block) {
    if (!block || seen.has(block)) return;
    seen.add(block);
    candidates.push(block);
}

function blockHasInputValues(block) {
    try {
        const body = parseJsObjectLiteral(block);
        return isPlainObject(body?.input_values ?? body?.inputValues);
    } catch {
        return false;
    }
}

function extractJsonStringifyObject(source) {
    const text = stripJsComments(String(source || ''));
    const assignments = collectObjectAssignments(text);
    const candidates = [];
    const seen = new Set();

    const stringifyPattern = /\bJSON\.stringify\s*\(/g;
    let match;
    while ((match = stringifyPattern.exec(text))) {
        const argument = readJsonStringifyArgument(text, match.index);
        pushCandidate(candidates, seen, expressionObjectBlock(argument, assignments));
    }

    for (const block of assignments.values()) {
        pushCandidate(candidates, seen, block);
    }

    for (let index = 0; index < text.length; index += 1) {
        if (text[index] !== '{') continue;
        const block = readBalancedBlock(text, index);
        if (!block || (!block.includes('input_values') && !block.includes('inputValues'))) continue;
        pushCandidate(candidates, seen, block);
    }

    return candidates.find(blockHasInputValues) || candidates[0] || '';
}

function numericControl(controls, name, value) {
    const number = Number(value);
    if (Number.isFinite(number)) controls[name] = number;
}

function looksNegativePrompt(value) {
    const text = String(value || '').toLowerCase();
    return /worst quality|bad anatomy|watermark|signature|deformed|distorted|disfigured|low quality|negative|ugly/.test(text);
}

function inputValueMacro(key, value, controls) {
    const lower = String(key).toLowerCase();
    if (lower.endsWith('.seed') || lower.includes(':seed') || lower.includes('.seed')) {
        numericControl(controls, 'seed', value);
        controls.randomSeed = false;
        return { macro: 'seed', quote: false };
    }
    if (lower.endsWith('.steps') || lower.includes('.steps')) {
        numericControl(controls, 'steps', value);
        return { macro: 'steps', quote: false };
    }
    if (lower.endsWith('.cfg') || lower.includes('.cfg')) {
        numericControl(controls, 'cfg', value);
        return { macro: 'cfg', quote: false };
    }
    if (lower.endsWith('.denoise') || lower.includes('.denoise')) {
        numericControl(controls, 'denoise', value);
        return { macro: 'denoise', quote: false };
    }
    if (lower.endsWith('.width') || lower.includes('.width')) {
        numericControl(controls, 'width', value);
        return { macro: 'width', quote: false };
    }
    if (lower.endsWith('.height') || lower.includes('.height')) {
        numericControl(controls, 'height', value);
        return { macro: 'height', quote: false };
    }
    if (lower.endsWith('.sampler_name') || lower.includes('.sampler_name')) {
        if (value !== undefined && value !== null) controls.sampler = String(value);
        return { macro: 'sampler', quote: true };
    }
    if (lower.endsWith('.scheduler') || lower.includes('.scheduler')) {
        if (value !== undefined && value !== null) controls.scheduler = String(value);
        return { macro: 'scheduler', quote: true };
    }
    if (lower.endsWith('.text') || lower.includes('.text')) {
        if (looksNegativePrompt(value)) {
            controls.negativePrompt = String(value ?? '');
            return { macro: 'negative_prompt', quote: true };
        }
        controls.positivePromptPrefix = String(value ?? '');
        return { macro: 'positive_prompt', quote: true };
    }
    return null;
}

function renderInputValuesTemplate(inputValues, controls) {
    const lines = ['{'];
    const entries = Object.entries(inputValues);
    entries.forEach(([key, value], index) => {
        const mapped = inputValueMacro(key, value, controls);
        const renderedValue = mapped
            ? mapped.quote
                ? `"{{${mapped.macro}}}"`
                : `{{${mapped.macro}}}`
            : JSON.stringify(value);
        const comma = index === entries.length - 1 ? '' : ',';
        lines.push(`  ${JSON.stringify(key)}: ${renderedValue}${comma}`);
    });
    lines.push('}');
    return lines.join('\n');
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

export function promptEntriesUseMacros(entries, macroNames) {
    const names = new Set((macroNames || []).map(name => String(name).trim()).filter(Boolean));
    if (!names.size) return false;
    const macroPattern = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
    return (entries || []).some((entry) => {
        if (!entry?.enabled || !entry?.content) return false;
        macroPattern.lastIndex = 0;
        for (const match of String(entry.content).matchAll(macroPattern)) {
            if (names.has(match[1])) return true;
        }
        return false;
    });
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
        this.accepted = false;
        if (dryRun || type === 'quiet') {
            return false;
        }
        return true;
    }

    afterCommands(type, dryRun = false) {
        if (dryRun || type === 'quiet' || type === 'impersonate') {
            this.accepted = false;
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
