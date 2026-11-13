import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationStore} from './session.js';
import {createDoubaoAdapter,buildPrompt} from './adapter.js';
const user=text=>({role:'user',content:[{type:'text',text}]});
const assistant=text=>({role:'assistant',content:[{type:'text',text}]});
const base={sessionId:'s1',accountKey:'account-hash',scope:{model:'0',system:'s',tools:[]},messages:[user('hello')]};
function seed(store,options=base){const p=store.prepare(options);assert.equal(p.continuation,undefined);assert.equal(p.commit({conversationId:'conv-a',sectionId:'sec-a',assistant:assistant('answer')}),true);return p;}
const next={...base,messages:[...base.messages,assistant('answer'),user('next')]};
test('old plan cannot commit after account clear, forget, or a newer plan',()=>{
 for(const invalidate of [s=>s.clear(),s=>s.forget('s1'),s=>s.prepare(base)]){
  const s=new ConversationStore(),p=s.prepare(base);invalidate(s);
  assert.equal(p.commit({conversationId:'old',assistant:assistant('old')}),false);
 }
});
test('strict prefix and real session identity yield only the new message',()=>{
 const store=new ConversationStore();seed(store);const p=store.prepare(next);
 assert.equal(p.from,2);assert.deepEqual(p.continuation,{conversationId:'conv-a',sectionId:'sec-a',accountKey:'account-hash'});
 assert.equal(store.size,0,'consuming a plan invalidates its old state until success');
});
for(const [name,change] of [
 ['different DSH session',{sessionId:'s2'}],['missing session',{sessionId:undefined}],['missing account',{accountKey:undefined}],['account switched',{accountKey:'other'}],['model switched',{scope:{...base.scope,model:'3'}}],['system changed',{scope:{...base.scope,system:'other'}}],['tools changed',{scope:{...base.scope,tools:[{name:'other'}]}}],['title generation',{purpose:'session-title'}],['compaction',{purpose:'compaction'}],['images',{hasImages:true}],['edited prefix',{messages:[user('edited'),assistant('answer'),user('next')]}],['edited assistant',{messages:[user('hello'),assistant('different'),user('next')]}],['regeneration',{messages:[user('hello')]}],['shorter history',{messages:[]}],
])test('starts fresh: '+name,()=>{const store=new ConversationStore();seed(store);assert.equal(store.prepare({...next,...change}).continuation,undefined);});
test('TTL expiration, clock rollback, eviction and metadata-only storage',()=>{
 let now=100;const store=new ConversationStore({ttlMs:10,maxEntries:1,now:()=>now});seed(store);assert.doesNotMatch(JSON.stringify([...store.entries.values()]),/hello|answer|account-hash/);
 now=111;assert.equal(store.prepare(next).continuation,undefined);now=120;seed(store);now=119;assert.equal(store.prepare(next).continuation,undefined);
 now=130;seed(store);seed(store,{...base,sessionId:'s2'});assert.equal(store.size,1);assert.equal(store.prepare(next).continuation,undefined);
});
function fixture(adapterOptions={}){
 let accountKey='account-hash';let events;const requests=[],records=[];
 const bridge={inspect:async()=>({accountKey,models:[{id:'0',name:'Quick',modeId:'1',agentMode:2}]}),async *stream(r){requests.push(r);for(const e of events??[{type:'ack',conversationId:'conv-a',sectionId:'sec-a'},{type:'text',text:'answer'},{type:'done'}])yield e;}};
 return {adapter:createDoubaoAdapter({bridge,ledger:{record:async r=>records.push(r)},...adapterOptions}),requests,records,setEvents:e=>events=e,setAccount:k=>accountKey=k};
}
async function collect(it){return Array.fromAsync(it);}
const options={provider:'doubao-client',model:'0',sessionId:'s1',system:'s',messages:[user('hello')]};
test('adapter transmits deltas, uses ACK and preserves explicit system/tool instructions',async()=>{
 const f=fixture();await collect(f.adapter.stream(options));const result=await collect(f.adapter.stream({...options,messages:[...options.messages,assistant('answer'),user('next')]}));
 assert.equal(result.at(-1).reason.kind,'stop');const r=f.requests[1];assert.equal(r.continuation.conversationId,'conv-a');
 const body=JSON.parse(r.prompt.split('DSH_REQUEST_JSON\n')[1]);assert.equal(body.system,'s');assert.deepEqual(body.messages,[user('next')]);assert.match(r.prompt,/incremental DSH turn/);assert.equal(f.records.length,2);
});
test('missing identity and missing session never reuse upstream conversation',async()=>{
 for(const missing of ['account','session']){const f=fixture();const opts={...options};if(missing==='account')f.setAccount(undefined);else delete opts.sessionId;await collect(f.adapter.stream(opts));await collect(f.adapter.stream({...opts,messages:[...opts.messages,assistant('answer'),user('next')]}));assert.equal(f.requests[1].continuation,undefined);}
});
test('failed, cancelled and incomplete rounds invalidate continuation',async()=>{
 for(const terminal of [{type:'error',code:'DOUBAO_RISK_CONTROL',message:'stop'},{type:'cancelled'},null]){
  const f=fixture();await collect(f.adapter.stream(options));f.setEvents([{type:'ack',conversationId:'conv-a'},{type:'text',text:'partial'},...terminal?[terminal]:[]]);
  const opts={...options,messages:[...options.messages,assistant('answer'),user('next')]};await collect(f.adapter.stream(opts));
  f.setEvents(undefined);await collect(f.adapter.stream({...opts,messages:[...opts.messages,assistant('partial'),user('retry')]}));assert.equal(f.requests[2].continuation,undefined);
 }
});
test('assistant tool IDs are fingerprinted from emitted DSH blocks, not raw JSON envelopes',async()=>{
 const f=fixture();const tool={name:'lookup',description:'test',parameters:{type:'object'}};
 f.setEvents([{type:'ack',conversationId:'conv-a'},{type:'text',text:'{"dsh_tool_calls":[{"name":"lookup","arguments":{"q":"x"}}]}'},{type:'done'}]);
 const opts={...options,tools:[tool]};const first=await collect(f.adapter.stream(opts));const call=first.find(c=>c.type==='block-end').block;assert.equal(call.type,'tool-call');
 f.setEvents(undefined);await collect(f.adapter.stream({...opts,messages:[...opts.messages,{role:'assistant',content:[call]},{role:'tool',toolCallId:call.id,content:[{type:'text',text:'found'}]}]}));assert.equal(f.requests[1].continuation.conversationId,'conv-a');
});
test('different ACK on continuation is rejected and next round starts fresh',async()=>{
 const f=fixture();await collect(f.adapter.stream(options));f.setEvents([{type:'ack',conversationId:'wrong'},{type:'text',text:'answer'},{type:'done'}]);
 const opts={...options,messages:[...options.messages,assistant('answer'),user('next')]};const result=await collect(f.adapter.stream(opts));assert.equal(result.at(-1).reason.failure.code,'DOUBAO_CONTINUITY_LOST');
 f.setEvents(undefined);await collect(f.adapter.stream({...opts,messages:[...opts.messages,assistant('answer'),user('again')]}));assert.equal(f.requests[2].continuation,undefined);
});
test('abandoned consumer, missing ACK and invalid tool envelopes do not retain session state',async()=>{
 const abandoned=fixture();const iterator=abandoned.adapter.stream(options);await iterator.next();await iterator.return();assert.equal(abandoned.adapter.continuityStatus().storedSessions,0);
 const noAck=fixture();noAck.setEvents([{type:'text',text:'answer'},{type:'done'}]);await collect(noAck.adapter.stream(options));assert.equal(noAck.adapter.continuityStatus().storedSessions,0);
 const invalid=fixture();invalid.setEvents([{type:'ack',conversationId:'conv-a'},{type:'text',text:'{"dsh_tool_calls":[{"name":"not-allowed","arguments":{}}]}'},{type:'done'}]);
 const result=await collect(invalid.adapter.stream({...options,tools:[{name:'lookup',description:'x',parameters:{type:'object'}}]}));assert.equal(result.at(-1).reason.failure.code,'DOUBAO_BAD_TOOL_CALL');assert.equal(invalid.adapter.continuityStatus().storedSessions,0);
});

