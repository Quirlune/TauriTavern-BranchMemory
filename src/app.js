import {
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    generateRaw,
    setExtensionPrompt
} from '/script.js';
import { ConnectionManagerRequestService } from '/scripts/extensions/shared.js';
import { clampInteger, deepMerge } from './core.js';
import { DEFAULT_SETTINGS } from './defaults.js';
import { BranchMemoryEngine } from './engine.js';
import { StorageGateway, waitForTauriHost } from './storage.js';
import { SettingsUi } from './ui.js';

const INJECTION_KEY = 'TT_BRANCH_MEMORY_V1';
let activeStorage = null;

function normalizeSettings(settings) {
    settings.memory.smallEvery = clampInteger(settings.memory.smallEvery, 1, 100000, 8);
    settings.memory.largeEvery = clampInteger(settings.memory.largeEvery, 1, 100000, 32);
    settings.memory.reserveFloors = clampInteger(settings.memory.reserveFloors, 0, 100000, 4);
    settings.memory.maxCallsPerTurn = clampInteger(settings.memory.maxCallsPerTurn, 0, 20, 2);
    settings.memory.responseLength = clampInteger(settings.memory.responseLength, 32, 32000, 700);
    settings.memory.injection.depth = clampInteger(settings.memory.injection.depth, 0, 100, 4);
    settings.status.contextFloors = clampInteger(settings.status.contextFloors, 1, 1000, 6);
    settings.status.responseLength = clampInteger(settings.status.responseLength, 32, 32000, 350);
    return settings;
}

function applyInjection(text, config) {
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
        INJECTION_KEY,
        text || '',
        positions[config.position] ?? extension_prompt_types.IN_CHAT,
        Number(config.depth) || 0,
        false,
        roles[config.role] ?? extension_prompt_roles.SYSTEM
    );
}

export async function bootstrapExtension() {
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

    const enqueue = (options) => {
        queue = queue
            .then(() => engine.refresh(options))
            .catch((error) => ui.showError(error));
        return queue;
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

    const ui = new SettingsUi({
        settings,
        getConnectionProfiles,
        onSettingsChanged: (_settings, { apply = false } = {}) => {
            normalizeSettings(settings);
            pendingSettingsApply ||= apply;
            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => {
                const shouldApply = pendingSettingsApply;
                pendingSettingsApply = false;
                void storage.saveSettings(settings)
                    .then(() => shouldApply
                        ? enqueue({ generateMemory: false, generateStatus: false, reason: 'settings_changed' })
                        : undefined)
                    .catch(error => ui.showError(error));
            }, 800);
        },
        onRunNow: () => enqueue({ generateMemory: true, generateStatus: true, reason: 'manual' })
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

    ui.mount();
    await storage.saveSettings(settings);

    eventSource.on(event_types.CHAT_CHANGED, () => {
        schedule({ generateMemory: false, generateStatus: false, reason: 'chat_changed' }, 250);
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (_messageId, type) => {
        ui.ensureStatusAtChatEnd();
        if (type === 'first_message') {
            schedule({ generateMemory: false, generateStatus: false, reason: 'first_message' }, 300);
            return;
        }
        schedule({ generateMemory: true, generateStatus: true, reason: 'assistant_output' }, 650);
    });
    eventSource.on(event_types.USER_MESSAGE_RENDERED, () => {
        ui.ensureStatusAtChatEnd();
    });
    eventSource.on(event_types.MESSAGE_SWIPED, () => {
        schedule({ generateMemory: true, generateStatus: true, reason: 'message_swiped' }, 500);
    });
    eventSource.on(event_types.MESSAGE_EDITED, () => {
        schedule({ generateMemory: true, generateStatus: true, reason: 'message_edited' }, 500);
    });
    eventSource.on(event_types.MESSAGE_DELETED, () => {
        schedule({ generateMemory: false, generateStatus: true, reason: 'message_deleted' }, 500);
    });
    eventSource.on(event_types.GENERATION_STARTED, async () => {
        await enqueue({ generateMemory: false, generateStatus: false, reason: 'before_generation' });
    });

    schedule({ generateMemory: false, generateStatus: false, reason: 'startup' }, 100);
    console.info('[BranchMemory] Extension initialized');
}

export async function cleanExtensionData() {
    const host = await waitForTauriHost();
    const storage = activeStorage || new StorageGateway(host);
    await storage.cleanAll();
    setExtensionPrompt(INJECTION_KEY, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
    document.getElementById('ttbm-status-host')?.remove();
    document.getElementById('ttbm-custom-status-style')?.remove();
}
