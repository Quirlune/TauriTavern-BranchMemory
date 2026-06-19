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
import { characterPromptInfo, chatIdentity, locateLatestAssistantMessage, readFullHistory, scopeHashForRef } from './history.js';

const IMAGE_GENERATION_REASONS = new Set(['assistant_output', 'manual']);
const IMAGE_CACHE_RETENTION_DAYS = 70;
const IMAGE_CACHE_RETENTION_MS = IMAGE_CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const TARGET_STABLE_WAITS_MS = [140, 620, 320, 320];
const TARGET_STABLE_WAITS_MANUAL_MS = [100, 260, 500, 320];

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
    const debugText = `Branch Memory image debug: ${message}`;
    try {
        const method = globalThis.toastr?.[level] || globalThis.toastr?.info;
        if (method) method(debugText);
        else console.info(debugText);
    } catch {
        console.info(debugText);
    }
}

function notifyImageProgress(settings, message, level = 'info') {
    if (imageDebugEnabled(settings)) return;
    const progressText = `Branch Memory: ${message}`;
    try {
        const method = globalThis.toastr?.[level] || globalThis.toastr?.info;
        if (method) method(progressText);
        else console.info(progressText);
    } catch {
        console.info(progressText);
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

function imageCacheExpiresAt(createdAt) {
    const timestamp = Date.parse(createdAt);
    if (!Number.isFinite(timestamp)) return '';
    return new Date(timestamp + IMAGE_CACHE_RETENTION_MS).toISOString();
}

function imageRecordExpired(record, now = Date.now()) {
    if (!record) return false;
    const expiresAt = Date.parse(record.expiresAt);
    if (Number.isFinite(expiresAt)) return expiresAt <= now;
    const createdAt = Date.parse(record.createdAt);
    return Number.isFinite(createdAt) && createdAt + IMAGE_CACHE_RETENTION_MS <= now;
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

let imageOpenDelegationBound = false;
let imageViewerState = null;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function pointerDistance(first, second) {
    return Math.hypot(second.x - first.x, second.y - first.y);
}

function pointerCenter(first, second) {
    return {
        x: (first.x + second.x) / 2,
        y: (first.y + second.y) / 2
    };
}

function viewerPromptText(item) {
    const generationPrompt = String(item?.generationPrompt || item?.positivePrompt || '').trim();
    const plannerPrompt = String(item?.prompt || '').trim();
    const negativePrompt = String(item?.negativePrompt || '').trim();
    const parts = [];
    const positive = generationPrompt || plannerPrompt;
    if (positive) parts.push(['正向提示词', positive]);
    if (plannerPrompt && generationPrompt && plannerPrompt !== generationPrompt) {
        parts.push(['规划提示词', plannerPrompt]);
    }
    if (negativePrompt) parts.push(['负面提示词', negativePrompt]);
    return parts.map(([title, text]) => `${title}\n${text}`).join('\n\n');
}

function applyViewerTransform(state) {
    state.image.style.transform = `translate3d(${state.offsetX}px, ${state.offsetY}px, 0) scale(${state.scale})`;
}

function resetViewerTransform(state) {
    state.scale = 1;
    state.offsetX = 0;
    state.offsetY = 0;
    state.gesture = null;
    state.lastPan = null;
    applyViewerTransform(state);
}

function zoomViewerAt(state, factor, clientX, clientY) {
    const previousScale = state.scale;
    const nextScale = clamp(previousScale * factor, 1, 6);
    if (nextScale === previousScale) return;

    const rect = state.stage.getBoundingClientRect();
    const centerX = clientX - rect.left - rect.width / 2;
    const centerY = clientY - rect.top - rect.height / 2;
    const ratio = nextScale / previousScale;
    state.offsetX = centerX - (centerX - state.offsetX) * ratio;
    state.offsetY = centerY - (centerY - state.offsetY) * ratio;
    state.scale = nextScale;
    if (state.scale === 1) {
        state.offsetX = 0;
        state.offsetY = 0;
    }
    applyViewerTransform(state);
}

function activeViewerPointers(state) {
    return [...state.pointers.values()];
}

function updateGestureFromPointers(state) {
    const pointers = activeViewerPointers(state);
    if (pointers.length >= 2) {
        const first = pointers[0];
        const second = pointers[1];
        state.gesture = {
            distance: Math.max(1, pointerDistance(first, second)),
            center: pointerCenter(first, second),
            scale: state.scale,
            offsetX: state.offsetX,
            offsetY: state.offsetY
        };
        state.lastPan = null;
    } else if (pointers.length === 1) {
        state.gesture = null;
        state.lastPan = { x: pointers[0].x, y: pointers[0].y };
    } else {
        state.gesture = null;
        state.lastPan = null;
    }
}

function handleViewerPointerMove(state, event) {
    if (!state.pointers.has(event.pointerId)) return;
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pointers = activeViewerPointers(state);
    if (pointers.length >= 2) {
        const first = pointers[0];
        const second = pointers[1];
        const center = pointerCenter(first, second);
        const distance = Math.max(1, pointerDistance(first, second));
        const gesture = state.gesture || {
            distance,
            center,
            scale: state.scale,
            offsetX: state.offsetX,
            offsetY: state.offsetY
        };
        state.gesture = gesture;
        const nextScale = clamp(gesture.scale * (distance / gesture.distance), 1, 6);
        const rect = state.stage.getBoundingClientRect();
        const startX = gesture.center.x - rect.left - rect.width / 2;
        const startY = gesture.center.y - rect.top - rect.height / 2;
        const currentX = center.x - rect.left - rect.width / 2;
        const currentY = center.y - rect.top - rect.height / 2;
        const contentX = (startX - gesture.offsetX) / gesture.scale;
        const contentY = (startY - gesture.offsetY) / gesture.scale;
        state.scale = nextScale;
        state.offsetX = currentX - contentX * nextScale;
        state.offsetY = currentY - contentY * nextScale;
        if (state.scale === 1) {
            state.offsetX = 0;
            state.offsetY = 0;
        }
        applyViewerTransform(state);
        event.preventDefault();
        return;
    }

    if (pointers.length === 1 && state.lastPan && state.scale > 1) {
        const pointer = pointers[0];
        state.offsetX += pointer.x - state.lastPan.x;
        state.offsetY += pointer.y - state.lastPan.y;
        state.lastPan = { x: pointer.x, y: pointer.y };
        applyViewerTransform(state);
        event.preventDefault();
    }
}

function closeImageViewer() {
    const state = imageViewerState;
    if (!state) return;
    state.viewer.hidden = true;
    state.image.removeAttribute('src');
    state.prompt.value = '';
    state.pointers.clear();
    document.documentElement.classList.remove('ttbm-image-viewer-open');
    document.body.classList.remove('ttbm-image-viewer-open');
}

function ensureImageViewer() {
    if (imageViewerState?.viewer?.isConnected) return imageViewerState;
    imageViewerState = null;
    const existing = document.getElementById('ttbm-image-viewer');
    if (existing) existing.remove();

    const viewer = document.createElement('div');
    viewer.id = 'ttbm-image-viewer';
    viewer.className = 'ttbm-image-viewer';
    viewer.hidden = true;
    viewer.tabIndex = -1;
    viewer.innerHTML = `
        <div class="ttbm-image-viewer-backdrop" data-ttbm-image-viewer-close></div>
        <section class="ttbm-image-viewer-panel" role="dialog" aria-modal="true" aria-label="图片预览">
            <header class="ttbm-image-viewer-head">
                <strong>图片预览</strong>
                <div class="ttbm-image-viewer-actions">
                    <button class="menu_button" type="button" data-ttbm-image-viewer-reset>重置</button>
                    <button class="menu_button" type="button" data-ttbm-image-viewer-copy>复制提示词</button>
                    <button class="menu_button" type="button" data-ttbm-image-viewer-close>关闭</button>
                </div>
            </header>
            <div class="ttbm-image-viewer-body">
                <div class="ttbm-image-viewer-stage">
                    <img class="ttbm-image-viewer-image" alt="" draggable="false">
                </div>
                <aside class="ttbm-image-viewer-prompt">
                    <strong>模型提示词</strong>
                    <textarea class="text_pole ttbm-code" readonly></textarea>
                </aside>
            </div>
        </section>
    `;
    document.body.appendChild(viewer);

    const state = {
        viewer,
        stage: viewer.querySelector('.ttbm-image-viewer-stage'),
        image: viewer.querySelector('.ttbm-image-viewer-image'),
        prompt: viewer.querySelector('.ttbm-image-viewer-prompt textarea'),
        pointers: new Map(),
        scale: 1,
        offsetX: 0,
        offsetY: 0,
        gesture: null,
        lastPan: null
    };

    viewer.addEventListener('click', (event) => {
        if (event.target.closest('[data-ttbm-image-viewer-close]')) closeImageViewer();
        if (event.target.closest('[data-ttbm-image-viewer-reset]')) resetViewerTransform(state);
        if (event.target.closest('[data-ttbm-image-viewer-copy]')) {
            const text = state.prompt.value;
            const fallbackCopy = () => {
                state.prompt.focus();
                state.prompt.select();
                document.execCommand?.('copy');
                globalThis.toastr?.success?.('已复制提示词');
            };
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(text)
                    .then(() => globalThis.toastr?.success?.('已复制提示词'))
                    .catch(fallbackCopy);
            } else {
                fallbackCopy();
            }
        }
    });
    viewer.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeImageViewer();
    });
    state.stage.addEventListener('wheel', (event) => {
        event.preventDefault();
        zoomViewerAt(state, event.deltaY < 0 ? 1.12 : 0.88, event.clientX, event.clientY);
    }, { passive: false });
    state.stage.addEventListener('dblclick', (event) => {
        event.preventDefault();
        if (state.scale > 1) resetViewerTransform(state);
        else zoomViewerAt(state, 2.4, event.clientX, event.clientY);
    });
    state.stage.addEventListener('pointerdown', (event) => {
        state.stage.setPointerCapture?.(event.pointerId);
        state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        updateGestureFromPointers(state);
        event.preventDefault();
    });
    state.stage.addEventListener('pointermove', (event) => handleViewerPointerMove(state, event));
    for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        state.stage.addEventListener(eventName, (event) => {
            state.pointers.delete(event.pointerId);
            updateGestureFromPointers(state);
        });
    }

    imageViewerState = state;
    return state;
}

