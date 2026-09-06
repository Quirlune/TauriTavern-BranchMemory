import {
    chat,
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    generateRaw,
    saveChatConditional,
    setExtensionPrompt,
    syncMesToSwipe,
    updateMessageBlock
} from '/script.js';
import { ConnectionManagerRequestService } from '/scripts/extensions/shared.js';
import { clampInteger, deepMerge, promptEntriesUseMacros } from './core.js';
import { DEFAULT_SETTINGS, migrateRunPodEndpointId } from './defaults.js';
import { BranchMemoryEngine } from './engine.js';
import { characterPromptInfo, clearHistoryCache } from './history.js';
import { ImagePipeline } from './images.js';
import { ModelClient } from './model-client.js';
import { PromptController } from './prompt-control.js';
import { RequestMonitor } from './monitor.js';
import { StorageGateway, waitForTauriHost } from './storage.js';
import { SettingsUi } from './ui.js';

const INJECTION_KEYS = {
    memory: 'TT_BRANCH_MEMORY_V1',
    status: 'TT_BRANCH_STATUS_V1'
};
const IMAGE_FAST_TRIGGER_DELAY_MS = 120;
const IMAGE_STATUS_TRIGGER_DELAY_MS = 720;
const IMAGE_STATUS_MACROS = ['status', 'previous_status', 'status_raw', 'status_injection'];
let activeCleanup = null;
let activeStorage = null;
let activeMonitor = null;
let activeImagePipeline = null;

function normalizeSettings(settings) {
    if (Number(settings.version) < 2) {
        const legacy = settings.image?.bizyair;
        const runpod = settings.image?.runpod;
        if (legacy && runpod) {
            if (!runpod.positivePromptPrefix && legacy.positivePromptPrefix) {
                runpod.positivePromptPrefix = String(legacy.positivePromptPrefix);
            }
            for (const key of ['width', 'height', 'seed']) {
                if (Number.isFinite(Number(legacy[key]))) runpod[key] = Number(legacy[key]);
            }
            if (typeof legacy.randomSeed === 'boolean') runpod.randomSeed = legacy.randomSeed;
        }
        const plannerSystemEntry = settings.image?.promptEntries?.find(entry => entry?.enabled !== false && entry?.role === 'system');
        if (plannerSystemEntry && !String(plannerSystemEntry.content || '').includes('stop_image_generation')) {
            plannerSystemEntry.content = `${String(plannerSystemEntry.content || '').trim()}\n如果正文明显是报错、拒答、占位符或其它无意义内容，只输出 <stop_image_generation>原因</stop_image_generation>。`;
        }
        delete settings.image.bizyair;
        settings.version = 2;
    }
    settings.memory.smallEvery = clampInteger(settings.memory.smallEvery, 1, 100000, 8);
    settings.memory.smallContextExtraFloors = clampInteger(settings.memory.smallContextExtraFloors, 0, 100000, 0);
    settings.memory.largeEvery = clampInteger(settings.memory.largeEvery, 1, 100000, 32);
    settings.memory.reserveFloors = clampInteger(settings.memory.reserveFloors, 0, 100000, 4);
    settings.memory.maxCallsPerTurn = clampInteger(settings.memory.maxCallsPerTurn, 0, 20, 2);
    settings.memory.responseLength = clampInteger(settings.memory.responseLength, 32, 32000, 700);
    settings.memory.injection.depth = clampInteger(settings.memory.injection.depth, 0, 100, 4);
    settings.status.contextFloors = clampInteger(settings.status.contextFloors, 1, 1000, 6);
    settings.status.responseLength = clampInteger(settings.status.responseLength, 32, 32000, 350);
    settings.status.renderDepth = clampInteger(settings.status.renderDepth, 0, 100000, 0);
    settings.status.injection.depth = clampInteger(settings.status.injection.depth, 0, 100, 4);
    settings.image.contextFloors = clampInteger(settings.image.contextFloors, 1, 1000, 2);
    settings.image.responseLength = clampInteger(settings.image.responseLength, 32, 32000, 900);
    settings.image.maxImagesPerMessage = clampInteger(settings.image.maxImagesPerMessage, 1, 12, 3);
    settings.image.paused = Boolean(settings.image.paused);
    settings.image.debugNotifications = Boolean(settings.image.debugNotifications);
    settings.image.cacheAsDataUrl = true;
    settings.image.runpod.width = Math.round(clampInteger(settings.image.runpod.width, 512, 1536, 1024) / 64) * 64;
    settings.image.runpod.height = Math.round(clampInteger(settings.image.runpod.height, 512, 1536, 1280) / 64) * 64;
    settings.image.runpod.seed = clampInteger(settings.image.runpod.seed, 0, Number.MAX_SAFE_INTEGER, 101);
    settings.image.runpod.pollIntervalMs = clampInteger(settings.image.runpod.pollIntervalMs, 500, 30000, 1000);
    settings.image.runpod.maxPolls = clampInteger(settings.image.runpod.maxPolls, 1, 1800, 300);
    settings.image.runpod.apiBase = String(settings.image.runpod.apiBase || 'https://api.runpod.ai/v2').replace(/\/+$/, '');
    settings.image.runpod.endpointId = migrateRunPodEndpointId(settings.image.runpod.endpointId);
    return settings;
}

