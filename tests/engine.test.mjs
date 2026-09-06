import test from 'node:test';
import assert from 'node:assert/strict';
import { BranchMemoryEngine } from '../src/engine.js';
import { DEFAULT_SETTINGS } from '../src/defaults.js';
import { buildSnapshot } from '../src/core.js';
import { StorageGateway } from '../src/storage.js';

function conversation(count) {
    return Array.from({ length: count }, (_, i) => [
        { is_user: true, mes: `user-${i + 1}`, name: 'User', send_date: `u${i}` },
        { is_user: false, mes: `answer-${i + 1}`, name: 'AI', send_date: `a${i}`, swipe_id: 0 }
    ]).flat();
}

function fixture(count = 4) {
    const state = { messages: conversation(count), fileName: 'chat-a', calls: [], rendered: [], injections: {}, runtime: null, stats: null };
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.memory.smallEvery = 2;
    settings.memory.largeEvery = 4;
    settings.memory.reserveFloors = 2;
    settings.memory.maxCallsPerTurn = 20;
    settings.status.injection.enabled = true;
    const maps = { Small: new Map(), Large: new Map(), Status: new Map() };
    const handle = {};
    const storage = {
        currentHandle: () => handle,
        currentRef: () => ({ kind: 'character', characterId: 'AI', fileName: state.fileName }),
        readSnapshot: async () => buildSnapshot(structuredClone(state.messages)),
        setChatRuntime: async runtime => { state.runtime = runtime; },
        getChatRuntime: async () => state.runtime
    };
    for (const [kind, map] of Object.entries(maps)) {
        storage[`get${kind}`] = async key => map.get(key) || null;
        storage[`set${kind}`] = async (key, value) => map.set(key, value);
        storage[`list${kind}Keys`] = async () => [...map.keys()];
    }
    const engine = new BranchMemoryEngine({ storage, getSettings: () => settings,
        generate: async request => {
            state.calls.push(request);
            if (state.generator) return state.generator(request);
            return `${request.scope}-result-${state.calls.length}`;
        },
        applyInjection: (channel, content) => { state.injections[channel] = content; },
        renderStatus: content => state.rendered.push(content), updateStats: stats => { state.stats = stats; }
    });
    return { state, settings, maps, storage, engine };
}

test('rolling the trigger floor and extra context ten times reuses the summarized prefix', async () => {
    const { engine, state, settings, maps } = fixture();
    settings.memory.smallContextExtraFloors = 2;
    await engine.refresh({ generateMemory: true, generateStatus: true });
    const firstSummary = [...maps.Small.values()][0];
    for (let i = 1; i <= 10; i += 1) {
        state.messages.at(-1).mes = `reroll-${i}`;
        state.messages.at(-1).swipe_id = i;
        engine.invalidate();
        await engine.refresh({ generateMemory: true, generateStatus: true, generationType: 'regenerate', forceStatus: true });
    }
    assert.equal(state.calls.filter(call => call.scope === 'memory').length, 1);
    assert.equal(state.calls.filter(call => call.scope === 'status').length, 11);
    assert.equal(maps.Small.size, 1);
    assert.deepEqual([...maps.Small.values()][0], firstSummary);
});

test('swipe selection uses cache only and switching back restores exact status', async () => {
    const { engine, state } = fixture();
    await engine.refresh({ generateStatus: true });
    const old = structuredClone(state.messages.at(-1));
    const status = state.rendered.at(-1);
    const count = state.calls.length;
    state.messages.at(-1).mes = 'unseen-swipe';
    engine.invalidate();
    await engine.refresh({ reason: 'message_swiped' });
    assert.equal(state.calls.length, count);
    assert.equal(state.rendered.at(-1), '');
    assert.equal(state.injections.status, '');
    state.messages[state.messages.length - 1] = old;
    await engine.refresh({ reason: 'message_swiped' });
    assert.equal(state.rendered.at(-1), status);
    assert.equal(state.calls.length, count);
});

test('regeneration excludes deleted reply and its status from both injection and previous_status', async () => {
    const { engine, state } = fixture(3);
    await engine.refresh({ generateStatus: true });
    const previous = state.rendered.at(-1);
    state.messages.push(...conversation(4).slice(-2));
    await engine.refresh({ generateStatus: true });
    const deletedStatus = state.rendered.at(-1);
    await engine.refresh({ reason: 'before_generation', generationType: 'regenerate' });
    assert.match(state.injections.status, new RegExp(previous));
    assert.ok(!state.injections.status.includes(deletedStatus));
    state.messages.at(-1).mes = 'new-fourth-reply';
    await engine.refresh({ generateStatus: true, forceStatus: true });
    const prompt = JSON.stringify(state.calls.at(-1).prompt);
    assert.ok(prompt.includes(previous));
    assert.ok(!prompt.includes(deletedStatus));
    assert.ok(!prompt.includes('answer-4'));
    assert.ok(prompt.includes('new-fourth-reply'));
});

