import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('./client.js',import.meta.url),'utf8');
const base={supported:true,state:'not-running',executablePath:'C:/Doubao/Doubao.exe',candidates:[{path:'D:/Doubao.exe',source:'registry'}],consentGranted:false,autoStart:false,endpoint:'http://127.0.0.1:19226',checkedAt:'2026-11-13T00:00:00Z'};
function harness(initial=base){
  let definition,component,tree,index=0,first=true,cleanup;
  const states=[],refs=[],effects=[],calls=[],timers=new Map();let serial=0;
  const react={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat()}),useState:value=>{const i=index++;if(!(i in states))states[i]=value;return [states[i],next=>{states[i]=typeof next==='function'?next(states[i]):next}]},useRef:value=>{const i=index++;return refs[i]??=({current:value})},useCallback:fn=>fn,useEffect:fn=>{if(first)effects.push(fn)}};
  const fetchMock=(url,options)=>new Promise((resolve,reject)=>{const call={url,options,body:JSON.parse(options.body),resolve:result=>resolve({ok:true,json:async()=>({ok:true,result})}),fail:(error,code)=>resolve({ok:false,status:400,json:async()=>({ok:false,error,code})})};calls.push(call);options.signal.addEventListener('abort',()=>reject(new Error('Aborted')),{once:true})});
  new Function('window','fetch','AbortController','setTimeout','clearTimeout',source)({__ModuleLoader__:{load:def=>{definition=def}}},fetchMock,AbortController,fn=>{timers.set(++serial,fn);return serial},id=>timers.delete(id));
  const dictionaries={};definition.factory(name=>{assert.equal(name,'react');return react}).apply({locale:{register:(_ns,lang,dict)=>{dictionaries[lang]=dict},bind:()=>key=>dictionaries.en[key]},slots:{inject:(_name,fn)=>fn(),register:(_def,fn)=>{component=fn}}});
  function render(){index=0;tree=component();first=false;return tree}
  function nodes(node=tree){return !node||typeof node!=='object'?[]:[node,...node.children.flatMap(child=>nodes(child))]}
  function findText(node,text){return node.children.some(child=>child===text||(child&&typeof child==='object'&&findText(child,text)))}
  function button(text){return nodes().find(node=>node.type==='button'&&findText(node,text))}
  function checkbox(text){const label=nodes().find(node=>node.type==='label'&&findText(node,text));return label?.children.find(node=>node?.type==='input')}
  const tick=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();render()};
  render();for(const effect of effects)cleanup=effect();
  return {calls,timers,render,nodes,button,checkbox,t: dictionaries.en,async ready(setup=initial){calls[0].resolve({setup});await tick()},async resolve(setup=initial){calls.at(-1).resolve(setup);await tick()},async tick(){await tick()},unmount(){cleanup()},text(){return JSON.stringify(tree)},click(text){const target=button(text);assert.ok(target,text);assert.equal(target.props.disabled,false,text+' enabled');return target.props.onClick()},changeConsent(value=true){checkbox(dictionaries.en.consent).props.onChange({target:{checked:value}});render()}};
}

test('mount and refresh only read status; diagnostic endpoint, headers and abort signal are explicit',async()=>{
  const ui=harness();assert.deepEqual(ui.calls.map(c=>c.body),[{action:'status'}]);
  await ui.ready();ui.click(ui.t.refresh);
  assert.equal(ui.calls.length,2);assert.equal(ui.calls[1].url,'/api/doubao-client');assert.deepEqual(ui.calls[1].body,{action:'status'});
  await ui.resolve({setup:base});ui.click(ui.t.detect);
  const call=ui.calls.at(-1);assert.equal(call.url,'/api/doubao-client/setup');assert.equal(call.options.credentials,'same-origin');assert.equal(call.options.headers['x-dsh-doubao'],'1');assert.equal(call.options.headers['content-type'],'application/json');assert.ok(call.options.signal instanceof AbortSignal);assert.deepEqual(call.body,{action:'diagnostics'});
  await ui.resolve();assert.ok(ui.text().includes(base.endpoint));
});

