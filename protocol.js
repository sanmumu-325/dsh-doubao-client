// Pure decoder, injected verbatim into the authorized Doubao renderer.
export function createProtocolDecoder() {
  const blocks=new Map(); let active, finished=false;
  // Keep all helpers inside this function: its source is injected into the renderer.
  const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
  function object(value) {
    if(typeof value==='string'){try{value=JSON.parse(value)}catch{return null}}
    return value&&typeof value==='object'&&!Array.isArray(value)?value:null;
  }
  function counter(value) {
    if(typeof value==='string') {
      if(!/^\d+$/.test(value))return null;
      value=Number(value);
    }
    return Number.isSafeInteger(value)&&value>=0?value:null;
  }
  function blockEvents(list,{full=false}={}) {
    const out=[];
    for(const b of Array.isArray(list)?list:[]) {
      if(!b||typeof b!=='object')continue;
      if(b.content?.tool_call_block||b.content?.tool_use_block||b.content?.pc_event_block)throw new Error('Native Doubao task tools are not supported; no desktop action was executed');
      const id=String(b.block_id??b.id??'default');const content=b.content??{};
      const reasoning=content.thinking_block??content.reasoning_block??content.think_block??content.deep_think_block;
      const normal=content.text_block;const value=reasoning?.text??reasoning?.content??normal?.text;
      const kind=reasoning?'reasoning':'text';
      if(typeof value==='string') {
        const old=blocks.get(id)?.text??'';
        const replace=full||b.patch_type===2||b.reset===true;
        let delta=value;
        if(replace){if(value.startsWith(old))delta=value.slice(old.length);else if(old&&value!==old)throw new Error('Upstream revised an emitted text block');else if(value===old)delta='';}
        blocks.set(id,{kind,text:replace?value:old+value});active=id;
        if(delta)out.push({type:kind,text:delta});
      }
    }
    return out;
  }
  function metadata(ext) {
    const out=[];ext=object(ext);if(!ext)return out;
    // Context occupancy is telemetry, not billable token usage or commerce credit.
    const context=own(ext,'context_window_usage')?object(ext.context_window_usage):null;
    if(context) {
      const window={};
      for(const [source,target] of [['system_prompt','systemPrompt'],['messages','messages'],['skills','skills'],['tools','tools'],['total_window_size','totalWindowSize']]) {
        const value=own(context,source)?counter(context[source]):null;
        if(value!==null)window[target]=value;
      }
      const components=['systemPrompt','messages','skills','tools'];
      if(components.every(key=>own(window,key))) {
        // A sum may exceed the safe range even when each component is safe.
        let total=0;
        for(const key of components){if(window[key]>Number.MAX_SAFE_INTEGER-total){total=null;break}total+=window[key];}
        if(total!==null)window.totalUsed=total;
      }
      if(Object.keys(window).length)out.push({type:'context-window',window});
    }
    // Only trust named numeric counters; commerce credits are never tokens.
    let u=ext.token_usage??ext.usage;
    if(typeof u==='string'){try{u=JSON.parse(u)}catch{u=null}}
    if(u&&typeof u==='object') {
      const input=u.input_tokens??u.prompt_tokens,output=u.output_tokens??u.completion_tokens,total=u.total_tokens;
      if(Number.isSafeInteger(input)&&input>=0&&Number.isSafeInteger(output)&&output>=0)out.push({type:'usage',usage:{inputTokens:input,outputTokens:output,...Number.isSafeInteger(total)&&total>=0?{totalTokens:total}:{}}});
    }
    if(ext.commerce_usage_data_v1){let c;try{c=typeof ext.commerce_usage_data_v1==='string'?JSON.parse(ext.commerce_usage_data_v1):ext.commerce_usage_data_v1}catch{}if(c)out.push({type:'commerce',summary:{label:String(c.summary?.label??'').slice(0,80),value:String(c.summary?.value??'').slice(0,80)}});}
    return out;
  }
  return {accept(event,data) {
    if(finished)return [];
    if(event==='SSE_HEARTBEAT')return [];
    if(event==='SSE_ACK') {
      const meta=object(data?.ack_client_meta);
      const ack={type:'ack',conversationId:meta?.conversation_id??null};
      // Only explicit section fields can identify the server's continuation anchor.
      for(const source of [meta,object(data)]) {
        if(!source)continue;
        for(const key of ['last_section_id','section_id']) {
          if(own(source,key)&&(typeof source[key]==='string'&&source[key].length>0||typeof source[key]==='number'&&Number.isSafeInteger(source[key])&&source[key]>=0)) {
            ack.sectionId=String(source[key]);break;
          }
        }
        if(own(ack,'sectionId'))break;
      }
      return [ack];
    }
    if(event==='STREAM_ERROR'||event==='SSE_ERROR'||event==='STREAM_MSG_ERROR') {
      if([data?.code,data?.error_code].some(code=>code===710022004||code==='710022004')) {
        const error=new Error('豆包触发风控（710022004）；请停止连续重试，在豆包桌面客户端手动完成验证后再试。');
        error.code='DOUBAO_RISK_CONTROL';throw error;
      }
      throw new Error('Doubao upstream error '+String(data?.code??data?.error_code??'')+': '+String(data?.message??data?.msg??data?.error_msg??'request rejected').slice(0,240));
    }
    if(event==='CHUNK_DELTA') {
      const text=data?.text;
      if(typeof text!=='string')return [];
      const b=blocks.get(active);if(!b)throw new Error('Delta without an active text block');b.text+=text;return [{type:b.kind,text}];
    }
    if(event==='STREAM_MSG_NOTIFY')return [...blockEvents(data?.content?.content_block),...metadata(data?.content?.ext)];
    if(event==='FULL_MSG_NOTIFY') {if(Number(data?.message?.user_type)!==2)return [];return [...blockEvents(data?.message?.content_block,{full:true}),...metadata(data?.message?.ext)];}
    if(event==='STREAM_CHUNK') {
      const out=[];for(const p of Array.isArray(data?.patch_op)?data.patch_op:[]) {
        const value=object(p?.patch_value);if(!value)continue;
        out.push(...blockEvents(value.content_block,{full:p.patch_type===2}));out.push(...metadata(value.ext));
        // Native tool actions (including pc_event_block) are rejected by blockEvents.
      }return out;
    }
    if(event==='SSE_REPLY_END'&&Number(data?.end_type)===3){finished=true;return [{type:'done'}];}
    return [];
  },get finished(){return finished}};
}

