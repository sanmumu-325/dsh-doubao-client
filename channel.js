// FIFO, bounded channel leases. A release closure owns exactly one slot, forever.
export function createChannel({maxConcurrent=2,busyWaitMs=0}={}) {
  if(!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>8)throw Error('Invalid maxConcurrent (1–8)');
  if(!Number.isInteger(busyWaitMs)||busyWaitMs<0||busyWaitMs>300000)throw Error('Invalid busyWaitMs');
  const holders=new Map(),queue=[];let disposed=false;
  const failure=()=>Object.assign(new Error('豆包并发通道已满，等待超时，请稍后重试'),{code:'DOUBAO_BUSY'});
  function grant(){const token=Symbol();holders.set(token,Date.now());let released=false;return ()=>{if(released)return;released=true;holders.delete(token);drain();};}
  function drain(){while(!disposed&&holders.size<maxConcurrent&&queue.length){const item=queue.shift();item.detach();if(item.signal?.aborted){item.reject(item.signal.reason??Error('Cancelled'));continue;}item.resolve(grant());}}
  function acquire(signal){
    if(disposed)return Promise.reject(Error('Doubao plugin unloaded'));
    if(signal?.aborted)return Promise.reject(signal.reason??Error('Cancelled'));
    if(holders.size<maxConcurrent&&!queue.length)return Promise.resolve(grant());
    if(!busyWaitMs)return Promise.reject(failure());
    return new Promise((resolve,reject)=>{
      let timer;const item={resolve,reject,signal,detach:()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);}};
      const remove=error=>{const i=queue.indexOf(item);if(i<0)return;queue.splice(i,1);item.detach();reject(error);};
      const abort=()=>remove(signal.reason??Error('Cancelled'));
      queue.push(item);timer=setTimeout(()=>remove(failure()),busyWaitMs);signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();
    });
  }
  return {acquire,get active(){return holders.size},get queued(){return queue.length},get maxConcurrent(){return maxConcurrent},get oldestMs(){return holders.size?Math.max(0,Date.now()-Math.min(...holders.values())):0},
    dispose(){disposed=true;for(const item of queue.splice(0)){item.detach();item.reject(Error('Doubao plugin unloaded'));}}
  };
}
