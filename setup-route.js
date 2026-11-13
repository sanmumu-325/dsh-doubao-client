import {safeError} from './bridge.js';

// Mounted only on Connection's authenticated Fetch carrier. These actions are
// intentionally NOT exposed by the read-only model-facing status tool.
export function createSetupRoute(service) {
  return {path:'/api/doubao-client/setup',methods:['POST'],requestBody:'buffered',async fetch(request){
    const send=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
    if(request.method!=='POST')return send({ok:false,error:'POST required'},405);
    if(request.headers.get('x-dsh-doubao')!=='1'||request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return send({ok:false,error:'Expected authenticated JSON setup request'},403);
    let args;
    try{
      const text=await request.text();if(Buffer.byteLength(text,'utf8')>4096)return send({ok:false,error:'Request too large'},413);
      args=JSON.parse(text);
      if(!args||typeof args!=='object'||Array.isArray(args))throw Error('Invalid setup action');
      const keys={diagnostics:['action'],configure:['action','executablePath','autoStart','consent'],start:['action','executablePath','consent']}[args.action];
      if(!keys||Object.keys(args).some(k=>!keys.includes(k)))throw Error('Invalid setup action');
      if(args.executablePath!==undefined&&(typeof args.executablePath!=='string'||!args.executablePath.trim()||args.executablePath.length>2048||/[\0\r\n]/.test(args.executablePath)))throw Error('Invalid executable path');
      if(args.autoStart!==undefined&&typeof args.autoStart!=='boolean')throw Error('Invalid autoStart');
      if(args.consent!==undefined&&!['LOCAL_DEBUGGING','REVOKE'].includes(args.consent))throw Error('Invalid consent');
      if(args.action==='start'&&args.consent==='REVOKE')throw Error('Invalid start consent');
    }catch{return send({ok:false,error:'Invalid setup request'},400);}
    // A form, cross-origin request, or non-browser caller cannot silently mutate
    // saved launch consent. The literal consent value is also checked downstream.
    if(args.action!=='diagnostics'){
      let origin;try{origin=new URL(request.url).origin;}catch{return send({ok:false,error:'Invalid request origin'},403);}
      if(request.headers.get('origin')!==origin||['cross-site','same-site'].includes(request.headers.get('sec-fetch-site')))return send({ok:false,error:'Setup changes require a same-origin settings action'},403);
    }
    try{return send({ok:true,result:await service.manageSetup(args,request.signal)});}
    catch(error){return send({ok:false,error:safeError(error),code:typeof error?.code==='string'&&/^[A-Z0-9_]{1,64}$/.test(error.code)?error.code:'DOUBAO_SETUP_FAILED'},error?.name==='AbortError'?409:400);}
  }};
}
