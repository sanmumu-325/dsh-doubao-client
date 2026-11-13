import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto,createHash} from 'node:crypto';
import {startRendererStream,inspectRenderer} from './renderer.js';
import {createDoubaoBridge} from './bridge.js';

const hashAccount=account=>createHash('sha256').update(account).digest('hex');
function renderer({account='account-a',continuation,launchError,decoderError,onError,switchAtLaunch,switchAtResponse,accountKey,images=[],switchDuringUpload}={}) {
  const items=[],requests=[],extras=[],uploads=[];
  const uk={eP:()=>true,$T:async()=>({user_id:account})};
  const modules={UK:uk,Us:{U:{getState:()=>({isUserInfoLoaded:!!account,userInfo:{user_id_str:account}})}},smQ:{vX:()=>({baseURL:'https://www.doubao.com',getCommonParams:()=>({}),getCommonHeaders:()=>({})})},
    ui:{QY:()=>({getState:()=>({modeSelectConfigsV2:{mode_list:{item_list:[]}}})})},
    ZP:{cz:{Launch:async()=>{if(launchError)throw launchError;if(switchAtLaunch)account=switchAtLaunch;return {data:{assistant_bot_id:'bot-not-account'}}}}},
    kD5:{x:()=>async image=>{uploads.push(image);if(switchDuringUpload)account=switchDuringUpload;return {image_uri:'mock-image'};}},
    Xca:{oy:extra=>{extras.push(extra);return {option:{need_create_conversation:true},client_meta:{conversation_id:'new',last_section_id:''}}}},
    T5X:{T:request=>{requests.push(request);queueMicrotask(()=>{if(switchAtResponse)account=switchAtResponse;if(onError)request.onError(onError);else request.onMessage({event:'MOCK',data:'{}'});});return {cancel(){}}}}};
  const window={binding:value=>items.push(JSON.parse(value)),'chunk_@flow-web/desktop':{push:value=>value[2](id=>modules[id])}};
  const context=vm.createContext({window,crypto:webcrypto,TextEncoder,setTimeout,clearTimeout,location:{origin:'doubao://doubao-chat'}});
  const run=async()=>{await vm.runInContext('('+startRendererStream.toString()+')',context)({id:'mock',binding:'binding',prompt:'hello',model:{id:'0',modeId:'1',agentMode:2},timeoutMs:5000,maxOutputChars:1000,continuation,accountKey,images},()=>({accept(){if(decoderError)throw decoderError;return [{type:'done'}]}}));await new Promise(resolve=>setImmediate(resolve));return {items,requests,extras,uploads}};
  return {run,context,items,requests,extras};
}

test('renderer preserves codes from startup, decoder and transport failures',async()=>{
  for(const key of ['launchError','decoderError','onError']){
    const error=Object.assign(new Error('risk rejected'),{code:'DOUBAO_RISK_CONTROL',upstreamCode:'710022004'});
    const {items}=await renderer({[key]:error}).run();
    assert.equal(items.at(-1).code,'DOUBAO_RISK_CONTROL');assert.equal(items.at(-1).upstreamCode,'710022004');
  }
});

test('unknown account identity fails closed before any continuation generation',async()=>{
  const h=renderer({account:null,continuation:{conversationId:'old',sectionId:'s',accountKey:'unknown'}}),{items,requests}=await h.run();
  assert.equal(items.at(-1).code,'DOUBAO_ACCOUNT_UNKNOWN');assert.equal(requests.length,0);
  const info=await vm.runInContext('('+inspectRenderer.toString()+')',h.context)();assert.equal(info.accountKey,null);
});

test('inspect hashes verified user identity and never exports the raw account',async()=>{
  const h=renderer(),info=await vm.runInContext('('+inspectRenderer.toString()+')',h.context)();
  assert.equal(info.accountKey,hashAccount('account-a'));assert.ok(!JSON.stringify(info).includes('account-a'));
});

test('continuation overrides request metadata only for the same verified account',async()=>{
  const continuation={conversationId:'old-conversation',sectionId:'last-section',accountKey:hashAccount('account-a')};
  const {requests,extras}=await renderer({continuation}).run();assert.equal(requests.length,1);
  assert.equal(extras[0].conversation_id,'old-conversation');
  assert.notEqual(extras[0].session_id,'old-conversation','per-request unique key must not reuse the conversation id');
  assert.equal(requests[0].body.client_meta.conversation_id,'old-conversation');
  assert.equal(requests[0].body.client_meta.last_section_id,'last-section');
  assert.equal(requests[0].body.option.need_create_conversation,false);
  for(const options of [{account:'account-b'},{switchAtLaunch:'account-b'}]){
    const {items,requests}=await renderer({...options,continuation}).run();assert.equal(requests.length,0);assert.equal(items.at(-1).code,'DOUBAO_ACCOUNT_CHANGED');
  }
});

test('fresh requests verify the inspected identity and response-time account changes abort completion',async()=>{
 const mismatch=await renderer({accountKey:hashAccount('other')}).run();assert.equal(mismatch.requests.length,0);assert.equal(mismatch.items.at(-1).code,'DOUBAO_ACCOUNT_CHANGED');
 const response=await renderer({accountKey:hashAccount('account-a'),switchAtResponse:'other'}).run();assert.equal(response.requests.length,1);assert.equal(response.items.at(-1).code,'DOUBAO_ACCOUNT_CHANGED');assert.equal(response.items.some(i=>i.type==='done'),false);
});