test('changing an actual summarized floor invalidates dependent summaries, preserving earlier prefixes', async () => {
    const { engine, state, maps } = fixture(8);
    await engine.refresh({ generateMemory: true });
    const before = state.calls.length;
    const first = [...maps.Small.values()].find(record => record.endFloor === 2);
    state.messages[5].mes = 'changed-third-floor';
    engine.invalidate();
    await engine.refresh({ generateMemory: true });
    assert.equal(state.calls.length - before, 3); // small 4, large 4, small 6
    assert.equal([...maps.Small.values()].filter(record => record.endFloor === 2).length, 1);
    assert.ok(state.stats.activeSmall.some(record => record.endFloor === 6));
    assert.equal([...maps.Small.values()].find(record => record.endFloor === 2), first);
});

test('branch changes reuse common prefix and never inject runtime status from the other branch', async () => {
    const { engine, state } = fixture();
    await engine.refresh({ generateMemory: true, generateStatus: true });
    const calls = state.calls.length;
    state.fileName = 'branch-b';
    state.messages.at(-1).mes = 'branch-b-answer';
    engine.invalidate();
    await engine.refresh({ reason: 'chat_changed' });
    assert.equal(state.stats.smallCount, 1);
    assert.equal(state.injections.status, '');
    assert.equal(state.calls.length, calls);
});

test('summary last-message macros are bounded and status macros all use status input regex', async () => {
    const { engine, state, settings } = fixture();
    settings.memory.smallPromptEntries = [{ enabled: true, role: 'user', content: '{{last_user}}/{{last_assistant}}' }];
    settings.status.promptEntries = [{ enabled: true, role: 'user', content: '{{chat}}|{{summary_chat}}|{{context_chat}}|{{last_assistant}}' }];
    settings.status.inputRegex = [{ enabled: true, pattern: 'answer-', flags: 'g', replacement: 'STATUS-' }];
    await engine.refresh({ generateMemory: true, generateStatus: true });
    assert.equal(state.calls[0].prompt[0].content, 'user-2/answer-2');
    assert.ok(!state.calls[1].prompt[0].content.includes('answer-'));
    assert.ok(state.calls[1].prompt[0].content.includes('STATUS-4'));
});

test('memory failure still permits status generation and exposes its cause', async () => {
    const { engine, state } = fixture();
    state.generator = request => { if (request.scope === 'memory') throw new Error('HTTP 503'); return 'status-ok'; };
    await assert.rejects(engine.refresh({ generateMemory: true, generateStatus: true }), /HTTP 503/);
    assert.equal(state.rendered.at(-1), 'status-ok');
    assert.match(state.stats.lastError, /503/);
});

test('editing while the model is pending cannot save or render a stale status', async () => {
    const { engine, state, maps } = fixture();
    let finish;
    const started = Promise.withResolvers();
    state.generator = () => { started.resolve(); return new Promise(resolve => { finish = resolve; }); };
    const run = engine.refresh({ generateStatus: true });
    await started.promise;
    state.messages.at(-1).mes = 'edited-in-flight';
    finish('stale-status');
    await run;
    assert.equal(maps.Status.size, 0);
    assert.equal(state.rendered.length, 0);
});

test('switching chat while summary is pending cannot write runtime or start another model', async () => {
    const { engine, state, maps } = fixture();
    const started = Promise.withResolvers();
    const response = Promise.withResolvers();
    state.generator = () => { started.resolve(); return response.promise; };
    const run = engine.refresh({ generateMemory: true, generateStatus: true });
    await started.promise;
    state.fileName = 'new-chat';
    engine.invalidate();
    response.resolve('stale');
    await run;
    assert.equal(maps.Small.size, 0);
    assert.equal(state.calls.length, 1);
    assert.equal(state.runtime, null);
});

test('legacy extra-context keys are reused by actual summary anchor without wiping stores', async () => {
    const { engine, state, settings, maps } = fixture();
    settings.memory.smallContextExtraFloors = 2;
    await engine.refresh({ generateMemory: true });
    const [key, record] = [...maps.Small][0];
    const oldKey = key.split('.').map((part,index) => index === 3 ? buildSnapshot(state.messages).chain : part).join('.');
    maps.Small.delete(key);
    maps.Small.set(oldKey, record);
    state.messages.at(-1).mes = 'new-extra-context';
    await engine.refresh({ generateMemory: true });
    assert.equal(state.calls.length, 1);
    assert.equal(state.stats.smallCount, 1);
    assert.equal(maps.Small.size, 1);
});

test('TauriTavern 2.2 uses live full chat before a delayed save completes', async () => {
    let diskReads = 0;
    const live = conversation(2);
    const handle = { history: { tail: async () => { diskReads++; throw new Error('should not read stale disk'); } } };
    const host = { api: { extension: { store: {} }, chat: { current: {
        ref: () => ({ kind: 'character', characterId: 'AI', fileName: 'a' }), handle: () => handle,
        windowInfo: async () => ({ mode: 'off', windowStartIndex: 0, windowLength: live.length, totalCount: live.length })
    } } } };
    const storage = new StorageGateway(host, { getLiveMessages: () => live });
    live.at(-1).mes = 'fresh-reply-not-saved';
    const snapshot = await storage.readSnapshot(storage.currentHandle());
    assert.equal(snapshot.messages.at(-1).mes, 'fresh-reply-not-saved');
    live.at(-1).mes = 'edited-after-read';
    assert.equal(snapshot.messages.at(-1).mes, 'fresh-reply-not-saved');
    assert.equal(diskReads, 0);
});
