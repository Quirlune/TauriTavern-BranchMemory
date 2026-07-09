import {
    applyRegexRules,
    boundaries,
    getFloor,
    makeCacheKey,
    processStatusOutput,
    promptEntriesToMessages,
    recipeHash,
    renderTemplate,
    selectActiveMemory,
    statusInjectionTargetFloor,
    statusRecordOutputs,
    summaryContextEndFloor,
    transcriptForFloorRange
} from './core.js';
import { chatIdentity, readFullHistory, scopeHashForRef } from './history.js';

function lastMessage(snapshot, role) {
    for (let index = snapshot.rows.length - 1; index >= 0; index -= 1) {
        if (snapshot.rows[index].role === role) {
            return String(snapshot.rows[index].message?.mes ?? '');
        }
    }
    return '';
}

function latestBefore(records, floor) {
    return [...records]
        .filter(record => record.endFloor < floor)
        .sort((left, right) => right.endFloor - left.endFloor)[0] || null;
}

function formatRecords(records, label) {
    if (!records.length) return '';
    return records
        .sort((left, right) => left.endFloor - right.endFloor)
        .map(record => `[${label} ${record.startFloor}-${record.endFloor}]\n${record.content}`)
        .join('\n\n');
}

async function loadRecords(boundaryList, availableKeys, getter, keyFactory) {
    const output = [];
    const available = new Set(availableKeys || []);
    const queue = boundaryList
        .map(boundary => ({ boundary, key: keyFactory(boundary) }))
        .filter(item => available.has(item.key));
    const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
        while (queue.length) {
            const { key } = queue.shift();
            const record = await getter(key);
            if (record) output.push(record);
        }
    });
    await Promise.all(workers);
    return output;
}

export class BranchMemoryEngine {
    constructor({ storage, getSettings, generate, applyInjection, renderStatus, updateStats }) {
        this.storage = storage;
        this.getSettings = getSettings;
        this.generate = generate;
        this.applyInjection = applyInjection;
        this.renderStatus = renderStatus;
        this.updateStats = updateStats;
        this.lastError = '';
    }

