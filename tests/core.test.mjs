import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AssistantGenerationGate,
    applyRegexRules,
    boundaries,
    buildSnapshot,
    processStatusOutput,
    promptEntriesToMessages,
    selectActiveMemory,
    statusInsertionIndex,
    transcriptForFloorRange
} from '../src/core.js';
import { sanitizeMonitorValue } from '../src/monitor.js';

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

test('status insertion depth counts messages backward from the end', () => {
    assert.equal(statusInsertionIndex(10, 0), 10);
    assert.equal(statusInsertionIndex(10, 1), 9);
    assert.equal(statusInsertionIndex(10, 3), 7);
    assert.equal(statusInsertionIndex(2, 99), 0);
});

test('status generation ignores slash-command starts without after-commands acceptance', () => {
    const gate = new AssistantGenerationGate();
    assert.equal(gate.start('normal', false), true);
    assert.equal(gate.shouldTrigger('normal'), false);
    assert.equal(gate.afterCommands('normal', false), true);
    assert.equal(gate.shouldTrigger('normal'), true);
    gate.reset();
    assert.equal(gate.start('quiet', false), false);
    assert.equal(gate.afterCommands('quiet', false), false);
    assert.equal(gate.shouldTrigger('quiet'), false);
});

test('status render and chat injection regexes independently process the raw model output', () => {
    const output = processStatusOutput(
        '<status>HP=9</status><internal>hidden</internal>',
        [{ enabled: true, pattern: '<internal>[\\s\\S]*?<\\/internal>', flags: 'g', replacement: '' }],
        [{ enabled: true, pattern: '^[\\s\\S]*?<status>([\\s\\S]*?)<\\/status>[\\s\\S]*$', flags: '', replacement: '$1' }]
    );
    assert.equal(output.rawContent, '<status>HP=9</status><internal>hidden</internal>');
    assert.equal(output.renderContent, '<status>HP=9</status>');
    assert.equal(output.injectionContent, 'HP=9');
});

test('request monitor redacts credentials without hiding generation parameters', () => {
    const sanitized = sanitizeMonitorValue({
        api_key: 'sk-secret',
        authorization: 'Bearer abc123',
        max_tokens: 900,
        temperature: 0.72,
        nested: { proxy_password: 'password', prompt: 'hello', secret_id: 'profile-secret-3', auth_mode: 'oauth' }
    });
    assert.equal(sanitized.api_key, '[REDACTED]');
    assert.equal(sanitized.authorization, '[REDACTED]');
    assert.equal(sanitized.nested.proxy_password, '[REDACTED]');
    assert.equal(sanitized.max_tokens, 900);
    assert.equal(sanitized.temperature, 0.72);
    assert.equal(sanitized.nested.prompt, 'hello');
    assert.equal(sanitized.nested.secret_id, 'profile-secret-3');
    assert.equal(sanitized.nested.auth_mode, 'oauth');
});
