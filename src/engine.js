import {
    applyRegexRules,
    boundaries,
    getFloor,
    makeCacheKey,
    promptEntriesToMessages,
    recipeHash,
    renderTemplate,
    selectActiveMemory,
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

    async refresh({ generateMemory = false, generateStatus = false, reason = 'refresh' } = {}) {
        const settings = this.getSettings();
        if (!settings.enabled) {
            this.applyInjection('', settings.memory.injection);
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
            responseLength: settings.memory.responseLength,
            inputRegex: settings.memory.inputRegex,
            outputRegex: settings.memory.outputRegex,
            promptEntries: settings.memory.smallPromptEntries
        });
        const largeRecipe = recipeHash({
            every: settings.memory.largeEvery,
            responseLength: settings.memory.responseLength,
            inputRegex: settings.memory.inputRegex,
            outputRegex: settings.memory.outputRegex,
            promptEntries: settings.memory.largePromptEntries,
            smallRecipe
        });

        const smallBoundaries = boundaries(settings.memory.smallEvery, eligibleFloor);
        const largeBoundaries = boundaries(settings.memory.largeEvery, eligibleFloor);
        const smallKey = floor => this.#memoryKey(scopeHash, snapshot, floor, smallRecipe);
        const largeKey = floor => this.#memoryKey(scopeHash, snapshot, floor, largeRecipe);

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
        if (settings.status.enabled) {
            const statusRecipe = recipeHash({
                contextFloors: settings.status.contextFloors,
                responseLength: settings.status.responseLength,
                inputRegex: settings.status.inputRegex,
                outputRegex: settings.status.outputRegex,
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
                    previousStatus: runtime.status?.content || '',
                    identity
                });
            }
        }

        this.renderStatus(statusRecord?.content || runtime.status?.content || '', settings.status);

        const runtimeValue = {
            version: 1,
            chatIdentity: identity,
            chain: snapshot.chain,
            totalFloors: snapshot.totalFloors,
            eligibleFloor,
            activeLarge: active.large || null,
            activeSmall: active.small,
            status: statusRecord || runtime.status || null,
            updatedAt: new Date().toISOString(),
            reason
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

    #memoryKey(scopeHash, snapshot, floor, recipe) {
        const anchor = getFloor(snapshot, floor);
        if (!anchor) throw new Error(`找不到第 ${floor} 楼的分支锚点。`);
        return makeCacheKey({ scopeHash, floor, chain: anchor.chain, recipe });
    }

    #baseValues({ snapshot, startFloor, endFloor, settings, previousLarge = '', smallSummaries = '', memory = '', previousStatus = '' }) {
        return {
            chat: transcriptForFloorRange(snapshot, startFloor, endFloor, settings.memory?.inputRegex || settings.status?.inputRegex || []),
            floor_start: startFloor,
            floor_end: endFloor,
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
        const previousLarge = latestBefore(largeRecords, startFloor)?.content || '';
        const values = this.#baseValues({ snapshot, startFloor, endFloor: floor, settings, previousLarge });
        const prompt = promptEntriesToMessages(settings.memory.smallPromptEntries, values);
        const content = await this.#runModel(prompt, settings.memory.responseLength, settings.memory.outputRegex, '小总结');
        if (!this.#isCurrent(identity)) return null;

        const anchor = getFloor(snapshot, floor);
        const record = {
            version: 1,
            kind: 'small',
            scopeHash,
            recipe,
            startFloor,
            endFloor: floor,
            anchorChain: anchor.chain,
            content,
            createdAt: new Date().toISOString()
        };
        await this.storage.setSmall(this.#memoryKey(scopeHash, snapshot, floor, recipe), record);
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
        const content = await this.#runModel(prompt, settings.memory.responseLength, settings.memory.outputRegex, '大总结');
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
        await this.storage.setLarge(this.#memoryKey(scopeHash, snapshot, floor, recipe), record);
        return record;
    }

    async #generateStatus({ settings, snapshot, scopeHash, recipe, key, memoryText, previousStatus, identity }) {
        const startFloor = Math.max(1, snapshot.totalFloors - settings.status.contextFloors + 1);
        const values = {
            ...this.#baseValues({ snapshot, startFloor, endFloor: snapshot.totalFloors, settings: { status: settings.status, memory: settings.memory }, memory: memoryText, previousStatus }),
            chat: transcriptForFloorRange(snapshot, startFloor, snapshot.totalFloors, settings.status.inputRegex)
        };
        const prompt = promptEntriesToMessages(settings.status.promptEntries, values);
        const content = await this.#runModel(prompt, settings.status.responseLength, settings.status.outputRegex, '状态栏');
        if (!this.#isCurrent(identity)) return null;

        const record = {
            version: 1,
            kind: 'status',
            scopeHash,
            recipe,
            floor: snapshot.totalFloors,
            anchorChain: snapshot.chain,
            content,
            createdAt: new Date().toISOString()
        };
        await this.storage.setStatus(key, record);
        return record;
    }

    async #runModel(prompt, responseLength, outputRegex, label) {
        if (!prompt.length) {
            throw new Error(`${label}没有启用的提示词条目。`);
        }
        const raw = await this.generate({ prompt, responseLength });
        const content = applyRegexRules(String(raw ?? '').trim(), outputRegex).trim();
        if (!content) {
            throw new Error(`${label}经过输出正则处理后为空。`);
        }
        return content;
    }

    #applyMemoryInjection(settings, active) {
        if (!settings.memory.enabled || !settings.memory.injection.enabled) {
            this.applyInjection('', settings.memory.injection);
            return '';
        }
        const largeMemory = active.large ? `[累计大总结 · 至第 ${active.large.endFloor} 楼]\n${active.large.content}` : '';
        const smallMemory = formatRecords(active.small, '阶段小总结');
        const text = renderTemplate(settings.memory.injection.template, {
            large_memory: largeMemory,
            small_memory: smallMemory,
            memory: [largeMemory, smallMemory].filter(Boolean).join('\n\n')
        }).trim();
        this.applyInjection(text, settings.memory.injection);
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
