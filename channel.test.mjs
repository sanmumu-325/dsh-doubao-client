import test from 'node:test';
import assert from 'node:assert/strict';
import {createChannel} from './channel.js';

test('two slots, FIFO waiters, and double-release cannot free someone else',async()=>{
 const c=createChannel({maxConcurrent:2,busyWaitMs:1000});
 const a=await c.acquire(),b=await c.acquire();const order=[];
 const p=c.acquire().then(r=>{order.push(1);return r}),q=c.acquire().then(r=>{order.push(2);return r});
 assert.equal(c.active,2);assert.equal(c.queued,2);a();const d=await p;
 assert.deepEqual(order,[1]);a();assert.equal(c.active,2);assert.equal(c.queued,1);
 b();const e=await q;assert.deepEqual(order,[1,2]);d();e();assert.equal(c.active,0);c.dispose();
});
test('queue timeout and abort consume no slot',async()=>{
 const c=createChannel({maxConcurrent:1,busyWaitMs:30}),a=await c.acquire();
 await assert.rejects(c.acquire(),{code:'DOUBAO_BUSY'});
 const ac=new AbortController(),p=c.acquire(ac.signal);ac.abort(Error('stop'));await assert.rejects(p,/stop/);
 assert.equal(c.active,1);assert.equal(c.queued,0);a();c.dispose();
});
test('unload rejects all waiters and no future lease can be acquired',async()=>{
 const c=createChannel({maxConcurrent:1,busyWaitMs:1000}),a=await c.acquire();const p=c.acquire();c.dispose();
 await assert.rejects(p,/unloaded/);a();await assert.rejects(c.acquire(),/unloaded/);assert.equal(c.active,0);
});
test('already aborted caller cannot steal an available slot',async()=>{
 const c=createChannel(),ac=new AbortController();ac.abort(Error('stop'));await assert.rejects(c.acquire(ac.signal),/stop/);assert.equal(c.active,0);
});
test('configuration must be a bounded positive integer',()=>{
 for(const maxConcurrent of [0,-1,9,1.5,'2'])assert.throws(()=>createChannel({maxConcurrent}));
});