export function normalizeQuota(data, checkedAt = new Date().toISOString()) {
  const number=v=>{if(typeof v==='number')return Number.isFinite(v)?v:null;if(typeof v!=='string'||!/^\d[\d,]*(?:\.\d+)?$/.test(v))return null;const n=Number(v.replaceAll(',',''));return Number.isFinite(n)?n:null;};
  const windows=[];
  for(const [key,source] of [['window_limit_section','subscription'],['enterprise_window_limit_section','enterprise'],['quota_package_section','package'],['incentive_quota_section','incentive']]) {
    const s=data?.[key];for(const group of s?.window_limit_groups??[])for(const w of group.window_limits??[]) {
      const used=number(w.used_amount),total=number(w.total_amount),end=number(w.end_time),usedPercent=number(w.used_percent);
      windows.push({source,group:String(group.feature_group??''),label:String(group.feature_group_name??''),windowType:w.window_type,windowLabel:({1:'5 小时',2:'近 7 天',3:'套餐总量',4:'每月'})[w.window_type]??'未知窗口',unit:'额度（不是 token 或人民币）',used,total,remaining:used!==null&&total!==null?Math.max(0,total-used):null,usedPercent,unlimited:w.unlimited===true||(w.window_type===1&&w.exemption?.active===true),exhausted:s.usage_exhausted===true,resetAt:end>0?new Date(end).toISOString():null});
    }
  }
  return {status:data?'known':'unknown',checkedAt,source:'豆包客户端订阅接口',hasActiveSubscription:data?.member_info?.hasActiveSubscription??null,windows};
}
