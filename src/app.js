import {
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    generateRaw,
    setExtensionPrompt
} from '/script.js';
import { ConnectionManagerRequestService } from '/scripts/extensions/shared.js';
import { AssistantGenerationGate, clampInteger, deepMerge, promptEntriesUseMacros } from './core.js';
import { DEFAULT_SETTINGS } from './defaults.js';
import { BranchMemoryEngine } from './engine.js';
import { characterPromptInfo, clearHistoryCache } from './history.js';
import { ImagePipeline } from './images.js';
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
let activeStorage = null;
let activeMonitor = null;
let activeImagePipeline = null;

function normalizeSettings(settings) {
    settings.memory.smallEvery = clampInteger(settings.memory.smallEvery, 1, 100000, 8);
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
    settings.image.maxImagesPerMessage = clampInteger(settings.image.maxImagesPerMessage, 1, 3, 3);
    settings.image.debugNotifications = Boolean(settings.image.debugNotifications);
    settings.image.bizyair.webAppId = clampInteger(settings.image.bizyair.webAppId, 1, 1000000, 48570);
    settings.image.bizyair.width = clampInteger(settings.image.bizyair.width, 64, 4096, 1024);
    settings.image.bizyair.height = clampInteger(settings.image.bizyair.height, 64, 4096, 1024);
    settings.image.bizyair.steps = clampInteger(settings.image.bizyair.steps, 1, 200, 10);
    settings.image.bizyair.seed = clampInteger(settings.image.bizyair.seed, 1, Number.MAX_SAFE_INTEGER, 101);
    settings.image.bizyair.pollIntervalMs = clampInteger(settings.image.bizyair.pollIntervalMs, 500, 30000, 1000);
    settings.image.bizyair.maxPolls = clampInteger(settings.image.bizyair.maxPolls, 1, 300, 60);
    settings.image.bizyair.concurrency = clampInteger(settings.image.bizyair.concurrency, 1, 8, 3);
    settings.image.bizyair.templateLibrary.items ||= [];
    if (!settings.image.bizyair.templateLibrary.items.length) {
        settings.image.bizyair.templateLibrary.activeId = '';
    } else if (!settings.image.bizyair.templateLibrary.items.some(item => item.id === settings.image.bizyair.templateLibrary.activeId)) {
        settings.image.bizyair.templateLibrary.activeId = settings.image.bizyair.templateLibrary.items[0].id;
    }
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
    activeMonitor?.stop();
    activeImagePipeline?.cancel();
    clearHistoryCache();
    const host = await waitForTauriHost();
    const storage = new StorageGateway(host);
    activeStorage = storage;
    const saved = await storage.loadSettings();
    const settings = normalizeSettings(deepMerge(DEFAULT_SETTINGS, saved || {}));

    let saveTimer = null;
    let pendingSettingsApply = false;
    let refreshTimer = null;
    let pendingRefresh = { generateMemory: false, generateStatus: false, reason: 'scheduled' };
    let queue = Promise.resolve();
    let engine;
    let imagePipeline;
    let ui;
    const generationGate = new AssistantGenerationGate();
    let generationResetTimer = null;
    const imageGenerationTimers = new Set();
    let imageGenerationCancelVersion = 0;
    let generationRendered = false;
    let generationEnded = false;
    let imageGenerationScheduledForTurn = false;
    const monitor = new RequestMonitor({
        eventSource,
        eventTypes: event_types,
        onChange: state => ui?.updateMonitor(state)
    });
    activeMonitor = monitor;

    const enqueue = (options) => {
        queue = queue
            .then(() => engine.refresh(options))
            .catch((error) => ui.showError(error));
        return queue;
    };

    const enqueueImages = (options) => {
        if (!imagePipeline) return Promise.resolve();
        return imagePipeline.enqueue(options);
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

    const resetGenerationGateSoon = (delay = 1800) => {
        clearTimeout(generationResetTimer);
        generationResetTimer = setTimeout(() => {
            generationGate.reset();
        }, delay);
    };

    const schedule = (options, delay = 500) => {
        pendingRefresh.generateMemory ||= Boolean(options.generateMemory);
        pendingRefresh.generateStatus ||= Boolean(options.generateStatus);
        pendingRefresh.reason = options.reason || pendingRefresh.reason;
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            const task = pendingRefresh;
            pendingRefresh = { generateMemory: false, generateStatus: false, reason: 'scheduled' };
            void enqueue(task);
        }, delay);
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
        onRunNow: () => {
            return enqueue({ generateMemory: true, generateStatus: true, reason: 'manual' })
                .then(() => enqueueImages({ generate: true, reason: 'manual' }));
        }
    });

    engine = new BranchMemoryEngine({
        storage,
        getSettings: () => settings,
        generate: async ({ prompt, responseLength, apiConfig }) => {
            if (apiConfig?.mode === 'connection_profile') {
                const profileId = String(apiConfig.connectionProfileId || '').trim();
                if (!profileId) {
                    throw new Error('已选择独立 API，但尚未选择 Connection Manager 配置。');
                }
                const response = await ConnectionManagerRequestService.sendRequest(
                    profileId,
                    prompt,
                    responseLength,
                    {
                        stream: false,
                        extractData: true,
                        includePreset: apiConfig.includePreset !== false,
                        includeInstruct: false
                    }
                );
                return response?.content || '';
            }
            return generateRaw({ prompt, responseLength, trimNames: false });
        },
        applyInjection,
        renderStatus: (content, statusSettings) => ui.renderStatus(content, statusSettings),
        updateStats: stats => ui.updateStats(stats)
    });

    imagePipeline = new ImagePipeline({
        storage,
        getSettings: () => settings,
        generate: async ({ prompt, responseLength, apiConfig }) => {
            if (apiConfig?.mode === 'connection_profile') {
                const profileId = String(apiConfig.connectionProfileId || '').trim();
                if (!profileId) {
                    throw new Error('图片规划已选择独立 API，但尚未选择 Connection Manager 配置。');
                }
                const response = await ConnectionManagerRequestService.sendRequest(
                    profileId,
                    prompt,
                    responseLength,
                    {
                        stream: false,
                        extractData: true,
                        includePreset: apiConfig.includePreset !== false,
                        includeInstruct: false
                    }
                );
                return response?.content || '';
            }
            return generateRaw({ prompt, responseLength, trimNames: false });
        },
        onError: error => ui.showError(error),
        updateStats: stats => ui.updateStats(stats)
    });
    activeImagePipeline = imagePipeline;

    ui.mount();
    await storage.saveSettings(settings);

    eventSource.on(event_types.CHAT_CHANGED, () => {
        clearHistoryCache();
        cancelPendingImageGeneration();
        imagePipeline?.cancel();
        schedule({ generateMemory: false, generateStatus: false, reason: 'chat_changed' }, 250);
        void enqueueImages({ generate: false, reason: 'chat_changed' });
    });
    if (event_types.MORE_MESSAGES_LOADED) {
        eventSource.on(event_types.MORE_MESSAGES_LOADED, () => {
            void enqueueImages({ generate: false, reason: 'more_messages_loaded' });
        });
    }
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, (type, _options, dryRun) => {
        if (generationGate.afterCommands(type, dryRun)) clearTimeout(generationResetTimer);
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (_messageId, type) => {
        ui.ensureStatusPosition();
        if (type === 'first_message') {
            schedule({ generateMemory: false, generateStatus: false, reason: 'first_message' }, 300);
            return;
        }
        if (!generationGate.shouldTrigger(type)) {
            return;
        }
        generationRendered = true;
        schedule({ generateMemory: true, generateStatus: true, reason: 'assistant_output' }, 650);
        if (generationEnded || !event_types.GENERATION_ENDED) {
            scheduleAssistantImageGenerationOnce();
        }
        resetGenerationGateSoon();
    });
    eventSource.on(event_types.USER_MESSAGE_RENDERED, () => {
        ui.ensureStatusPosition();
    });
    eventSource.on(event_types.MESSAGE_SWIPED, () => {
        clearHistoryCache(storage.currentHandle());
        ui.ensureStatusPosition();
        cancelPendingImageGeneration();
        imagePipeline?.cancel();
        imagePipeline?.clearRendered();
        generationGate.reset();
        clearTimeout(generationResetTimer);
        schedule({ generateMemory: true, generateStatus: true, reason: 'message_swiped' }, 500);
    });
    eventSource.on(event_types.MESSAGE_EDITED, () => {
        clearHistoryCache(storage.currentHandle());
        ui.ensureStatusPosition();
        schedule({ generateMemory: true, generateStatus: false, reason: 'message_edited' }, 500);
    });
    eventSource.on(event_types.MESSAGE_DELETED, () => {
        clearHistoryCache(storage.currentHandle());
        ui.ensureStatusPosition();
        schedule({ generateMemory: false, generateStatus: false, reason: 'message_deleted' }, 500);
    });
    eventSource.on(event_types.GENERATION_STARTED, async (type, _options, dryRun) => {
        generationRendered = false;
        generationEnded = false;
        imageGenerationScheduledForTurn = false;
        if (!generationGate.start(type, dryRun)) {
            return;
        }
        await enqueue({ generateMemory: false, generateStatus: false, reason: 'before_generation' });
    });
    if (event_types.GENERATION_ENDED) {
        eventSource.on(event_types.GENERATION_ENDED, () => {
            generationEnded = true;
            if (generationRendered) {
                scheduleAssistantImageGenerationOnce();
                generationGate.reset();
                clearTimeout(generationResetTimer);
                return;
            }
            resetGenerationGateSoon(3000);
        });
    }
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        if (!generationEnded) {
            cancelPendingImageGeneration();
            imagePipeline?.cancel();
            imageGenerationScheduledForTurn = false;
        }
        generationGate.reset();
        clearTimeout(generationResetTimer);
    });

    schedule({ generateMemory: false, generateStatus: false, reason: 'startup' }, 100);
    void enqueueImages({ generate: false, reason: 'startup' });
    console.info('[BranchMemory] Extension initialized');
}

export async function cleanExtensionData() {
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
    document.documentElement.classList.remove('ttbm-image-viewer-open');
    document.body.classList.remove('ttbm-image-viewer-open');
    document.querySelectorAll('[data-ttbm-image-slot]').forEach(node => node.remove());
}