    async refresh({ generateMemory = false, generateStatus = false, reason = 'refresh', generationType = '' } = {}) {
        const settings = this.getSettings();
        if (!settings.enabled) {
            this.applyInjection('memory', '', settings.memory.injection);
            this.applyInjection('status', '', settings.status.injection);
            this.renderStatus('', settings.status);
            return;
        }

        const handle = this.storage.currentHandle();
        const ref = this.storage.currentRef();
        const identity = chatIdentity(ref);
        const scopeHash = scopeHashForRef(ref);
        const snapshot = await readFullHistory(handle);
        const eligibleFloor = Math.max(0, snapshot.totalFloors - settings.memory.reserveFloors);
        const runtime = await this.storage.getChatRuntime(handle) || {};

        const smallRecipe = recipeHash({
            every: settings.memory.smallEvery,
            contextExtraFloors: settings.memory.smallContextExtraFloors,
            responseLength: settings.memory.responseLength,
            api: settings.memory.api,
            inputRegex: settings.memory.inputRegex,
            outputRegex: settings.memory.outputRegex,
            promptEntries: settings.memory.smallPromptEntries
        });
        const largeRecipe = recipeHash({
            every: settings.memory.largeEvery,
            responseLength: settings.memory.responseLength,
            api: settings.memory.api,
            inputRegex: settings.memory.inputRegex,
            outputRegex: settings.memory.outputRegex,
            promptEntries: settings.memory.largePromptEntries,
            smallRecipe
        });

        const smallBoundaries = boundaries(settings.memory.smallEvery, eligibleFloor);
        const largeBoundaries = boundaries(settings.memory.largeEvery, eligibleFloor);
        const smallKey = floor => this.#memoryKey(scopeHash, snapshot, floor, smallRecipe, this.#memoryContextAnchorFloor(snapshot, settings, floor));
        const largeKey = floor => this.#memoryKey(scopeHash, snapshot, floor, largeRecipe, this.#memoryContextAnchorFloor(snapshot, settings, floor));

        const [smallAvailableKeys, largeAvailableKeys] = await Promise.all([
            this.storage.listSmallKeys(),
            this.storage.listLargeKeys()
        ]);
        let smallRecords = await loadRecords(smallBoundaries, smallAvailableKeys, key => this.storage.getSmall(key), smallKey);
        let largeRecords = await loadRecords(largeBoundaries, largeAvailableKeys, key => this.storage.getLarge(key), largeKey);

        if (settings.memory.enabled && generateMemory) {
            const budget = Math.max(0, settings.memory.maxCallsPerTurn);
            let calls = 0;
            const allBoundaries = [...new Set([...smallBoundaries, ...largeBoundaries])].sort((a, b) => a - b);

            for (const floor of allBoundaries) {
                if (calls >= budget) break;

                if (smallBoundaries.includes(floor) && !smallRecords.some(record => record.endFloor === floor)) {
                    const record = await this.#generateSmall({ settings, snapshot, scopeHash, floor, recipe: smallRecipe, largeRecords, identity });
                    if (record) {
                        smallRecords.push(record);
                        calls += 1;
                    }
                }

                if (calls >= budget) break;

                if (largeBoundaries.includes(floor) && !largeRecords.some(record => record.endFloor === floor)) {
                    const record = await this.#generateLarge({ settings, snapshot, scopeHash, floor, recipe: largeRecipe, smallRecords, largeRecords, identity });
                    if (record) {
                        largeRecords.push(record);
                        calls += 1;
                    }
                }
            }
        }

        const active = selectActiveMemory({ largeRecords, smallRecords, eligibleFloor });
        const memoryText = this.#applyMemoryInjection(settings, active);

        let statusRecord = null;
        let statusRecipe = null;
        if (settings.status.enabled) {
            statusRecipe = recipeHash({
                contextFloors: settings.status.contextFloors,
                responseLength: settings.status.responseLength,
                api: settings.status.api,
                inputRegex: settings.status.inputRegex,
                promptEntries: settings.status.promptEntries
            });
            const statusKey = makeCacheKey({
                scopeHash,
                floor: snapshot.totalFloors,
                chain: snapshot.chain,
                recipe: statusRecipe
            });
            statusRecord = await this.storage.getStatus(statusKey);

            if (!statusRecord && generateStatus) {
                statusRecord = await this.#generateStatus({
                    settings,
                    snapshot,
                    scopeHash,
                    recipe: statusRecipe,
                    key: statusKey,
                    memoryText,
                    previousStatus: statusRecordOutputs(runtime.status, settings.status).renderContent,
                    identity
                });
            }
        }

        const effectiveStatus = statusRecord || runtime.status || null;
        const statusOutputs = statusRecordOutputs(effectiveStatus, settings.status);
        const injectionStatus = await this.#statusForInjection({
            settings,
            snapshot,
            scopeHash,
            recipe: statusRecipe,
            effectiveStatus,
            reason,
            generationType
        });
        const injectionStatusOutputs = statusRecordOutputs(injectionStatus, settings.status);
        this.renderStatus(statusOutputs.renderContent, settings.status);
        this.#applyStatusInjection(settings, injectionStatusOutputs.injectionContent);

        if (effectiveStatus) {
            statusRecord = {
                ...effectiveStatus,
                content: statusOutputs.renderContent,
                injectionContent: statusOutputs.injectionContent
            };
            if (statusOutputs.rawContent !== null) {
                statusRecord.version = Math.max(2, Number(effectiveStatus.version) || 1);
                statusRecord.rawContent = statusOutputs.rawContent;
            }
        }

        const runtimeValue = {
            version: 1,
            chatIdentity: identity,
            chain: snapshot.chain,
            totalFloors: snapshot.totalFloors,
            eligibleFloor,
            activeLarge: active.large || null,
            activeSmall: active.small,
            status: statusRecord,
            updatedAt: new Date().toISOString(),
            reason,
            generationType
        };
        await this.storage.setChatRuntime(runtimeValue, handle);
        this.lastError = '';
        this.updateStats({
            ...runtimeValue,
            smallCount: smallRecords.length,
            largeCount: largeRecords.length,
            lastError: ''
        });
    }

    #memoryKey(scopeHash, snapshot, floor, recipe, anchorFloor = floor) {
        const anchor = getFloor(snapshot, anchorFloor);
        if (!anchor) throw new Error(`找不到第 ${anchorFloor} 楼的分支锚点。`);
        return makeCacheKey({ scopeHash, floor, chain: anchor.chain, recipe });
    }

    #memoryContextAnchorFloor(snapshot, settings, floor) {
        return Math.max(floor, summaryContextEndFloor(snapshot.totalFloors, floor, settings.memory?.smallContextExtraFloors));
    }

    #baseValues({ snapshot, startFloor, endFloor, settings, previousLarge = '', smallSummaries = '', memory = '', previousStatus = '', contextEndFloor = endFloor }) {
        const inputRegex = settings.memory?.inputRegex || settings.status?.inputRegex || [];
        const resolvedContextEndFloor = Math.max(endFloor, summaryContextEndFloor(snapshot.totalFloors, endFloor, Math.max(0, Number(contextEndFloor) - endFloor)));
        const hasExtraContext = resolvedContextEndFloor > endFloor;
        const summaryChat = transcriptForFloorRange(snapshot, startFloor, endFloor, inputRegex);
        const contextChat = hasExtraContext
            ? transcriptForFloorRange(snapshot, startFloor, resolvedContextEndFloor, inputRegex)
            : summaryChat;
        const extraChat = hasExtraContext
            ? transcriptForFloorRange(snapshot, endFloor + 1, resolvedContextEndFloor, inputRegex)
            : '';
        return {
            chat: contextChat,
            summary_chat: summaryChat,
            context_chat: contextChat,
            extra_chat: extraChat,
            floor_start: startFloor,
            floor_end: endFloor,
            summary_floor_start: startFloor,
            summary_floor_end: endFloor,
            context_floor_start: startFloor,
            context_floor_end: resolvedContextEndFloor,
            extra_floor_start: hasExtraContext ? endFloor + 1 : '',
            extra_floor_end: hasExtraContext ? resolvedContextEndFloor : '',
            small_extra_floors: Math.max(0, resolvedContextEndFloor - endFloor),
            total_floors: snapshot.totalFloors,
            eligible_floor: Math.max(0, snapshot.totalFloors - (settings.memory?.reserveFloors || 0)),
            previous_large: previousLarge,
            small_summaries: smallSummaries,
            memory,
            previous_status: previousStatus,
            last_user: lastMessage(snapshot, 'user'),
            last_assistant: lastMessage(snapshot, 'assistant')
        };
    }

    async #generateSmall({ settings, snapshot, scopeHash, floor, recipe, largeRecords, identity }) {
        const startFloor = Math.max(1, floor - settings.memory.smallEvery + 1);
        const contextEndFloor = this.#memoryContextAnchorFloor(snapshot, settings, floor);
        const previousLarge = latestBefore(largeRecords, startFloor)?.content || '';
        const values = this.#baseValues({ snapshot, startFloor, endFloor: floor, settings, previousLarge, contextEndFloor });
        const prompt = promptEntriesToMessages(settings.memory.smallPromptEntries, values);
        const content = await this.#runModel(prompt, settings.memory.responseLength, settings.memory.outputRegex, '小总结', settings.memory.api);
        if (!this.#isCurrent(identity)) return null;

        const anchor = getFloor(snapshot, floor);
        const record = {
            version: 1,
            kind: 'small',
            scopeHash,
            recipe,
            startFloor,
            endFloor: floor,
            contextEndFloor,
            contextExtraFloors: Math.max(0, contextEndFloor - floor),
            anchorChain: anchor.chain,
            content,
            createdAt: new Date().toISOString()
        };
        await this.storage.setSmall(this.#memoryKey(scopeHash, snapshot, floor, recipe, contextEndFloor), record);
        return record;
    }

    async #generateLarge({ settings, snapshot, scopeHash, floor, recipe, smallRecords, largeRecords, identity }) {
        const previousLarge = latestBefore(largeRecords, floor);
        const segmentStart = (previousLarge?.endFloor || 0) + 1;
        const contributingSmall = smallRecords.filter(record => record.endFloor >= segmentStart && record.endFloor <= floor);
        const values = this.#baseValues({
            snapshot,
            startFloor: segmentStart,
            endFloor: floor,
            settings,
            previousLarge: previousLarge?.content || '',
            smallSummaries: formatRecords(contributingSmall, '小总结')
        });
        const prompt = promptEntriesToMessages(settings.memory.largePromptEntries, values);
        const content = await this.#runModel(prompt, settings.memory.responseLength, settings.memory.outputRegex, '大总结', settings.memory.api);
        if (!this.#isCurrent(identity)) return null;

        const anchor = getFloor(snapshot, floor);
        const record = {
            version: 1,
            kind: 'large',
            scopeHash,
            recipe,
            startFloor: 1,
            segmentStartFloor: segmentStart,
            endFloor: floor,
            anchorChain: anchor.chain,
            content,
            createdAt: new Date().toISOString()
        };
        await this.storage.setLarge(this.#memoryKey(scopeHash, snapshot, floor, recipe, this.#memoryContextAnchorFloor(snapshot, settings, floor)), record);
        return record;
    }

    async #generateStatus({ settings, snapshot, scopeHash, recipe, key, memoryText, previousStatus, identity }) {
        const startFloor = Math.max(1, snapshot.totalFloors - settings.status.contextFloors + 1);
        const values = {
            ...this.#baseValues({ snapshot, startFloor, endFloor: snapshot.totalFloors, settings: { status: settings.status, memory: settings.memory }, memory: memoryText, previousStatus }),
            chat: transcriptForFloorRange(snapshot, startFloor, snapshot.totalFloors, settings.status.inputRegex)
        };
        const prompt = promptEntriesToMessages(settings.status.promptEntries, values);
        const rawContent = await this.#runModelRaw(prompt, settings.status.responseLength, '状态栏', settings.status.api);
        const outputs = processStatusOutput(rawContent, settings.status.outputRegex, settings.status.injection.outputRegex);
        if (!this.#isCurrent(identity)) return null;

        const record = {
            version: 2,
            kind: 'status',
            scopeHash,
            recipe,
            floor: snapshot.totalFloors,
            anchorChain: snapshot.chain,
            rawContent: outputs.rawContent,
            content: outputs.renderContent,
            injectionContent: outputs.injectionContent,
            createdAt: new Date().toISOString()
        };
        await this.storage.setStatus(key, record);
        return record;
    }

    async #statusForInjection({ settings, snapshot, scopeHash, recipe, effectiveStatus, reason, generationType }) {
        if (!settings.status.enabled || !settings.status.injection.enabled || !recipe) {
            return effectiveStatus;
        }
        const targetFloor = statusInjectionTargetFloor(snapshot, { reason, generationType });
        if (targetFloor === snapshot.totalFloors) {
            return effectiveStatus;
        }
        if (Number(effectiveStatus?.floor) === targetFloor && effectiveStatus?.recipe === recipe) {
            return effectiveStatus;
        }
        const anchor = getFloor(snapshot, targetFloor);
        if (!anchor) {
            return null;
        }
        const key = makeCacheKey({
            scopeHash,
            floor: targetFloor,
            chain: anchor.chain,
            recipe
        });
        return this.storage.getStatus(key);
    }

    async #runModel(prompt, responseLength, outputRegex, label, apiConfig) {
        const raw = await this.#runModelRaw(prompt, responseLength, label, apiConfig);
        const content = applyRegexRules(raw, outputRegex).trim();
        if (!content) {
            throw new Error(`${label}经过输出正则处理后为空。`);
        }
        return content;
    }

    async #runModelRaw(prompt, responseLength, label, apiConfig) {
        if (!prompt.length) {
            throw new Error(`${label}没有启用的提示词条目。`);
        }
        const raw = await this.generate({ prompt, responseLength, apiConfig });
        const content = String(raw ?? '').trim();
        if (!content) {
            throw new Error(`${label}模型输出为空。`);
        }
        return content;
    }

    #applyMemoryInjection(settings, active) {
        if (!settings.memory.enabled || !settings.memory.injection.enabled) {
            this.applyInjection('memory', '', settings.memory.injection);
            return '';
        }
        const largeMemory = active.large ? `[累计大总结 · 至第 ${active.large.endFloor} 楼]\n${active.large.content}` : '';
        const smallMemory = formatRecords(active.small, '阶段小总结');
        const text = renderTemplate(settings.memory.injection.template, {
            large_memory: largeMemory,
            small_memory: smallMemory,
            memory: [largeMemory, smallMemory].filter(Boolean).join('\n\n')
        }).trim();
        this.applyInjection('memory', text, settings.memory.injection);
        return text;
    }

    #applyStatusInjection(settings, statusContent) {
        if (!settings.status.enabled || !settings.status.injection.enabled || !statusContent) {
            this.applyInjection('status', '', settings.status.injection);
            return '';
        }
        const text = renderTemplate(settings.status.injection.template, { status: statusContent }).trim();
        this.applyInjection('status', text, settings.status.injection);
        return text;
    }

    #isCurrent(identity) {
        try {
            return chatIdentity(this.storage.currentRef()) === identity;
        } catch {
            return false;
        }
    }
}
