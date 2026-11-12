// 真 host、分句器和 TtsQueue；只替换网络合成与模型/存储边界。
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
export const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
export const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
export async function voiceHost() {
  const tmp = mkdtempSync(join(tmpdir(), 'voice-focus-'))
  const jobs = []
  globalThis.__voiceJobs = jobs
  const stubs = {
    'msedge-tts': `export const OUTPUT_FORMAT = {}; export class MsEdgeTTS {
      async setMetadata() {} async close() {} async getVoices() { return [] }
      toStream(text) { const jobs = globalThis.__voiceJobs; return { audioStream: (async function*() {
        await new Promise(resolve => jobs.push({ text, resolve })); yield Buffer.from([255,251,144,0]);
      })() } } }`,
    'asr-host.ts': `export function createAsrRuntime() { return { modelStatus: () => ({asr:{ready:false},vad:{ready:false},sense:{enabled:false,ready:false}}), warmup(){}, warmupSense(){}, reset(){}, dispose(){}, markStale(){} } } export function handleAsrRequest(){}`,
    'tts-local.ts': `export function createSherpaVitsEngine(){} export function createSherpaKokoroEngine(){} export const TTS_MODEL_REPO=''; export function kokoroModelDir(){return ''}`,
    'settings-store.ts': `export function readOverrides(){return {values:{}}} export function readLegacyVoiceSettings(){return {}} export function pickKnownKeys(o){return o??{}} export function settingsFilePath(){return ''} export function unknownKeys(){return []} export function writeOverrides(){}`,
  }
  const outfile = join(tmp, 'host.mjs')
  await build({ stdin: { contents: "export { apply } from './index.ts'; export { TtsQueue } from './tts-queue.ts'", resolveDir: fileURLToPath(new URL('../../src/', import.meta.url)), loader: 'ts' }, outfile,
    bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{name:'boundaries',setup(b){
      b.onResolve({filter:/.*/}, args => {const name=args.path.split('/').pop(); if(stubs[name]) return {path:name,namespace:'stub'}})
      b.onLoad({filter:/.*/,namespace:'stub'}, args=>({contents:stubs[args.path],loader:'js'}))
    }}] })
  const { apply, TtsQueue } = await import(pathToFileURL(outfile))
  const routes = new Map(), hooks = new Map(), disposers = []
  apply({
    effect(fn){const d=fn(); if(typeof d==='function') disposers.push(d); return d},
    on(name,fn){hooks.set(name,fn);return ()=>{}},
    get(name){if(name==='sessions') return {get:id=>({id})}},
    settings:{register(){return {get:()=>({readAloud:'always',ttsEngine:'edge'}),watch:()=>()=>{}}}},
    webServer:{register(r){routes.set(r.path,r.handler);return ()=>routes.delete(r.path)}},
  }, {enabled:true,cacheDir:tmp,ttsEngine:'edge',allowLan:false,allowCustomModelHost:false})
  function request(path, body, method='POST') {
    const req = new EventEmitter(), res = new EventEmitter(), done = deferred()
    Object.assign(req,{socket:{remoteAddress:'127.0.0.1'},headers:{host:'localhost'},url:path,method,pause(){},resume(){},destroy(){}})
    Object.assign(res,{statusCode:200,blocks:[],writableLength:0,
      writeHead(code){this.statusCode=code},setHeader(){},flushHeaders(){},
      write(block){this.blocks.push(String(block));return true},
      end(body){this.body=body;done.resolve();this.emit('finish');queueMicrotask(()=>this.emit('close'))},
    })
    routes.get(path.split('?')[0])(req,res)
    if(body!==undefined){req.emit('data',Buffer.from(JSON.stringify(body)));req.emit('end')}
    return {req,res,done:done.promise}
  }
  const post = async(path,body)=>{const r=request('/voice-mode/'+path,body);await r.done;assert.equal(r.res.statusCode,200);return r.res}
  const stream = tab => request('/voice-mode/stream?tabId='+tab,undefined,'GET')
  const observer=stream('observer')
  const events=()=>observer.res.blocks.flatMap(s=>{const m=/event: ([^\n]+)\ndata: (.*)/.exec(s);return m?[{type:m[1],...JSON.parse(m[2])}]:[]})
  const pre=(sid,turn,step=1)=>hooks.get('agent/pre-step')({agent:{id:sid},turn,step},()=>{})
  const tap=(sid,inner)=>hooks.get('llm/stream')({sessionId:sid},()=>inner)
  const speak=async(sid,text)=>{for await(const _ of tap(sid,(async function*(){yield {type:'text-delta',text}})())){} await tick()}
  return {TtsQueue,jobs,post,stream,events,pre,tap,speak,hooks,
    async close(){for(const j of jobs)j.resolve();await tick();for(const d of disposers.reverse())d();await tick();rmSync(tmp,{recursive:true,force:true});delete globalThis.__voiceJobs},
  }
}
