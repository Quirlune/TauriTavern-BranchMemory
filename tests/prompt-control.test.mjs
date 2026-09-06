import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_PROMPT_CONTROL, transformPrompt, PromptController } from '../src/prompt-control.js';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/merge-editor.json', import.meta.url), 'utf8'));
for (const fixture of fixtures) test(`mergeEditor reference output: ${fixture.name}`, () => {
    const before = structuredClone(fixture.messages);
    assert.deepEqual(transformPrompt(fixture.messages, { ...structuredClone(DEFAULT_PROMPT_CONTROL), ...fixture.config }), fixture.expected);
    assert.deepEqual(fixture.messages, before);
});

test('default compatibility applies to body only', () => {
    const messages = [{ role: 'user', content: 'hello' }];
    for (const scope of ['memory','status','image']) assert.deepEqual(transformPrompt(messages, DEFAULT_PROMPT_CONTROL, scope), messages);
    assert.equal(transformPrompt(messages)[0].role, 'assistant');
});

test('literal rule precedence, custom markers and protected boundaries', () => {
    const config = structuredClone(DEFAULT_PROMPT_CONTROL);
    Object.assign(config, { mode: 'roles', merge: 'adjacent', protectedMarkers: '[KEEP]' });
    config.roles.system = 'user';
    config.rules = [{ enabled: true, source: 'system', contains: 'important', target: 'assistant' },
        { enabled: true, source: '*', contains: 'important', target: 'system' }];
    const output = transformPrompt([{role:'system',content:'important'},{role:'user',content:'a'},
        {role:'user',content:'[KEEP]x'},{role:'user',content:'b'},{role:'user',content:'c'}],config);
    assert.deepEqual(output.map(x=>[x.role,x.content]), [['assistant','important'],['user','a'],['user','x'],['user','b\n\nc']]);
});

test('tools, multimodal content and extra provider fields retain exact structure', () => {
    const complex = [{role:'assistant',content:null,tool_calls:[{id:'call',type:'function',function:{name:'lookup',arguments:'{}'}}]},
        {role:'tool',tool_call_id:'call',content:'result'},
        {role:'user',content:[{type:'text',text:'hello'},{type:'image_url',image_url:{url:'data:image/png;base64,AAA'}}]},
        {role:'system',content:'cached',cache_control:{type:'ephemeral'}}];
    assert.deepEqual(transformPrompt(complex),complex);
});

test('custom regex metacharacters in role labels remain literal', () => {
    const config = structuredClone(DEFAULT_PROMPT_CONTROL);
    config.prefixes.user = 'Human[1]';
    config.prefixes.assistant = 'AI(+)';
    const output = transformPrompt([{role:'user',content:'hello'},{role:'assistant',content:'world'}],config);
    assert.ok(output[0].content.includes('Human[1]: hello'));
    assert.ok(output[0].content.includes('AI(+): world'));
});

test('no merge and adjacent modes remain separate selectable operations', () => {
    const config = {...structuredClone(DEFAULT_PROMPT_CONTROL),mode:'roles',merge:'none'};
    const messages=[{role:'user',content:'a'},{role:'user',content:'b'}];
    assert.deepEqual(transformPrompt(messages,config), messages);
    config.merge='adjacent';
    assert.equal(transformPrompt(messages,config).length,1);
});

test('settings hook is idempotent, skips quiet calls and detaches cleanly', () => {
    let handler;
    const eventSource={on:(_event,fn)=>{handler=fn;},removeListener:(_event,fn)=>{assert.equal(fn,handler);handler=null;}};
    const controller=new PromptController({eventSource,eventTypes:{CHAT_COMPLETION_SETTINGS_READY:'ready'},getSettings:()=>({enabled:true,promptControl:DEFAULT_PROMPT_CONTROL})});
    controller.start();
    const payload={type:'normal',messages:[{role:'user',content:'hello'}]};
    handler(payload);
    const once=structuredClone(payload);
    handler(payload);
    assert.deepEqual(payload,once);
    const quiet={type:'quiet',messages:[{role:'user',content:'status'}]};
    handler(quiet);
    assert.equal(quiet.messages[0].role,'user');
    controller.stop();
    assert.equal(handler,null);
});
