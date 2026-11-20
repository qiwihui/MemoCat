export const DEFAULT_SCHEDULE={enabled:true,intervalMinutes:5};
export function scheduleConfig(store){return {...DEFAULT_SCHEDULE,...store.getSetting('syncSchedule',{})};}
export function validateSchedule(input){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['enabled','intervalMinutes'].includes(k))||typeof input.enabled!=='boolean'||!Number.isInteger(input.intervalMinutes)||input.intervalMinutes<1||input.intervalMinutes>1440)throw new Error('同步间隔须为 1–1440 的整数分钟，并指定定时开关');return {enabled:input.enabled,intervalMinutes:input.intervalMinutes};}
export class SyncScheduler{
 constructor(store,service,{now=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout}={}){Object.assign(this,{store,service,now,setTimer,clearTimer});this.generation=0;this.closed=false;this.reset();}
 status(){return {...scheduleConfig(this.store),nextRun:this.nextRun?new Date(this.nextRun).toISOString():null};}
 configure(input){const config=validateSchedule(input);this.store.setSetting('syncSchedule',config);this.reset();return this.status();}
 reset(){this.generation++;if(this.timer)this.clearTimer(this.timer);this.timer=null;this.nextRun=null;const config=scheduleConfig(this.store);if(this.closed||!config.enabled)return;const generation=this.generation;this.nextRun=this.now()+config.intervalMinutes*60000;this.timer=this.setTimer(async()=>{this.timer=null;this.nextRun=null;try{if(this.store.getSetting('sources',[]).some(s=>s.enabled))await this.service.sync();}catch{/* service keeps source failures in syncState; always rearm */}finally{if(!this.closed&&generation===this.generation)this.reset();}},config.intervalMinutes*60000);this.timer?.unref?.();}
 close(){this.closed=true;this.generation++;if(this.timer)this.clearTimer(this.timer);this.timer=null;this.nextRun=null;}
}
