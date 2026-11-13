import test from 'node:test';
import assert from 'node:assert/strict';
import {createSetupRoute} from './setup-route.js';
const origin='http://127.0.0.1:12011';
function harness(){const calls=[];return {calls,route:createSetupRoute({async manageSetup(args,signal){calls.push({args,signal});return {state:'ready',autoStart:false};}})};}
function req(body,headers={},method='POST'){return new Request(origin+'/api/doubao-client/setup',{method,headers:{'content-type':'application/json','x-dsh-doubao':'1',origin,...headers},...(method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});}
test('authenticated route descriptor and explicit same-origin launch',async()=>{
 const h=harness();assert.equal(h.route.path,'/api/doubao-client/setup');assert.deepEqual(h.route.methods,['POST']);
 const r=await h.route.fetch(req({action:'start',consent:'LOCAL_DEBUGGING',executablePath:'C:/Doubao/app/Doubao.exe'}));
 assert.equal(r.status,200);assert.equal((await r.json()).result.state,'ready');assert.equal(h.calls.length,1);assert.equal(h.calls[0].signal instanceof AbortSignal,true);assert.equal(r.headers.get('cache-control'),'no-store');
});
for(const action of ['configure','start'])for(const headers of [{origin:'https://evil.example'},{origin:''},{origin:'null'},{'sec-fetch-site':'cross-site'},{'sec-fetch-site':'same-site'}])test('reject cross-origin/missing-origin mutation '+action+' '+JSON.stringify(headers),async()=>{
 const h=harness(),r=await h.route.fetch(req({action,consent:'LOCAL_DEBUGGING'},headers));assert.equal(r.status,403);assert.equal(h.calls.length,0);
});
test('diagnostics only read the setup and never inherit launch options',async()=>{
 const h=harness();assert.equal((await h.route.fetch(req({action:'diagnostics'}))).status,200);
 assert.equal((await h.route.fetch(req({action:'diagnostics',autoStart:true}))).status,400);assert.equal(h.calls.length,1);
});
for(const body of [[],null,{action:'kill'},{action:'start',args:['--anything']},{action:'configure',autoStart:'true'},{action:'configure',consent:true},{action:'start',consent:'REVOKE'},{action:'configure',executablePath:'a\nb'},{action:'configure',executablePath:''},'{bad'])test('invalid body is rejected before management '+JSON.stringify(body),async()=>{
 const h=harness();assert.equal((await h.route.fetch(req(body))).status,400);assert.equal(h.calls.length,0);
});
test('wrong method/content type and oversized payload fail closed',async()=>{
 const h=harness();assert.equal((await h.route.fetch(req(null,{},'GET'))).status,405);
 assert.equal((await h.route.fetch(req({action:'start'},{'content-type':'application/jsonx'}))).status,403);
 assert.equal((await h.route.fetch(req({action:'start'},{'x-dsh-doubao':''}))).status,403);
 assert.equal((await h.route.fetch(req('x'.repeat(4097)))).status,413);assert.equal(h.calls.length,0);
});
test('setup failures are errors, not fabricated successful starts',async()=>{
 const route=createSetupRoute({manageSetup:async()=>{throw Object.assign(Error('Please exit normally'),{code:'DOUBAO_RUNNING_NO_CHANNEL'});}});
 const r=await route.fetch(req({action:'start',consent:'LOCAL_DEBUGGING'}));const j=await r.json();assert.equal(j.ok,false);assert.equal(j.code,'DOUBAO_RUNNING_NO_CHANNEL');assert.match(j.error,/exit normally/);
});
