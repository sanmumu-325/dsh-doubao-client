import test from 'node:test';
import assert from 'node:assert/strict';
import {DoubaoClientService} from './service.js';
import {createDoubaoAdapter} from './adapter.js';
const options={provider:'doubao-client',model:'0',sessionId:'setup-test',messages:[{role:'user',content:[{type:'text',text:'hello'}]}]};
function fixture(){
 const calls=[];let state={supported:true,state:'ready',code:'READY',message:'Ready',autoStart:false,consentGranted:false};
 const startup={diagnostics:async()=>{calls.push('diagnostics');return {...state};},observe:async()=>{calls.push('observe');return {...state};},ensure:async x=>{calls.push(['ensure',x]);return {...state};},configure:async x=>{calls.push(['configure',x]);return {...state};},start:async x=>{calls.push(['start',x]);return {...state};},dispose(){calls.push('startup-dispose');}};
 const bridge={inspect:async()=>({models:[{id:'0',name:'Quick',modeId:'1',agentMode:2}],loggedIn:true,accountKey:'mock-account'}),quota:async()=>({status:'known'}),cachedQuota:()=>null,telemetry:()=>null,risk:()=>null,channelStatus:()=>({maxConcurrent:2,active:0}),dispose(){calls.push('bridge-dispose');},async *stream(){calls.push('model-stream');yield {type:'text',text:'reply'};yield {type:'done'};}};
 const ledger={summary:async()=>({}),record:async()=>{}};
 const service=new DoubaoClientService({},null,null,{startup,bridge,ledger});
 return {calls,startup,service,bridge,ledger,setState:s=>{state=s;}};
}
test('status, quota, usage, discovery and construction do not start or authorize clients',async()=>{
 const f=fixture();assert.deepEqual(f.calls,[]);
 const status=await f.service.execute({action:'status'});assert.equal(status.setup.autoStart,false);
 await f.service.execute({action:'quota'});await f.service.execute({action:'usage'});await f.service.adapter.listModels('doubao-client');
 assert.deepEqual(f.calls,['diagnostics']);assert.throws(()=>f.service.execute({action:'start'}),/Unsupported/);
 assert.throws(()=>f.service.execute({action:'configure',autoStart:true}),/Unsupported/);
});
test('manual launch and configure are available only through the separate management method',async()=>{
 const f=fixture(),ac=new AbortController();
 await f.service.manageSetup({action:'configure',autoStart:true,consent:'LOCAL_DEBUGGING'});
 await f.service.manageSetup({action:'start',consent:'LOCAL_DEBUGGING'},ac.signal);
 assert.deepEqual(f.calls[0],['configure',{autoStart:true,consent:'LOCAL_DEBUGGING'}]);
 assert.equal(f.calls[1][0],'start');assert.equal(f.calls[1][1].signal,ac.signal);
});
test('failure setup states cannot be presented as successful saves or starts',async()=>{
 const f=fixture();f.setState({state:'unknown',code:'CONFIGURATION_FAILED',message:'Permission denied'});
 await assert.rejects(f.service.manageSetup({action:'configure',autoStart:true}),{code:'CONFIGURATION_FAILED'});
 f.setState({state:'unknown',code:'CONFIGURATION_CANCELLED',message:'Newer settings requested'});
 await assert.rejects(f.service.manageSetup({action:'configure',consent:'REVOKE'}),{code:'CONFIGURATION_CANCELLED'});
 f.setState({state:'running-no-channel',code:'RUNNING_NO_CHANNEL',message:'Exit normally'});
 await assert.rejects(f.service.manageSetup({action:'start'}),{code:'RUNNING_NO_CHANNEL'});
});
test('explicit model use checks saved opt-in before dispatch; direct and prepared streams work',async()=>{
 const f=fixture(),ac=new AbortController();
 const prepared=await f.service.adapter.prepareCall('doubao-client','0',ac.signal);
 assert.equal(f.calls[0][0],'ensure');assert.equal(f.calls[0][1].signal,ac.signal);
 const chunks=await Array.fromAsync(prepared.stream({...options,signal:ac.signal}));assert.equal(chunks.at(-1).reason.kind,'stop');
 const direct=await Array.fromAsync(f.service.adapter.stream(options));assert.equal(direct.at(-1).reason.kind,'stop');
 assert.equal(f.calls.filter(c=>Array.isArray(c)&&c[0]==='ensure').length,2);
 assert.equal(f.calls.filter(c=>c==='model-stream').length,2);
});
test('unconsented or failed automatic startup never dispatches a model or retries',async()=>{
 const f=fixture();f.setState({state:'not-running',code:'CONSENT_REQUIRED',message:'Use settings first'});
 await assert.rejects(f.service.adapter.prepareCall('doubao-client','0'),{code:'CONSENT_REQUIRED'});
 const chunks=await Array.fromAsync(f.service.adapter.stream(options));assert.equal(chunks.at(-1).reason.failure.code,'CONSENT_REQUIRED');
 assert.equal(f.calls.includes('model-stream'),false);assert.equal(f.calls.some(c=>Array.isArray(c)&&c[0]==='start'),false);
});
test('cancelled stream never reaches startup and both lifecycle resources dispose',async()=>{
 const f=fixture(),ac=new AbortController();ac.abort(Error('stop'));
 const chunks=await Array.fromAsync(f.service.adapter.stream({...options,signal:ac.signal}));assert.equal(chunks.at(-1).reason.kind,'aborted');
 assert.equal(f.calls.length,0);await f.service.dispose();assert.deepEqual(f.calls,['startup-dispose','bridge-dispose']);
});
test('missing channel and broken ledger cannot hide first-use diagnostics',async()=>{
 const f=fixture();f.setState({supported:true,state:'not-running',code:'NOT_RUNNING',message:'Start from settings',autoStart:false,consentGranted:false});
 f.bridge.inspect=async()=>{throw Error('must not interrogate an unverified endpoint');};f.bridge.quota=f.bridge.inspect;
 f.ledger.summary=async()=>{throw Error('broken usage file');};
 const r=await f.service.status();assert.equal(r.setup.state,'not-running');assert.equal(r.connection.status,'disconnected');assert.equal(r.usage.diagnostics.complete,false);assert.deepEqual(f.calls,['diagnostics']);
});
test('transport verification is strictly observation and rejects unverified owners',async()=>{
 const f=fixture();await f.service.verifyClientRead();assert.deepEqual(f.calls,['observe']);
 f.setState({state:'port-conflict',code:'PORT_CONFLICT',message:'Wrong owner'});
 await assert.rejects(f.service.verifyClientRead(),{code:'PORT_CONFLICT'});assert.equal(f.calls.some(c=>Array.isArray(c)&&c[0]==='ensure'),false);
});
test('optional adapter hook is absent by default for standalone adapters',async()=>{
 const adapter=createDoubaoAdapter({bridge:{inspect:async()=>({models:[{id:'0',name:'Quick',modeId:'1',agentMode:2}]})},ledger:{record:async()=>{}}});
 assert.equal((await adapter.resolveModel('doubao-client','0')).id,'0');
});
