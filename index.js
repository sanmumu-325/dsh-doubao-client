import {DoubaoClientService} from './service.js';
import {safeError} from './bridge.js';
import {createSetupRoute} from './setup-route.js';
export const name='doubao-client';
export const inject=['llm','connection','tools','attachments'];
export function apply(ctx,config={}) {
  const service=new DoubaoClientService(config,ref=>ctx.llm.fileRequestText(ref),(ref,target,signal)=>ctx.attachments.readImageRequest(ref,target,signal));
  ctx.effect(()=>()=>service.dispose());
  ctx.llm.registerAdapter(['doubao-client'],service.adapter);
  ctx.connection.fetch.register(createSetupRoute(service));
  ctx.tools.register({name:'doubao_client_status',description:'只读查询豆包桌面客户端连接、实际订阅额度或本插件最近 90 天内用量。额度不是 token；无服务端 token 计数时显示未知，字数估算单列。不会发聊天、登录、重启客户端或执行豆包原生工作任务。',parameters:{type:'object',properties:{action:{type:'string',enum:['status','quota','usage'],default:'status',description:'status 返回连接、模型、额度和用量；quota 仅查真实订阅额度；usage 仅读本地台账。'},days:{type:'integer',minimum:1,maximum:90,default:90,description:'usage 的统计窗口，按 UTC+8 日历日，1–90 天。'}},additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_args,result)=>[{type:'text',text:JSON.stringify(result,null,2)}]},execute:args=>service.execute(args)});
  ctx.connection.fetch.register({path:'/api/doubao-client',methods:['POST'],requestBody:'buffered',async fetch(request){
    const send=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
    if(request.headers.get('x-dsh-doubao')!=='1'||!request.headers.get('content-type')?.startsWith('application/json'))return send({ok:false,error:'Expected authenticated JSON management request'},403);
    let args;try{const body=await request.text();if(body.length>4096)return send({ok:false,error:'Request too large'},413);args=JSON.parse(body);if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['action','days'].includes(k))||!['status','quota','usage'].includes(args.action??'status')||(args.days!==undefined&&(!Number.isInteger(args.days)||args.days<1||args.days>90)))throw Error('Invalid read action');}catch{return send({ok:false,error:'Invalid read action'},400);}
    try{return send({ok:true,result:await service.execute(args)});}catch(e){return send({ok:false,error:safeError(e)},500);}
  }});
}