function openImageViewer(item) {
    if (!item?.imageUrl) return;
    const state = ensureImageViewer();
    resetViewerTransform(state);
    state.image.src = item.imageUrl;
    state.image.alt = item.prompt || 'BizyAir image';
    state.prompt.value = viewerPromptText(item) || '没有记录提示词。';
    state.viewer.hidden = false;
    state.viewer.focus?.();
    document.documentElement.classList.add('ttbm-image-viewer-open');
    document.body.classList.add('ttbm-image-viewer-open');
}

function ensureImageOpenDelegation() {
    if (imageOpenDelegationBound) return;
    document.addEventListener('click', (event) => {
        const button = event.target.closest?.('[data-ttbm-image-open]');
        if (!button) return;
        const wrapper = button.closest('[data-ttbm-image-slot]');
        const item = wrapper?.ttbmImageItem;
        if (!item?.imageUrl) return;
        event.preventDefault();
        event.stopPropagation();
        openImageViewer(item);
    });
    imageOpenDelegationBound = true;
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

function findMessageTextElement(messageIndex) {
    const message = document.querySelector(`.mes[mesid="${cssEscape(messageIndex)}"]`)
        || document.querySelector(`#chat .mes:nth-of-type(${Number(messageIndex) + 1})`);
    return message?.querySelector?.('.mes_text') || message;
}

function renderImageItem(record, item) {
    const root = findMessageTextElement(record.messageIndex);
    if (!root || !item?.imageUrl) return false;
    ensureImageOpenDelegation();
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
    wrapper.ttbmImageItem = item;
    wrapper.innerHTML = `
        <button class="ttbm-image-open" type="button" data-ttbm-image-open aria-label="查看大图">
            <img class="ttbm-image-element" src="${escapeAttribute(item.imageUrl)}" alt="${escapeAttribute(item.prompt || 'BizyAir image')}" loading="lazy">
        </button>
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
        const intervalMs = Math.max(500, Math.floor(Number(image.bizyair.pollIntervalMs) || 1000));
        for (let index = 0; index < maxPolls; index += 1) {
            if (index > 0) {
                notifyImageDebug(settings, `${label} 等待轮询 ${index + 1}/${maxPolls}，${intervalMs}ms`);
                await delay(intervalMs, signal);
            } else {
                notifyImageDebug(settings, `${label} 立即轮询 1/${maxPolls}`);
            }
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
        this.activeJobs = new Map();
        this.renderQueue = Promise.resolve();
        this.renderVersion = 0;
        this.cancelVersion = 0;
    }

    enqueue(options = {}) {
        return this.refresh(options)
            .catch((error) => {
                if (error?.branchMemoryCancelled) return;
                const settings = this.getSettings();
                notifyImageProgress(settings, '图像生成失败', 'error');
                if (imageDebugEnabled(settings)) {
                    this.onError(error);
                } else {
                    console.warn('[BranchMemory] Image pipeline error', error);
                }
            });
    }

    cancel() {
        this.cancelVersion += 1;
        const error = this.#cancelledError();
        if (this.activeJobs.size) {
            notifyImageDebug(this.getSettings(), `收到取消图片生成请求，正在中断 ${this.activeJobs.size} 个任务`, 'warning');
        }
        for (const job of this.activeJobs.values()) {
            job.controller.abort(error);
        }
        this.activeJobs.clear();
    }

    clearRendered() {
        document.querySelectorAll('[data-ttbm-image-slot]').forEach(node => node.remove());
    }

    async refresh({ generate = false, reason = 'refresh' } = {}) {
        if (generate) return this.#generateLatest({ reason });
        return this.#renderCurrentCached({ reason });
    }

    async #renderCurrentCached({ reason = 'refresh' } = {}) {
        const renderId = this.renderVersion + 1;
        this.renderVersion = renderId;
        this.renderQueue = this.renderQueue
            .catch(() => undefined)
            .then(async () => {
                const settings = this.getSettings();
                notifyImageDebug(settings, `回渲染图片缓存：reason=${reason}`);
                if (!settings.enabled || !settings.image?.enabled) {
                    if (renderId === this.renderVersion) {
                        notifyImageDebug(settings, '扩展或图片模块未启用，移除现有图片占位', 'warning');
                        document.querySelectorAll('[data-ttbm-image-slot]').forEach(node => node.remove());
                    }
                    return;
                }

                const context = await this.#buildContext();
                if (renderId !== this.renderVersion) {
                    notifyImageDebug(settings, '已有更新的缓存回渲染任务，丢弃本次旧结果', 'warning');
                    return;
                }

                document.querySelectorAll('[data-ttbm-image-slot]').forEach(node => node.remove());
                notifyImageDebug(settings, '开始回渲染已有图片缓存');
                const renderedCacheCount = await this.#renderCached(context);
                notifyImageDebug(settings, `缓存回渲染完成：${renderedCacheCount} 条记录`);
            });
        return this.renderQueue;
    }

    async #generateLatest({ reason = 'refresh' } = {}) {
        const settings = this.getSettings();
        const requestVersion = this.cancelVersion;
        notifyImageDebug(settings, `准备图片生成：reason=${reason}`);
        if (!IMAGE_GENERATION_REASONS.has(reason)) {
            notifyImageDebug(settings, `reason=${reason} 不是图片生成入口，跳过`);
            return;
        }
        if (!settings.enabled || !settings.image?.enabled) {
            notifyImageDebug(settings, '扩展或图片模块未启用，跳过图片生成', 'warning');
            return;
        }

        const target = await this.#captureStableTarget({ reason, requestVersion });
        this.#throwIfCancelled(requestVersion);
        if (!target) {
            notifyImageDebug(settings, '没有找到稳定的 AI 回复，跳过图片生成', 'warning');
            return;
        }

        const existing = await this.#getCachedImageForTarget(target);
        if (existing) {
            notifyImageDebug(settings, `命中图片缓存：第 ${target.row.floor} 楼，${existing.items?.length || 0} 张`, 'success');
            renderImageRecord(existing);
            return;
        }
        if (!settings.image.autoGenerate && reason !== 'manual') {
            notifyImageDebug(settings, '自动生成关闭，未命中缓存，跳过新图片生成');
            return;
        }

        const running = this.activeJobs.get(target.key);
        if (running) {
            notifyImageDebug(settings, `第 ${target.row.floor} 楼图片任务已在运行，复用当前任务`);
            return running.promise;
        }

        notifyImageProgress(settings, '开始图像生成');
        const controller = new AbortController();
        const promise = this.#generateTarget({ target, controller, reason, requestVersion })
            .finally(() => {
                if (this.activeJobs.get(target.key)?.promise === promise) {
                    this.activeJobs.delete(target.key);
                }
            });
        this.activeJobs.set(target.key, { controller, promise });
        return promise;
    }

    #cancelledError() {
        const error = new Error('图片生成已取消。');
        error.branchMemoryCancelled = true;
        return error;
    }

    #throwIfCancelled(requestVersion) {
        if (requestVersion !== this.cancelVersion) {
            throw this.#cancelledError();
        }
    }

    async #buildContext() {
        const settings = this.getSettings();
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
            version: 3,
            api: settings.image.api,
            promptEntries: settings.image.promptEntries,
            inputRegex: settings.image.inputRegex,
            positionTag: settings.image.positionTag || 'position',
            promptTag: settings.image.promptTag || 'positive_prompt',
            status: {
                enabled: settings.status?.enabled !== false,
                outputRegex: settings.status?.outputRegex || [],
                injectionOutputRegex: settings.status?.injection?.outputRegex || []
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
        return { settings, handle, ref, identity, scopeHash, snapshot, character, statusOutputs, recipe };
    }

    #targetFromContext(context) {
        const { settings, snapshot, scopeHash, recipe } = context;
        const row = latestAssistantRow(snapshot);
        if (!row) {
            return null;
        }
        const floorInfo = getFloor(snapshot, row.floor);
        if (!floorInfo) {
            notifyImageDebug(settings, `找不到第 ${row.floor} 楼分支信息，跳过`, 'warning');
            return null;
        }

        const source = applyRegexRules(String(row.message?.mes || ''), settings.image.inputRegex).trim();
        if (!source) {
            notifyImageDebug(settings, '正文提取后为空，跳过图片规划', 'warning');
            return null;
        }
        const sourceHash = hashString(source);
        const segmentedSource = segmentImageSource(source);
        if (!segmentedSource.segments.length) {
            notifyImageDebug(settings, '正文分片为空，跳过图片规划', 'warning');
            return null;
        }
        const key = makeCacheKey({ scopeHash, floor: row.floor, chain: floorInfo.chain, recipe });
        return {
            ...context,
            row,
            floorInfo,
            key,
            source,
            sourceHash,
            segmentedSource,
            signature: `${context.identity}:${row.index}:${row.floor}:${floorInfo.chain}:${sourceHash}`
        };
    }

    async #captureStableTarget({ reason, requestVersion }) {
        const waits = reason === 'manual' ? TARGET_STABLE_WAITS_MANUAL_MS : TARGET_STABLE_WAITS_MS;
        let lastSignature = '';
        for (let attempt = 0; attempt < waits.length; attempt += 1) {
            this.#throwIfCancelled(requestVersion);
            const target = this.#targetFromContext(await this.#buildContext());
            if (!target) {
                await delay(waits[attempt], undefined);
                continue;
            }

            await delay(waits[attempt], undefined);
            this.#throwIfCancelled(requestVersion);
            const confirmed = this.#targetFromContext(await this.#buildContext());
            if (confirmed?.signature === target.signature) {
                notifyImageDebug(confirmed.settings, `捕获到稳定图片目标：第 ${confirmed.row.floor} 楼，${confirmed.segmentedSource.segments.length} 个分片`);
                return confirmed;
            }

            const signature = confirmed?.signature || '';
            if (signature && signature !== lastSignature) {
                notifyImageDebug(target.settings, `图片目标仍在被其它插件更新，等待重新确认：${attempt + 1}/${waits.length}`, 'warning');
                lastSignature = signature;
            }
        }

        const settings = this.getSettings();
        notifyImageDebug(settings, '多次确认后仍没有稳定的 AI 回复，跳过本次图片生成', 'warning');
        return null;
    }

    async #targetStillCurrentFast(target) {
        if (chatIdentity(this.storage.currentRef()) !== target.identity) {
            notifyImageDebug(target.settings, '聊天已切换，丢弃本批图片结果', 'warning');
            return false;
        }

        const hit = await locateLatestAssistantMessage(target.handle);
        if (hit?.message) {
            const hitIndex = Number(hit.index);
            const currentSource = applyRegexRules(String(hit.message?.mes || ''), target.settings.image.inputRegex).trim();
            if (Number.isFinite(hitIndex) && hitIndex !== target.row.index) return false;
            return hashString(currentSource) === target.sourceHash;
        }

        return this.#targetStillCurrent(target);
    }

    async #targetStillCurrent(target) {
        if (chatIdentity(this.storage.currentRef()) !== target.identity) {
            notifyImageDebug(target.settings, '聊天已切换，丢弃本批图片结果', 'warning');
            return false;
        }
        const currentSnapshot = await readFullHistory(target.handle);
        const currentFloorInfo = getFloor(currentSnapshot, target.row.floor);
        const currentRow = currentSnapshot.rows[target.row.index];
        const currentSource = applyRegexRules(String(currentRow?.message?.mes || ''), target.settings.image.inputRegex).trim();
        if (!currentFloorInfo || currentFloorInfo.chain !== target.floorInfo.chain || hashString(currentSource) !== target.sourceHash) {
            notifyImageDebug(target.settings, '当前消息已变化，丢弃旧图片任务结果', 'warning');
            return false;
        }
        return true;
    }

    async #getCachedImageForTarget(target, availableKeys = null) {
        const exact = await this.#getFreshImage(target.key, { availableKeys });
        if (exact) return exact;
        return this.#getLatestImageForFloorChain({
            scopeHash: target.scopeHash,
            floor: target.row.floor,
            chain: target.floorInfo.chain,
            availableKeys
        });
    }

    async #deleteImageCacheRecord(key, availableKeys = null) {
        try {
            await this.storage.deleteImage(key);
            availableKeys?.delete?.(key);
            return true;
        } catch (error) {
            console.warn('[BranchMemory] Unable to delete expired image cache', key, error);
            return false;
        }
    }

    async #getFreshImage(key, { now = Date.now(), availableKeys = null } = {}) {
        const record = await this.storage.getImage(key);
        if (!imageRecordExpired(record, now)) return record;
        await this.#deleteImageCacheRecord(key, availableKeys);
        return null;
    }

    async #pruneExpiredImageCache(availableKeys) {
        const now = Date.now();
        let removed = 0;
        for (const key of [...availableKeys]) {
            const record = await this.storage.getImage(key);
            if (!imageRecordExpired(record, now)) continue;
            if (await this.#deleteImageCacheRecord(key, availableKeys)) removed += 1;
        }
        if (removed) {
            notifyImageDebug(this.getSettings(), `已清理过期图片缓存 ${removed} 条（保留 ${IMAGE_CACHE_RETENTION_DAYS} 天）`);
        }
        return removed;
    }

    async #getLatestImageForFloorChain({ scopeHash, floor, chain, availableKeys = null }) {
        const keys = availableKeys || new Set(await this.storage.listImageKeys());
        const prefix = `v1.${scopeHash}.${Math.max(0, Number(floor) || 0)}.${chain}.`;
        const candidates = [...keys].filter(key => String(key).startsWith(prefix));
        if (!candidates.length) return null;

        const records = [];
        const now = Date.now();
        for (const key of candidates) {
            const record = await this.#getFreshImage(key, { now, availableKeys: keys });
            if (record) records.push(record);
        }
        records.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        return records[0] || null;
    }

    async #generateTarget({ target, controller, reason, requestVersion }) {
        const {
            settings,
            snapshot,
            character,
            statusOutputs,
            row,
            floorInfo,
            key,
            recipe,
            scopeHash,
            source,
            sourceHash,
            segmentedSource
        } = target;
        notifyImageDebug(settings, `开始图片规划：第 ${row.floor} 楼，${segmentedSource.segments.length} 个分片`);
        notifyImageProgress(settings, '正在规划图片');
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
        this.#throwIfCancelled(requestVersion);
        if (!await this.#targetStillCurrentFast(target)) {
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

        const signal = controller.signal;
        let items = [];
        const concurrency = Math.min(plan.length, Math.max(1, Math.floor(Number(settings.image.bizyair.concurrency) || 3)));
        notifyImageDebug(settings, `开始 BizyAir 批量生成：${plan.length} 张，并发=${concurrency}`);
        notifyImageProgress(settings, '正在生成图片');
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
                const generationPrompt = joinPositivePrompt(settings.image.bizyair.positivePromptPrefix, item.prompt);
                const negativePrompt = String(settings.image.bizyair.negativePrompt || '').trim();
                const remoteUrl = await this.client.generate(item.prompt, signal, { label });
                notifyImageDebug(settings, `${label} 获得远程图片 URL`, 'success');
                const previewItem = {
                    ...item,
                    id: slotId,
                    segmentText: segment.text,
                    segmentOccurrence: segment.occurrence,
                    contentWrapped: segmentedSource.contentWrapped,
                    isLastSegment: item.segmentIndex === segmentedSource.segments.length,
                    generationPrompt,
                    negativePrompt,
                    remoteUrl,
                    imageUrl: remoteUrl,
                    createdAt: new Date().toISOString()
                };
                if (await this.#targetStillCurrentFast(target)) {
                    renderImageRecord({ key, messageIndex: row.index, items: [previewItem] });
                    notifyImageDebug(settings, `${label} 已先插入远程图片`, 'success');
                }
                const imageUrl = await cacheImageUrl(remoteUrl, settings.image.cacheAsDataUrl !== false, signal, settings, label);
                notifyImageDebug(settings, `${label} 生成流程完成`, 'success');
                return {
                    ...previewItem,
                    imageUrl,
                    cachedAt: new Date().toISOString()
                };
            } catch (error) {
                notifyImageDebug(settings, `${label} 失败：${error.message || error}`, 'error');
                controller.abort(error);
                throw error;
            }
        }, signal);
        if (!items.length) {
            notifyImageDebug(settings, 'BizyAir 没有返回可保存图片，跳过写入缓存', 'warning');
            return;
        }
        this.#throwIfCancelled(requestVersion);
        if (!await this.#targetStillCurrent(target)) {
            return;
        }

        const createdAt = new Date().toISOString();
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
            createdAt,
            expiresAt: imageCacheExpiresAt(createdAt),
            reason
        };
        await this.storage.setImage(key, record);
        notifyImageDebug(settings, `图片记录已保存：第 ${row.floor} 楼，${items.length} 张`, 'success');
        renderImageRecord(record);
        notifyImageDebug(settings, '图片已插回聊天正文', 'success');
        notifyImageProgress(settings, '完成图像生成', 'success');
        this.updateStats({ lastImageAt: record.createdAt, imageCount: items.length, imageFloor: row.floor });
    }

    async #renderCached({ snapshot, scopeHash, recipe }) {
        const available = new Set(await this.storage.listImageKeys());
        if (!available.size) return 0;
        await this.#pruneExpiredImageCache(available);
        if (!available.size) return 0;
        const records = [];
        for (const floor of snapshot.floors) {
            const key = makeCacheKey({ scopeHash, floor: floor.number, chain: floor.chain, recipe });
            const record = available.has(key)
                ? await this.storage.getImage(key)
                : await this.#getLatestImageForFloorChain({
                    scopeHash,
                    floor: floor.number,
                    chain: floor.chain,
                    availableKeys: available
                });
            if (record) records.push(record);
        }
        records.sort((a, b) => a.messageIndex - b.messageIndex).forEach(renderImageRecord);
        return records.length;
    }
}
