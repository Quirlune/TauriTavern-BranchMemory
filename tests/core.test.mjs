import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AssistantGenerationGate,
    applyRegexRules,
    boundaries,
    buildSnapshot,
    parseBizyAirApiExample,
    parseImagePlan,
    processStatusOutput,
    promptEntriesToMessages,
    selectActiveMemory,
    statusInsertionIndex,
    transcriptForFloorRange
} from '../src/core.js';
import { characterPromptInfo } from '../src/history.js';
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

test('image planning output parses anchored insertion slots', () => {
    const plan = parseImagePlan('```json\n{"images":[{"anchor":"她抬头看向雨夜","placement":"after","occurrence":1,"prompt":"girl looking at rainy night, cinematic"}]}\n```', { maxItems: 3 });
    assert.deepEqual(plan, [{
        id: 'image-1',
        anchor: '她抬头看向雨夜',
        prompt: 'girl looking at rainy night, cinematic',
        placement: 'after',
        occurrence: 1,
        reason: ''
    }]);
});

test('image planning output reports invalid json clearly', () => {
    assert.throws(() => parseImagePlan('not json'), /图片规划输出不是有效 JSON/);
});

test('character prompt info follows the active character ref', () => {
    const info = characterPromptInfo({
        kind: 'character',
        characterId: 'alice-001',
        fileName: 'Alice.png',
        name: 'Alice'
    });
    assert.deepEqual(info, {
        kind: 'character',
        key: 'character:alice-001',
        label: 'Alice',
        characterId: 'alice-001',
        fileName: 'Alice.png'
    });
});

test('bizyair api example parses into a reusable template', () => {
    const parsed = parseBizyAirApiExample(`
        const response = await fetch('https://api.bizyair.cn/w/v1/webapp/task/openapi/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer YOUR_API_KEY'
          },
          body: JSON.stringify({
              "web_app_id": 51978,
              "suppress_preview_output": true,
              "input_values": {
                "3:KSampler.seed": 95663262248077,
                "3:KSampler.steps": 26,
                "5:EmptyLatentImage.width": 1280,
                "5:EmptyLatentImage.height": 1560,
                "6:CLIPTextEncode.text": "masterpiece, very aesthetic, best quality",
                "7:CLIPTextEncode.text": "(worst quality:1.4), bad anatomy, watermark"
              }
            })
        });
    `);
    assert.equal(parsed.webAppId, 51978);
    assert.equal(parsed.suppressPreviewOutput, true);
    assert.equal(parsed.controls.seed, 95663262248077);
    assert.equal(parsed.controls.steps, 26);
    assert.equal(parsed.controls.width, 1280);
    assert.equal(parsed.controls.height, 1560);
    assert.equal(parsed.controls.randomSeed, false);
    assert.match(parsed.controls.positivePromptPrefix, /masterpiece/);
    assert.match(parsed.controls.negativePrompt, /worst quality/);
    assert.match(parsed.inputValuesTemplate, /"3:KSampler.seed": {{seed}}/);
    assert.match(parsed.inputValuesTemplate, /"5:EmptyLatentImage.width": {{width}}/);
    assert.match(parsed.inputValuesTemplate, /"6:CLIPTextEncode.text": "{{positive_prompt}}"/);
    assert.match(parsed.inputValuesTemplate, /"7:CLIPTextEncode.text": "{{negative_prompt}}"/);
    assert.doesNotMatch(parsed.inputValuesTemplate, /{{cfg}}/);
});
