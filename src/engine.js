import {
    applyRegexRules, boundaries, buildSnapshot, getFloor, makeCacheKey,
    processStatusOutput, promptEntriesToMessages, recipeHash, renderTemplate,
    selectActiveMemory, statusRecordOutputs, summaryContextEndFloor, transcriptForFloorRange
} from './core.js';
import { chatIdentity, readFullHistory, scopeHashForRef } from './history.js';
import { promptControlRecipe } from './prompt-control.js';
import { describeModelError } from './model-client.js';

function formatRecords(records, label) {
    return [...records].sort((a, b) => a.endFloor - b.endFloor)
        .map(record => `[${label} ${record.startFloor}-${record.endFloor}]\n${record.content}`).join('\n\n');
}

function latestBefore(records, floor) {
    return [...records].filter(record => record.endFloor < floor).sort((a, b) => b.endFloor - a.endFloor)[0] || null;
}

function memoryText(settings, active) {
    if (!settings.memory.enabled || !settings.memory.injection.enabled) return '';
    const large = active.large ? `[累计大总结 · 至第 ${active.large.endFloor} 楼]\n${active.large.content}` : '';
    const small = formatRecords(active.small, '阶段小总结');
    return renderTemplate(settings.memory.injection.template, {
        large_memory: large, small_memory: small, memory: [large, small].filter(Boolean).join('\n\n')
    }).trim();
}

export class BranchMemoryEngine {
    constructor({ storage, getSettings, generate, applyInjection, renderStatus, updateStats }) {
        Object.assign(this, { storage, getSettings, generate, applyInjection, renderStatus, updateStats });
        this.revision = 0;
    }

    invalidate() { this.revision += 1; }

