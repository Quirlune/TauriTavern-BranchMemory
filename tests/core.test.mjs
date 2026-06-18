import test from 'node:test';
import assert from 'node:assert/strict';
import {
    appendMessagesToSnapshot,
    AssistantGenerationGate,
    applyRegexRules,
    boundaries,
    buildSnapshot,
    parseBizyAirApiExample,
    parseImagePlan,
    processStatusOutput,
    promptEntriesUseMacros,
    promptEntriesToMessages,
    selectActiveMemory,
    segmentImageSource,
    statusRecordOutputs,
    statusInsertionIndex,
    transcriptForFloorRange
} from '../src/core.js';
import { characterPromptInfo, clearHistoryCache, readFullHistory } from '../src/history.js';
import { sanitizeMonitorValue } from '../src/monitor.js';

const messages = [
    { is_user: false, name: 'AI', mes: 'hello', send_date: '0' },
    { is_user: true, name: 'User', mes: 'u1', send_date: '1' },
    { is_user: false, name: 'AI', mes: 'a1', send_date: '2' },
    { is_user: true, name: 'User', mes: 'u2', send_date: '3' },
    { is_user: false, name: 'AI', mes: 'a2', send_date: '4' }
];

function pagedHistoryHandle(messagesProvider) {
    const calls = { tail: 0, beforePages: 0 };
    const handle = {
        history: {
            async tail({ limit }) {
                calls.tail += 1;
                const source = messagesProvider();
                const startIndex = Math.max(0, source.length - limit);
                return {
                    startIndex,
                    messages: source.slice(startIndex),
                    hasMoreBefore: startIndex > 0
                };
            },
            async beforePages(page, { limit, pages }) {
                calls.beforePages += 1;
                const source = messagesProvider();
                const output = [];
                let endIndex = Math.max(0, Number(page.startIndex) || 0);
                for (let index = 0; index < pages && endIndex > 0; index += 1) {
                    const startIndex = Math.max(0, endIndex - limit);
                    output.push({
                        startIndex,
                        messages: source.slice(startIndex, endIndex),
                        hasMoreBefore: startIndex > 0
                    });
                    endIndex = startIndex;
                }
                return output;
            }
        }
    };
    return { handle, calls };
}

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

test('appended snapshot matches a full rebuild', () => {
    const base = buildSnapshot(messages.slice(0, 4));
    const appended = appendMessagesToSnapshot(base, messages.slice(4));
    const rebuilt = buildSnapshot(messages);
    assert.equal(appended.chain, rebuilt.chain);
    assert.equal(appended.totalFloors, rebuilt.totalFloors);
    assert.deepEqual(appended.floors, rebuilt.floors);
});

test('full history reader reuses tail-validated snapshots and appends new messages', async () => {
    clearHistoryCache();
    const source = Array.from({ length: 300 }, (_, index) => ({
        is_user: index % 2 === 0,
        name: index % 2 === 0 ? 'User' : 'AI',
        mes: `message ${index}`,
        send_date: String(index)
    }));
    const { handle, calls } = pagedHistoryHandle(() => source);

    const first = await readFullHistory(handle);
    assert.equal(first.messages.length, 300);
    assert.equal(calls.beforePages, 1);

    const second = await readFullHistory(handle);
    assert.strictEqual(second, first);
    assert.equal(calls.beforePages, 1);

    source.push({ is_user: false, name: 'AI', mes: 'new assistant reply', send_date: '300' });
    const third = await readFullHistory(handle);
    const rebuilt = buildSnapshot(source);
    assert.equal(third.messages.length, 301);
    assert.equal(third.chain, rebuilt.chain);
    assert.equal(calls.beforePages, 1);
    clearHistoryCache();
});

