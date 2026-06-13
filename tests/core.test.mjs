import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyRegexRules,
    boundaries,
    buildSnapshot,
    promptEntriesToMessages,
    selectActiveMemory,
    transcriptForFloorRange
} from '../src/core.js';

const messages = [
    { is_user: false, name: 'AI', mes: 'hello', send_date: '0' },
    { is_user: true, name: 'User', mes: 'u1', send_date: '1' },
    { is_user: false, name: 'AI', mes: 'a1', send_date: '2' },
    { is_user: true, name: 'User', mes: 'u2', send_date: '3' },
    { is_user: false, name: 'AI', mes: 'a2', send_date: '4' }
];

test('counts only user messages as floors and anchors after the assistant reply', () => {
    const snapshot = buildSnapshot(messages);
    assert.equal(snapshot.totalFloors, 2);
    assert.equal(snapshot.floors[0].startIndex, 1);
    assert.equal(snapshot.floors[0].endIndex, 2);
    assert.equal(snapshot.floors[1].endIndex, 4);
});

test('shared prefixes keep the same chain and divergent branches change afterward', () => {
    const base = buildSnapshot(messages);
    const branch = buildSnapshot([...messages.slice(0, 3), { ...messages[3], mes: 'different user branch' }, messages[4]]);
    assert.equal(base.rows[2].chain, branch.rows[2].chain);
    assert.notEqual(base.rows[3].chain, branch.rows[3].chain);
});

test('transcript ranges include the full assistant response for each user floor', () => {
    const snapshot = buildSnapshot(messages);
    const text = transcriptForFloorRange(snapshot, 1, 1);
    assert.match(text, /u1/);
    assert.match(text, /a1/);
    assert.doesNotMatch(text, /u2/);
});

test('regex pipeline and prompt stack are deterministic', () => {
    const cleaned = applyRegexRules('reasoning: secret\nanswer', [{ enabled: true, pattern: '^reasoning:.*\\n', flags: 'i', replacement: '' }]);
    assert.equal(cleaned, 'answer');
    const prompt = promptEntriesToMessages([{ enabled: true, role: 'user', content: 'Chat={{chat}}' }], { chat: cleaned });
    assert.deepEqual(prompt, [{ role: 'user', content: 'Chat=answer' }]);
});

test('active memory uses the latest large summary and only later small summaries', () => {
    const result = selectActiveMemory({
        eligibleFloor: 40,
        largeRecords: [{ endFloor: 32, content: 'L32' }, { endFloor: 64, content: 'L64' }],
        smallRecords: [{ endFloor: 24 }, { endFloor: 32 }, { endFloor: 40 }]
    });
    assert.equal(result.large.content, 'L32');
    assert.deepEqual(result.small.map(item => item.endFloor), [40]);
    assert.deepEqual(boundaries(8, 35), [8, 16, 24, 32]);
});
