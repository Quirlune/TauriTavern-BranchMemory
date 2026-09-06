import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestMonitor, sanitizeMonitorValue } from '../src/monitor.js';
import { parsePrompt, promptDetailHtml, promptRecordVisible, splitTextRoles } from '../src/prompt-inspector.js';

test('native 2.2 index and raw provider request load lazily and without prompt truncation', async () => {
    let accepts, reads=0, stopped=0;
    const long='x'.repeat(600000);
    const monitor=new RequestMonitor({eventSource:{on(){},removeListener(){}},eventTypes:{},nativeLogs:{
        subscribeIndex:async fn=>{accepts=fn;return ()=>{stopped++;};},
        index:async()=>[{id:7,model:'test',ok:true}],
        getRaw:async()=>{reads++;return {requestRaw:JSON.stringify({messages:[{role:'system',content:long}],authorization:'secret'}),responseRaw:'{}'};}
    }});
    const fetch=globalThis.fetch;
    monitor.start();
    try {
        await new Promise(setImmediate);
        assert.equal(monitor.nativeState,'connected');
        const record=monitor.records.find(x=>x.channel==='native');
        assert.equal(reads,0);
        const [one,two]=await Promise.all([monitor.loadRecord(record.id),monitor.loadRecord(record.id)]);
        assert.equal(reads,1);
        assert.equal(one,two);
        assert.equal(one.details.requestBody.messages[0].content.length,600000);
        assert.equal(one.details.requestBody.authorization,'[REDACTED]');
        accepts({id:7});
        assert.equal(monitor.records.filter(x=>x.channel==='native').length,1);
    } finally { monitor.stop(); }
    assert.equal(stopped,1);
    assert.equal(globalThis.fetch,fetch);
});

test('stopping while native subscription connects immediately cleans late subscription', async () => {
    let stop=0;
    const resolve=Promise.withResolvers();
    const monitor=new RequestMonitor({eventSource:{on(){},removeListener(){}},eventTypes:{},nativeLogs:{subscribeIndex:()=>resolve.promise,index:async()=>[]}});
    monitor.start();
    monitor.stop();
    resolve.resolve(()=>{stop++;});
    await new Promise(setImmediate);
    assert.equal(stop,1);
});

test('inspector parses Claude, Gemini and Responses native payloads', () => {
    assert.deepEqual(parsePrompt({system:'S',messages:[{role:'user',content:'U'}]}).map(x=>x.role),['system','user']);
    assert.deepEqual(parsePrompt({systemInstruction:{parts:[{text:'S'}]},contents:[{role:'model',parts:[{text:'A'}]}]}).map(x=>x.role),['system','model']);
    assert.deepEqual(parsePrompt({instructions:'S',input:[{role:'user',content:'U'},{type:'function_call_output',output:'OK'}]}).map(x=>x.role),['system','user','function_call_output']);
});

test('viewer escapes prompt HTML, collapses long content and keeps original send order numbers', () => {
    const record={channel:'native',details:{requestBody:{messages:[{role:'user',content:'<script>bad()</script>'},{role:'system',content:'x'.repeat(2000)},{role:'user',content:'last'}]}}};
    const html=promptDetailHtml(record);
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('#3 user'));
    assert.ok(html.includes('class="ttbm-prompt-part" >'));
    assert.equal(promptRecordVisible(record,'native'),true);
    assert.equal(promptRecordVisible({channel:'event',type:'GENERATION_STARTED'},'requests'),false);
});

test('redaction does not mistake shared objects for cycles', () => {
    const item={content:'same'};
    assert.deepEqual(sanitizeMonitorValue([item,item]),[{content:'same'},{content:'same'}]);
    item.self=item;
    assert.equal(sanitizeMonitorValue(item).self,'[Circular]');
    assert.equal(sanitizeMonitorValue({apiKey:'secret'}).apiKey,'[REDACTED]');
});

test('merged text labels form a separate inferred level without changing API roles', () => {
    const parts=splitTextRoles('Intro\n\nHuman[1]: Hi\n\nAI(+): Hello',{user:'Human[1]',assistant:'AI(+)'});
    assert.deepEqual(parts.map(part=>part.label),['前导文本','文本标签 Human[1]','文本标签 AI(+)']);
    assert.ok(parts[1].text.includes('Human[1]: Hi'));
    assert.equal(splitTextRoles('No labels here',{user:'Human'}).length,0);
});

test('restarting beneath another fetch wrapper never recurses and preserves responses', async () => {
    const saved=globalThis.fetch;
    let calls=0;
    const base=async()=>{calls++;return new Response('ok',{headers:{'content-type':'text/plain'}});};
    globalThis.fetch=base;
    const monitor=new RequestMonitor({eventSource:{on(){},removeListener(){}},eventTypes:{},nativeLogs:null});
    try {
        monitor.start();
        const first=globalThis.fetch;
        const other=(...args)=>first(...args);
        globalThis.fetch=other;
        monitor.stop();
        monitor.start();
        const response=await globalThis.fetch('http://example.invalid/api/generate');
        assert.equal(await response.text(),'ok');
        assert.equal(calls,1);
        assert.equal(monitor.records.filter(record=>record.type==='fetch_request').length,1);
        monitor.stop();
        assert.equal(globalThis.fetch,other);
    } finally { monitor.stop(); globalThis.fetch=saved; }
});
