import {createHash} from 'node:crypto';

// In-memory metadata only: no prompts, account identifiers or transcript contents.
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stable=value=>{
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));
  return value;
};
const digest=value=>hash(stable(value));
export class ConversationStore {
  constructor({ttlMs=30*60*1000,maxEntries=64,now=()=>Date.now()}={}){
    this.ttlMs=ttlMs;this.maxEntries=maxEntries;this.now=now;this.entries=new Map();this.owners=new Map();this.epoch=0;
  }
  key(sessionId){return typeof sessionId==='string'&&sessionId.trim()?hash(sessionId):null;}
  forget(sessionId){const key=this.key(sessionId);if(key){this.entries.delete(key);this.owners.delete(key);}}
  clear(){this.epoch++;this.entries.clear();this.owners.clear();}
  prepare({sessionId,purpose,accountKey,scope,messages,hasImages=false}){
    const key=this.key(sessionId),time=this.now();
    for(const [id,state] of this.entries)if(time<state.at||time-state.at>this.ttlMs)this.entries.delete(id);
    const prior=key?this.entries.get(key):null;
    // Consume the prior state before any I/O: failure, cancellation or abandonment
    // leaves no reusable server thread. A successful caller must explicitly commit.
    if(key)this.entries.delete(key);
    const eligible=!!key&&!purpose&&!hasImages&&typeof accountKey==='string'&&accountKey.length>0;
    const scoped=digest({accountKey,scope});
    const fingerprints=messages.map(digest);
    const same=eligible&&prior&&prior.scope===scoped&&fingerprints.length>prior.fingerprints.length&&prior.fingerprints.every((v,i)=>v===fingerprints[i]);
    const continuation=same?{conversationId:prior.conversationId,...prior.sectionId?{sectionId:prior.sectionId}:{},accountKey}:undefined;
    let committed=false;const epoch=this.epoch,owner=Symbol();if(key)this.owners.set(key,owner);
    return {
      continuation,
      reason:same?'continuation':!key?'missing-session-id':purpose?'auxiliary-call':hasImages?'image-history':!accountKey?'unknown-account':!prior?'no-previous-complete-turn':prior.scope!==scoped?'settings-or-account-changed':'history-changed',
      from:same?prior.fingerprints.length:0,
      commit:({conversationId,sectionId,assistant})=>{
        if(committed||epoch!==this.epoch||this.owners.get(key)!==owner||!eligible||typeof conversationId!=='string'||!conversationId.trim()||!assistant)return false;
        committed=true;this.owners.delete(key);this.entries.delete(key);
        this.entries.set(key,{scope:scoped,fingerprints:[...fingerprints,digest(assistant)],conversationId,...typeof sectionId==='string'&&sectionId?{sectionId}:{},at:this.now()});
        while(this.entries.size>this.maxEntries)this.entries.delete(this.entries.keys().next().value);
        return true;
      },
    };
  }
  get size(){return this.entries.size;}
}
