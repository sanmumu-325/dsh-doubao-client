import test from 'node:test';
import assert from 'node:assert/strict';
import {createDoubaoBridge} from './bridge.js';
import {endpointURL, discoverTarget} from './cdp.js';

const TARGET={id:'mock',type:'page',url:'doubao://doubao-chat/chat',webSocketDebuggerUrl:'ws://127.0.0.1:19226/devtools/page/mock'};
function deferred(){let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject};}
async function within(promise, ms=750) {
  let timer;
  try {return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`did not settle within ${ms}ms`)),ms);})]);}
  finally {clearTimeout(timer);}
}
async function until(predicate){await within((async()=>{while(!predicate()) await new Promise(resolve=>setImmediate(resolve));})());}

// Top-level tests deliberately run serially. Each file gets its own Node test worker;
// mocks replace process-local globals only and never evaluate renderer expressions.
function harness(t,{autoOpen=true,fetchImpl,holdStartAck=false,holdCancelAck=false}={}) {
  const originalFetch=globalThis.fetch, originalWebSocket=globalThis.WebSocket;
  const sockets=[],calls=[],fetchCalls=[],bridges=[];
  const started=deferred();
  class MockWebSocket extends EventTarget {
    static CONNECTING=0; static OPEN=1; static CLOSING=2; static CLOSED=3;
    readyState=MockWebSocket.CONNECTING;
    constructor(url){super();this.url=url;sockets.push(this);if(autoOpen)queueMicrotask(()=>this.open());}
    open(){if(this.readyState!==MockWebSocket.CONNECTING)return;this.readyState=MockWebSocket.OPEN;this.dispatchEvent(new Event('open'));}
    message(value){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}
    send(text){
      assert.equal(this.readyState,MockWebSocket.OPEN,'send must use an open mock socket');
      const call=JSON.parse(text);calls.push(call);
      if(call.method==='Runtime.addBinding')this.binding=call.params.name;
      if(holdCancelAck&&call.method==='Runtime.evaluate'&&call.params.expression.includes('window.__dshDoubaoStreams?.['))return;
      if(call.method==='Runtime.evaluate'&&call.params.expression.includes('function startRendererStream')){
        const id=/"id":"([^"]+)"/.exec(call.params.expression)?.[1];
        assert.ok(id,'start expression includes request id');this.requestId=id;started.resolve(this);
        if(holdStartAck)return;
      }
      queueMicrotask(()=>{if(this.readyState===MockWebSocket.OPEN)this.message({id:call.id,result:call.method==='Runtime.evaluate'?{result:{value:call.params.expression.includes('window.__dshDoubaoStreams?.[')?true:{started:true}}}:{}});});
    }
    close(){if(this.readyState===MockWebSocket.CLOSED)return;this.readyState=MockWebSocket.CLOSED;this.dispatchEvent(new Event('close'));}
    fail(){this.dispatchEvent(new Event('error'));}
    emitItem(item){assert.ok(this.binding);assert.ok(this.requestId);this.message({method:'Runtime.bindingCalled',params:{name:this.binding,payload:JSON.stringify({id:this.requestId,...item})}});}
  }
  globalThis.WebSocket=MockWebSocket;
  globalThis.fetch=async(url,options)=>{fetchCalls.push({url:String(url),options});return fetchImpl?fetchImpl(url,options):{ok:true,json:async()=>[TARGET]};};
  const makeBridge=(options={})=>{const bridge=createDoubaoBridge({timeoutMs:5000,maxConcurrent:1,...options});bridges.push(bridge);return bridge;};
  const cancellations=()=>calls.filter(c=>c.method==='Runtime.evaluate'&&c.params.expression.includes('window.__dshDoubaoStreams?.['));
  const starts=()=>calls.filter(c=>c.method==='Runtime.evaluate'&&c.params.expression.includes('function startRendererStream'));
  t.after(async()=>{try{await Promise.allSettled(bridges.map(b=>b.dispose()));for(const socket of sockets)socket.close();}finally{globalThis.fetch=originalFetch;globalThis.WebSocket=originalWebSocket;}});
  return {sockets,calls,fetchCalls,started,makeBridge,cancellations,starts};
}
const request=signal=>({prompt:'mock prompt',model:{id:'0',modeId:'1',agentMode:2},signal});

test('loopback endpoint restrictions reject remote and credential-bearing URLs',()=>{
  for(const endpoint of ['http://example.com:19226','http://localhost:19226','https://127.0.0.1:19226','http://user:pass@127.0.0.1:19226','http://127.0.0.1:19226/path','http://127.0.0.1:19226/?secret=x'])assert.throws(()=>endpointURL(endpoint));
  assert.equal(endpointURL('http://127.0.0.1:19226').hostname,'127.0.0.1');
  assert.equal(endpointURL('http://[::1]:19226').hostname,'[::1]');
});

