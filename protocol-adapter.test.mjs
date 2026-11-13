import test from 'node:test';
import assert from 'node:assert/strict';
import {createProtocolDecoder, normalizeQuota} from './protocol.js';
import {buildPrompt, parseToolEnvelope, createDoubaoAdapter, PROVIDER} from './adapter.js';

const block = (text, id = 'text') => ({block_id:id, content:{text_block:{text}}});
const notify = blocks => ({content:{content_block:blocks}});
const full = blocks => ({message:{user_type:2, content_block:blocks}});
const patch = (blocks, patch_type = 1) => ({patch_op:[{patch_type, patch_value:{content_block:blocks}}]});
const done = {type:'done'};
const MODEL = {id:'0', name:'Fast', modeId:'1', agentMode:2, contextWindow:32000};
const TOOL = {name:'lookup', description:'Read test data', parameters:{type:'object', properties:{query:{type:'string'}}}};
const OPTIONS = {provider:PROVIDER, model:'0', system:'System rules', messages:[{role:'user', content:[{type:'text', text:'hello'}]}]};
const collect = async iterable => {const result=[]; for await (const item of iterable) result.push(item); return result;};
function fixture(events = [{type:'text', text:'answer'}, done], config = {}) {
  const records=[], requests=[];
  const bridge = {inspect:async()=>({models:[MODEL, {id:'work', modeId:'2', agentMode:3}]}), async *stream(request){requests.push(request); for (const event of events) yield event;}};
  const adapter=createDoubaoAdapter({bridge, ledger:{async record(row){records.push(row);}}, ...config});
  return {adapter, records, requests};
}

test('decoder composes notify, chunk patches, CHUNK_DELTA and full snapshot without duplication', () => {
  const decoder=createProtocolDecoder();
  assert.deepEqual(decoder.accept('SSE_HEARTBEAT', {}), []);
  assert.deepEqual(decoder.accept('SSE_ACK', {ack_client_meta:{conversation_id:'c'}}), [{type:'ack', conversationId:'c'}]);
  assert.deepEqual(decoder.accept('STREAM_MSG_NOTIFY', notify([block('hel')])), [{type:'text',text:'hel'}]);
  assert.deepEqual(decoder.accept('STREAM_CHUNK', patch([block('lo')])), [{type:'text',text:'lo'}]);
  assert.deepEqual(decoder.accept('CHUNK_DELTA', {text:'!'}), [{type:'text',text:'!'}]);
  assert.deepEqual(decoder.accept('FULL_MSG_NOTIFY', full([block('hello!')])), []);
  assert.deepEqual(decoder.accept('FULL_MSG_NOTIFY', full([block('hello! Next')])), [{type:'text',text:' Next'}]);
  assert.deepEqual(decoder.accept('SSE_REPLY_END', {end_type:1}), []);
  assert.equal(decoder.finished, false);
  assert.deepEqual(decoder.accept('SSE_REPLY_END', {end_type:3}), [done]);
  assert.equal(decoder.finished, true);
  assert.deepEqual(decoder.accept('CHUNK_DELTA', {text:'ignored'}), []);
});

test('decoder handles reasoning and replacement patches; rejects revisions and orphan deltas', () => {
  const decoder=createProtocolDecoder();
  assert.deepEqual(decoder.accept('STREAM_MSG_NOTIFY', notify([{block_id:'r',content:{thinking_block:{text:'think'}}}])), [{type:'reasoning',text:'think'}]);
  assert.deepEqual(decoder.accept('CHUNK_DELTA', {text:' more'}), [{type:'reasoning',text:' more'}]);
  assert.deepEqual(decoder.accept('STREAM_CHUNK', patch([block('A')], 2)), [{type:'text',text:'A'}]);
  assert.deepEqual(decoder.accept('STREAM_CHUNK', patch([block('AB')], 2)), [{type:'text',text:'B'}]);
  assert.throws(()=>decoder.accept('FULL_MSG_NOTIFY', full([block('changed')])), /revised/);
  assert.throws(()=>createProtocolDecoder().accept('CHUNK_DELTA',{text:'orphan'}), /active text block/);
  assert.deepEqual(createProtocolDecoder().accept('FULL_MSG_NOTIFY',{message:{user_type:1,content_block:[block('user')]}}), []);
});