test('full history reader detects in-place message mutations', async () => {
    clearHistoryCache();
    const source = Array.from({ length: 260 }, (_, index) => ({
        is_user: index % 2 === 0,
        name: index % 2 === 0 ? 'User' : 'AI',
        mes: `message ${index}`,
        send_date: String(index)
    }));
    const { handle, calls } = pagedHistoryHandle(() => source);

    const first = await readFullHistory(handle);
    source[259].mes = 'message 259 cleaned by another plugin';
    const second = await readFullHistory(handle);
    const rebuilt = buildSnapshot(source);

    assert.notEqual(second.chain, first.chain);
    assert.equal(second.chain, rebuilt.chain);
    assert.equal(calls.beforePages, 2);
    clearHistoryCache();
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

test('prompt macro detection ignores disabled entries and unrelated macros', () => {
    const entries = [
        { enabled: false, content: 'Status={{status}}' },
        { enabled: true, content: 'Body={{body}}' },
        { enabled: true, content: 'Raw={{ status_raw }}' }
    ];
    assert.equal(promptEntriesUseMacros(entries, ['status']), false);
    assert.equal(promptEntriesUseMacros(entries, ['status_raw']), true);
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

test('generation gate clears stale accepted state for skipped generation types', () => {
    const gate = new AssistantGenerationGate();
    gate.start('normal', false);
    gate.afterCommands('normal', false);
    assert.equal(gate.shouldTrigger('normal'), true);

    assert.equal(gate.start('quiet', false), false);
    assert.equal(gate.shouldTrigger('normal'), false);

    gate.start('normal', false);
    gate.afterCommands('normal', false);
    assert.equal(gate.afterCommands('impersonate', false), false);
    assert.equal(gate.shouldTrigger('normal'), false);
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

test('status record outputs resolve latest content for downstream macros', () => {
    const outputs = statusRecordOutputs(
        { rawContent: '<status>HP=9</status><internal>hidden</internal>' },
        {
            outputRegex: [{ enabled: true, pattern: '<internal>[\\s\\S]*?<\\/internal>', flags: 'g', replacement: '' }],
            injection: { outputRegex: [{ enabled: true, pattern: '^[\\s\\S]*?<status>([\\s\\S]*?)<\\/status>[\\s\\S]*$', flags: '', replacement: '$1' }] }
        }
    );
    assert.equal(outputs.renderContent, '<status>HP=9</status>');
    assert.equal(outputs.injectionContent, 'HP=9');
    assert.deepEqual(statusRecordOutputs({ content: 'legacy status', injectionContent: 'legacy inject' }, {}), {
        rawContent: null,
        renderContent: 'legacy status',
        injectionContent: 'legacy inject'
    });
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

test('image source is segmented into numbered XML blocks', () => {
    const segmented = segmentImageSource('<content>\n她抬头看向雨夜。\n\n街灯在水面摇晃。\n</content>');
    assert.equal(segmented.contentWrapped, true);
    assert.equal(segmented.segments.length, 2);
    assert.equal(segmented.segments[0].id, 1);
    assert.match(segmented.formatted, /<segment id="1">/);
    assert.match(segmented.formatted, /她抬头看向雨夜。/);
});

test('image planning output parses XML insertion slots', () => {
    const plan = parseImagePlan('<image><position>2</position><positive_prompt>girl looking at rainy night, cinematic</positive_prompt></image>', { maxItems: 3 });
    assert.deepEqual(plan, [{
        id: 'image-1',
        segmentIndex: 2,
        prompt: 'girl looking at rainy night, cinematic',
        placement: 'after',
        reason: ''
    }]);
});

test('image planning output reports missing xml tags clearly', () => {
    assert.throws(() => parseImagePlan('not json'), /图片规划输出没有找到 XML 标签/);
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
                "6:CLIPTextEncode.text": "masterpiece, very aesthetic, best quality, 8k, (Anime-art:1), amazing quality, very awa, sharp eyes, absurdres, newest, high detail, 3d, realstic, artist:mikaze_oto, [artist:kedama milk],[artist:ask_(askzy)],artist:wanke,artist:wlop,",
                "7:CLIPTextEncode.text": "(worst quality:1.4), muscular woman, deformed, distorted, disfigured, bad anatomy, missing legs, extra legs, extra limbs, cloned face, low resolution, low quality, jpeg artifacts, (watermark, signature, text:1.5), error, ugly, bad proportions, bad face, unrealistic, mutated, cross-eye, (fused eyes:1.3), blurred eyes, poorly drawn face,obese, Chubby, curvy, over weight, overweight, sweat,"
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
    assert.match(parsed.controls.positivePromptPrefix, /artist:wanke/);
    assert.match(parsed.controls.negativePrompt, /worst quality/);
    assert.match(parsed.controls.negativePrompt, /text:1\.5/);
    assert.match(parsed.inputValuesTemplate, /"3:KSampler.seed": {{seed}}/);
    assert.match(parsed.inputValuesTemplate, /"5:EmptyLatentImage.width": {{width}}/);
    assert.match(parsed.inputValuesTemplate, /"6:CLIPTextEncode.text": "{{positive_prompt}}"/);
    assert.match(parsed.inputValuesTemplate, /"7:CLIPTextEncode.text": "{{negative_prompt}}"/);
    assert.doesNotMatch(parsed.inputValuesTemplate, /{{cfg}}/);
});

test('bizyair api example resolves native js body variables', () => {
    const parsed = parseBizyAirApiExample(`
        const payload = {
            web_app_id: 52001,
            suppress_preview_output: false,
            inputValues: {
                "3:KSampler.seed": 123456,
                "3:KSampler.cfg": 7,
                "5:EmptyLatentImage.width": 832,
                "5:EmptyLatentImage.height": 1216,
                "6:CLIPTextEncode.text": "cinematic light, detailed eyes",
                "7:CLIPTextEncode.text": "worst quality, watermark"
            }
        };

        const response = await fetch("https://api.bizyair.cn/w/v1/webapp/task/openapi/create", {
            method: "POST",
            headers: myHeaders,
            body: JSON.stringify(payload)
        });
    `);

    assert.equal(parsed.webAppId, 52001);
    assert.equal(parsed.suppressPreviewOutput, false);
    assert.equal(parsed.controls.cfg, 7);
    assert.match(parsed.inputValuesTemplate, /"3:KSampler.cfg": {{cfg}}/);
    assert.match(parsed.inputValuesTemplate, /"6:CLIPTextEncode.text": "{{positive_prompt}}"/);
});

test('bizyair api example resolves raw requestOptions body variables', () => {
    const parsed = parseBizyAirApiExample(`
        const payload = {
            "web_app_id": 51978,
            "input_values": {
                "3:KSampler.seed": 95663262248077,
                "3:KSampler.steps": 26,
                "5:EmptyLatentImage.width": 1280,
                "5:EmptyLatentImage.height": 1560,
                "6:CLIPTextEncode.text": "masterpiece, best quality",
                "7:CLIPTextEncode.text": "bad anatomy, watermark"
            }
        };
        const raw = JSON.stringify(payload);
        const requestOptions = {
            method: "POST",
            headers: myHeaders,
            body: raw,
            redirect: "follow"
        };
        fetch("https://api.bizyair.cn/w/v1/webapp/task/openapi/create", requestOptions);
    `);

    assert.equal(parsed.webAppId, 51978);
    assert.equal(parsed.controls.steps, 26);
    assert.equal(parsed.controls.width, 1280);
    assert.match(parsed.controls.negativePrompt, /bad anatomy/);
});
