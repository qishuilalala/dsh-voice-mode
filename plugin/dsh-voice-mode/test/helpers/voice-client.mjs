// 编译真 client/bus/播放引擎，仅在测试 bundle 导出闭包工厂；浏览器设备边界由桩提供。
import { build } from 'esbuild'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
export async function voiceClient(stubs = {}) {
  const tmp=mkdtempSync(join(tmpdir(),'voice-client-')), requests=[], audios=[], sources=[]
  globalThis.sessionStorage={getItem:()=> 'tab',setItem(){}}
  globalThis.localStorage={getItem:()=>null,setItem(){},removeItem(){}}
  globalThis.location={origin:'http://localhost'}
  const windowEvents=new Map()
  globalThis.window={addEventListener(k,fn){if(!windowEvents.has(k))windowEvents.set(k,new Set());windowEvents.get(k).add(fn)},removeEventListener(k,fn){windowEvents.get(k)?.delete(fn)},getSelection:()=>null}
  globalThis.document={createElement:()=>({remove(){}}),head:{appendChild(){}},visibilityState:'visible',hidden:false,documentElement:{classList:{add(){},remove(){}}},addEventListener(){},removeEventListener(){}}
  globalThis.HTMLElement=class {}
  globalThis.Audio=class {constructor(){this.paused=true;audios.push(this)} async play(){this.paused=false;this.onplaying?.()} pause(){this.paused=true} removeAttribute(){} load(){} }
  globalThis.EventSource=class {
    listeners=new Map();constructor(){sources.push(this)}
    addEventListener(k,fn){this.listeners.set(k,fn)} close(){}
    emit(type,data){this.listeners.get(type)?.({data:JSON.stringify(data)})}
  }
  globalThis.fetch=async(url,init={})=>{requests.push({url,body:init.body?JSON.parse(init.body):null});return {ok:true,status:200,json:async()=>({active:init.body?JSON.parse(init.body).sessionId:null,ownerTabId:'tab'})}}
  const outfile=join(tmp,'client.mjs')
  await build({entryPoints:[fileURLToPath(new URL('../../src/client.tsx',import.meta.url))],outfile,bundle:true,format:'esm',platform:'browser',logLevel:'silent',
    define:{__AUDIO_WORKLET__:JSON.stringify(''),__BUILD_TAG__:JSON.stringify('test')},
    plugins:[{name:'test-export',setup(b){
      b.onResolve({filter:/.*/},a=>{const name=a.path.split('/').pop();if(stubs[name])return {path:name,namespace:'stub'}})
      b.onLoad({filter:/.*/,namespace:'stub'},a=>({contents:stubs[a.path],loader:'js'}))
      b.onLoad({filter:/\/client\.tsx$/},a=>({contents:readFileSync(a.path,'utf8')+'\nexport { createVoiceBus };',loader:'tsx'}))}}]})
  const {createVoiceBus,MicButton}=await import(pathToFileURL(outfile))
  const bus=createVoiceBus()
  // bus.enter 创建 SSE；focus-only 场景不需要激活语音会话，订阅会建立连接。
  bus.subscribe(()=>{})
  return {bus,MicButton,requests,audios,sources,
    key(type,e){for(const fn of windowEvents.get(type)??[])fn(e)},
    emit(type,data){sources.at(-1).emit(type,data)},
    finishAudio(){const a=audios[0];a.paused=true;a.onended?.()},
    audio(sid,seq){this.emit('audio',{sessionId:sid,sentenceId:seq,chunkId:0,final:false,audio:'/w=='});this.emit('audio',{sessionId:sid,sentenceId:seq,chunkId:1,final:true,audio:'',text:sid})},
    close(){bus.skipAudio();rmSync(tmp,{recursive:true,force:true})},
  }
}
