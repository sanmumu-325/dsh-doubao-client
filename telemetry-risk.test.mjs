import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createProtocolDecoder} from './protocol.js';

const meta = ext => createProtocolDecoder().accept('STREAM_MSG_NOTIFY', {content:{ext}});
const windowEvent = window => [{type:'context-window',window}];
const complete = {system_prompt:10,messages:20,skills:3,tools:4,total_window_size:100};
const expected = {systemPrompt:10,messages:20,skills:3,tools:4,totalWindowSize:100,totalUsed:37};
const block = text => ({block_id:'b',content:{text_block:{text}}});
const patch = (patch_value, patch_type=1) => ({patch_op:[{patch_type,patch_value}]});

test('window telemetry accepts object/string ext and object/string counters independently', () => {
  for(const encodeExt of [v=>v,JSON.stringify])for(const encodeWindow of [v=>v,JSON.stringify]) {
    assert.deepEqual(meta(encodeExt({context_window_usage:encodeWindow(complete)})),windowEvent(expected));
    assert.deepEqual(meta(encodeExt({context_window_usage:encodeWindow(Object.fromEntries(Object.entries(complete).map(([k,v])=>[k,String(v)])))})),windowEvent(expected));
  }
});

test('missing counters stay missing, totalUsed needs all four components, and zero is explicit', () => {
  assert.deepEqual(meta({context_window_usage:{messages:0}}),windowEvent({messages:0}));
  assert.deepEqual(meta({context_window_usage:{total_window_size:'0'}}),windowEvent({totalWindowSize:0}));
  assert.deepEqual(meta({context_window_usage:{system_prompt:0,messages:0,skills:'0',tools:0}}),windowEvent({systemPrompt:0,messages:0,skills:0,tools:0,totalUsed:0}));
  for(const key of ['system_prompt','messages','skills','tools']) {
    const partial={...complete};delete partial[key];
    const [event]=meta({context_window_usage:partial});
    assert.equal(Object.hasOwn(event.window,'totalUsed'),false);
    assert.equal(Object.hasOwn(event.window,({system_prompt:'systemPrompt'})[key]??key),false);
  }
});

test('malformed, missing, array and primitive metadata emit nothing', () => {
  for(const ext of [undefined,null,0,true,[],{},'', '{', 'null','[]','1','true'])assert.deepEqual(meta(ext),[]);
  for(const value of [undefined,null,[],0,false,'','{','null','[]','1','true',{}, {unknown:1}])assert.deepEqual(meta({context_window_usage:value}),[]);
});

test('only nonnegative safe integers and decimal digit strings are accepted without coercion', () => {
  const hostile={valueOf(){throw new Error('must not coerce')},toString(){throw new Error('must not stringify')}};
  for(const bad of [-1,1.5,NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER+1,null,true,false,{},[],hostile,'-1','1.5','1e3','0x10','1,000',' 1','1 ','','Infinity','NaN','9007199254740992','9007199254740993']) {
    assert.deepEqual(meta({context_window_usage:{messages:bad}}),[],typeof bad==='string'?bad:typeof bad);
  }
  assert.deepEqual(meta({context_window_usage:{messages:'00012'}}),windowEvent({messages:12}));
  assert.deepEqual(meta({context_window_usage:{messages:String(Number.MAX_SAFE_INTEGER)}}),windowEvent({messages:Number.MAX_SAFE_INTEGER}));
});

test('safe-integer boundaries never publish rounded or overflowing totalUsed', () => {
  const max=Number.MAX_SAFE_INTEGER;
  assert.deepEqual(meta({context_window_usage:{system_prompt:max-3,messages:1,skills:1,tools:1}}),windowEvent({systemPrompt:max-3,messages:1,skills:1,tools:1,totalUsed:max}));
  assert.deepEqual(meta({context_window_usage:{system_prompt:max,messages:1,skills:0,tools:0}}),windowEvent({systemPrompt:max,messages:1,skills:0,tools:0}));
  assert.deepEqual(meta({context_window_usage:'{"messages":9007199254740993}'}),[]);
});