test('account switch fences image uploads after Launch and between asynchronous uploads',async()=>{
 const images=[{base64:'one'},{base64:'two'}],accountKey=hashAccount('account-a');
 const launched=await renderer({accountKey,images,switchAtLaunch:'other'}).run();
 assert.equal(launched.uploads.length,0);assert.equal(launched.requests.length,0);assert.equal(launched.items.at(-1).code,'DOUBAO_ACCOUNT_CHANGED');
 const uploaded=await renderer({accountKey,images,switchDuringUpload:'other'}).run();
 assert.equal(uploaded.uploads.length,1);assert.equal(uploaded.requests.length,0);assert.equal(uploaded.items.at(-1).code,'DOUBAO_ACCOUNT_CHANGED');
});

test('new renderer requests remain ordinary chat without task runtime fields',async()=>{
  const {requests,extras,items}=await renderer().run();assert.equal(items.at(-1).type,'done');
  assert.equal(requests.length,1);assert.equal(requests[0].path,'/chat/completion');
  assert.equal(extras[0].ext.conversation_mode,'chat');assert.ok(extras[0].session_id);
  assert.equal(requests[0].body.option.general_task_param.server_do_compare,false);
});

function bindingHarness(t){
  const oldFetch=globalThis.fetch,oldSocket=globalThis.WebSocket;let socket,startResolve,identity='account-a';
  const started=new Promise(resolve=>startResolve=resolve),calls=[];
  class MockSocket extends EventTarget{
    static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;
    readyState=0;
    constructor(){super();socket=this;queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'))})}
    send(text){const call=JSON.parse(text);calls.push(call);if(call.method==='Runtime.addBinding')this.binding=call.params.name;
      if(call.method==='Runtime.evaluate'&&call.params.expression.includes('function startRendererStream')){this.id=/"id":"([^"]+)"/.exec(call.params.expression)[1];startResolve(this)}
      const value=call.params?.expression?.includes('function inspectRenderer')?{loggedIn:true,accountKey:identity,models:[{id:'0'}]}:{started:true};
      queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:call.id,result:call.method==='Runtime.evaluate'?{result:{value}}:{}})})))}
    emit(item){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({method:'Runtime.bindingCalled',params:{name:this.binding,payload:JSON.stringify({id:this.id,...item})}})}))}
    close(){if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new Event('close'))}
  }
  globalThis.WebSocket=MockSocket;globalThis.fetch=async()=>({ok:true,json:async()=>[{id:'mock',type:'page',url:'doubao://doubao-chat/chat',webSocketDebuggerUrl:'ws://127.0.0.1:19226/devtools/page/mock'}]});
  const bridge=createDoubaoBridge({timeoutMs:5000});t.after(async()=>{await bridge.dispose();socket?.close();globalThis.fetch=oldFetch;globalThis.WebSocket=oldSocket});
  return {bridge,started,calls,setAccount:key=>identity=key};
}

test('bridge forwards continuation and retains only allowlisted context telemetry',async t=>{
  const h=bindingHarness(t),continuation={conversationId:'secret-conversation',sectionId:'section',accountKey:'hashed-account'};
  const stream=h.bridge.stream({prompt:'private text',model:{id:'0'},continuation}),first=stream.next(),socket=await h.started;
  socket.emit({type:'context-window',window:{messages:0,totalWindowSize:4096,conversationId:'secret',body:'private text',tools:-1}});
  assert.equal((await first).value.type,'context-window');
  assert.deepEqual(h.bridge.telemetry().window,{messages:0,totalWindowSize:4096});
  assert.equal(h.bridge.telemetry().model,'0');assert.ok(h.bridge.telemetry().checkedAt);
  const copy=h.bridge.telemetry();copy.window.messages=999;assert.equal(h.bridge.telemetry().window.messages,0);
  const source=h.calls.find(x=>x.method==='Runtime.evaluate'&&x.params.expression.includes('function startRendererStream')).params.expression;
  assert.ok(source.includes(JSON.stringify(continuation)));socket.emit({type:'done'});await stream.next();await stream.next();
  assert.ok(!JSON.stringify(h.bridge.telemetry()).includes('secret'));assert.equal(h.bridge.risk(),null);
});

test('observing a changed account clears prior context and risk snapshots',async t=>{
 const h=bindingHarness(t);await h.bridge.inspect({refresh:true});
 const stream=h.bridge.stream({prompt:'mock',model:{id:'0'},accountKey:'account-a'}),first=stream.next(),socket=await h.started;
 socket.emit({type:'context-window',window:{messages:42}});await first;const next=stream.next();socket.emit({type:'error',code:'710022004',message:'risk'});await next;await stream.next();
 assert.ok(h.bridge.telemetry());assert.ok(h.bridge.risk());h.setAccount('account-b');await h.bridge.inspect({refresh:true});assert.equal(h.bridge.telemetry(),null);assert.equal(h.bridge.risk(),null);
});

test('bridge classifies otherwise untyped 710022004 without retries or cooldown',async t=>{
  const h=bindingHarness(t),stream=h.bridge.stream({prompt:'mock',model:{id:'0'}}),first=stream.next(),socket=await h.started;
  socket.emit({type:'error',code:'DOUBAO_UPSTREAM_ERROR',message:'upstream 710022004: rejected'});
  const item=(await first).value;assert.equal(item.code,'DOUBAO_RISK_CONTROL');assert.equal(item.upstreamCode,'710022004');
  await stream.next();assert.equal(h.bridge.busy,false);assert.equal(h.bridge.risk().upstreamCode,'710022004');
  assert.equal(h.calls.filter(x=>x.method==='Runtime.evaluate'&&x.params.expression.includes('function startRendererStream')).length,1);
  assert.equal(h.bridge.telemetry(),null);assert.equal('cooldownUntil' in h.bridge.risk(),false);
});
