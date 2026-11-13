// Explicit opt-in integration checks. Consumes real account requests only with --live.
import assert from 'node:assert/strict';
import {DoubaoClientService} from './service.js';
if(!process.argv.includes('--live')){console.log('Read-only by default. Use: node live-check.mjs --live status|quick|expert|tool-loop|model:<id>|tools:<id>');process.exit(0);}
const arg=process.argv.at(-1),colon=arg.indexOf(':'),kind=colon<0?arg:arg.slice(0,colon),argId=colon<0?'':arg.slice(colon+1);
const service=new DoubaoClientService();
async function generate(options){const chunks=[];for await(const chunk of service.adapter.stream(options))chunks.push(chunk);const finish=chunks.findLast(x=>x.type==='finish');assert.ok(finish);assert.notEqual(finish.reason.kind,'error',finish.reason.failure?.message);assert.notEqual(finish.reason.kind,'aborted');return chunks;}
const textOf=chunks=>chunks.filter(x=>x.type==='text-delta').map(x=>x.text).join('');
const TOOL={name:'dsh_probe_sum',description:'Add two integers. For this verification, call this tool before answering the question.',parameters:{type:'object',properties:{a:{type:'integer'},b:{type:'integer'}},required:['a','b'],additionalProperties:false}};
async function toolLoop(model){
  const messages=[{role:'user',content:[{type:'text',text:'这是工具接入测试。必须调用 dsh_probe_sum 计算 19+23。不要自己算，也不要直接回答；请先输出规定的工具 JSON。'}]}];
  const base={provider:'doubao-client',model,system:'You are testing the DSH tool protocol. You MUST call the provided tool for addition. Once a tool result is returned, answer with the number it reports.',tools:[TOOL]};
  const first=await generate({...base,messages});assert.equal(first.at(-1).reason.kind,'tool-calls');const calls=first.filter(x=>x.type==='block-end'&&x.block.type==='tool-call').map(x=>x.block);assert.equal(calls.length,1);const call=calls[0];assert.equal(call.name,TOOL.name);const args=JSON.parse(call.arguments);assert.equal(args.a,19);assert.equal(args.b,23);
  // A test-only pure stub; never executes a tool name provided by the model.
  messages.push({role:'assistant',content:[call]},{role:'tool',toolCallId:call.id,content:[{type:'text',text:JSON.stringify({result:args.a+args.b})}]});
  const second=await generate({...base,messages});assert.equal(second.at(-1).reason.kind,'stop');const text=textOf(second);assert.match(text,/42/);
  return {model,tool:call.name,arguments:args,text,firstFinish:first.at(-1),secondFinish:second.at(-1)};
}
try{
 if(kind==='status'){const s=await service.status();console.log(JSON.stringify({connection:{status:s.connection.status,models:s.connection.models},quota:{status:s.quota.status,windows:s.quota.windows},usage:s.usage.all.totals,capabilities:s.capabilities},null,2));}
 else if(kind==='quick'||kind==='expert'||kind==='model'){
  const model=kind==='quick'?'0':kind==='expert'?'3':argId;assert.ok(model,'model:<id> requires an id');
  const chunks=await generate({provider:'doubao-client',model,system:'Follow the user request exactly. Do not use native tools.',messages:[{role:'user',content:[{type:'text',text:'只回复 DSH_ADAPTER_OK。'}]}]});
  const text=textOf(chunks);assert.match(text,/DSH_ADAPTER_OK/);console.log(JSON.stringify({verified:true,kind,model,text,finish:chunks.at(-1),serverUsage:chunks.find(x=>x.type==='usage')?.usage??null}));
 }
 else if(kind==='tool-loop')console.log(JSON.stringify({verified:true,...await toolLoop('3')}));
 else if(kind==='tools'){assert.ok(argId,'tools:<id> requires an id');console.log(JSON.stringify({verified:true,...await toolLoop(argId)}));}
 else throw Error('Unknown live check mode');
}finally{await service.dispose();}
