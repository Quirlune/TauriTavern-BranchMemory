import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelClient } from '../src/model-client.js';
import { DEFAULT_SETTINGS } from '../src/defaults.js';

test('raw model calls are serialized across status and image scopes', async () => {
    let active=0,max=0;
    const client=new ModelClient({getSettings:()=>DEFAULT_SETTINGS,generateRaw:async()=>{active++;max=Math.max(max,active);await new Promise(setImmediate);active--;return 'ok';}});
    await Promise.all(['status','image','memory'].map(scope=>client.generate({scope,prompt:[{role:'user',content:scope}],responseLength:100})));
    assert.equal(max,1);
});

test('Connection Manager errors retain original failure cause and queue recovers', async () => {
    let fail=true;
    const client=new ModelClient({getSettings:()=>DEFAULT_SETTINGS,connectionService:{sendRequest:async()=>{if(fail)throw new Error('API request failed',{cause:new Error('HTTP 429: quota')});return {content:'ok'};}}});
    const request={scope:'status',label:'状态栏',prompt:[{role:'user',content:'status'}],apiConfig:{mode:'connection_profile',connectionProfileId:'a'}};
    await assert.rejects(client.generate(request),/状态栏.*429/);
    fail=false;
    assert.equal(await client.generate(request),'ok');
});

test('cancellation drops active and queued stale calls', async () => {
    const ready=Promise.withResolvers(),response=Promise.withResolvers();
    let calls=0;
    const client=new ModelClient({getSettings:()=>DEFAULT_SETTINGS,generateRaw:()=>{calls++;ready.resolve();return response.promise;}});
    const first=client.generate({prompt:[]});
    const second=client.generate({prompt:[]});
    const rejected=Promise.all([assert.rejects(first,{name:'AbortError'}),assert.rejects(second,{name:'AbortError'})]);
    await ready.promise;
    client.cancel();
    response.resolve('stale');
    await rejected;
    assert.equal(calls,1);
});
