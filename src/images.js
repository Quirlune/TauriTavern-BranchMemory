import {
    applyRegexRules,
    getFloor,
    hashString,
    makeCacheKey,
    parseImagePlan,
    promptEntriesToMessages,
    recipeHash,
    renderTemplate,
    roleOf,
    segmentImageSource,
    statusRecordOutputs,
    transcriptForFloorRange
} from './core.js';
import { characterPromptInfo, chatIdentity, readFullHistory, scopeHashForRef } from './history.js';

function latestAssistantRow(snapshot) {
    for (let index = snapshot.rows.length - 1; index >= 0; index -= 1) {
        const row = snapshot.rows[index];
        if (row.role === 'assistant' && row.floor > 0) return row;
    }
    return null;
}

function imageDebugEnabled(settings) {
    return Boolean(settings?.image?.debugNotifications);
}

function notifyImageDebug(settings, message, level = 'info') {
    if (!imageDebugEnabled(settings)) return;
    const text = `Branch Memory 图片测试：${message}`;
    try {
        const method = globalThis.toastr?.[level] || globalThis.toastr?.info;
        if (method) method(text);
        else console.info(text);
    } catch {
        console.info(text);
    }
}

function lastMessage(snapshot, role) {
    for (let index = snapshot.rows.length - 1; index >= 0; index -= 1) {
        if (snapshot.rows[index].role === role) {
            return String(snapshot.rows[index].message?.mes ?? '');
        }
    }
    return '';
}

function characterPromptRecord(settings, info) {
    const prompts = settings.image?.characterPrompts || {};
    const record = prompts.records?.[info.key] || null;
    const prompt = String(record?.prompt || prompts.fallback || '').trim();
    return {
        ...info,
        prompt
    };
}

function normalizeList(value) {
    return String(value || '')
        .split(/[\s,，]+/)
        .map(item => item.trim())
        .filter(Boolean);
}

function asNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function jsonStringContent(value) {
    return JSON.stringify(String(value ?? '')).slice(1, -1);
}

function randomSeed() {
    return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER) + 1;
}

function joinPositivePrompt(prefix, prompt) {
    const fixed = String(prefix || '').trim();
    const dynamic = String(prompt || '').trim();
    if (!fixed) return dynamic;
    if (!dynamic) return fixed;
    return `${fixed}${/[，,;；]$/.test(fixed) ? ' ' : ', '}${dynamic}`;
}

function getFinalImage(outputs) {
    if (!Array.isArray(outputs) || !outputs.length) return '';
    const output = [...outputs].reverse().find(item => item?.object_url || item?.url || item?.image_url) || outputs.at(-1);
    return String(output?.object_url || output?.url || output?.image_url || '');
}

function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener?.('abort', () => {
            clearTimeout(timer);
            reject(signal.reason || new Error('BizyAir request aborted'));
        }, { once: true });
    });
}

function cssEscape(value) {
    if (globalThis.CSS?.escape) return CSS.escape(String(value));
    return String(value).replace(/["\\]/g, '\\$&');
}

function escapeAttribute(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

async function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
        reader.readAsDataURL(blob);
    });
}