test('context metadata is an own-property whitelist, not an arbitrary account payload', () => {
  const malicious=JSON.parse('{"system_prompt":1,"messages":2,"skills":3,"tools":4,"total_window_size":100,"totalUsed":999,"input_tokens":999,"account_id":"secret-account","__proto__":{"polluted":true},"constructor":99}');
  assert.deepEqual(meta({context_window_usage:malicious}),windowEvent({systemPrompt:1,messages:2,skills:3,tools:4,totalWindowSize:100,totalUsed:10}));
  assert.deepEqual(meta({context_window_usage:Object.create(complete)}),[]);
  assert.deepEqual(meta(Object.create({context_window_usage:complete})),[]);
  assert.equal({}.polluted,undefined);
});

test('window telemetry does not invent token usage or confuse billing and credits', () => {
  const events=meta({context_window_usage:complete,commerce_usage_data_v1:{summary:{label:'credits',value:'7'}}});
  assert.deepEqual(events,[...windowEvent(expected),{type:'commerce',summary:{label:'credits',value:'7'}}]);
  assert.equal(events.some(e=>e.type==='usage'),false);
  assert.deepEqual(meta(JSON.stringify({context_window_usage:{messages:4},token_usage:{input_tokens:2,output_tokens:3,total_tokens:5}})),[
    ...windowEvent({messages:4}),{type:'usage',usage:{inputTokens:2,outputTokens:3,totalTokens:5}},
  ]);
  assert.deepEqual(meta({token_usage:{input_tokens:'2',output_tokens:3}}),[]);
});

test('all metadata-bearing events decode object/string ext and STREAM_CHUNK string patch_value', () => {
  for(const encodeExt of [v=>v,JSON.stringify]) {
    const ext=encodeExt({context_window_usage:complete});
    for(const [event,data] of [
      ['STREAM_MSG_NOTIFY',{content:{ext}}],
      ['FULL_MSG_NOTIFY',{message:{user_type:2,ext}}],
      ['STREAM_CHUNK',patch({ext})],
      ['STREAM_CHUNK',patch(JSON.stringify({ext}))],
    ])assert.deepEqual(createProtocolDecoder().accept(event,data),windowEvent(expected));
  }
});

test('string patch_value preserves incremental, replacement, reasoning and full-snapshot behavior', () => {
  const d=createProtocolDecoder();
  assert.deepEqual(d.accept('STREAM_CHUNK',patch(JSON.stringify({content_block:[block('A')]}))),[{type:'text',text:'A'}]);
  assert.deepEqual(d.accept('STREAM_CHUNK',patch(JSON.stringify({content_block:[block('AB')]}),2)),[{type:'text',text:'B'}]);
  assert.deepEqual(d.accept('CHUNK_DELTA',{text:'C'}),[{type:'text',text:'C'}]);
  assert.deepEqual(d.accept('FULL_MSG_NOTIFY',{message:{user_type:2,content_block:[block('ABC')]}}),[]);
  assert.deepEqual(d.accept('STREAM_CHUNK',patch(JSON.stringify({content_block:[{block_id:'r',content:{thinking_block:{text:'think'}}}]}))),[{type:'reasoning',text:'think'}]);
  assert.throws(()=>d.accept('STREAM_CHUNK',patch(JSON.stringify({content_block:[block('changed')]}),2)),/revised/);
});

test('malformed patch payloads are ignored, native actions remain rejected in string patches', () => {
  for(const value of [null,undefined,false,1,[], '{','null','[]','1','true',{content_block:{}},{content_block:[null,1]}])assert.deepEqual(createProtocolDecoder().accept('STREAM_CHUNK',patch(value)),[]);
  for(const patch_op of [undefined,null,{},'bad'])assert.deepEqual(createProtocolDecoder().accept('STREAM_CHUNK',{patch_op}),[]);
  for(const type of ['tool_call_block','tool_use_block','pc_event_block'])assert.throws(()=>createProtocolDecoder().accept('STREAM_CHUNK',patch(JSON.stringify({content_block:[{content:{[type]:{name:'native'}}}]}))),/Native Doubao task tools/);
});