test('a session that grew past the local character cap keeps working by transmitting only the delta',async()=>{
 const cap=20000,f=fixture({maxPromptChars:cap});
 let messages=[user('start')];
 assert.equal((await collect(f.adapter.stream({...options,messages}))).at(-1).reason.kind,'stop');
 for(let i=0;i<14;i++){
  messages=[...messages,assistant('answer'),user('第'+i+'条填充：'+'填'.repeat(1500))];
  assert.equal((await collect(f.adapter.stream({...options,messages}))).at(-1).reason.kind,'stop','第 '+i+' 轮应继续可用');
 }
 const tail=[...messages,assistant('answer'),user('最后一个问题')];
 const full=buildPrompt({...options,messages:tail},{maxPromptChars:Number.MAX_SAFE_INTEGER});
 assert.ok(full.length>cap,`完整历史应已超过本地上限（实际 ${full.length} > ${cap}）`);
 const last=await collect(f.adapter.stream({...options,messages:tail}));
 assert.equal(last.at(-1).reason.kind,'stop');
 assert.ok(f.requests.at(-1).prompt.length<cap,`只应转交增量（实际 ${f.requests.at(-1).prompt.length}）`);
 assert.match(f.requests.at(-1).prompt,/incremental DSH turn/);
});
test('a fresh session whose full history exceeds the cap still fails clearly before upstream',async()=>{
 const cap=20000,f=fixture({maxPromptChars:cap});
 const huge=Array.from({length:30},(_,i)=>user('第'+i+'条：'+'填'.repeat(1500)));
 const result=await collect(f.adapter.stream({...options,messages:huge}));
 assert.equal(result.at(-1).reason.failure.code,'DOUBAO_PROMPT_LIMIT');
 assert.match(result.at(-1).reason.failure.message,/压缩上下文或新建会话/);
 assert.equal(f.requests.length,0,'超限的完整历史不得发往上游');
});
test('unsupported blocks fail even when only a delta would be transmitted',async()=>{
 const f=fixture();await collect(f.adapter.stream(options));
 f.setEvents(undefined);
 const withBadBlock=[...options.messages,assistant('answer'),user('next')];
 withBadBlock[0]={role:'user',content:[{type:'text',text:'hello'},{type:'file',attachment:{attachmentId:'x'}}]};
 const result=await collect(f.adapter.stream({...options,messages:withBadBlock}));
 assert.equal(result.at(-1).reason.failure.code,'DOUBAO_UNSUPPORTED_INPUT');assert.equal(f.requests.length,1);
});