test('unchecked consent blocks first start and auto-start; explicit start sends literal authorization',async()=>{
  const ui=harness();await ui.ready();
  assert.equal(ui.checkbox(ui.t.consent).props.checked,false);assert.equal(ui.checkbox(ui.t.autoStart).props.checked,false);assert.equal(ui.checkbox(ui.t.autoStart).props.disabled,true);assert.equal(ui.button(ui.t.start).props.disabled,true);
  ui.changeConsent();ui.click(ui.t.start);assert.deepEqual(ui.calls.at(-1).body,{action:'start',executablePath:base.executablePath,consent:'LOCAL_DEBUGGING'});
  // A second event fired before React rerenders cannot create a simultaneous request.
  ui.button(ui.t.start).props.onClick();assert.equal(ui.calls.length,2);
  const connectedSetup={...base,state:'ready',consentGranted:true};
  await ui.resolve(connectedSetup);
  assert.deepEqual(ui.calls.map(call=>call.body.action),['status','start','status']);
  assert.equal(ui.calls.at(-1).url,'/api/doubao-client');
  assert.equal(ui.button(ui.t.startGranted).props.disabled,true);assert.ok(ui.text().includes(ui.t.setupReady));
  await ui.resolve({setup:connectedSetup,connection:{status:'connected',models:[{id:'updated',name:'Fresh catalog entry',access:'chat'}]},quota:{status:'known',windows:[],checkedAt:base.checkedAt}});
  assert.ok(ui.text().includes(ui.t.connected));assert.ok(ui.text().includes('Fresh catalog entry'));
  assert.equal(ui.calls.length,3,'successful startup triggers exactly one read-only refresh');
});

test('auto-start toggle saves only with authorization and revoke atomically disables it',async()=>{
  const ui=harness();await ui.ready();ui.changeConsent();
  ui.checkbox(ui.t.autoStart).props.onChange({target:{checked:true}});
  assert.deepEqual(ui.calls.at(-1).body,{action:'configure',executablePath:base.executablePath,autoStart:true,consent:'LOCAL_DEBUGGING'});
  await ui.resolve({...base,consentGranted:true,autoStart:true});assert.equal(ui.checkbox(ui.t.autoStart).props.checked,true);
  ui.click(ui.t.revoke);assert.deepEqual(ui.calls.at(-1).body,{action:'configure',consent:'REVOKE',autoStart:false});
  await ui.resolve();assert.equal(ui.checkbox(ui.t.autoStart).props.checked,false);assert.equal(ui.checkbox(ui.t.consent).props.checked,false);assert.ok(ui.text().includes(ui.t.setupRevoked));
  assert.ok(ui.calls.every(call=>call.body.action!=='start'));
});

test('candidate selection and manual path save never start or grant authorization',async()=>{
  const ui=harness();await ui.ready();
  ui.nodes().find(node=>node.type==='select').props.onChange({target:{value:'D:/Doubao.exe'}});ui.render();ui.click(ui.t.save);
  assert.deepEqual(ui.calls.at(-1).body,{action:'configure',executablePath:'D:/Doubao.exe'});await ui.resolve({...base,executablePath:'D:/Doubao.exe'});
  ui.nodes().find(node=>node.type==='input'&&node.props.type==='text').props.onChange({target:{value:'E:/Custom.exe'}});ui.render();ui.click(ui.t.save);
  assert.deepEqual(ui.calls.at(-1).body,{action:'configure',executablePath:'E:/Custom.exe'});await ui.resolve({...base,executablePath:'E:/Custom.exe'});
});