for (const event of ['STREAM_ERROR','SSE_ERROR','STREAM_MSG_ERROR']) {
  test(`decoder rejects explicit upstream error ${event}`, () => {
    assert.throws(()=>createProtocolDecoder().accept(event,{code:42,message:'rejected'}), /42: rejected/);
  });
}
for (const event of ['STREAM_MSG_NOTIFY','STREAM_CHUNK','FULL_MSG_NOTIFY']) {
  for (const type of ['tool_call_block','tool_use_block','pc_event_block']) {
    test(`decoder rejects native ${type} in ${event}`, () => {
      const blocks=[{block_id:'native',content:{[type]:{name:'desktop'}}}];
      const data=event==='STREAM_CHUNK'?patch(blocks):event==='FULL_MSG_NOTIFY'?full(blocks):notify(blocks);
      assert.throws(()=>createProtocolDecoder().accept(event,data), /Native Doubao task tools/);
    });
  }
}

test('token usage accepts only actual numeric counters; commerce is not token usage', () => {
  const decoder=createProtocolDecoder();
  const meta = ext => decoder.accept('STREAM_MSG_NOTIFY', {content:{ext}});
  assert.deepEqual(meta({token_usage:{input_tokens:4,output_tokens:5,total_tokens:9}}), [{type:'usage',usage:{inputTokens:4,outputTokens:5,totalTokens:9}}]);
  assert.deepEqual(meta({usage:JSON.stringify({prompt_tokens:0,completion_tokens:2})}), [{type:'usage',usage:{inputTokens:0,outputTokens:2}}]);
  assert.deepEqual(meta({usage:{input_tokens:'4',output_tokens:5}}), []);
  assert.deepEqual(meta({usage:{total_tokens:9}}), []);
  const commerce=meta({commerce_usage_data_v1:{summary:{label:'credits',value:100}}});
  assert.equal(commerce[0].type, 'commerce');
  assert.equal(commerce.some(e=>e.type==='usage'), false);
});

test('quota distinguishes known numbers, comma-separated amounts, and unknown values', () => {
  assert.deepEqual(normalizeQuota(null,'checked').windows, []);
  assert.equal(normalizeQuota(null,'checked').status,'unknown');
  const q=normalizeQuota({member_info:{hasActiveSubscription:true},window_limit_section:{window_limit_groups:[{feature_group:'chat',feature_group_name:'Chat',window_limits:[
    {window_type:1,used_amount:'1,234.5',total_amount:'2,000',used_percent:61.725,end_time:1700000000000},
    {window_type:2,used_amount:'unknown',total_amount:null},
    {window_type:1,used_amount:0,total_amount:0,exemption:{active:true}},
  ]}]}},'checked');
  assert.equal(q.checkedAt,'checked');
  assert.equal(q.windows[0].used,1234.5);
  assert.equal(q.windows[0].remaining,765.5);
  assert.equal(q.windows[0].resetAt,new Date(1700000000000).toISOString());
  assert.equal(q.windows[1].remaining,null);
  assert.equal(q.windows[2].unlimited,true);
  assert.match(q.windows[0].unit,/不是 token/);
});