    async refresh({ generateMemory = false, generateStatus = false, reason = 'refresh', generationType = '', forceStatus = false } = {}) {
        const settings = structuredClone(this.getSettings());
        if (!settings.enabled) {
            this.applyInjection('memory', '', settings.memory.injection);
            this.applyInjection('status', '', settings.status.injection);
            this.renderStatus('', settings.status);
            return;
        }
        const handle = this.storage.currentHandle();
        const ref = this.storage.currentRef();
        if (!handle || !ref) return;
        const task = { revision: this.revision, identity: chatIdentity(ref), handle };
        const scopeHash = scopeHashForRef(ref);
        // Host histories can contain live objects. Freeze a single model input.
        const original = buildSnapshot(structuredClone((await this.#readSnapshot(handle)).messages));
        let snapshot = original;
        const replacing = reason === 'before_generation' && ['regenerate', 'swipe'].includes(generationType);
        if (replacing && snapshot.rows.at(-1)?.role === 'assistant') snapshot = buildSnapshot(snapshot.messages.slice(0, -1));
        const eligibleFloor = Math.max(0, Math.min(snapshot.totalFloors - settings.memory.reserveFloors,
            replacing ? snapshot.totalFloors - 1 : snapshot.totalFloors));
        const control = promptControlRecipe(settings.promptControl, 'memory');
        const smallRecipe = recipeHash({
            every: settings.memory.smallEvery, contextExtraFloors: settings.memory.smallContextExtraFloors,
            responseLength: settings.memory.responseLength, api: settings.memory.api,
            inputRegex: settings.memory.inputRegex, outputRegex: settings.memory.outputRegex,
            promptEntries: settings.memory.smallPromptEntries, ...(control ? { promptControl: control } : {})
        });
        const largeRecipe = recipeHash({
            every: settings.memory.largeEvery, responseLength: settings.memory.responseLength,
            api: settings.memory.api, inputRegex: settings.memory.inputRegex, outputRegex: settings.memory.outputRegex,
            promptEntries: settings.memory.largePromptEntries, smallRecipe
        });
        const smallBoundaries = boundaries(settings.memory.smallEvery, eligibleFloor);
        const largeBoundaries = boundaries(settings.memory.largeEvery, eligibleFloor);
        const [smallRecords, largeRecords] = await Promise.all([
            this.#loadMemory('Small', smallBoundaries, { snapshot, scopeHash, recipe: smallRecipe }),
            this.#loadMemory('Large', largeBoundaries, { snapshot, scopeHash, recipe: largeRecipe })
        ]);
        if (!this.#isCurrent(task)) return;
        const errors = [];
        if (settings.memory.enabled && generateMemory) {
            let calls = 0;
            const budget = Math.max(0, settings.memory.maxCallsPerTurn);
            for (const floor of [...new Set([...smallBoundaries, ...largeBoundaries])].sort((a, b) => a - b)) {
                for (const kind of ['small', 'large']) {
                    const records = kind === 'small' ? smallRecords : largeRecords;
                    const limits = kind === 'small' ? smallBoundaries : largeBoundaries;
                    if (calls >= budget || !limits.includes(floor) || records.some(record => record.endFloor === floor)) continue;
                    if (!this.#isCurrent(task)) return;
                    calls += 1;
                    try {
                        const record = await this.#generateMemory(kind, {
                            settings, snapshot, scopeHash, floor, recipe: kind === 'small' ? smallRecipe : largeRecipe,
                            smallRecords, largeRecords, task
                        });
                        if (record) records.push(record);
                    } catch (error) {
                        if (error?.name === 'AbortError' || !this.#isCurrent(task)) return;
                        errors.push(describeModelError(error));
                        // A failing memory provider must not prevent the status request.
                        calls = budget;
                        break;
                    }
                }
                if (calls >= budget) break;
            }
        }
        if (!this.#isCurrent(task)) return;
        if (!await this.#unchanged(task, original)) return;
        const active = selectActiveMemory({ largeRecords, smallRecords, eligibleFloor });
        const memory = memoryText(settings, active);
        const statusControl = promptControlRecipe(settings.promptControl, 'status');
        const statusRecipe = recipeHash({
            contextFloors: settings.status.contextFloors, responseLength: settings.status.responseLength,
            api: settings.status.api, inputRegex: settings.status.inputRegex, promptEntries: settings.status.promptEntries,
            ...(statusControl ? { promptControl: statusControl } : {})
        });
        let status = null;
        if (settings.status.enabled) {
            const currentComplete = snapshot.rows.at(-1)?.role === 'assistant';
            if (currentComplete && !replacing) status = await this.#statusAt(snapshot, scopeHash, statusRecipe, snapshot.totalFloors);
            const previous = await this.#previousStatus(snapshot, scopeHash, statusRecipe, snapshot.totalFloors - 1);
            if (currentComplete && !replacing && generateStatus && (!status || forceStatus) && snapshot.totalFloors > 0) {
                try {
                    status = await this.#generateStatus({ settings, snapshot, scopeHash, recipe: statusRecipe, memory,
                        previousStatus: statusRecordOutputs(previous, settings.status).renderContent, task });
                } catch (error) {
                    if (error?.name === 'AbortError' || !this.#isCurrent(task)) return;
                    errors.push(describeModelError(error));
                }
            }
            // Runtime.status may belong to a deleted/swiped reply. Never use it blindly.
            if (!currentComplete || replacing) status = previous;
        }
        if (!await this.#unchanged(task, original)) return;
        const outputs = statusRecordOutputs(status, settings.status);
        if (status) status = { ...status, content: outputs.renderContent, injectionContent: outputs.injectionContent };
        const runtime = {
            version: 1, chatIdentity: task.identity, chain: original.chain, totalFloors: snapshot.totalFloors,
            eligibleFloor, activeLarge: active.large, activeSmall: active.small, status,
            updatedAt: new Date().toISOString(), reason, generationType, lastError: errors.join('\n')
        };
        await this.storage.setChatRuntime(runtime, handle);
        if (!this.#isCurrent(task)) return;
        this.applyInjection('memory', memory, settings.memory.injection);
        this.renderStatus(outputs.renderContent, settings.status);
        const injection = settings.status.enabled && settings.status.injection.enabled && outputs.injectionContent
            ? renderTemplate(settings.status.injection.template, { status: outputs.injectionContent }).trim() : '';
        this.applyInjection('status', injection, settings.status.injection);
        this.updateStats({ ...runtime, smallCount: smallRecords.length, largeCount: largeRecords.length });
        if (errors.length) throw new Error(errors.join('\n'));
    }

    #key(snapshot, scopeHash, floor, recipe) {
        const anchor = getFloor(snapshot, floor);
        return anchor ? makeCacheKey({ scopeHash, floor, chain: anchor.chain, recipe }) : null;
    }

    async #loadMemory(kind, floors, { snapshot, scopeHash, recipe }) {
        const keys = new Set(await this.storage[`list${kind}Keys`]());
        const legacyByFloor = new Map();
        for (const key of keys) {
            const parts = key.split('.');
            if (parts[1] !== scopeHash || parts[4] !== recipe) continue;
            const floor = Number(parts[2]);
            if (!legacyByFloor.has(floor)) legacyByFloor.set(floor, []);
            legacyByFloor.get(floor).push(key);
        }
        const results = [];
        const pending = [...floors];
        await Promise.all(Array.from({ length: Math.min(8, pending.length) }, async () => {
            while (pending.length) {
                const floor = pending.shift();
                const key = this.#key(snapshot, scopeHash, floor, recipe);
                let record = keys.has(key) ? await this.storage[`get${kind}`](key) : null;
                if (!record) {
                    // v0.6 anchored keys to extra context. Reuse its actual summarized prefix.
                    const candidates = (legacyByFloor.get(floor) || []).sort();
                    for (const candidate of candidates) {
                        const old = await this.storage[`get${kind}`](candidate);
                        if (old?.anchorChain === getFloor(snapshot, floor)?.chain) { record = old; break; }
                    }
                }
                if (record) results.push(record);
            }
        }));
        return results;
    }

    #values({ snapshot, startFloor, endFloor, inputRegex, contextEndFloor = endFloor, settings, ...extra }) {
        const last = role => {
            const row = snapshot.rows.findLast(item => item.floor >= startFloor && item.floor <= contextEndFloor && item.role === role);
            return applyRegexRules(row?.message?.mes || '', inputRegex);
        };
        const summary = transcriptForFloorRange(snapshot, startFloor, endFloor, inputRegex);
        const context = transcriptForFloorRange(snapshot, startFloor, contextEndFloor, inputRegex);
        const hasExtra = contextEndFloor > endFloor;
        return {
            chat: context, summary_chat: summary, context_chat: context,
            extra_chat: hasExtra ? transcriptForFloorRange(snapshot, endFloor + 1, contextEndFloor, inputRegex) : '',
            floor_start: startFloor, floor_end: endFloor, summary_floor_start: startFloor, summary_floor_end: endFloor,
            context_floor_start: startFloor, context_floor_end: contextEndFloor,
            extra_floor_start: hasExtra ? endFloor + 1 : '', extra_floor_end: hasExtra ? contextEndFloor : '',
            small_extra_floors: contextEndFloor - endFloor, total_floors: snapshot.totalFloors,
            eligible_floor: Math.max(0, snapshot.totalFloors - settings.memory.reserveFloors),
            previous_large: '', small_summaries: '', memory: '', previous_status: '',
            last_user: last('user'), last_assistant: last('assistant'), ...extra
        };
    }

    async #generateMemory(kind, { settings, snapshot, scopeHash, floor, recipe, smallRecords, largeRecords, task }) {
        const config = settings.memory;
        const small = kind === 'small';
        const startFloor = small ? Math.max(1, floor - config.smallEvery + 1) : (latestBefore(largeRecords, floor)?.endFloor || 0) + 1;
        const contextEndFloor = small ? summaryContextEndFloor(snapshot.totalFloors, floor, config.smallContextExtraFloors) : floor;
        const values = this.#values({
            snapshot, settings, startFloor, endFloor: floor, contextEndFloor, inputRegex: config.inputRegex,
            previous_large: latestBefore(largeRecords, small ? startFloor : floor)?.content || '',
            small_summaries: small ? '' : formatRecords(smallRecords.filter(record => record.endFloor >= startFloor && record.endFloor <= floor), '小总结')
        });
        const raw = await this.#runModel(promptEntriesToMessages(small ? config.smallPromptEntries : config.largePromptEntries, values), config, 'memory', small ? '小总结' : '大总结');
        const content = applyRegexRules(raw, config.outputRegex).trim();
        if (!content) throw new Error(`${small ? '小总结' : '大总结'}经过输出正则处理后为空。`);
        if (!this.#isCurrent(task)) return null;
        const current = await this.#readSnapshot(task.handle, { force: true });
        if (getFloor(current, floor)?.chain !== getFloor(snapshot, floor)?.chain || !this.#isCurrent(task)) return null;
        const record = {
            version: 1, kind, scopeHash, recipe, startFloor: small ? startFloor : 1,
            ...(small ? { contextEndFloor, contextExtraFloors: contextEndFloor - floor } : { segmentStartFloor: startFloor }),
            endFloor: floor, anchorChain: getFloor(snapshot, floor).chain, content, createdAt: new Date().toISOString()
        };
        await this.storage[small ? 'setSmall' : 'setLarge'](this.#key(snapshot, scopeHash, floor, recipe), record);
        return record;
    }

    async #statusAt(snapshot, scopeHash, recipe, floor) {
        const key = this.#key(snapshot, scopeHash, floor, recipe);
        return key ? this.storage.getStatus(key) : null;
    }

    async #previousStatus(snapshot, scopeHash, recipe, maxFloor) {
        const keys = typeof this.storage.listStatusKeys === 'function' ? new Set(await this.storage.listStatusKeys()) : null;
        for (let floor = maxFloor; floor > 0; floor -= 1) {
            if (keys && !keys.has(this.#key(snapshot, scopeHash, floor, recipe))) continue;
            const record = await this.#statusAt(snapshot, scopeHash, recipe, floor);
            if (record) return record;
        }
        return null;
    }

    async #generateStatus({ settings, snapshot, scopeHash, recipe, memory, previousStatus, task }) {
        const config = settings.status;
        const values = this.#values({ snapshot, settings, startFloor: Math.max(1, snapshot.totalFloors - config.contextFloors + 1),
            endFloor: snapshot.totalFloors, inputRegex: config.inputRegex, memory, previous_status: previousStatus });
        const raw = await this.#runModel(promptEntriesToMessages(config.promptEntries, values), config, 'status', '状态栏');
        if (!await this.#unchanged(task, snapshot)) return null;
        const outputs = processStatusOutput(raw, config.outputRegex, config.injection.outputRegex);
        const record = {
            version: 2, kind: 'status', scopeHash, recipe, floor: snapshot.totalFloors, anchorChain: snapshot.chain,
            rawContent: outputs.rawContent, content: outputs.renderContent, injectionContent: outputs.injectionContent,
            createdAt: new Date().toISOString()
        };
        await this.storage.setStatus(this.#key(snapshot, scopeHash, snapshot.totalFloors, recipe), record);
        return record;
    }

    async #runModel(prompt, config, scope, label) {
        if (!prompt.length) throw new Error(`${label}没有启用的提示词条目。`);
        const raw = await this.generate({ prompt, responseLength: config.responseLength, apiConfig: config.api, scope, label });
        if (typeof raw !== 'string' || !raw.trim()) throw new Error(`${label}模型输出为空。`);
        return raw.trim();
    }

    #isCurrent(task) {
        try { return task.revision === this.revision && chatIdentity(this.storage.currentRef()) === task.identity; }
        catch { return false; }
    }

    async #unchanged(task, snapshot) {
        if (!this.#isCurrent(task)) return false;
        const current = await this.#readSnapshot(task.handle, { force: true });
        return this.#isCurrent(task) && current.chain === snapshot.chain;
    }

    #readSnapshot(handle, options) {
        return this.storage.readSnapshot ? this.storage.readSnapshot(handle, options) : readFullHistory(handle, options);
    }
}