test('ACK forwards conversationId and only explicitly named section identifiers', () => {
  const ack=data=>createProtocolDecoder().accept('SSE_ACK',data);
  assert.deepEqual(ack({ack_client_meta:{conversation_id:'c'}}),[{type:'ack',conversationId:'c'}]);
  for(const key of ['last_section_id','section_id'])for(const section of ['s',123,0]) {
    assert.deepEqual(ack({ack_client_meta:{conversation_id:'c',[key]:section}}),[{type:'ack',conversationId:'c',sectionId:String(section)}]);
    assert.deepEqual(ack({ack_client_meta:{conversation_id:'c'},[key]:section}),[{type:'ack',conversationId:'c',sectionId:String(section)}]);
  }
  assert.deepEqual(ack({ack_client_meta:{conversation_id:'c',last_section_id:'last',section_id:'section'}}),[{type:'ack',conversationId:'c',sectionId:'last'}]);
  for(const section of ['',null,{},[],false,-1,1.5,Number.MAX_SAFE_INTEGER+1])assert.deepEqual(ack({ack_client_meta:{conversation_id:'c',last_section_id:section},message_id:'not-section',block_id:'not-section'}),[{type:'ack',conversationId:'c'}]);
  assert.deepEqual(ack({ack_client_meta:{conversation_id:'c',message_id:'m',id:'i'},id:'i',section:{id:'nested'}}),[{type:'ack',conversationId:'c'}]);
});

for(const event of ['STREAM_ERROR','SSE_ERROR','STREAM_MSG_ERROR']) {
  test(`${event} consistently classifies 710022004 without leaking upstream account data`, () => {
    for(const field of ['code','error_code'])for(const code of [710022004,'710022004'])assert.throws(()=>createProtocolDecoder().accept(event,{[field]:code,message:'secret-account secret-token',msg:'sensitive',account_id:'secret-account'}),error=>{
      assert.equal(error.code,'DOUBAO_RISK_CONTROL');
      assert.match(error.message,/710022004/);
      assert.match(error.message,/停止连续重试/);
      assert.match(error.message,/桌面客户端手动.*验证/);
      assert.doesNotMatch(error.message,/secret|sensitive|account_id/);
      assert.deepEqual(Object.keys(error),['code']);
      return true;
    });
    assert.throws(()=>createProtocolDecoder().accept(event,{code:42,error_code:710022004}),{code:'DOUBAO_RISK_CONTROL'});
    for(const code of [42,'7100220040',710022004.5])assert.throws(()=>createProtocolDecoder().accept(event,{code,message:'rejected'}),error=>{
      assert.equal(error.code,undefined);
      assert.equal(error.message,`Doubao upstream error ${code}: rejected`);
      return true;
    });
  });
}

test('decoder is self-contained when serialized into a fresh renderer realm', () => {
  const decoder=vm.runInNewContext(`(${createProtocolDecoder.toString()})()`);
  const result=decoder.accept('STREAM_CHUNK',patch(JSON.stringify({ext:JSON.stringify({context_window_usage:complete})})));
  assert.deepEqual(JSON.parse(JSON.stringify(result)),windowEvent(expected));
  assert.throws(()=>decoder.accept('SSE_ERROR',{code:710022004}),{code:'DOUBAO_RISK_CONTROL'});
  assert.deepEqual(JSON.parse(JSON.stringify(decoder.accept('SSE_REPLY_END',{end_type:3}))),[{type:'done'}]);
  assert.equal(decoder.finished,true);
  assert.deepEqual(JSON.parse(JSON.stringify(decoder.accept('STREAM_MSG_NOTIFY',{content:{ext:{context_window_usage:complete}}}))),[]);
});