test('adapter performs DSH tool-call/result two-stage exchange without executing tools', async () => {
  const envelope=JSON.stringify({dsh_tool_calls:[{name:'lookup',arguments:{query:'test'}}]});
  const first=fixture([{type:'reasoning',text:'need data'},{type:'text',text:envelope},done]);
  const chunks=await collect(first.adapter.stream({...OPTIONS,tools:[TOOL]}));
  assert.deepEqual(chunks.map(c=>c.type), ['block-start','reasoning-delta','block-end','block-start','tool-call-delta','block-end','finish']);
  assert.deepEqual(chunks[0],{type:'block-start',index:0,blockType:'reasoning'});
  const call=chunks.find(c=>c.type==='block-end'&&c.block.type==='tool-call').block;
  assert.equal(call.name,'lookup');
  assert.deepEqual(JSON.parse(call.arguments),{query:'test'});
  assert.match(call.id,/^doubao_/);
  assert.deepEqual(chunks.find(c=>c.type==='tool-call-delta'),{type:'tool-call-delta',index:1,id:call.id,name:'lookup',argumentsDelta:call.arguments});
  assert.deepEqual(chunks.at(-1),{type:'finish',reason:{kind:'tool-calls'}});
  assert.equal(chunks.some(c=>c.type==='text-delta'),false);
  assert.equal(first.records[0].status,'success');
  const second=fixture();
  const result=await collect(second.adapter.stream({...OPTIONS,tools:[TOOL],messages:[...OPTIONS.messages,{role:'assistant',content:[call]},{role:'tool',toolCallId:call.id,content:[{type:'text',text:'tool result'}]}]}));
  assert.equal(result.at(-1).reason.kind,'stop');
  const request=JSON.parse(second.requests[0].prompt.split('DSH_REQUEST_JSON\n')[1]);
  assert.equal(request.system,OPTIONS.system);
  assert.equal(request.messages.at(-1).tool_call_id,call.id);
  assert.equal(request.messages.at(-1).content[0].text,'tool result');
  assert.deepEqual(request.available_tools,[TOOL]);
});

test('tool envelope validates available names and argument objects', async () => {
  assert.throws(()=>parseToolEnvelope('{"dsh_tool_calls":[{"name":"other","arguments":{}}]}',[TOOL]), {code:'DOUBAO_BAD_TOOL_CALL'});
  assert.throws(()=>parseToolEnvelope('{"dsh_tool_calls":[{"name":"lookup","arguments":[]}]}',[TOOL]), {code:'DOUBAO_BAD_TOOL_CALL'});
  const {adapter,records}=fixture([{type:'text',text:'{"dsh_tool_calls":[{"name":"other","arguments":{}}]}'},done]);
  const chunks=await collect(adapter.stream({...OPTIONS,tools:[TOOL]}));
  assert.equal(chunks.some(c=>c.blockType==='tool-call'),false);
  assert.equal(chunks.at(-1).reason.failure.code,'DOUBAO_BAD_TOOL_CALL');
  assert.equal(records[0].status,'error');
});

test('unsupported model never falls back and safe model list excludes work model', async () => {
  const f=fixture();
  assert.deepEqual((await f.adapter.listModels(PROVIDER)).map(m=>m.id),['0']);
  await assert.rejects(f.adapter.resolveModel(PROVIDER,'work'),{code:'DOUBAO_UNSUPPORTED_MODEL'});
  const chunks=await collect(f.adapter.stream({...OPTIONS,model:'work'}));
  assert.equal(chunks.at(-1).reason.failure.code,'DOUBAO_UNSUPPORTED_MODEL');
  assert.equal(f.requests.length,0);
  assert.equal(f.adapter.providerRetryPolicy().maxRetries,0);
});
for (const control of [{temperature:0},{maxTokens:100},{stop:['END']}]) {
  test(`explicit unsupported control ${Object.keys(control)[0]} is rejected before upstream`, async () => {
    const f=fixture();
    const chunks=await collect(f.adapter.stream({...OPTIONS,...control}));
    assert.equal(chunks.at(-1).reason.failure.code,'DOUBAO_UNSUPPORTED_CONTROL');
    assert.equal(f.requests.length,0);
  });
}

