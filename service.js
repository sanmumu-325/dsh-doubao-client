import path from 'node:path';
import {homedir} from 'node:os';
import {createDoubaoBridge,safeError} from './bridge.js';
import {createUsageLedger} from './usage.js';
import {createDesktopStartup} from './startup.js';
import {createDoubaoAdapter,modelAccess,modelAccessReason,supportedModel,VISION_MODELS} from './adapter.js';
export class DoubaoClientService {
  constructor(config={},fileRequestText,readImageRequest=null,dependencies={}) {
    this.endpoint=config.endpoint??'http://127.0.0.1:19226';
    const dataDirectory=path.join(process.env.LOCALAPPDATA??path.join(homedir(),'AppData','Local'),'dsh-doubao-client');
    this.startup=dependencies.startup??createDesktopStartup({endpoint:this.endpoint,directory:dataDirectory});
    this.bridge=dependencies.bridge??createDoubaoBridge({endpoint:this.endpoint,timeoutMs:config.timeoutMs??180000,maxOutputChars:config.maxOutputChars??120000,busyWaitMs:config.busyWaitMs??20000,maxConcurrent:config.maxConcurrent??2,beforeConnect:signal=>this.verifyClientRead(signal)});
    this.ledger=dependencies.ledger??createUsageLedger({directory:path.join(dataDirectory,'usage')});
    this.maxPromptChars=config.maxPromptChars??200000;this.recordError=null;this.lastState=null;this.contextWindows=config.contextWindows??{};this.trustDeclaredWindow=config.trustDeclaredWindow===true;
    this.adapter=createDoubaoAdapter({bridge:this.bridge,ledger:this.ledger,maxPromptChars:config.maxPromptChars??200000,fileRequestText,readImageRequest,contextWindows:config.contextWindows??{},trustDeclaredWindow:config.trustDeclaredWindow===true,busyWaitMs:config.busyWaitMs??20000,beforeModelUse:signal=>this.ensureClientForUse(signal),onRecordError:error=>{this.recordError=error}});
  }
  async verifyClientRead(signal){
    if(signal?.aborted)throw signal.reason??Error('Cancelled');
    const setup=await this.startup.observe({signal});
    if(setup.state!=='ready')throw Object.assign(Error(setup.message??'无法核实本机豆包调试端口'),{code:setup.code??'DOUBAO_SETUP_REQUIRED'});
  }
  async ensureClientForUse(signal){
    if(signal?.aborted)throw signal.reason??Error('Cancelled');
    const setup=await this.startup.ensure({signal});
    if(setup.state!=='ready')throw Object.assign(new Error(setup.message??'请先在豆包插件设置页完成连接授权和诊断'),{code:setup.code??'DOUBAO_SETUP_REQUIRED'});
  }
  async manageSetup({action,...options},signal){
    if(action==='diagnostics')return this.startup.diagnostics();
    if(action==='configure'){
      const result=await this.startup.configure(options);
      if(['CONFIGURATION_FAILED','CONFIGURATION_CANCELLED','INVALID_PATH','DISPOSED'].includes(result.code))throw Object.assign(Error(result.message),{code:result.code});
      return result;
    }
    if(action==='start'){
      const result=await this.startup.start({...options,signal});
      if(result.state!=='ready')throw Object.assign(Error(result.message),{code:result.code??'DOUBAO_SETUP_FAILED'});
      return result;
    }
    throw Object.assign(Error('Invalid setup action'),{code:'DOUBAO_SETUP_INVALID'});
  }
  async quota(){try{return await this.bridge.quota();}catch(e){return {status:'unknown',error:safeError(e),checkedAt:null,cached:this.bridge.cachedQuota(),stale:!!this.bridge.cachedQuota()};}}
  usage({days=90}={}){return this.ledger.summary({days});}
  // 与 adapter.windowOf 保持同一套规则（纯计算，不重复调用 bridge，避免并发 inspect 冲突）。
  windowFor(model){
    const measured=Number(this.contextWindows?.[model.id]);
    if(Number.isFinite(measured)&&measured>0)return {tokens:measured,source:'measured'};
    if(!this.trustDeclaredWindow)return {tokens:null,source:'unverified'};
    const declared=Number(model.contextWindow);
    return Number.isFinite(declared)&&declared>0?{tokens:declared,source:'client-declared'}:{tokens:null,source:'unknown'};
  }
  async status(){
    // First-use diagnostics must remain available even when CDP, quota or the
    // usage ledger fail. These are observations, never auto-start requests.
    let setup;try{setup=await this.startup.diagnostics();}catch(error){setup={supported:process.platform==='win32',state:'unknown',code:'DOUBAO_SETUP_DIAGNOSTICS',message:safeError(error),consentGranted:false,autoStart:false};}
    const channel=this.bridge.channelStatus();
    let connection;
    if(setup.state!=='ready')connection={status:'disconnected',error:setup.message,lastKnown:this.lastState};
    else if(channel.active>=channel.maxConcurrent)connection={status:'busy',error:'豆包并发通道正在使用中；只展示上次目录，不等待生成结束',lastKnown:this.lastState};
    else try{const info=await this.bridge.inspect({refresh:true});const rows=info.models.map(m=>{const w=this.windowFor(m);return {id:m.id,name:m.name,modeId:m.modeId,modeName:m.modeId==='3'?'工作任务':'对话',access:modelAccess(m),contextWindow:w.tokens,contextWindowSource:w.source,images:VISION_MODELS.has(m.id),supported:supportedModel(m),reason:modelAccessReason(m)};});connection={status:'connected',loggedIn:info.loggedIn,checkedAt:info.checkedAt,models:rows};this.lastState=connection;}catch(e){connection={status:this.bridge.busy?'busy':'disconnected',error:safeError(e),lastKnown:this.lastState};}
    const quota=connection.status==='connected'?await this.quota():{status:'unknown',error:connection.error,checkedAt:null,cached:this.bridge.cachedQuota(),stale:!!this.bridge.cachedQuota()};
    let usage,usageError;try{usage=await this.usage();}catch(error){usageError=safeError(error);usage={today:{totals:null},all:{totals:null},diagnostics:{complete:false,error:usageError}};}
    return {provider:'doubao-client',version:'1.8.0',endpoint:this.endpoint,connection,quota,usage,setup,channel:this.bridge.channelStatus(),telemetry:this.bridge.telemetry(),risk:this.bridge.risk(),continuity:this.adapter.continuityStatus(),recordError:this.recordError,
      capabilities:{text:true,images:`${VISION_MODELS.size}/12 模型实测可读图（其余模型未验证，不声明）`,imageTarget:{width:1568,height:1568,maxBytes:1200*1024},imageMaxPerRequest:8,chatModels:['快速','专家'],workModels:'all-12-via-chat-mode（10 个工作任务模型全部以普通对话模式调用，实测可用）',nativeTaskRuntime:false,contextWindowSource:this.trustDeclaredWindow?'client-declared（客户端目录标称值，非本插件验证的可用 token 容量；不改变服务端窗口）':'unverified',toolCalling:'strict-json-emulation',nativeSystemRole:false,streaming:'text live without tools; tool-enabled text validated before publication',exactTokenUsage:'only if returned by upstream; currently not observed',maxPromptChars:this.maxPromptChars,busyWaitMs:this.bridge.busyWaitMs??0,maxConcurrent:this.bridge.maxConcurrent,sameSessionConcurrent:1,autoRetry:false},
      warnings:['非官方本人账号集成；客户端更新或风控可能导致失效。','12 个模型全部接入，但工作任务模型只以普通对话模式调用；插件不会启用豆包原生任务运行时、本地/云沙盒、桌面工具或联网执行。','自动与豆包 2.1 Pro 的任务型思考码（DeepThinkGeneralTask*）在上游只被原生任务模式接受，插件改用普通思考码 Auto 后实测可用。','图片会先上传到豆包自己的存储（复用客户端贴图的同一通道）再作为图片附件发出；图片字节不计入本地字数字账。','person-glm-5-3-flash 与 person-deepseek-v4-pro 目前连文字都被上游限流（710022004），因此它们的图片能力未验证、暂按纯文本声明。','完整 DSH 请求以文本转交豆包；不是独立 system/tools API，工具适配可靠性低于正式 API。','额度单位不是 token 或人民币；字数估算不会计入 DSH 真实 token 用量。','本机调试端口可控制当前豆包账号，请勿转发端口或在不可信多用户环境使用。','仅在账号身份可核实且本插件会话前缀完全匹配时安全续接；未知账号、分支或设置变化会新建对话。仅持有本插件当前进程内的续接状态，不读取已有历史；对话可能计入客户端历史。']};
  }
  execute({action='status',days=90}={}){if(action==='status')return this.status();if(action==='quota')return this.quota();if(action==='usage')return this.usage({days});throw Error('Unsupported Doubao read action');}
  async dispose(){await Promise.allSettled([Promise.resolve().then(()=>this.startup.dispose()),Promise.resolve().then(()=>this.bridge.dispose())]);}
}