test('failed operations show alert without claiming success or changing authorization',async()=>{
  const ui=harness();await ui.ready();ui.changeConsent();ui.click(ui.t.start);ui.calls.at(-1).fail('Bad executable','INVALID_PATH');await ui.tick();
  assert.ok(ui.nodes().some(node=>node.props.role==='alert'));assert.ok(ui.text().includes('INVALID_PATH: Bad executable'));assert.ok(!ui.text().includes(ui.t.setupStarted));assert.equal(ui.checkbox(ui.t.autoStart).props.checked,false);
  assert.deepEqual(ui.calls.map(call=>call.body.action),['status','start'],'failed startup is neither retried nor refreshed');
});

test('HTTP-success operational failures cannot claim success or refresh startup',async()=>{
  const ui=harness();await ui.ready();ui.click(ui.t.save);
  await ui.resolve({...base,code:'CONFIGURATION_FAILED',message:'Cannot save settings'});
  assert.ok(ui.text().includes('CONFIGURATION_FAILED: Cannot save settings'));assert.ok(!ui.text().includes(ui.t.setupSaved));
  ui.changeConsent();ui.click(ui.t.start);await ui.resolve({...base,state:'unknown',code:'START_TIMEOUT',message:'Outcome unknown; detect again'});
  assert.ok(ui.text().includes('START_TIMEOUT: Outcome unknown; detect again'));assert.ok(!ui.text().includes(ui.t.setupStarted));
  assert.deepEqual(ui.calls.map(call=>call.body.action),['status','configure','start']);
});

for(const operation of ['save','revoke'])test('cancelled configure cannot claim '+operation+' success',async()=>{
  const authorized={...base,consentGranted:true};
  const ui=harness(authorized);await ui.ready();ui.click(ui.t[operation]);
  await ui.resolve({...authorized,code:'CONFIGURATION_CANCELLED',message:'Superseded by newer settings'});
  assert.ok(ui.nodes().some(node=>node.props.role==='alert'));
  assert.ok(ui.text().includes('CONFIGURATION_CANCELLED: Superseded by newer settings'));
  assert.ok(!ui.text().includes(ui.t.setupSaved));assert.ok(!ui.text().includes(ui.t.setupRevoked));
  assert.deepEqual(ui.calls.map(call=>call.body.action),['status','configure']);
});

test('start timeout reports unknown outcome, never retries and supports explicit detection',async()=>{
  const ui=harness();await ui.ready();ui.changeConsent();ui.click(ui.t.start);for(const timeout of ui.timers.values())timeout();await ui.tick();
  assert.equal(ui.calls.length,2);assert.ok(ui.text().includes(ui.t.setupTimeout));assert.ok(!ui.text().includes(ui.t.setupStarted));
  ui.click(ui.t.detect);assert.deepEqual(ui.calls.at(-1).body,{action:'diagnostics'});await ui.resolve({...base,state:'ready',consentGranted:true});
});

test('unmount aborts pending fetch and suppresses all post-unmount state updates',async()=>{
  const ui=harness();await ui.ready();ui.changeConsent();ui.click(ui.t.start);ui.render();const before=ui.text();const call=ui.calls.at(-1);ui.unmount();assert.equal(call.options.signal.aborted,true);await ui.tick();assert.equal(ui.text(),before);
});

for(const [state,key] of Object.entries({'ready':'setupReady','not-running':'setupNotRunning','running-no-channel':'setupNoChannel','not-installed':'setupNotInstalled','invalid-path':'setupInvalidPath','port-conflict':'setupPortConflict','unknown':'setupUnknown','starting':'setupStarting','unsupported':'setupUnsupported'}))test('state copy and safe controls: '+state,async()=>{
  const ui=harness({...base,state,supported:state!=='unsupported',consentGranted:true});await ui.ready();assert.ok(ui.text().includes(ui.t[key]));
  if(['ready','running-no-channel','port-conflict','starting','unsupported'].includes(state))assert.equal(ui.button(ui.t.startGranted).props.disabled,true);
  assert.equal(ui.calls.length,1);
});