function applyInjection(channel, text, config) {
    const positions = {
        in_chat: extension_prompt_types.IN_CHAT,
        in_prompt: extension_prompt_types.IN_PROMPT,
        before_prompt: extension_prompt_types.BEFORE_PROMPT
    };
    const roles = {
        system: extension_prompt_roles.SYSTEM,
        user: extension_prompt_roles.USER,
        assistant: extension_prompt_roles.ASSISTANT
    };
    setExtensionPrompt(
        INJECTION_KEYS[channel],
        text || '',
        positions[config.position] ?? extension_prompt_types.IN_CHAT,
        Number(config.depth) || 0,
        false,
        roles[config.role] ?? extension_prompt_roles.SYSTEM
    );
}

function imagePromptNeedsFreshStatus(settings) {
    return settings.status?.enabled !== false
        && promptEntriesUseMacros(settings.image?.promptEntries, IMAGE_STATUS_MACROS);
}

export async function bootstrapExtension() {
    activeCleanup?.();
    activeMonitor?.stop();
    activeImagePipeline?.cancel();
    clearHistoryCache();
    const host = await waitForTauriHost();
    const storage = new StorageGateway(host, { getLiveMessages: () => chat });
    activeStorage = storage;
    const saved = await storage.loadSettings();
    const settings = normalizeSettings(deepMerge(DEFAULT_SETTINGS, saved || {}));
    let lastAppliedSettings = JSON.stringify(settings);

    let saveTimer = null;
    let pendingSettingsApply = false;
    let refreshTimer = null;
    let pendingRefresh = { generateMemory: false, generateStatus: false, reason: 'scheduled', generationType: '' };
    let queue = Promise.resolve();
    let engine;
    let imagePipeline;
    let ui;
    let workVersion = 0;
    let turn = null;
    const imageGenerationTimers = new Set();
    let imageGenerationCancelVersion = 0;
    let imageGenerationScheduledForTurn = false;
    const monitor = new RequestMonitor({
        eventSource,
        eventTypes: event_types,
        onChange: state => ui?.updateMonitor(state)
    });
    activeMonitor = monitor;
    const modelClient = new ModelClient({ generateRaw, connectionService: ConnectionManagerRequestService, getSettings: () => settings, monitor });
    const promptController = new PromptController({ eventSource, eventTypes: event_types, getSettings: () => settings,
        onTransform: details => monitor.record('prompt', 'prompt_control', details) });
    promptController.start();

    const enqueue = (options) => {
        const version = workVersion;
        queue = queue
            .then(() => version === workVersion ? engine.refresh(options) : undefined)
            .catch((error) => { if (error?.name !== 'AbortError') ui.showError(error); });
        return queue;
    };

    const enqueueImages = (options) => {
        if (!imagePipeline) return Promise.resolve();
        return imagePipeline.enqueue(options);
    };

    const scheduleCachedImageRender = (reason, delay = 450) => {
        const timer = setTimeout(() => {
            imageGenerationTimers.delete(timer);
            void enqueueImages({ generate: false, reason });
        }, delay);
        imageGenerationTimers.add(timer);
    };

    const cancelPendingImageGeneration = () => {
        imageGenerationCancelVersion += 1;
        for (const timer of imageGenerationTimers) clearTimeout(timer);
        imageGenerationTimers.clear();
    };

    const scheduleImageGeneration = ({ reason, delay = 900, waitForEngine = true } = {}) => {
        cancelPendingImageGeneration();
        const cancelVersion = imageGenerationCancelVersion;
        const timer = setTimeout(() => {
            imageGenerationTimers.delete(timer);
            const ready = waitForEngine ? queue : Promise.resolve();
            void ready
                .then(() => {
                    if (cancelVersion !== imageGenerationCancelVersion) return undefined;
                    return enqueueImages({ generate: true, reason });
                })
                .catch(error => ui.showError(error));
        }, delay);
        imageGenerationTimers.add(timer);
    };

    const scheduleAssistantImageGenerationOnce = () => {
        if (imageGenerationScheduledForTurn) return;
        imageGenerationScheduledForTurn = true;
        const needsFreshStatus = imagePromptNeedsFreshStatus(settings);
        scheduleImageGeneration({
            reason: 'assistant_output',
            delay: needsFreshStatus ? IMAGE_STATUS_TRIGGER_DELAY_MS : IMAGE_FAST_TRIGGER_DELAY_MS,
            waitForEngine: needsFreshStatus
        });
    };

    const schedule = (options, delay = 500) => {
        pendingRefresh = { ...options };
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            const task = pendingRefresh;
            pendingRefresh = {};
            void enqueue(task);
        }, delay);
    };

    const invalidateWork = () => {
        workVersion += 1;
        engine?.invalidate();
        modelClient.cancel();
        clearTimeout(refreshTimer);
        pendingRefresh = {};
        cancelPendingImageGeneration();
        imagePipeline?.cancel();
    };

    const getConnectionProfiles = () => {
        try {
            return ConnectionManagerRequestService.getSupportedProfiles()
                .filter(profile => ConnectionManagerRequestService.validateProfile(profile).selected === 'openai')
                .map(profile => ({
                    id: profile.id,
                    name: profile.name || profile.model || profile.id,
                    api: profile.api || '',
                    model: profile.model || ''
                }));
        } catch {
            return [];
        }
    };

    ui = new SettingsUi({
        settings,
        monitor,
        getConnectionProfiles,
        getCurrentCharacterInfo: () => characterPromptInfo(storage.currentRef()),
        onSettingsChanged: (_settings, { apply = false } = {}) => {
            normalizeSettings(settings);
            if (apply && lastAppliedSettings !== JSON.stringify(settings)) {
                lastAppliedSettings = JSON.stringify(settings);
                invalidateWork();
            }
            pendingSettingsApply ||= apply;
            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => {
                const shouldApply = pendingSettingsApply;
                pendingSettingsApply = false;
                void storage.saveSettings(settings)
                    .then(() => {
                        if (!shouldApply) return undefined;
                        void enqueueImages({ generate: false, reason: 'settings_changed' });
                        return enqueue({ generateMemory: false, generateStatus: false, reason: 'settings_changed' });
                    })
                    .catch(error => ui.showError(error));
            }, 800);
        },
        onImageGenerationToggle: (paused) => {
            if (!paused) return;
            cancelPendingImageGeneration();
            imagePipeline?.cancel();
        },
        onRegenerateLatestImage: () => {
            cancelPendingImageGeneration();
            return enqueueImages({ regenerate: true, reason: 'manual' });
        },
        onRunNow: () => {
            if (turn?.accepted && !turn.ended) {
                ui.showError(new Error('请等待当前正文生成结束后再同步，避免读取尚未完成的楼层。'));
                return Promise.resolve();
            }
            return enqueue({ generateMemory: true, generateStatus: true, reason: 'manual' })
                .then(() => enqueueImages({ generate: true, reason: 'manual' }));
        }
    });

    engine = new BranchMemoryEngine({
        storage,
        getSettings: () => settings,
        generate: request => modelClient.generate(request),
        applyInjection,
        renderStatus: (content, statusSettings) => ui.renderStatus(content, statusSettings),
        updateStats: stats => ui.updateStats(stats)
    });

    imagePipeline = new ImagePipeline({
        storage,
        getSettings: () => settings,
        persistMessageText: async ({ absoluteIndex, expectedText, text, expectedDisplayText = null, displayText = null }) => {
            const windowInfo = await storage.currentWindowInfo();
            const localIndex = Number(absoluteIndex) - Number(windowInfo?.windowStartIndex || 0);
            const message = chat[localIndex];
            if (!message || localIndex < 0) {
                throw new Error('图片锚点目标已不在当前聊天窗口中。');
            }
            if (String(message.mes || '') !== String(expectedText || '')) {
                throw new Error('写入图片锚点前消息已变化，已停止保存，避免锚点写入错误消息。');
            }
            const usesDisplayText = typeof expectedDisplayText === 'string' || typeof displayText === 'string';
            if (usesDisplayText && String(message.extra?.display_text ?? '') !== String(expectedDisplayText ?? '')) {
                throw new Error('写入图片锚点前显示文本已变化，已停止保存，避免正则处理错误内容。');
            }
            const previousText = message.mes;
            const previousDisplayText = message.extra?.display_text;
            message.mes = String(text || '');
            if (usesDisplayText) {
                message.extra ||= {};
                message.extra.display_text = String(displayText ?? '');
            }
            // Persist the XML marker in the active swipe as well as `mes` so
            // switching away and back cannot resurrect an unanchored copy.
            syncMesToSwipe(localIndex);
            updateMessageBlock(localIndex, message);
            try {
                await saveChatConditional();
            } catch (error) {
                message.mes = previousText;
                if (usesDisplayText) message.extra.display_text = previousDisplayText;
                syncMesToSwipe(localIndex);
                updateMessageBlock(localIndex, message);
                throw error;
            }
            return { renderMessageIndex: localIndex };
        },
        generate: request => modelClient.generate({ ...request, scope: 'image', label: '图片规划' }),
        onError: error => ui.showError(error),
        updateStats: stats => ui.updateStats(stats)
    });
    activeImagePipeline = imagePipeline;

    ui.mount();
    await storage.saveSettings(settings);

    const listeners = [];
    const on = (name, handler) => {
        const event = event_types[name];
        if (!event) return;
        eventSource.on(event, handler);
        listeners.push({ event, handler });
    };
    const completeTurn = () => {
        if (!turn?.accepted || !turn.rendered || !turn.ended || turn.scheduled) return;
        turn.scheduled = true;
        clearHistoryCache(storage.currentHandle());
        schedule({ generateMemory: true, generateStatus: true, reason: 'assistant_output',
            generationType: turn.type, forceStatus: turn.type === 'regenerate' }, 50);
        scheduleAssistantImageGenerationOnce();
    };
    on('CHAT_CHANGED', () => {
        turn = null;
        invalidateWork();
        clearHistoryCache();
        ui.renderStatus('', settings.status);
        applyInjection('status', '', settings.status.injection);
        applyInjection('memory', '', settings.memory.injection);
        imagePipeline?.clearRendered();
        schedule({ reason: 'chat_changed' }, 250);
        void enqueueImages({ generate: false, reason: 'chat_changed' });
    });
    on('MORE_MESSAGES_LOADED', () => { void enqueueImages({ generate: false, reason: 'more_messages_loaded' }); });
    on('GENERATION_STARTED', async (type, _options, dryRun) => {
        if (dryRun || ['quiet', 'impersonate'].includes(type)) return;
        invalidateWork();
        clearHistoryCache(storage.currentHandle());
        // Never leave the replaced reply's injection installed if reading the
        // current history/cache fails while preparing a new body request.
        applyInjection('status', '', settings.status.injection);
        applyInjection('memory', '', settings.memory.injection);
        turn = { type: type || 'normal', accepted: false, rendered: false, ended: false, scheduled: false };
        imageGenerationScheduledForTurn = false;
        // This read-only refresh must not wait behind an obsolete model request.
        try { await engine.refresh({ reason: 'before_generation', generationType: turn.type }); }
        catch (error) { ui.showError(error); }
    });
    on('GENERATION_AFTER_COMMANDS', (type, _options, dryRun) => {
        if (dryRun || ['quiet', 'impersonate'].includes(type)) return;
        if (turn) turn.accepted = true;
    });
    on('CHARACTER_MESSAGE_RENDERED', (_messageId, type) => {
        ui.ensureStatusPosition();
        if (type === 'first_message') { schedule({ reason: 'first_message' }, 300); return; }
        if (!turn?.accepted || ['quiet', 'impersonate'].includes(type)) return;
        turn.rendered = true;
        if (!event_types.GENERATION_ENDED) turn.ended = true;
        completeTurn();
    });
    on('USER_MESSAGE_RENDERED', () => { ui.ensureStatusPosition(); });
    on('MESSAGE_SWIPED', () => {
        turn = null;
        invalidateWork();
        clearHistoryCache(storage.currentHandle());
        ui.renderStatus('', settings.status);
        applyInjection('status', '', settings.status.injection);
        imagePipeline?.clearRendered();
        schedule({ reason: 'message_swiped' });
        scheduleCachedImageRender('message_swiped');
    });
    on('MESSAGE_EDITED', () => {
        turn = null;
        invalidateWork();
        clearHistoryCache(storage.currentHandle());
        ui.renderStatus('', settings.status);
        imagePipeline?.clearRendered();
        scheduleCachedImageRender('message_edited');
        schedule({ generateMemory: true, reason: 'message_edited' });
    });
    on('MESSAGE_DELETED', () => {
        clearHistoryCache(storage.currentHandle());
        // Regenerate deletes the old reply after GENERATION_STARTED. Keep its
        // prepared previous-floor injection until the new reply has completed.
        if (turn?.accepted && turn.type === 'regenerate' && !turn.ended) return;
        turn = null;
        invalidateWork();
        ui.renderStatus('', settings.status);
        imagePipeline?.clearRendered();
        schedule({ reason: 'message_deleted' });
    });
    on('GENERATION_ENDED', () => {
        if (!turn?.accepted) return;
        turn.ended = true;
        completeTurn();
    });
    on('GENERATION_STOPPED', () => {
        turn = null;
        invalidateWork();
        schedule({ reason: 'generation_stopped' });
    });
    activeCleanup = () => {
        invalidateWork();
        clearTimeout(saveTimer);
        promptController.stop();
        for (const { event, handler } of listeners) eventSource.removeListener(event, handler);
    };

    schedule({ generateMemory: false, generateStatus: false, reason: 'startup' }, 100);
    void enqueueImages({ generate: false, reason: 'startup' });
    console.info('[BranchMemory] Extension initialized');
}

export async function cleanExtensionData() {
    activeCleanup?.();
    activeCleanup = null;
    activeMonitor?.stop();
    activeMonitor = null;
    activeImagePipeline?.cancel();
    activeImagePipeline = null;
    clearHistoryCache();
    const host = await waitForTauriHost();
    const storage = activeStorage || new StorageGateway(host);
    await storage.cleanAll();
    for (const key of Object.values(INJECTION_KEYS)) {
        setExtensionPrompt(key, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
    }
    document.getElementById('ttbm-status-host')?.remove();
    document.getElementById('ttbm-custom-status-style')?.remove();
    document.getElementById('ttbm-image-viewer')?.remove();
    document.getElementById('ttbm-image-wand-container')?.remove();
    document.documentElement.classList.remove('ttbm-image-viewer-open');
    document.body.classList.remove('ttbm-image-viewer-open');
    document.querySelectorAll('[data-ttbm-image-slot]').forEach(node => node.remove());
}
