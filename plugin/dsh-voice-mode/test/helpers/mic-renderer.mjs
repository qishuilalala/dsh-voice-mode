// 最小 hook/时钟台架：执行真 MicButton 的事件与 effect，不按源码文本断言。
export function micRenderer() {
  const cells=[],effects=[]; let pos=0,dirty=true,renderFn,tree,now=100000,id=0
  const timers=new Map(), saved={setTimeout,clearTimeout,setInterval,clearInterval,dateNow:Date.now}
  const arm=(fn,ms,interval)=>{const n=++id;timers.set(n,{fn,at:now+ms,ms,interval});return n}
  globalThis.setTimeout=(fn,ms=0)=>arm(fn,ms,false)
  globalThis.setInterval=(fn,ms=0)=>arm(fn,ms,true)
  globalThis.clearTimeout=globalThis.clearInterval=n=>timers.delete(n)
  Date.now=()=>now
  const changed=(a,b)=>!a||!b||a.length!==b.length||a.some((v,i)=>v!==b[i])
  const hooks={
    useRef(v){return cells[pos++]??=( {current:v} )},
    useState(v){const i=pos++;cells[i]??={value:typeof v==='function'?v():v};return [cells[i].value,n=>{const next=typeof n==='function'?n(cells[i].value):n;if(next!==cells[i].value){cells[i].value=next;dirty=true}}]},
    useEffect(fn,deps){const i=pos++;if(changed(cells[i]?.deps,deps)) effects.push(()=>{cells[i]?.cleanup?.();cells[i]={deps,cleanup:fn()}})},
    useCallback(fn,deps){const i=pos++;if(changed(cells[i]?.deps,deps))cells[i]={deps,value:fn};return cells[i].value},
    useSyncExternalStore(_s,get){return get()},
    createElement(type,props,...children){return {type,props:{...props,children}}},
  }
  globalThis.__micHooks=hooks
  const flush=async()=>{for(let i=0;i<40;i++){await Promise.resolve();if(dirty&&renderFn){dirty=false;pos=0;tree=renderFn();while(effects.length)effects.shift()()}}}
  const buttons=n=>!n||typeof n!=='object'?[]:[...(n.type==='button'?[n]:[]),...(n.props?.children??[]).flat(Infinity).flatMap(buttons)]
  const unmount=()=>{renderFn=null;for(const cell of cells)cell?.cleanup?.();cells.length=0;effects.length=0;dirty=true}
  return {hooks,flush,unmount,
    async mount(fn){renderFn=fn;await flush()},
    async render(){dirty=true;await flush()},
    button(){return buttons(tree).find(n=>n.props.onPointerDown)},
    async advance(ms){const end=now+ms;await flush();for(;;){const due=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;const [n,t]=due;now=t.at;if(t.interval)t.at+=t.ms;else timers.delete(n);t.fn();await flush()}now=end;await flush()},
    close(){unmount();Object.assign(globalThis,{setTimeout:saved.setTimeout,clearTimeout:saved.clearTimeout,setInterval:saved.setInterval,clearInterval:saved.clearInterval});Date.now=saved.dateNow;delete globalThis.__micHooks},
  }
}
export const reactStub=`export const {useState,useRef,useEffect,useCallback,useSyncExternalStore,createElement}=globalThis.__micHooks; export const Fragment='fragment';`
export const asrStub=`export function createAsrEngine(options) {
  const e={active:false,holding:false,state:'idle',starts:0,stops:0,
    async start(){this.active=true;this.starts++;this.state='listening'},async stop(){this.active=false;this.stops++;this.holding=false},
    beginHeld(){if(this.active)this.holding=true},endHeld(){this.holding=false},async discardSegment(){},forceSend(){},
    onTelemetry(){},onLevel(){},onError(){},onNotice(){},onState(fn){this.stateFn=fn},onPartial(fn){this.partialFn=fn},onSegment(fn){this.segmentFn=fn},
    echoLevels(){return {floorRms:0,residualRms:0,peakRms:0}},
  };globalThis.__micEngine=e;return e
}`