async function cacheImageUrl(url, enabled, signal, settings, label = '图片') {
    if (!enabled) {
        notifyImageDebug(settings, `${label} data URL 缓存关闭，保留远程 URL`);
        return String(url);
    }
    if (String(url).startsWith('data:')) {
        notifyImageDebug(settings, `${label} 已是 data URL，跳过下载缓存`);
        return String(url);
    }
    notifyImageDebug(settings, `${label} 开始下载缓存`);
    try {
        const response = await fetch(url, { mode: 'cors', signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const dataUrl = await blobToDataUrl(await response.blob());
        notifyImageDebug(settings, `${label} 已缓存为 data URL`, 'success');
        return dataUrl;
    } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        console.warn('[BranchMemory] BizyAir image cache fallback to remote URL', error);
        notifyImageDebug(settings, `${label} 缓存失败，保留远程 URL：${error.message || error}`, 'warning');
        return String(url);
    }
}

async function mapConcurrent(items, concurrency, mapper, signal) {
    const output = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(items.length, Math.max(1, Math.floor(Number(concurrency) || 1)));
    const workers = Array.from({ length: workerCount }, async () => {
        while (!signal?.aborted && nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            output[index] = await mapper(items[index], index);
        }
    });
    await Promise.all(workers);
    return output.filter(Boolean);
}

function textNodeWalker(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
            if (node.parentElement?.closest?.('[data-ttbm-image-slot]')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
}

function normalizeLocatorText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizedTextIndex(root) {
    const chars = [];
    const map = [];
    let previousWasSpace = false;
    for (const node of textNodeWalker(root)) {
        const value = node.nodeValue || '';
        for (let offset = 0; offset < value.length; offset += 1) {
            const char = value[offset];
            if (/\s/.test(char)) {
                if (!previousWasSpace) {
                    chars.push(' ');
                    map.push({ node, offset });
                    previousWasSpace = true;
                }
                continue;
            }
            chars.push(char);
            map.push({ node, offset });
            previousWasSpace = false;
        }
    }
    return { text: chars.join(''), map };
}

function normalizedRange(root, needle, occurrence = 1) {
    const target = normalizeLocatorText(needle);
    if (!target) return null;
    const index = normalizedTextIndex(root);
    let seen = 0;
    let searchFrom = 0;
    while (searchFrom <= index.text.length) {
        const start = index.text.indexOf(target, searchFrom);
        if (start < 0) break;
        seen += 1;
        if (seen === occurrence) {
            return {
                start: index.map[start],
                end: index.map[start + target.length - 1]
            };
        }
        searchFrom = start + Math.max(1, target.length);
    }
    return null;
}

function lastNormalizedRange(root, needle) {
    const target = normalizeLocatorText(needle);
    if (!target) return null;
    const index = normalizedTextIndex(root);
    const start = index.text.lastIndexOf(target);
    if (start < 0) return null;
    return {
        start: index.map[start],
        end: index.map[start + target.length - 1]
    };
}

function insertAfterMappedPosition(position, node) {
    if (!position?.node?.parentNode) return false;
    const after = position.node.splitText(position.offset + 1);
    after.parentNode.insertBefore(node, after);
    return true;
}

function insertAfterSegment(root, item, node) {
    if (item.contentWrapped && item.isLastSegment) {
        const closing = lastNormalizedRange(root, '</content>');
        if (insertAfterMappedPosition(closing?.end, node)) return true;
    }

    const range = normalizedRange(root, item.segmentText, item.segmentOccurrence || 1);
    return insertAfterMappedPosition(range?.end, node);
}

function insertAtAnchor(root, anchor, occurrence, placement, node) {
    let seen = 0;
    for (const textNode of textNodeWalker(root)) {
        let searchFrom = 0;
        while (searchFrom <= textNode.nodeValue.length) {
            const index = textNode.nodeValue.indexOf(anchor, searchFrom);
            if (index < 0) break;
            seen += 1;
            if (seen === occurrence) {
                if (placement === 'before') {
                    const anchorNode = textNode.splitText(index);
                    anchorNode.parentNode.insertBefore(node, anchorNode);
                } else if (placement === 'replace') {
                    const anchorNode = textNode.splitText(index);
                    anchorNode.splitText(anchor.length);
                    anchorNode.parentNode.replaceChild(node, anchorNode);
                } else {
                    const afterAnchor = textNode.splitText(index + anchor.length);
                    afterAnchor.parentNode.insertBefore(node, afterAnchor);
                }
                return true;
            }
            searchFrom = index + Math.max(1, anchor.length);
        }
    }
    return false;
}

function directChildWithin(node, ancestor) {
    let current = node;
    while (current && current.parentNode !== ancestor) {
        current = current.parentNode;
    }
    return current || null;
}

function cloneWithoutId(element) {
    const clone = element.cloneNode(false);
    clone.removeAttribute?.('id');
    return clone;
}

function moveImageOutsideGalContainer(wrapper, item) {
    if (!item.contentWrapped) return false;
    const content = wrapper.closest?.('.gal-content');
    const container = content?.closest?.('.gal-container');
    if (!content || !container?.parentNode) return false;

    const boundary = directChildWithin(wrapper, content);
    if (boundary !== wrapper) return false;

    const parent = container.parentNode;
    if (item.isLastSegment) {
        content.removeChild(wrapper);
        parent.insertBefore(wrapper, container.nextSibling);
        return true;
    }

    const afterContainer = cloneWithoutId(container);
    const afterContent = cloneWithoutId(content);
    let next = wrapper.nextSibling;
    while (next) {
        const moving = next;
        next = next.nextSibling;
        afterContent.appendChild(moving);
    }

    content.removeChild(wrapper);
    afterContainer.appendChild(afterContent);

    const footer = Array.from(container.children)
        .find(child => child !== content && child.classList?.contains('gal-footer'));
    if (footer) afterContainer.appendChild(footer.cloneNode(true));

    parent.insertBefore(wrapper, container.nextSibling);
    parent.insertBefore(afterContainer, wrapper.nextSibling);
    return true;
}

function findMessageTextElement(messageIndex) {
    const message = document.querySelector(`.mes[mesid="${cssEscape(messageIndex)}"]`)
        || document.querySelector(`#chat .mes:nth-of-type(${Number(messageIndex) + 1})`);
    return message?.querySelector?.('.mes_text') || message;
}

function renderImageItem(record, item) {
    const root = findMessageTextElement(record.messageIndex);
    if (!root || !item?.imageUrl) return false;
    const slotId = `${record.key}.${item.id}`;
    let wrapper = root.querySelector(`[data-ttbm-image-slot="${cssEscape(slotId)}"]`);
    if (!wrapper) {
        wrapper = document.createElement('span');
        wrapper.className = 'ttbm-image-inline';
        wrapper.dataset.ttbmImageSlot = slotId;
        wrapper.dataset.ttbmImageAnchor = item.anchor || '';
        wrapper.dataset.ttbmImageSegment = item.segmentIndex || '';
        let inserted = false;
        if (item.segmentText) {
            inserted = insertAfterSegment(root, item, wrapper);
        }
        if (!inserted && item.anchor) {
            inserted = insertAtAnchor(root, item.anchor, item.occurrence || 1, item.placement || 'after', wrapper);
        }
        if (!inserted) {
            root.appendChild(document.createTextNode('\n'));
            root.appendChild(wrapper);
        }
    }
    moveImageOutsideGalContainer(wrapper, item);
    wrapper.innerHTML = `
        <img class="ttbm-image-element" src="${escapeAttribute(item.imageUrl)}" alt="${escapeAttribute(item.prompt || 'BizyAir image')}" loading="lazy">
    `;
    return true;
}

function renderImageRecord(record) {
    if (!record?.items?.length) return;
    for (const item of record.items) renderImageItem(record, item);
}

export class BizyAirClient {
    constructor(settingsProvider) {
        this.settingsProvider = settingsProvider;
    }

    async generate(prompt, signal, { label = '图片' } = {}) {
        const settings = this.settingsProvider();
        const image = settings.image;
        const keys = normalizeList(image.bizyair.apiKeys);
        const apiKey = keys[0] || '';
        if (!apiKey) {
            notifyImageDebug(settings, `${label} 缺少 BizyAir API Key`, 'error');
            throw new Error('图片模块尚未填写 BizyAir API Key。');
        }

        const seed = image.bizyair.randomSeed ? randomSeed() : asNumber(image.bizyair.seed, 101);
        notifyImageDebug(settings, `${label} 准备 BizyAir create，seed=${seed}`);
        const positivePrompt = joinPositivePrompt(image.bizyair.positivePromptPrefix, prompt);
        const values = {
            prompt: jsonStringContent(positivePrompt),
            positive_prompt: jsonStringContent(positivePrompt),
            ai_prompt: jsonStringContent(prompt),
            positive_prompt_prefix: jsonStringContent(image.bizyair.positivePromptPrefix || ''),
            negative_prompt: jsonStringContent(image.bizyair.negativePrompt || ''),
            seed,
            width: asNumber(image.bizyair.width, 1024),
            height: asNumber(image.bizyair.height, 1024),
            steps: asNumber(image.bizyair.steps, 10),
            cfg: asNumber(image.bizyair.cfg, 1),
            sampler: jsonStringContent(image.bizyair.sampler || 'euler'),
            scheduler: jsonStringContent(image.bizyair.scheduler || 'simple'),
            denoise: asNumber(image.bizyair.denoise, 1)
        };
        let inputValues;
        try {
            inputValues = JSON.parse(renderTemplate(image.bizyair.inputValuesTemplate, values));
        } catch (error) {
            notifyImageDebug(settings, `${label} input_values 模板渲染失败：${error.message}`, 'error');
            throw error;
        }
        notifyImageDebug(settings, `${label} 提交 BizyAir create，Web App ID=${asNumber(image.bizyair.webAppId, 48570)}`);
        const createResponse = await fetch('https://api.bizyair.cn/w/v1/webapp/task/openapi/create', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            signal,
            body: JSON.stringify({
                web_app_id: asNumber(image.bizyair.webAppId, 48570),
                suppress_preview_output: image.bizyair.suppressPreviewOutput !== false,
                input_values: inputValues
            })
        });
        const createResult = await createResponse.json();
        if (!createResponse.ok) {
            notifyImageDebug(settings, `${label} BizyAir create 失败：${createResult.message || createResult.error || createResponse.status}`, 'error');
            throw new Error(createResult.message || createResult.error || 'BizyAir 创建任务失败。');
        }

        const immediate = getFinalImage(createResult.outputs);
        if (immediate) {
            notifyImageDebug(settings, `${label} BizyAir create 直接返回图片`, 'success');
            return immediate;
        }
        const taskId = createResult.request_id || createResult.task_id;
        if (!taskId) {
            notifyImageDebug(settings, `${label} BizyAir 未返回图片或任务 ID`, 'error');
            throw new Error('BizyAir 未返回图片或任务 ID。');
        }
        notifyImageDebug(settings, `${label} BizyAir task=${taskId}，开始轮询`);
        return this.#poll(taskId, apiKey, signal, { label });
    }

    async #poll(taskId, apiKey, signal, { label = '图片' } = {}) {
        const settings = this.settingsProvider();
        const image = settings.image;
        const maxPolls = Math.max(1, Math.floor(Number(image.bizyair.maxPolls) || 60));
        const intervalMs = Math.max(500, Math.floor(Number(image.bizyair.pollIntervalMs) || 2000));
        for (let index = 0; index < maxPolls; index += 1) {
            notifyImageDebug(settings, `${label} 等待轮询 ${index + 1}/${maxPolls}，${intervalMs}ms`);
            await delay(intervalMs, signal);
            const response = await fetch(`https://api.bizyair.cn/w/v1/webapp/task/openapi/query?task_id=${encodeURIComponent(taskId)}`, {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                signal
            });
            const result = await response.json();
            if (!response.ok) {
                notifyImageDebug(settings, `${label} BizyAir query 失败：${result.message || result.error || response.status}`, 'error');
                throw new Error(result.message || result.error || 'BizyAir 查询任务失败。');
            }
            notifyImageDebug(settings, `${label} BizyAir 状态：${result.status || 'unknown'}`);
            if (String(result.status || '').toLowerCase() === 'success') {
                const imageUrl = getFinalImage(result.outputs);
                if (imageUrl) {
                    notifyImageDebug(settings, `${label} BizyAir 生成成功`, 'success');
                    return imageUrl;
                }
            }
            if (String(result.status || '').toLowerCase() === 'failed') {
                notifyImageDebug(settings, `${label} BizyAir 生成失败：${result.error || result.message || 'failed'}`, 'error');
                throw new Error(result.error || result.message || 'BizyAir 生成失败。');
            }
        }
        notifyImageDebug(settings, `${label} BizyAir 等待图片生成超时`, 'error');
        throw new Error('BizyAir 等待图片生成超时。');
    }
}