test('unknown token usage emits no invented usage; actual server usage is forwarded', async () => {
  const f=fixture();
  const chunks=await collect(f.adapter.stream(OPTIONS));
  assert.equal(chunks.some(c=>c.type==='usage'),false);
  assert.equal(f.records[0].serverUsage,null);
  assert.equal(f.records[0].chars.output,6);
  const measured=fixture([{type:'text',text:'ok'},{type:'usage',usage:{inputTokens:3,outputTokens:1}},done]);
  assert.deepEqual((await collect(measured.adapter.stream(OPTIONS))).find(c=>c.type==='usage'),{type:'usage',usage:{inputTokens:3,outputTokens:1}});
});
for (const terminal of [{type:'error',code:'TEST_UPSTREAM',message:'failed'},{type:'cancelled'}]) {
  test(`partial ${terminal.type} records measured characters and correct terminal state`, async () => {
    const f=fixture([{type:'text',text:'partial'},terminal]);
    const chunks=await collect(f.adapter.stream(OPTIONS));
    assert.equal(chunks.at(-1).reason.kind,terminal.type==='cancelled'?'aborted':'error');
    assert.equal(f.records.length,1);
    assert.equal(f.records[0].status,terminal.type==='cancelled'?'cancelled':'error');
    assert.equal(f.records[0].chars.output,7);
    assert.equal(f.records[0].serverUsage,null);
  });
}

test('missing done and empty output cannot be successful', async () => {
  for (const [events,code] of [[[{type:'text',text:'partial'}],'DOUBAO_INCOMPLETE'],[[done],'DOUBAO_EMPTY_RESPONSE']]) {
    const f=fixture(events);
    const chunks=await collect(f.adapter.stream(OPTIONS));
    assert.equal(chunks.at(-1).reason.failure.code,code);
    assert.equal(f.records[0].status,'error');
  }
});

test('image blocks are projected by DSH and forwarded as real attachments', async () => {
  const projected=[];
  const f=fixture(undefined,{readImageRequest:async(ref,target)=>{projected.push({ref,target});return {data:Buffer.from('PNGBYTES'),mediaType:'image/png',width:120,height:60};}});
  const chunks=await collect(f.adapter.stream({...OPTIONS,messages:[{role:'user',content:[{type:'text',text:'what is in the picture'},{type:'image',attachment:{attachmentId:'a1',mediaType:'image/png',bytes:8,width:120,height:60,name:'shot.png'}}]}]}));
  assert.equal(chunks.at(-1).reason.kind,'stop');
  assert.deepEqual(projected[0].target,{width:1568,height:1568,maxBytes:1200*1024});
  assert.deepEqual(projected[0].ref,{attachmentId:'a1',mediaType:'image/png',bytes:8,width:120,height:60,name:'shot.png'});
  const request=f.requests[0];
  assert.deepEqual(request.images,[{base64:Buffer.from('PNGBYTES').toString('base64'),mediaType:'image/png',name:'shot.png',width:120,height:60}]);
  const payload=JSON.parse(request.prompt.split('DSH_REQUEST_JSON\n')[1]);
  assert.deepEqual(payload.images,[{index:0,name:'shot.png',width:120,height:60,mediaType:'image/png'}]);
  assert.deepEqual(payload.messages[0].content,[{type:'text',text:'what is in the picture'},{type:'image'}]);
  assert.match(request.prompt,/1 张图片已作为真实图片附件/);
});

test('image without the attachment service and oversized prompts fail before upstream', async () => {
  const f=fixture();
  const chunks=await collect(f.adapter.stream({...OPTIONS,messages:[{role:'user',content:[{type:'image',attachment:{attachmentId:'a1',mediaType:'image/png',bytes:8,width:10,height:10}}]}]}));
  assert.equal(chunks.at(-1).reason.failure.code,'DOUBAO_IMAGE_UNAVAILABLE');
  assert.equal(f.requests.length,0);
  assert.throws(()=>parseToolEnvelope('{"dsh_tool_calls":[{"name":"lookup","arguments":{}}]}',[]),{code:'DOUBAO_BAD_TOOL_CALL'});
  const many=fixture(undefined,{readImageRequest:async()=>({data:Buffer.from('x'),mediaType:'image/png',width:1,height:1})});
  const nine=Array.from({length:9},(_,i)=>({type:'image',attachment:{attachmentId:`a${i}`,mediaType:'image/png',bytes:1,width:1,height:1}}));
  const tooMany=await collect(many.adapter.stream({...OPTIONS,messages:[{role:'user',content:nine}]}));
  assert.equal(tooMany.at(-1).reason.failure.code,'DOUBAO_TOO_MANY_IMAGES');
  assert.equal(many.requests.length,0);
  assert.throws(()=>buildPrompt(OPTIONS,{maxPromptChars:10}),{code:'DOUBAO_PROMPT_LIMIT'});
  const small=fixture(undefined,{maxPromptChars:10});
  assert.equal((await collect(small.adapter.stream(OPTIONS))).at(-1).reason.failure.code,'DOUBAO_PROMPT_LIMIT');
  assert.equal(small.requests.length,0);
  const unsupported=fixture(undefined,{readImageRequest:async()=>({data:Buffer.from('x'),mediaType:'image/png',width:1,height:1})});
  const bad=await collect(unsupported.adapter.stream({...OPTIONS,messages:[{role:'user',content:[{type:'audio',url:'x'}]}]}));
  assert.equal(bad.at(-1).reason.failure.code,'DOUBAO_UNSUPPORTED_INPUT');
  assert.equal(unsupported.requests.length,0);
});