test('discovery rejects nonmatching debugger host or port; never follows redirects',async t=>{
  const h=harness(t,{fetchImpl:async()=>({ok:true,json:async()=>[{...TARGET,webSocketDebuggerUrl:'ws://example.com:19226/devtools/page/mock'}]})});
  await assert.rejects(discoverTarget('http://127.0.0.1:19226'),/Untrusted/);
  assert.equal(h.fetchCalls[0].options.redirect,'error');
  assert.equal(h.sockets.length,0);
});

test('dispose during discovery prevents all subsequent CDP/model calls even if fetch ignores abort',async t=>{
  const gate=deferred();
  const h=harness(t,{fetchImpl:()=>gate.promise});
  const bridge=h.makeBridge(), stream=bridge.stream(request()), next=stream.next();
  const rejected=assert.rejects(next,/unloaded|abort/i);
  await until(()=>h.fetchCalls.length===1);
  await within(bridge.dispose());
  assert.equal(h.fetchCalls[0].options.signal.aborted,true);
  gate.resolve({ok:true,json:async()=>[TARGET]});
  await within(rejected);
  assert.equal(h.sockets.length,0);
  assert.equal(h.calls.length,0);
  assert.equal(bridge.busy,false);
});

test('dispose during WebSocket CONNECTING promptly rejects handshake and never starts renderer',async t=>{
  const h=harness(t,{autoOpen:false});
  const bridge=h.makeBridge(), stream=bridge.stream(request()), next=stream.next();
  const rejected=assert.rejects(next,/closed|unloaded|abort/i);
  await until(()=>h.sockets.length===1);
  await within(bridge.dispose());
  await within(rejected);
  assert.equal(h.sockets[0].readyState,3);
  assert.equal(h.starts().length,0);
  assert.equal(bridge.busy,false);
});

for(const event of ['close','error']){
  test(`idle pending stream immediately receives terminal error on CDP ${event}`,async t=>{
    const h=harness(t), bridge=h.makeBridge(), stream=bridge.stream(request());
    const next=stream.next();
    const socket=await within(h.started.promise);
    // Let the evaluate acknowledgement settle so there is no pending CDP call.
    await new Promise(resolve=>setImmediate(resolve));
    event==='close'?socket.close():socket.fail();
    const result=await within(next);
    assert.equal(result.done,false);
    assert.equal(result.value.type,'error');
    assert.equal(result.value.code,'DOUBAO_CONNECTION_LOST');
    assert.match(result.value.message,/不自动重试/);
    assert.equal((await within(stream.next())).done,true);
    assert.equal(bridge.busy,true,'unknown upstream termination must retain its slot');
    assert.equal(bridge.channelStatus().quarantined,1);
    await assert.rejects(bridge.stream(request()).next(),{code:'DOUBAO_BUSY'});
    assert.equal(h.starts().length,1);
  });
}

test('dispose wakes idle stream, cancels renderer before socket close and prevents new calls',async t=>{
  const h=harness(t), bridge=h.makeBridge(), stream=bridge.stream(request());
  const next=stream.next();await within(h.started.promise);
  await new Promise(resolve=>setImmediate(resolve));
  await within(bridge.dispose());
  assert.equal((await within(next)).value.type,'cancelled');
  assert.equal(h.cancellations().length,1);
  assert.equal(h.sockets[0].readyState,3);
  assert.equal((await within(stream.next())).done,true);
  assert.equal(bridge.busy,false);
  await assert.rejects(bridge.stream(request()).next(),/unloaded/);
  await assert.rejects(bridge.inspect(),/unloaded/);
  assert.equal(h.starts().length,1);
});

test('abort signal cancels remote stream once and clears busy lock',async t=>{
  const h=harness(t), bridge=h.makeBridge(), abort=new AbortController(), stream=bridge.stream(request(abort.signal));
  const next=stream.next();await within(h.started.promise);
  abort.abort(new Error('user cancelled'));
  assert.equal((await within(next)).value.type,'cancelled');
  assert.equal((await within(stream.next())).done,true);
  assert.equal(h.cancellations().length,1);
  assert.equal(bridge.busy,false);
});

