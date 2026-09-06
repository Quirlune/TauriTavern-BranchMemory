import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DEFAULT_SETTINGS } from '../src/defaults.js';

const hooks = registerHooks({
    resolve(specifier, context, next) {
        if (specifier === '/script.js' || specifier === '/scripts/extensions/shared.js'
            || context.parentURL?.endsWith('/src/app.js') && ['./ui.js','./images.js'].includes(specifier)) {
            return { url: `mock:${specifier}`, shortCircuit: true };
        }
        return next(specifier, context);
    },
    load(url, context, next) {
        if (!url.startsWith('mock:')) return next(url, context);
        let source;
        if (url === 'mock:/script.js') source = `
            export const chat = globalThis.__appTest.messages;
            export const eventSource = globalThis.__appTest.events;
            export const event_types = globalThis.__appTest.types;
            export const extension_prompt_roles = {SYSTEM:0,USER:1,ASSISTANT:2};
            export const extension_prompt_types = {IN_CHAT:1,IN_PROMPT:2,BEFORE_PROMPT:3};
            export const generateRaw = async ({prompt}) => { globalThis.__appTest.calls.push(prompt); return 'status-'+globalThis.__appTest.calls.length; };
            export const setExtensionPrompt = (key,text) => {globalThis.__appTest.injections[key]=text;};
            export const saveChatConditional = async()=>{};
            export const syncMesToSwipe = ()=>{};
            export const updateMessageBlock = ()=>{};`;
        else if (url.includes('shared.js')) source = 'export const ConnectionManagerRequestService = {getSupportedProfiles:()=>[]};';
        else if (url.endsWith('ui.js')) source = `export class SettingsUi {
            constructor(options){this.options=options;globalThis.__appTest.ui=this;}
            mount(){} updateMonitor(){} ensureStatusPosition(){} updateStats(){}
            renderStatus(text){globalThis.__appTest.status=text;}
            showError(error){globalThis.__appTest.errors.push(error);}
        }`;
        else source = 'export class ImagePipeline {enqueue(){return Promise.resolve();}cancel(){}clearRendered(){}}';
        return { format: 'module', source, shortCircuit: true };
    }
});

const handlers = new Map();
const state = globalThis.__appTest = {
    messages: [{is_user:true,mes:'u1',send_date:'1'},{is_user:false,mes:'a1',send_date:'2',swipe_id:0}],
    calls: [], injections: {}, status:'',errors:[],
    types: Object.fromEntries(['CHAT_CHANGED','MORE_MESSAGES_LOADED','GENERATION_STARTED','GENERATION_AFTER_COMMANDS',
        'CHARACTER_MESSAGE_RENDERED','USER_MESSAGE_RENDERED','MESSAGE_SWIPED','MESSAGE_EDITED','MESSAGE_DELETED',
        'GENERATION_ENDED','GENERATION_STOPPED','CHAT_COMPLETION_SETTINGS_READY'].map(x=>[x,x])),
    events: {
        on(event,fn){ if(!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); },
        removeListener(event,fn){handlers.get(event)?.delete(fn);},
        async emit(event,...args){for(const fn of [...(handlers.get(event)||[])]) await fn(...args);}
    }
};
const table = new Map();
const settings=structuredClone(DEFAULT_SETTINGS);
settings.memory.enabled=false;
settings.status.injection.enabled=true;
const handle={store:{setJson:async()=>{},getJson:async()=>null}};
const ref={kind:'character',characterId:'AI',fileName:'test'};
globalThis.__TAURITAVERN__={api:{chat:{current:{ref:()=>ref,handle:()=>handle,windowInfo:async()=>({mode:'off',windowStartIndex:0,totalCount:state.messages.length})}},extension:{store:{
    tryGetJson:async ({table:kind,key})=>kind==='settings'?{found:true,value:settings}:{found:table.has(`${kind}:${key}`),value:table.get(`${kind}:${key}`)},
    setJson:async({table:kind,key,value})=>{table.set(`${kind}:${key}`,value);},
    listKeys:async({table:kind})=>[...table.keys()].filter(x=>x.startsWith(kind+':')).map(x=>x.slice(kind.length+1)),
    deleteTable:async()=>{}
}}}};
globalThis.document={getElementById:()=>null,querySelectorAll:()=>[],documentElement:{classList:{remove(){}}},body:{classList:{remove(){}}}};
const {bootstrapExtension,cleanExtensionData}=await import('../src/app.js');
const emit=(event,...args)=>state.events.emit(event,...args);
const drain=()=>new Promise(setImmediate);

test('actual app lifecycle: existing arrows, regeneration deletion, duplicate completion and cancellation', async t => {
    t.mock.timers.enable({apis:['setTimeout']});
    await bootstrapExtension();
    t.mock.timers.tick(100);await drain();
    await state.ui.options.onRunNow();
    assert.equal(state.calls.length,1);
    const firstStatus=state.status;
    await emit('MESSAGE_SWIPED',1);
    t.mock.timers.tick(1000);await drain();
    assert.equal(state.calls.length,1,'existing swipe must not generate');
    assert.equal(state.status,firstStatus);

    await emit('GENERATION_STARTED','regenerate',{},false);
    await emit('GENERATION_AFTER_COMMANDS','regenerate',{},false);
    state.messages.pop();
    await emit('MESSAGE_DELETED',1);
    t.mock.timers.tick(1000);await drain();
    assert.equal(state.calls.length,1,'deletion during regeneration is not a completed turn');
    assert.equal(state.injections.TT_BRANCH_STATUS_V1,'');
    state.messages.push({is_user:false,mes:'new-reply',send_date:'3',swipe_id:0});
    // Streaming in 2.2 can emit ENDED before CHARACTER_MESSAGE_RENDERED.
    await emit('GENERATION_ENDED',2);
    await emit('CHARACTER_MESSAGE_RENDERED',1,'regenerate');
    await emit('CHARACTER_MESSAGE_RENDERED',1,'regenerate');
    await emit('GENERATION_ENDED',2);
    t.mock.timers.tick(1000);await drain();
    assert.equal(state.calls.length,2);
    assert.ok(JSON.stringify(state.calls.at(-1)).includes('new-reply'));
    assert.ok(!JSON.stringify(state.calls.at(-1)).includes(firstStatus));

    // A queued completed turn is cancelled if another swipe is selected first.
    await emit('GENERATION_STARTED','swipe',{},false);
    await emit('GENERATION_AFTER_COMMANDS','swipe',{},false);
    state.messages.at(-1).mes='queued-reply';
    await emit('CHARACTER_MESSAGE_RENDERED',1,'swipe');
    await emit('GENERATION_ENDED',2);
    state.messages.at(-1).mes='selected-existing-reply';
    await emit('MESSAGE_SWIPED',1);
    t.mock.timers.tick(1000);await drain();
    assert.equal(state.calls.length,2,'cancel pending generation when selecting an existing swipe');
    assert.equal(state.errors.length,0);
    await cleanExtensionData();
    assert.ok([...handlers.values()].every(set=>set.size===0));
    hooks.deregister();
});