test('an abandoned consumer releases the DSH session lock instead of blocking it forever',async()=>{
 const f=fixture({abandonedConsumerMs:60});
 const stream=f.adapter.stream(options);await stream.next(); // 取用第一项后即放弃
 await new Promise(resolve=>setTimeout(resolve,160));
 const again=await collect(f.adapter.stream(options));
 assert.equal(again.at(-1).reason.kind,'stop','被放弃的流不得让该会话永久占用：'+JSON.stringify(again.at(-1).reason));
});
test('a second request in the same session waits for the in-flight turn instead of failing',async()=>{
 const f=fixture({busyWaitMs:1500});
 const first=f.adapter.stream(options);await first.next();      // 第一轮持有会话锁并挂起在 yield 上
 const second=collect(f.adapter.stream(options));               // 同一会话的第二轮：应排队等待
 await new Promise(resolve=>setTimeout(resolve,80));
 await first.return();                                          // 第一轮收尾并释放
 const result=await second;
 assert.equal(result.at(-1).reason.kind,'stop','等待释放后应正常执行');
});
test('waiting aborts promptly when the caller cancels',async()=>{
 const f=fixture({busyWaitMs:5000});
 const first=f.adapter.stream(options);await first.next();
 const controller=new AbortController();
 const waiting=collect(f.adapter.stream({...options,signal:controller.signal}));
 await new Promise(resolve=>setTimeout(resolve,60));
 controller.abort(new Error('cancelled by test'));
 const result=await waiting;
 assert.match(JSON.stringify(result.at(-1).reason),/cancel|abort/i);
 await first.return();
});
test('resuming abandoned output cannot overwrite a newer completed turn',async()=>{
 const f=fixture({abandonedConsumerMs:50}),old=f.adapter.stream(options);
 await old.next();await new Promise(r=>setTimeout(r,100));
 await collect(f.adapter.stream(options));assert.equal(f.adapter.continuityStatus().storedSessions,1);
 const remaining=await collect(old);assert.equal(remaining.length,0);
 assert.equal(f.adapter.continuityStatus().storedSessions,1);
});
test('unconfirmed downstream stop quarantines the same session as well as its channel',async()=>{
 const bridge={inspect:async()=>({accountKey:'account-hash',models:[{id:'0',modeId:'1',agentMode:2}]}),async *stream(r){r.onCleanupAvailable(async()=>false);yield {type:'text',text:'partial'};}};
 const adapter=createDoubaoAdapter({bridge,ledger:{record:async()=>{}},abandonedConsumerMs:50});
 const old=adapter.stream(options);await old.next();await new Promise(r=>setTimeout(r,100));
 assert.equal(adapter.continuityStatus().quarantinedSessions,1);
 const result=await collect(adapter.stream(options));assert.equal(result.at(-1).reason.failure.code,'DOUBAO_SESSION_BUSY');
 await collect(old);
});
test('parallel requests in the same DSH session fail closed without consuming active mapping',async()=>{
 let release;const wait=new Promise(r=>release=r);
 // Block the upstream response so this session remains in flight until finish.
 const bridge={inspect:async()=>({accountKey:'a',models:[{id:'0',modeId:'1',agentMode:2}]}),async *stream(){await wait;yield {type:'text',text:'answer'};yield {type:'done'};}};
 const adapter=createDoubaoAdapter({bridge,ledger:{record:async()=>{}}});const active=collect(adapter.stream(options));await Promise.resolve();
 const second=await collect(adapter.stream(options));assert.equal(second.at(-1).reason.failure.code,'DOUBAO_SESSION_BUSY');release();assert.equal((await active).at(-1).reason.kind,'stop');
});