test('abort while renderer start evaluation is pending promptly terminates locally',async t=>{
  const h=harness(t,{holdStartAck:true}), bridge=h.makeBridge(), abort=new AbortController(), stream=bridge.stream(request(abort.signal));
  const next=stream.next();
  // Observe rejection immediately as well, so cleanup cannot create an unhandled rejection.
  const observed=next.then(value=>({value}),error=>({error}));
  await within(h.started.promise);
  abort.abort(new Error('user cancelled during Launch'));
  try {
    const result=await within(observed);
    assert.equal(result.error,undefined);
    assert.equal(result.value.value.type,'cancelled');
    assert.equal((await within(stream.next())).done,true);
  } finally {
    await within(bridge.dispose());
    await within(observed);
    await within(stream.return());
  }
});

test('normal text/done roundtrip preserves payload and cleans binding/renderer exactly once',async t=>{
  const h=harness(t), bridge=h.makeBridge(), stream=bridge.stream(request());
  const first=stream.next(), socket=await within(h.started.promise);
  socket.emitItem({type:'text',text:'hello'});
  assert.equal((await within(first)).value.text,'hello');
  socket.emitItem({type:'done'});
  assert.equal((await within(stream.next())).value.type,'done');
  assert.equal((await within(stream.next())).done,true);
  assert.equal(h.calls.filter(c=>c.method==='Runtime.removeBinding').length,1);
  assert.equal(h.cancellations().length,1);
  assert.equal(bridge.busy,false);
});

test('channel stays locked during bounded cleanup and recovers after pending cancel/start acknowledgements',async t=>{
  const h=harness(t,{holdStartAck:true,holdCancelAck:true}),bridge=h.makeBridge(),stream=bridge.stream(request());
  const next=stream.next();const socket=await within(h.started.promise);socket.emitItem({type:'done'});
  assert.equal((await within(next)).value.type,'done');
  const cleanup=stream.next();await until(()=>h.cancellations().length===1);
  assert.equal(bridge.busy,true,'must not unlock while renderer cancellation is pending');
  await assert.rejects(bridge.stream(request()).next(),{code:'DOUBAO_BUSY'});
  assert.equal((await within(cleanup,6500)).done,true);
  assert.equal(bridge.busy,false);assert.equal(socket.readyState,3);
});

test('elapsed wall time does not release a live request or let old cleanup unlock a new request',async t=>{
  const h=harness(t),bridge=h.makeBridge(),stream=bridge.stream(request());const next=stream.next();await within(h.started.promise);
  const original=Date.now;try{Date.now=()=>original()+3600000;await assert.rejects(bridge.stream(request()).next(),{code:'DOUBAO_BUSY'});assert.equal(h.sockets.length,1);}finally{Date.now=original;}
  await bridge.dispose();await within(next);await within(stream.next());assert.equal(bridge.busy,false);
});

test('an abandoned consumer releases the channel and closes the socket',async t=>{
  const h=harness(t),bridge=h.makeBridge({abandonedConsumerMs:60});
  const stream=bridge.stream(request());const next=stream.next();const socket=await within(h.started.promise);
  socket.emitItem({type:'text',text:'partial'});
  assert.equal((await within(next)).value.text,'partial');
  assert.equal(bridge.busy,true);
  assert.ok(bridge.busyForMs>=0);
  // 消费者到此不再取用：既不再 next()，也不 return()。
  await until(()=>bridge.busy===false);
  assert.equal(bridge.busyForMs,0);
  assert.equal(socket.readyState,3,'被放弃的请求必须关闭调试连接');
  assert.equal(h.cancellations().length,1,'应只取消一次');
  assert.equal(bridge.busyForMs,0);
});

test('a long silent generation is not mistaken for an abandoned consumer',async t=>{
  const h=harness(t),bridge=h.makeBridge({abandonedConsumerMs:60});
  const stream=bridge.stream(request());const next=stream.next();const socket=await within(h.started.promise);
  // 此刻生成器挂在等待事件的 await 上，而不是 yield 上：模型迟迟不出首字也必须保持占用。
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(bridge.busy,true,'等待上游首个事件期间不得被看门狗释放');
  socket.emitItem({type:'text',text:'late'});
  assert.equal((await within(next)).value.text,'late');
  socket.emitItem({type:'done'});
  assert.equal((await within(stream.next())).value.type,'done');
  await within(stream.next());
  assert.equal(bridge.busy,false);assert.equal(h.sockets.length,1);
});

test('a promptly consumed stream is unaffected by the abandonment watchdog',async t=>{
  const h=harness(t),bridge=h.makeBridge({abandonedConsumerMs:3000});
  const stream=bridge.stream(request());const next=stream.next();const socket=await within(h.started.promise);
  socket.emitItem({type:'text',text:'first'});
  assert.equal((await within(next)).value.text,'first');
  socket.emitItem({type:'done'});
  assert.equal((await within(stream.next())).value.type,'done');
  await within(stream.next());
  assert.equal(bridge.busy,false);assert.equal(bridge.busyForMs,0);assert.equal(h.cancellations().length,1);
});

