import assert from 'node:assert/strict'
import { voiceClient } from './helpers/voice-client.mjs'
import { voiceHost, tick } from './helpers/voice-host.mjs'
import { micRenderer, reactStub, asrStub } from './helpers/mic-renderer.mjs'
const h=await voiceHost()
await h.post('toggle',{sessionId:'A',on:true,tabId:'tab'})
const r=micRenderer()
const c=await voiceClient({'react':reactStub,'asr.ts':asrStub})
let running=false,draft='',submitted=0
const config={...c.bus.ui.boot,mode:'once',readAloud:'voice',autoResume:false,autoSend:true,llmCorrect:false,bargeInMode:'manual',idleTimeoutMinutes:10}
const baseFetch=globalThis.fetch
globalThis.fetch=async(url,init)=>{
  if(String(url).endsWith('/config')) return {ok:true,json:async()=>config}
  if(String(url).endsWith('/cancel')) {await h.post('cancel',JSON.parse(init.body));return {ok:true,json:async()=>({ok:true})}}
  return baseFetch(url,init)
}
const props={bus:c.bus,sessionId:'A',useSession:fn=>fn({running}),useInput:fn=>fn({draft,phase:'idle'}),inputActions:{setDraft(v){draft=v},submit(){submitted++;draft=''}}}
try {
  await r.mount(()=>c.MicButton(props))
  r.button().props.onClick({detail:1});await r.flush()
  assert.equal(c.bus.activeSessionId,'A', JSON.stringify({error:c.bus.ui.error,requests:c.requests}))
  const e=globalThis.__micEngine
  assert.equal(e.active,true)
  e.segmentFn('第一回合',{force:true});await r.flush()
  assert.equal(submitted,1)
  running=true;await r.render()
  c.emit('turn',{sessionId:'A',state:'agent-speaking',turn:1});c.audio('A',1);await r.flush()
  assert.equal(e.active,false,'once 等待回复时应关麦')
  h.pre('A',1);await h.speak('A','仍然在合成的句子。后面排队的句子。')
  assert.equal(h.jobs.length,1)
  const p={button:0,ctrlKey:false,clientY:0,pointerId:1,currentTarget:{setPointerCapture(){}}}
  r.button().props.onPointerDown(p);await r.advance(250)
  assert.equal(c.bus.ui.playing,false,'once 等待中长按必须能打断朗读')
  h.jobs[0].resolve();await tick()
  assert.equal(h.jobs.length,1,'打断后积压句子不得合成')
  assert.equal(h.events().filter(e=>e.type==='audio').length,0,'迟到合成结果不得下发')
  assert.equal(h.events().find(e=>e.type==='tts-idle').turn,1,'host idle 应携带回合身份')
  for(const ev of h.events().filter(e=>e.type==='tts-idle')) c.emit('tts-idle',ev)
  running=false;await r.render()
  c.emit('tts-idle',{sessionId:'A'});c.emit('tts-idle',{sessionId:'A'});await r.advance(11000)
  assert.equal(c.bus.activeSessionId,'A','被打断的回合不得经 idle 或 10 秒兜底退出')
  assert.equal(e.active,true,'打断后应恢复收音，允许继续说话')
  r.button().props.onPointerUp(p);await r.flush()
  e.segmentFn('下一回合',{force:true});await r.flush()
  running=true;await r.render();c.emit('turn',{sessionId:'A',state:'agent-speaking',turn:2})
  c.emit('tts-idle',{sessionId:'A',turn:1})
  assert.equal(c.bus.ui.ttsDrained,false,'上一回合的迟到 idle 不得把新回合标成已排空')
  c.audio('A',2)
  c.emit('tool',{sessionId:'A',name:'lookup'});c.finishAudio();await r.advance(12000)
  assert.equal(c.bus.activeSessionId,'A','工具调用空档不得退出')
  c.emit('turn',{sessionId:'A',state:'agent-speaking',turn:2});c.audio('A',3);await r.flush()
  assert.equal(c.bus.ui.playing,true,'新回合工具后续 step 正常朗读')
  running=false;await r.render();c.emit('tts-idle',{sessionId:'A'});c.finishAudio();await r.advance(1300)
  assert.equal(c.bus.activeSessionId,null,'下一回合自然读完仍须退出')
  // 队列已空、自然收尾计时已启动时，Ctrl 打断也撤销 settle/stall/noStart。
  await r.advance(2500);r.button().props.onClick({detail:1});await r.flush()
  const e2=globalThis.__micEngine
  e2.segmentFn('空队列回合',{force:true});await r.flush()
  running=true;await r.render();c.emit('turn',{sessionId:'A',state:'agent-speaking',turn:3})
  running=false;await r.render();c.emit('tts-idle',{sessionId:'A'});await r.advance(500)
  c.key('keydown',{key:'Control',code:'ControlLeft',repeat:false,shiftKey:false,ctrlKey:true,altKey:false,metaKey:false,target:null})
  await r.flush()
  c.key('keyup',{key:'Control'})
  c.emit('tts-idle',{sessionId:'A'});await r.advance(31000)
  assert.equal(c.bus.activeSessionId,'A','空队列打断须撤销所有已武装的收尾/未启动计时器')
  assert.equal(e2.active,true)
  e2.segmentFn('无 idle 的自然收尾',{force:true});await r.flush()
  running=true;await r.render();c.emit('turn',{sessionId:'A',state:'agent-speaking',turn:4})
  running=false;await r.render();await r.advance(10001)
  assert.equal(c.bus.activeSessionId,null,'正常回合仍保留 10 秒丢失 idle 兜底')
  console.log('  ✓ once 长按打断后保留语音模式并恢复收音；重复 idle/兜底不误退；下一回合多 step 自然收尾')
} finally {r.close();c.close();await h.close();delete globalThis.__micEngine}
