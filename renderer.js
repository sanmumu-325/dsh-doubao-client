// Functions run only inside the user-authorized Doubao chat renderer.
export async function inspectRenderer() {
  let require;const chunk='dsh_doubao_inspect_'+crypto.randomUUID();const table=window['chunk_@flow-web/desktop'];
  if(!table?.push)throw new Error('Unsupported Doubao client bundle');
  table.push([[chunk],{},r=>require=r]);
  const state=require('ui').QY('chatInputStore').getState();const config=state.modeSelectConfigsV2;
  const models=[];const seen=new Set();
  for(const mode of config?.mode_list?.item_list??[]) {
    const list=config.use_mode_model_list?(mode.model_list?.item_list??config.model_list?.item_list??[]):config.model_list?.item_list??[];
    for(const m of list) {
      const id=String(m.model_item_key??m.item_id??'');if(!id||seen.has(id)||m.subscribe_config?.need_upgrade===true)continue;seen.add(id);
      const old=state.modeSelectConfigs?.menu_item_list?.find(x=>String(x.model_item_key??x.item_id)===id);
      models.push({id,name:String(m.name??old?.name??id),modeId:String(mode.mode_id),agentMode:mode.agent_mode??old?.agent_mode??2,itemId:m.item_id??old?.menu_type,extra:m.model_extra_params??{},contextWindow:Number(m.model_extra_params?.total_window_size)||null,reasoning:m.reasoning_effort_config?{defaultLevel:m.reasoning_effort_config.default_level,options:(m.reasoning_effort_config.option_list??[]).map(o=>({id:String(o.level),name:String(o.name)}))}:null});
    }
  }
  const common=require('smQ').vX();
  if(common?.baseURL!=='https://www.doubao.com')throw new Error('Unexpected Doubao upstream origin');
  // UK's shipped source reads Us.U.userInfo.user_id_str; only its SHA-256 leaves the renderer.
  let accountKey=null;
  try{const identity=require('Us').U.getState();const user=identity?.isUserInfoLoaded&&identity.userInfo?.user_id_str;if(typeof user==='string'&&user&&require('UK').eP()){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(user));accountKey=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');}}catch{}
  return {loggedIn:require('UK').eP()===true,accountKey,models,protocol:'doubao-desktop-chat-v2',origin:location.origin};
}
export async function quotaRenderer() {
  let require;window['chunk_@flow-web/desktop'].push([['dsh_doubao_quota_'+crypto.randomUUID()],{},r=>require=r]);
  await require('UK').$T();if(!require('UK').eP())throw new Error('豆包客户端未登录，请在客户端手动登录');
  const q=await require('ZP').uH.AGWGetSubscriptionQuotaSummary({product_line:'membership'});
  if(q.code!==undefined&&Number(q.code)!==0)throw new Error('豆包额度查询失败，code='+q.code);
  const d=q.data;if(!d)return null;
  // Exclude account identifiers, payment/order details and arbitrary unknown fields.
  const out={member_info:{hasActiveSubscription:d.member_info?.hasActiveSubscription===true}};
  for(const key of ['window_limit_section','enterprise_window_limit_section','quota_package_section','incentive_quota_section']) {
    const s=d[key];if(!s)continue;
    out[key]={usage_exhausted:s.usage_exhausted===true,window_limit_groups:(s.window_limit_groups??[]).map(g=>({feature_group:g.feature_group,feature_group_name:g.feature_group_name,window_limits:(g.window_limits??[]).map(w=>({window_type:w.window_type,total_amount:w.total_amount,used_amount:w.used_amount,used_percent:w.used_percent,start_time:w.start_time,end_time:w.end_time,unlimited:w.unlimited,exemption:w.exemption?{active:w.exemption.active,end_time:w.exemption.end_time}:undefined}))}))};
  }
  return out;
}
export async function startRendererStream(params, createDecoder) {
  const {id,binding,prompt,model,reasoningEffort,timeoutMs,maxOutputChars,images,continuation,accountKey}=params;
  let require;window['chunk_@flow-web/desktop'].push([['dsh_doubao_stream_'+id],{},r=>require=r]);
  const streams=window.__dshDoubaoStreams??=Object.create(null);
  const emit=v=>window[binding](JSON.stringify({id,...v}));
  const decoder=createDecoder();let instance,terminal=false,chars=0,timer;
  const failure=(error,fallback)=>({type:'error',code:error?.code??fallback,...error?.upstreamCode!==undefined?{upstreamCode:error.upstreamCode}:{},message:String(error?.message??'豆包请求失败').slice(0,300)});
  function finish(v){if(terminal)return;terminal=true;clearTimeout(timer);try{emit(v)}finally{try{instance?.cancel?.();}finally{delete streams[id];}}}
  const controller={cancel(){finish({type:'cancelled'})}};streams[id]=controller;
  try{
    const common=require('smQ').vX();if(common?.baseURL!=='https://www.doubao.com')throw new Error('Unexpected upstream origin');
    if(!require('UK').eP())throw new Error('豆包客户端未登录');
    // Verified from UK -> Us.U.getState(), not the assistant bot id or a cookie.
    const readAccount=()=>{try{const state=require('Us').U.getState();return state?.isUserInfoLoaded&&require('UK').eP()&&typeof state.userInfo?.user_id_str==='string'?state.userInfo.user_id_str:null;}catch{return null;}};
    const currentAccount=readAccount(),expectedAccount=continuation?.accountKey??accountKey;
    if(continuation&&(!expectedAccount||!currentAccount))throw Object.assign(new Error('无法核实当前账号身份，已阻止上游会话续接'),{code:'DOUBAO_ACCOUNT_UNKNOWN'});
    if(expectedAccount){
      if(!currentAccount)throw Object.assign(new Error('当前账号身份不可确认；停止请求，不自动重试'),{code:'DOUBAO_ACCOUNT_UNKNOWN'});
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(currentAccount));
      const actual=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
      if(actual!==expectedAccount)throw Object.assign(new Error('豆包登录账号已变化；停止请求并废弃续接状态'),{code:'DOUBAO_ACCOUNT_CHANGED'});
    }
    const assertAccount=()=>{if(expectedAccount&&readAccount()!==currentAccount)throw Object.assign(new Error('豆包登录账号已变化；停止请求并废弃续接状态'),{code:'DOUBAO_ACCOUNT_CHANGED'});};
    const boot=await require('ZP').cz.Launch();assertAccount();const botId=boot?.data?.assistant_bot_id;if(!botId)throw new Error('豆包未返回 assistant_bot_id');
    if(terminal)return {started:false};
    const localId='local_'+crypto.randomUUID();const messageId=crypto.randomUUID();
    // Real images are uploaded through the client's own channel (same one its paste
    // handler uses: UploaderService via module kD5, scene '5' / type 2) and then
    // referenced by uri in an attachment block -- the protocol has no base64 path.
    const blocks=[{block_type:10000,block_id:crypto.randomUUID(),parent_id:'',content:{text_block:{text:prompt}},meta_info:[],extra_info:{},append_fields:[]}];
    if(images?.length){
      const params=common.getCommonParams?.()??{};
      const uploader=require('kD5').x({userId:'',appId:params.aid??params.real_aid,logger:{persist:{error(){},info(){}}},scene:'5',type:2});
      const attachments=[];
      for(const image of images){
        assertAccount();if(terminal)return {started:false};
        const uploaded=await uploader({type:'base64',value:image.base64});assertAccount();
        if(!uploaded?.image_uri)throw new Error('豆包图片上传未返回 uri');
        attachments.push({type:1,identifier:crypto.randomUUID(),image:{name:image.name||'image.png',uri:uploaded.image_uri,image_ori:{url:'',width:uploaded.image_width??image.width??0,height:uploaded.image_height??image.height??0,format:String(image.mediaType??'image/png').split('/')[1]||'png',url_formats:{}}},parse_state:0,review_state:1,upload_status:1,progress:100,src:''});
        if(terminal)return {started:false};
      }
      blocks.push({block_type:10052,block_id:crypto.randomUUID(),parent_id:'',content:{attachment_block:{attachments},pc_event_block:''},meta_info:[],extra_info:{},append_fields:[]});
    }
    const extra={...continuation?{conversation_id:continuation.conversationId}:{local_conversation_id:localId},local_message_id:messageId,session_id:crypto.randomUUID(),bot_id:botId,create_time:Date.now(),status:1,
      content_blocks_v2:blocks,
      ext:{agent_mode:String(model.agentMode),model_item_key:model.id,mode_id:model.modeId,reasoning_effort:String(reasoningEffort??model.reasoning?.defaultLevel??3),model_extra_params:JSON.stringify(model.extra??{}),conversation_mode:model.modeId==='1'?'chat':'office',conversation_init_option:JSON.stringify({need_ack_conversation:true}),use_deep_think:String(model.thinkingCode??model.itemId??0),support_lazy_fetch_stream:'0',commerce_credit_config_enable:'1'}};
    const body=require('Xca').oy(extra,{localPermissions:[],taskMode:'once'});
    body.option.general_task_param={server_do_compare:false};
    if(continuation){
      if(typeof continuation.conversationId!=='string'||!continuation.conversationId.trim())throw Object.assign(new Error('无效的上游续接标识'),{code:'DOUBAO_CONTINUITY_LOST'});
      body.client_meta.conversation_id=continuation.conversationId;
      body.client_meta.last_section_id=typeof continuation.sectionId==='string'?continuation.sectionId:'';
      body.option.need_create_conversation=false;
      delete body.client_meta.local_conversation_id;
      delete body.option.conversation_init_ext;delete body.option.conversation_init_option;
    }
    assertAccount();
    timer=setTimeout(()=>finish({type:'error',code:'DOUBAO_TIMEOUT',message:'豆包生成超时；请求结果不明，不自动重试'}),timeoutMs);
    instance=require('T5X').T({baseURL:common.baseURL,path:'/chat/completion',query:common.getCommonParams?.()??{},headers:common.getCommonHeaders?.()??{},body,
      openInterceptor:async response=>{assertAccount();if(!response.ok)throw new Error('豆包 HTTP '+response.status);if(!response.headers.get('content-type')?.startsWith('text/event-stream'))throw new Error('豆包返回非流式响应');},
      onMessage:message=>{if(terminal)return;try{assertAccount();const data=message.data?JSON.parse(message.data):{};for(const item of decoder.accept(message.event,data)){if(item.type==='text'||item.type==='reasoning'){chars+=item.text.length;if(chars>maxOutputChars)throw new Error('豆包输出超过本地字符安全上限');}if(item.type==='done'){finish(item);return;}emit(item);}}catch(error){finish(failure(error,'DOUBAO_PROTOCOL_ERROR'));}},
      onError:error=>finish(failure(error,'DOUBAO_UPSTREAM_ERROR')),
      onClose:()=>{if(!terminal)finish({type:'error',code:'DOUBAO_INCOMPLETE',message:'豆包连接在明确结束标记前关闭；不自动重试'});}});
    if(terminal)instance?.cancel?.();
    return {started:true};
  }catch(error){finish(failure(error,'DOUBAO_START_FAILED'));return {started:false};}
}