test('unmet image projection byte target is rejected before upload or model dispatch',async()=>{
 const f=fixture(undefined,{readImageRequest:async()=>({data:Buffer.alloc(1200*1024+1),mediaType:'image/png',width:1,height:1})});
 const chunks=await collect(f.adapter.stream({...OPTIONS,messages:[{role:'user',content:[{type:'image',attachment:{attachmentId:'large',mediaType:'image/png',bytes:1200*1024+1,width:1,height:1}}]}]}));
 assert.equal(chunks.at(-1).reason.failure.code,'DOUBAO_IMAGE_TOO_LARGE');assert.equal(f.requests.length,0);
});

test('work-task models are registered and dispatched in chat mode with a chat-safe thinking code', async () => {
  const MODELS=[
    {id:'0',name:'Fast',modeId:'1',agentMode:2},
    {id:'person-glm-5-3-261111',name:'GLM 5.3',modeId:'3',agentMode:1,itemId:10001,contextWindow:300000,reasoning:{defaultLevel:3,options:[{id:'3',name:'Low'}]}},
    {id:'9',name:'Auto',modeId:'3',agentMode:1,itemId:9},
    {id:'5',name:'Pro',modeId:'3',agentMode:1,itemId:5},
    {id:'future-task-model',name:'Unverified',modeId:'3',agentMode:1,itemId:10001},
  ];
  const requests=[];
  const bridge={inspect:async()=>({models:MODELS}),async *stream(request){requests.push(request);yield {type:'text',text:'ok'};yield done;}};
  const adapter=createDoubaoAdapter({bridge,ledger:{async record(){}},trustDeclaredWindow:true});
  const list=await adapter.listModels(PROVIDER);
  assert.deepEqual(list.map(m=>m.id),['0','person-glm-5-3-261111','9','5']);
  assert.match(list[1].name,/对话模式/);
  assert.match(list[1].description,/任务运行时/);
  const resolved=await adapter.resolveModel(PROVIDER,'person-glm-5-3-261111');
  assert.equal(resolved.context.contextWindow,300000);
  assert.deepEqual(resolved.reasoning.efforts,[{id:'3',name:'Low'}]);
  await collect(adapter.stream({...OPTIONS,model:'person-glm-5-3-261111'}));
  // The client only offers these under 工作任务; the request must be plain chat.
  assert.equal(requests[0].model.modeId,'1');
  assert.equal(requests[0].model.agentMode,2);
  assert.equal(requests[0].model.access,'work-chat');
  assert.equal(requests[0].model.itemId,10001);
  // Task-only thinking codes must be replaced; otherwise the upstream rejects them.
  await collect(adapter.stream({...OPTIONS,model:'9'}));
  assert.equal(requests[1].model.thinkingCode,2);
  await collect(adapter.stream({...OPTIONS,model:'5'}));
  assert.equal(requests[2].model.thinkingCode,2);
  const rejected=await collect(adapter.stream({...OPTIONS,model:'future-task-model'}));
  assert.equal(rejected.at(-1).reason.failure.code,'DOUBAO_UNSUPPORTED_MODEL');
  assert.equal(requests.length,3);
});