export class ImagePipeline {
    constructor({ storage, getSettings, generate, onError = () => {}, updateStats = () => {} }) {
        this.storage = storage;
        this.getSettings = getSettings;
        this.generate = generate;
        this.onError = onError;
        this.updateStats = updateStats;
        this.client = new BizyAirClient(getSettings);
        this.queue = Promise.resolve();
        this.abortController = null;
    }

    enqueue(options = {}) {
        this.queue = this.queue
            .then(() => this.refresh(options))
            .catch((error) => {
                if (!error?.branchMemoryCancelled) this.onError(error);
            });
        return this.queue;
    }

    cancel() {
        notifyImageDebug(this.getSettings(), '收到取消图片生成请求，正在中断并发任务', 'warning');
        const error = new Error('图片生成已取消。');
        error.branchMemoryCancelled = true;
        this.abortController?.abort(error);
        this.abortController = null;
    }

    async refresh({ generate = false, reason = 'refresh' } = {}) {
        const settings = this.getSettings();
        notifyImageDebug(settings, `刷新图片管线：reason=${reason}，generate=${generate ? 'true' : 'false'}`);
        if (!settings.enabled || !settings.image?.enabled) {
            notifyImageDebug(settings, '扩展或图片模块未启用，移除现有图片占位', 'warning');
            document.querySelectorAll('[data-ttbm-image-slot]').forEach(node => node.remove());
            return;
        }

        const handle = this.storage.currentHandle();
        const ref = this.storage.currentRef();
        const identity = chatIdentity(ref);
        const scopeHash = scopeHashForRef(ref);
        const snapshot = await readFullHistory(handle);
        const character = characterPromptRecord(settings, characterPromptInfo(ref));
        const runtime = await this.storage.getChatRuntime(handle) || {};
        const statusOutputs = settings.status?.enabled === false
            ? { rawContent: null, renderContent: '', injectionContent: '' }
            : statusRecordOutputs(runtime.status, settings.status || {});
        const recipe = recipeHash({
            version: 2,
            api: settings.image.api,
            promptEntries: settings.image.promptEntries,
            inputRegex: settings.image.inputRegex,
            positionTag: settings.image.positionTag || 'position',
            promptTag: settings.image.promptTag || 'positive_prompt',
            status: {
                rawContent: statusOutputs.rawContent || '',
                renderContent: statusOutputs.renderContent,
                injectionContent: statusOutputs.injectionContent
            },
            character: {
                key: character.key,
                prompt: character.prompt
            },
            bizyair: {
                webAppId: settings.image.bizyair.webAppId,
                suppressPreviewOutput: settings.image.bizyair.suppressPreviewOutput,
                inputValuesTemplate: settings.image.bizyair.inputValuesTemplate,
                positivePromptPrefix: settings.image.bizyair.positivePromptPrefix,
                negativePrompt: settings.image.bizyair.negativePrompt
            }
        });
        document.querySelectorAll('[data-ttbm-image-slot]').forEach(node => node.remove());
        notifyImageDebug(settings, '开始回渲染已有图片缓存');
        const renderedCacheCount = await this.#renderCached({ snapshot, scopeHash, recipe });
        notifyImageDebug(settings, `缓存回渲染完成：${renderedCacheCount} 条记录`);

        if (!generate) {
            notifyImageDebug(settings, '本次只回渲染缓存，不触发图片生成');
            return;
        }
        if (!settings.image.autoGenerate && reason !== 'manual') {
            notifyImageDebug(settings, '自动生成关闭，跳过图片生成');
            return;
        }
        const row = latestAssistantRow(snapshot);
        if (!row) {
            notifyImageDebug(settings, '没有找到可用于规划的最新 AI 回复', 'warning');
            return;
        }
        const floorInfo = getFloor(snapshot, row.floor);
        if (!floorInfo) {
            notifyImageDebug(settings, `找不到第 ${row.floor} 楼分支信息，跳过`, 'warning');
            return;
        }
        const key = makeCacheKey({ scopeHash, floor: row.floor, chain: floorInfo.chain, recipe });
        const existing = await this.storage.getImage(key);
        if (existing) {
            notifyImageDebug(settings, `命中图片缓存：第 ${row.floor} 楼，${existing.items?.length || 0} 张`, 'success');
            renderImageRecord(existing);
            return;
        }

        const source = applyRegexRules(String(row.message?.mes || ''), settings.image.inputRegex).trim();
        if (!source) {
            notifyImageDebug(settings, '正文提取后为空，跳过图片规划', 'warning');
            return;
        }
        const sourceHash = hashString(source);
        const segmentedSource = segmentImageSource(source);
        if (!segmentedSource.segments.length) {
            notifyImageDebug(settings, '正文分片为空，跳过图片规划', 'warning');
            return;
        }
        notifyImageDebug(settings, `开始图片规划：第 ${row.floor} 楼，${segmentedSource.segments.length} 个分片`);
        const startFloor = Math.max(1, row.floor - settings.image.contextFloors + 1);
        const positionTag = settings.image.positionTag || 'position';
        const promptTag = settings.image.promptTag || 'positive_prompt';
        const prompt = promptEntriesToMessages(settings.image.promptEntries, {
            body: source,
            body_segments: segmentedSource.formatted,
            segmented_body: segmentedSource.formatted,
            source_segments: segmentedSource.formatted,
            assistant: String(row.message?.mes || ''),
            chat: transcriptForFloorRange(snapshot, startFloor, row.floor, []),
            floor: row.floor,
            floor_start: startFloor,
            floor_end: row.floor,
            total_floors: snapshot.totalFloors,
            last_user: lastMessage(snapshot, 'user'),
            last_assistant: lastMessage(snapshot, 'assistant'),
            max_images: settings.image.maxImagesPerMessage,
            character_prompt: character.prompt,
            appearance_prompt: character.prompt,
            character_name: character.label,
            character_key: character.key,
            character_id: character.characterId,
            character_file: character.fileName,
            status: statusOutputs.renderContent,
            previous_status: statusOutputs.renderContent,
            status_raw: statusOutputs.rawContent || '',
            status_injection: statusOutputs.injectionContent,
            position_tag: positionTag,
            prompt_tag: promptTag
        });
        if (!prompt.length) throw new Error('图片规划没有启用的提示词条目。');

        notifyImageDebug(settings, `调用图片规划模型：messages=${prompt.length}`);
        const rawPlan = await this.generate({ prompt, responseLength: settings.image.responseLength, apiConfig: settings.image.api });
        if (chatIdentity(this.storage.currentRef()) !== identity) return;
        const plannedSnapshot = await readFullHistory(handle);
        const plannedFloorInfo = getFloor(plannedSnapshot, row.floor);
        const plannedRow = plannedSnapshot.rows[row.index];
        const plannedSource = applyRegexRules(String(plannedRow?.message?.mes || ''), settings.image.inputRegex).trim();
        if (!plannedFloorInfo || plannedFloorInfo.chain !== floorInfo.chain || hashString(plannedSource) !== sourceHash) {
            notifyImageDebug(settings, '图片规划返回时消息已变化，丢弃旧规划结果', 'warning');
            return;
        }
        notifyImageDebug(settings, `图片规划模型返回：${String(rawPlan || '').length} 字符`);
        const planText = String(rawPlan || '').trim();
        const plan = parseImagePlan(planText, { maxItems: settings.image.maxImagesPerMessage, positionTag, promptTag })
            .filter(item => item.segmentIndex >= 1 && item.segmentIndex <= segmentedSource.segments.length);
        if (!plan.length) {
            notifyImageDebug(settings, '图片规划解析后没有有效项目，跳过 BizyAir', 'warning');
            return;
        }

        this.abortController = new AbortController();
        const controller = this.abortController;
        const signal = controller.signal;
        let items = [];
        try {
            const concurrency = Math.min(plan.length, Math.max(1, Math.floor(Number(settings.image.bizyair.concurrency) || 3)));
            notifyImageDebug(settings, `开始 BizyAir 批量生成：${plan.length} 张，并发=${concurrency}`);
            items = await mapConcurrent(plan, concurrency, async (item, index) => {
                const label = `图片 ${index + 1}/${plan.length}（分片 ${item.segmentIndex}）`;
                const segment = segmentedSource.segments[item.segmentIndex - 1];
                if (!segment) {
                    notifyImageDebug(settings, `${label} 找不到对应分片，跳过`, 'warning');
                    return null;
                }
                const slotId = hashString(`${key}:${item.id}:${item.segmentIndex}:${item.prompt}`);
                try {
                    notifyImageDebug(settings, `${label} 开始生成`);
                    const remoteUrl = await this.client.generate(item.prompt, signal, { label });
                    notifyImageDebug(settings, `${label} 获得远程图片 URL`, 'success');
                    const imageUrl = await cacheImageUrl(remoteUrl, settings.image.cacheAsDataUrl !== false, signal, settings, label);
                    notifyImageDebug(settings, `${label} 生成流程完成`, 'success');
                    return {
                        ...item,
                        id: slotId,
                        segmentText: segment.text,
                        segmentOccurrence: segment.occurrence,
                        contentWrapped: segmentedSource.contentWrapped,
                        isLastSegment: item.segmentIndex === segmentedSource.segments.length,
                        remoteUrl,
                        imageUrl,
                        createdAt: new Date().toISOString()
                    };
                } catch (error) {
                    notifyImageDebug(settings, `${label} 失败：${error.message || error}`, 'error');
                    controller.abort(error);
                    throw error;
                }
            }, signal);
        } finally {
            if (this.abortController === controller) this.abortController = null;
        }
        if (!items.length) {
            notifyImageDebug(settings, 'BizyAir 没有返回可保存图片，跳过写入缓存', 'warning');
            return;
        }
        if (chatIdentity(this.storage.currentRef()) !== identity) {
            notifyImageDebug(settings, '聊天已切换，丢弃本批图片结果', 'warning');
            return;
        }
        const currentSnapshot = await readFullHistory(handle);
        const currentFloorInfo = getFloor(currentSnapshot, row.floor);
        const currentRow = currentSnapshot.rows[row.index];
        const currentSource = applyRegexRules(String(currentRow?.message?.mes || ''), settings.image.inputRegex).trim();
        if (!currentFloorInfo || currentFloorInfo.chain !== floorInfo.chain || hashString(currentSource) !== sourceHash) {
            notifyImageDebug(settings, '当前消息已变化，丢弃旧图片任务结果', 'warning');
            return;
        }

        const record = {
            version: 1,
            kind: 'image',
            key,
            scopeHash,
            recipe,
            floor: row.floor,
            messageIndex: row.index,
            anchorChain: floorInfo.chain,
            sourceHash,
            items,
            createdAt: new Date().toISOString(),
            reason
        };
        await this.storage.setImage(key, record);
        notifyImageDebug(settings, `图片记录已保存：第 ${row.floor} 楼，${items.length} 张`, 'success');
        renderImageRecord(record);
        notifyImageDebug(settings, '图片已插回聊天正文', 'success');
        this.updateStats({ lastImageAt: record.createdAt, imageCount: items.length, imageFloor: row.floor });
    }

    async #renderCached({ snapshot, scopeHash, recipe }) {
        const available = new Set(await this.storage.listImageKeys());
        if (!available.size) return 0;
        const records = [];
        for (const floor of snapshot.floors) {
            const key = makeCacheKey({ scopeHash, floor: floor.number, chain: floor.chain, recipe });
            if (!available.has(key)) continue;
            const record = await this.storage.getImage(key);
            if (record) records.push(record);
        }
        records.sort((a, b) => a.messageIndex - b.messageIndex).forEach(renderImageRecord);
        return records.length;
    }
}
