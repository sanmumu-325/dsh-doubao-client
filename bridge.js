import {randomUUID} from 'node:crypto';
import {createChannel} from './channel.js';
import {connectCDP,discoverTarget,endpointURL} from './cdp.js';
import {inspectRenderer,quotaRenderer,startRendererStream} from './renderer.js';
import {createProtocolDecoder,normalizeQuota} from './protocol.js';
export function safeError(error) {
  return String(error?.message??error??'Unknown error').replace(/https?:\/\/[^\s"']+/g,s=>{try{const u=new URL(s);return u.origin+u.pathname}catch{return '[url]'}}).replace(/(?:bearer\s+)[\w.\-]+/gi,'Bearer [redacted]').slice(0,600);
}
export function createDoubaoBridge({endpoint='http://127.0.0.1:19226',timeoutMs=180000,maxOutputChars=120000,abandonedConsumerMs=60000,busyWaitMs=0,maxConcurrent=2,beforeConnect=null}={}) {
  endpointURL(endpoint);if(!Number.isInteger(timeoutMs)||timeoutMs<5000||timeoutMs>600000)throw Error('Invalid timeoutMs');
  if(!Number.isInteger(maxOutputChars)||maxOutputChars<100||maxOutputChars>1000000)throw Error('Invalid maxOutputChars');
  if(!Number.isInteger(abandonedConsumerMs)||abandonedConsumerMs<50||abandonedConsumerMs>600000)throw Error('Invalid abandonedConsumerMs');
  if(!Number.isInteger(busyWaitMs)||busyWaitMs<0||busyWaitMs>300000)throw Error('Invalid busyWaitMs');
  const channel=createChannel({maxConcurrent,busyWaitMs});
  let disposed=false,catalogCache=null,quotaCache=null,lastTelemetry=null,lastRisk=null,lastAccountKey;const active=new Set(),pending=new Set(),cancellers=new Map(),quarantined=new Set();
  async function boundedCleanup(operation,ms){let timer;try{await Promise.race([Promise.resolve().then(operation),new Promise(resolve=>{timer=setTimeout(resolve,ms)})]);}catch{}finally{clearTimeout(timer);}}
  const observeAccount=key=>{if(lastAccountKey!==undefined&&lastAccountKey!==key){lastTelemetry=null;lastRisk=null;quotaCache=null;}lastAccountKey=key;};
  const check=()=>{if(disposed)throw Error('Doubao plugin unloaded');};
  async function connection(){check();const setup=new AbortController();pending.add(setup);let c;try{await beforeConnect?.(setup.signal);check();const target=await discoverTarget(endpoint,AbortSignal.any([setup.signal,AbortSignal.timeout(5000)]));check();c=await connectCDP(target,{timeoutMs:30000,signal:setup.signal});check();active.add(c);return c;}catch(e){c?.close();throw e;}finally{pending.delete(setup);}}
  async function read(operation,signal){check();const release=await channel.acquire(signal);let c;try{check();c=await connection();check();return await c.evaluate('('+operation.toString()+')()');}finally{try{if(c){active.delete(c);c.close();}}catch{}release();}}
  return {
    get busy(){return channel.active>0},
    get busyForMs(){return channel.oldestMs},
    channelStatus(){return {busy:channel.active>0,busyForMs:channel.oldestMs,active:channel.active,queued:channel.queued,maxConcurrent,quarantined:quarantined.size}},
    get maxConcurrent(){return maxConcurrent},
    get busyWaitMs(){return busyWaitMs},
    async inspect({refresh=false,signal}={}) {check();if(catalogCache&&!refresh&&Date.now()-catalogCache.checkedMs<30000)return catalogCache.value;const info=await read(inspectRenderer,signal);observeAccount(info.accountKey??null);if(!info.loggedIn)throw Error('豆包客户端未登录，请在客户端手动登录');if(!info.models?.length)throw Error('豆包客户端未提供模型清单，请先打开新对话');const value={...info,endpoint,checkedAt:new Date().toISOString()};catalogCache={checkedMs:Date.now(),value};return value;},
    async quota(){const data=await read(quotaRenderer);quotaCache=normalizeQuota(data);return quotaCache;},
    cachedQuota(){return quotaCache},
    telemetry(){return lastTelemetry?structuredClone(lastTelemetry):null},
    risk(){return lastRisk?{...lastRisk}:null},
    async *stream({prompt,model,reasoningEffort,images=[],signal,continuation,accountKey,onCleanupAvailable}) {
      check();if(signal?.aborted)throw signal.reason??Error('Cancelled');
      const release=await channel.acquire(signal);let c,timer,abort=()=>{},removeClose,remoteCancelPromise,startPromise;const id=randomUUID(),binding='__dshDoubao_'+id.replaceAll('-','');let terminal=false,remoteStopped=false,wake,bytes=0;const queue=[];
      const cancelExpression=`(()=>{window.__dshDoubaoStreams?.[${JSON.stringify(id)}]?.cancel();delete window.__dshDoubaoStreams?.[${JSON.stringify(id)}];return true})()`;
      const cancelRemote=()=>{if(!c)return Promise.resolve();return remoteCancelPromise??=(async()=>{let t;try{const stopped=await Promise.race([c.evaluate(cancelExpression),new Promise(resolve=>{t=setTimeout(resolve,3000)})]);if(stopped===true)remoteStopped=true;}catch{}finally{clearTimeout(t)}})();};
      const snapshotCurrent=()=>lastAccountKey===undefined||(continuation?.accountKey??accountKey)===lastAccountKey;
      const enqueue=item=>{if(terminal)return;
        if(item.type==='error'&&snapshotCurrent()&&['DOUBAO_ACCOUNT_CHANGED','DOUBAO_ACCOUNT_UNKNOWN'].includes(item.code))observeAccount(null);
        if(item.type==='context-window'&&snapshotCurrent()){
          const window={};for(const key of ['systemPrompt','messages','skills','tools','totalWindowSize','totalUsed'])if(Number.isSafeInteger(item.window?.[key])&&item.window[key]>=0)window[key]=item.window[key];
          if(Object.keys(window).length)lastTelemetry={checkedAt:new Date().toISOString(),model:String(model.id),window};
        }
        if(item.type==='error'&&(item.code==='DOUBAO_RISK_CONTROL'||String(item.code)==='710022004'||String(item.upstreamCode)==='710022004'||/(^|[^0-9])710022004([^0-9]|$)/.test(String(item.message)))){
          item={...item,code:'DOUBAO_RISK_CONTROL',upstreamCode:'710022004',message:'豆包风控拦截了本次请求（710022004）。请停止连续重试，在豆包桌面客户端手动检查并完成验证，稍后再试；不自动换模型或重试。'};
          if(snapshotCurrent())lastRisk={checkedAt:new Date().toISOString(),model:String(model.id),code:'DOUBAO_RISK_CONTROL',upstreamCode:'710022004'};
        }
        bytes+=JSON.stringify(item).length;if(bytes>2000000){queue.push({type:'error',code:'DOUBAO_BACKPRESSURE',message:'豆包流式队列超过安全上限'});terminal=true;void cancelRemote();}else{queue.push(item);if(['done','error','cancelled'].includes(item.type))terminal=true;}wake?.();wake=undefined;};
      // 一次性清理：正常结束、取消、被放弃都走它；幂等，可被看门狗或 abort 提前触发。
      let cleaned=false,watchdog,cleanupPromise;
      const disarm=()=>{if(watchdog){clearTimeout(watchdog);watchdog=undefined;}};
      function cleanup(){
        if(cleanupPromise)return cleanupPromise;cleaned=true;disarm();
        return cleanupPromise=(async()=>{
        clearTimeout(timer);signal?.removeEventListener('abort',abort);removeClose?.();
        try{
          if(c){
            await boundedCleanup(cancelRemote,3200);
            await boundedCleanup(()=>c.call('Runtime.removeBinding',{name:binding}),1000);
            cancellers.delete(c);active.delete(c);try{c.close();}catch{}
            if(startPromise)await boundedCleanup(()=>startPromise,1000);
          }
        }finally{if(disposed||!startPromise||remoteStopped)release();else quarantined.add(release);}
        return disposed||!startPromise||remoteStopped;
        })();
      }
      // 消费者若在 yield 处停止取用（页面刷新、任务被丢弃），生成器不再被唤醒，finally 永远不会执行。
      // 看门狗只在「因 yield 挂起」期间计时，所以一次正常的长时间生成不会被误判为放弃。
      const armAbandoned=()=>{disarm();watchdog=setTimeout(()=>{void cleanup();},abandonedConsumerMs);};
      try{
        onCleanupAvailable?.(cleanup);check();if(signal?.aborted)throw signal.reason??Error('Cancelled');
        c=await connection();check();
        cancellers.set(c,async()=>{enqueue({type:'cancelled'});await cancelRemote();c.close();});
        removeClose=c.onClose(()=>enqueue({type:'error',code:'DOUBAO_CONNECTION_LOST',message:'豆包调试连接已断开；上游结果不明，不自动重试'}));
        await c.call('Runtime.enable');check();await c.call('Runtime.addBinding',{name:binding});check();
        c.onEvent(event=>{if(event.method==='Runtime.bindingCalled'&&event.params.name===binding){try{const item=JSON.parse(event.params.payload);if(item.id===id){if(['done','error','cancelled'].includes(item.type))remoteStopped=true;enqueue(item);}}catch{enqueue({type:'error',message:'Invalid renderer binding payload'})}}});
        abort=()=>{enqueue({type:'cancelled'});void cancelRemote();};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
        timer=setTimeout(()=>{enqueue({type:'error',code:'DOUBAO_TIMEOUT',message:'豆包请求超时；结果不明，不自动重试'});void cancelRemote();},timeoutMs+10000);
        if(!terminal){check();startPromise=c.evaluate('('+startRendererStream.toString()+')('+JSON.stringify({id,binding,prompt,model,reasoningEffort,images,timeoutMs,maxOutputChars,continuation,accountKey})+',('+createProtocolDecoder.toString()+'))').catch(error=>enqueue({type:'error',code:'DOUBAO_START_FAILED',message:safeError(error)}));}
        while(true){while(queue.length){const item=queue.shift();bytes-=JSON.stringify(item).length;armAbandoned();try{yield item;}finally{disarm();}if(cleaned)throw Object.assign(Error('豆包请求已清理；不恢复过期输出'),{code:'ABORTED'});}if(terminal)break;await new Promise(resolve=>{wake=resolve;});}
      }finally{await cleanup();}
    },
    async dispose(){disposed=true;channel.dispose();for(const setup of pending)setup.abort(new Error('Doubao plugin unloaded'));await Promise.allSettled([...active].map(async c=>{const cancel=cancellers.get(c);if(cancel)await cancel();else c.close();}));active.clear();for(const release of quarantined)release();quarantined.clear();}
  };
}
