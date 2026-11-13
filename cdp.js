// Loopback-only CDP transport. Credentials remain inside the Doubao renderer.
export function endpointURL(endpoint) {
  const u = new URL(endpoint);
  if (u.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname)) throw new Error('CDP endpoint must be a literal loopback HTTP origin');
  return u;
}
export async function discoverTarget(endpoint, signal) {
  const u = endpointURL(endpoint);
  const r = await fetch(new URL('/json/list',u),{signal: signal ?? AbortSignal.timeout(5000),redirect:'error'});
  if(!r.ok) throw new Error('Doubao debugging endpoint unavailable');
  const targets=await r.json();
  const target=targets.find(t=>t.type==='page' && /^doubao:\/\/doubao-chat\/chat(?:[/?#]|$)/.test(t.url));
  if(!target) throw new Error('No Doubao chat renderer. Open the Doubao client chat window.');
  const ws = new URL(target.webSocketDebuggerUrl);
  if(ws.protocol!=='ws:' || ws.hostname!==u.hostname || ws.port!==u.port || ws.username || ws.password)throw new Error('Untrusted debugging target');
  return {id:target.id,url:target.url,webSocketDebuggerUrl:ws.href};
}
export async function connectCDP(target, {signal,timeoutMs=20000}={}) {
  const ws=new WebSocket(target.webSocketDebuggerUrl);
  let serial=0,closed=false;const pending=new Map(),listeners=new Set(),closeListeners=new Set();
  function fail(e){for(const p of pending.values()){clearTimeout(p.timer);p.reject(e);}pending.clear();}
  ws.addEventListener('message',e=>{let m;try{m=JSON.parse(String(e.data));}catch{return;}if(m.id){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error('CDP '+m.error.code+': '+m.error.message)):p.resolve(m.result);}else for(const listener of listeners)listener(m);});
  function disconnect(message){if(closed)return;closed=true;const error=new Error(message);fail(error);for(const fn of closeListeners)fn(error);}
  ws.addEventListener('close',()=>disconnect('Doubao debugging connection closed; outcome unknown, do not retry automatically'));
  ws.addEventListener('error',()=>disconnect('Doubao debugging connection failed; outcome unknown, do not retry automatically'));
  const abort=()=>{ws.close();fail(signal.reason??new Error('Cancelled'));};
  if(signal?.aborted){abort();throw signal.reason;}
  signal?.addEventListener('abort',abort,{once:true});
  try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.close();reject(new Error('CDP connection timeout'));},5000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('CDP connection failed'));},{once:true});ws.addEventListener('close',()=>{clearTimeout(timer);reject(new Error('CDP connection closed before ready'));},{once:true});});}catch(e){signal?.removeEventListener('abort',abort);throw e;}
  const call=(method,params={})=>new Promise((resolve,reject)=>{if(closed||ws.readyState!==WebSocket.OPEN)return reject(new Error('CDP is closed'));const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP request timeout: '+method));},timeoutMs);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
  return {call,onEvent(fn){listeners.add(fn);return()=>listeners.delete(fn);},onClose(fn){closeListeners.add(fn);return()=>closeListeners.delete(fn);},async evaluate(expression){const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:false});if(r.exceptionDetails)throw new Error('Doubao renderer operation failed: '+(r.exceptionDetails.exception?.description??r.exceptionDetails.text));return r.result?.value;},close(){signal?.removeEventListener('abort',abort);disconnect('CDP closed');listeners.clear();closeListeners.clear();ws.close();}};
}