test('a second request queues for the in-flight one instead of failing immediately',async t=>{
  const h=harness(t),bridge=h.makeBridge({busyWaitMs:1500});
  const first=bridge.stream(request());const firstNext=first.next();const socketA=await within(h.started.promise);
  const second=bridge.stream(request());const secondNext=second.next();
  await new Promise(resolve=>setTimeout(resolve,120));
  assert.equal(h.sockets.length,1,'排队等待期间不得再开第二条连接');
  socketA.emitItem({type:'text',text:'a'});assert.equal((await within(firstNext)).value.text,'a');
  socketA.emitItem({type:'done'});assert.equal((await within(first.next())).value.type,'done');await within(first.next());
  await until(()=>h.sockets.length===2);
  const socketB=h.sockets[1];await until(()=>socketB.requestId);
  socketB.emitItem({type:'text',text:'b'});
  assert.equal((await within(secondNext)).value.text,'b');
  socketB.emitItem({type:'done'});assert.equal((await within(second.next())).value.type,'done');await within(second.next());
  assert.equal(bridge.busy,false);
});

test('waiting gives up with a clear busy error when the in-flight request never ends',async t=>{
  const h=harness(t),bridge=h.makeBridge({busyWaitMs:150});
  const first=bridge.stream(request());const firstNext=first.next();const socket=await within(h.started.promise);
  await assert.rejects(bridge.stream(request()).next(),{code:'DOUBAO_BUSY'});
  assert.equal(h.sockets.length,1);
  socket.emitItem({type:'done'});await within(firstNext);await within(first.next());
});

test('two live streams are isolated; third queues; cancelling one leaves the other usable',async t=>{
  const h=harness(t),bridge=h.makeBridge({maxConcurrent:2,busyWaitMs:1000});
  const ac=new AbortController(),a=bridge.stream(request(ac.signal)),pa=a.next();
  await within(h.started.promise);
  const b=bridge.stream(request()),pb=b.next();await until(()=>h.sockets[1]?.requestId);
  const [sa,sb]=h.sockets;assert.equal(bridge.channelStatus().active,2);
  const c=bridge.stream(request()),pc=c.next();await until(()=>bridge.channelStatus().queued===1);
  assert.equal(h.sockets.length,2);
  sa.emitItem({type:'text',text:'A'});sb.emitItem({type:'text',text:'B'});
  assert.equal((await pa).value.text,'A');assert.equal((await pb).value.text,'B');
  ac.abort();assert.equal((await a.next()).value.type,'cancelled');await a.next();
  await until(()=>h.sockets[2]?.requestId);const sc=h.sockets[2];
  assert.equal(sb.readyState,1,'cancel A must not close B');
  sb.emitItem({type:'text',text:'B still alive'});assert.equal((await b.next()).value.text,'B still alive');
  sc.emitItem({type:'text',text:'C'});assert.equal((await pc).value.text,'C');
  for(const [stream,socket] of [[b,sb],[c,sc]]){socket.emitItem({type:'done'});await stream.next();await stream.next();}
  assert.equal(bridge.channelStatus().active,0);
  assert.equal(new Set(h.sockets.map(s=>s.binding)).size,3);
});

test('all CDP entry paths verify the endpoint before opening any socket',async t=>{
 const h=harness(t);let checks=0;const bridge=h.makeBridge({beforeConnect:async()=>{checks++;throw Object.assign(Error('Unverified port'),{code:'PORT_CONFLICT'});}});
 await assert.rejects(bridge.inspect({refresh:true}),{code:'PORT_CONFLICT'});
 await assert.rejects(bridge.quota(),{code:'PORT_CONFLICT'});
 await assert.rejects(bridge.stream(request()).next(),{code:'PORT_CONFLICT'});
 assert.equal(checks,3);assert.equal(h.sockets.length,0);assert.equal(bridge.busy,false);
});

test('a busy bridge rejects competing generation without opening a second socket',async t=>{
  const h=harness(t), bridge=h.makeBridge(), stream=bridge.stream(request());
  const next=stream.next();await within(h.started.promise);
  await assert.rejects(bridge.stream(request()).next(),{code:'DOUBAO_BUSY'});
  assert.equal(h.sockets.length,1);
  await within(bridge.dispose());await within(next);await within(stream.next());
});
