import assert from 'node:assert/strict'
import { voiceHost, tick, deferred } from './helpers/voice-host.mjs'
import { voiceClient } from './helpers/voice-client.mjs'
import { micRenderer, reactStub, asrStub } from './helpers/mic-renderer.mjs'

const h = await voiceHost()
try {
  await h.post('focus',{sessionId:'A',tabId:'tab'})
  h.pre('A',1)
  await h.speak('A','甲会话已经播放的第一句话。')
  h.jobs[0].resolve(); await tick()
  const first = h.events().find(e=>e.type==='audio' && e.final)
  assert.ok(first)
  const tail = deferred()
  const flow = (async()=>{for await(const _ of h.tap('A',(async function*(){
    yield {type:'text-delta',text:'甲会话在途的第二句话。甲会话排队的第三句话。'}
    await tail.promise
    yield {type:'text-delta',text:'焦点离开后流的余句仍然到达。'}
  })())){}})()
  await tick()
  assert.equal(h.jobs.length,2)
  await h.post('focus',{sessionId:'B',tabId:'tab'})
  h.jobs[1].resolve(); tail.resolve(); await flow; await tick()
  assert.equal(h.events().filter(e=>e.type==='audio' && e.sessionId==='A' && e.final).length,1,'切焦点必须作废 A 的迟到合成')
  assert.equal(h.jobs.length,2,'A 的积压和流余句不得再合成')
  h.pre('B',1); await h.speak('B','乙会话正常朗读。'); h.jobs.at(-1).resolve();await tick()
  await h.post('focus',{sessionId:'A',tabId:'tab'})
  h.pre('A',2); await h.speak('A','甲会话新回合正常朗读。');h.jobs.at(-1).resolve();await tick()
  const finals=h.events().filter(e=>e.type==='audio' && e.final)
  assert.deepEqual(finals.map(e=>e.sessionId),['A','B','A'])
  assert.ok(finals.every((e,i)=>i===0 || e.sentenceId>finals[i-1].sentenceId),'序号必须严格递增')
  console.log('  ✓ 切焦点作废在途、积压和流余句，B 与 A 新回合正常，序号单调')
  // 断连不是显式切焦点：旧 close 与最新连接断开都不能取消在途朗读。
  for(const voice of [false,true]) {
    if(voice)await h.post('toggle',{sessionId:'A',on:true,tabId:'tab'})
    const old=h.stream('tab'), fresh=h.stream('tab')
    old.req.emit('close');old.res.emit('close')
    h.pre('A',3);await h.speak('A','重连后继续朗读。')
    h.jobs.at(-1).resolve();await tick()
    assert.equal(h.events().filter(e=>e.type==='audio' && e.final).at(-1).text,'重连后继续朗读。')
    const eventStart=h.events().length
    h.pre('A',4)
    const reconnectTail=deferred()
    const reconnectFlow=(async()=>{for await(const _ of h.tap('A',(async function*(){
      yield {type:'text-delta',text:'断线时仍在合成的句子。'}
      await reconnectTail.promise
      yield {type:'text-delta',text:'重连后同一回合的后续句子。'}
    })())){}})()
    await tick()
    fresh.req.emit('close');h.jobs.at(-1).resolve();await tick()
    assert.equal(h.events().filter(e=>e.type==='audio' && e.final).at(-1).text,'断线时仍在合成的句子。','最新连接断开不得取消在途合成')
    assert.equal(h.events().filter(e=>e.type==='focus').at(-1).sessionId,null)
    h.stream('tab')
    await h.post('focus',{sessionId:'A',tabId:'tab'})
    reconnectTail.resolve();await reconnectFlow;await tick()
    h.jobs.at(-1).resolve();await tick()
    assert.equal(h.events().filter(e=>e.type==='audio' && e.final).at(-1).text,'重连后同一回合的后续句子。')
    // 同一 tap 的余句与 finally 均受捕获的 gen 守卫；二者放行锁定 turnGen 未变。
    assert.deepEqual(h.events().slice(eventStart).filter(e=>e.type==='turn' && e.turn===4).map(e=>e.state),['agent-speaking','listening'])
    console.log(`  ✓ SSE ${voice?'语音会话':'普通朗读'}：最新连接断开保留在途朗读与 turnGen，重连同回合继续朗读`)
    if(voice)await h.post('toggle',{sessionId:'A',on:false,tabId:'tab'})
  }
  await h.post('focus',{sessionId:'A',tabId:'tab'})
  h.pre('A',5);await h.speak('A','切走前尚未完成的合成。')
  const late=h.jobs.at(-1), count=h.events().filter(e=>e.type==='audio' && e.final).length
  await h.post('focus',{sessionId:'B',tabId:'tab'})
  await h.post('focus',{sessionId:'A',tabId:'tab'})
  h.pre('A',6);await h.speak('A','立即切回后的新回合。')
  late.resolve();await tick();h.jobs.at(-1).resolve();await tick()
  assert.deepEqual(h.events().filter(e=>e.type==='audio' && e.final).slice(count).map(e=>e.text),['立即切回后的新回合。'])
  console.log('  ✓ 旧合成跨越切走、切回、新回合后落定也不会复活')
  const gate=deferred(), frames=[]
  let interrupts=0
  const q=new h.TtsQueue({engine:{mime:'audio/wav',updateVoice(){},close:async()=>{},
    interrupt(){interrupts++},synthesize:async()=>{await gate.promise;return Buffer.from('RIFF-test')}}})
  q.subscribe(f=>frames.push(f))
  q.enqueue('A','甲');q.enqueue('B','乙');q.cancel('A');q.cancel('不存在的会话')
  assert.equal(interrupts,0,'取消 A 不得中断仍在合成 B 的共享引擎')
  gate.resolve();await tick()
  assert.deepEqual(frames.filter(f=>f.final).map(f=>f.sessionId),['B'])
  await q.close()
  console.log('  ✓ 取消不会误伤其它会话的共享引擎')
} finally { await h.close() }

// A 仍挂载时切走焦点：走真 host、bus、MicButton，设备和时钟由既有台架替换。
for (const mode of ['toggle','once']) {
  const host=await voiceHost(), r=micRenderer()
  const c=await voiceClient({'react':reactStub,'asr.ts':asrStub})
  let running=false,draft='',cursor=0
  const relay=()=>{const events=host.events();for(const ev of events.slice(cursor))c.emit(ev.type,ev);cursor=events.length}
  const config={...c.bus.ui.boot,mode,readAloud:'voice',autoResume:false,autoSend:true,llmCorrect:false,idleTimeoutMinutes:10}
  const baseFetch=globalThis.fetch
  globalThis.fetch=async(url,init)=>{
    if(String(url).endsWith('/config'))return {ok:true,json:async()=>config}
    const route=String(url).split('/').at(-1)
    if(['focus','toggle'].includes(route)) {
      const res=await host.post(route,JSON.parse(init.body));relay()
      return {ok:true,status:res.statusCode,json:async()=>JSON.parse(res.body)}
    }
    return baseFetch(url,init)
  }
  const props={bus:c.bus,sessionId:'A',useSession:fn=>fn({running}),useInput:fn=>fn({draft,phase:'idle'}),inputActions:{setDraft(v){draft=v},submit(){draft=''}}}
  try {
    await r.mount(()=>c.MicButton(props))
    r.button().props.onClick({detail:1});await r.flush()
    const mic=globalThis.__micEngine
    mic.segmentFn('首个回合',{force:true});await r.flush()
    running=true;await r.render()
    host.pre('A',1);await host.speak('A','正在播放的首句。')
    host.jobs.at(-1).resolve();await tick();relay();await r.flush()
    assert.equal(c.bus.ui.playing,true)
    const tail=deferred()
    const flow=(async()=>{for await(const _ of host.tap('A',(async function*(){
      yield {type:'text-delta',text:'切焦点时在途的句子。积压的句子。'}
      await tail.promise
      yield {type:'text-delta',text:'切走后本流剩余句子。'}
    })())){}})()
    await tick();relay()
    const jobs=host.jobs.length,finals=host.events().filter(e=>e.type==='audio' && e.final).length
    c.bus.setFocusedSession('B','navigation');await r.flush()
    assert.equal(c.bus.ui.playing,false,mode+'：显式切走必须停止 A')
    assert.equal(c.bus.activeSessionId,'A','仅切焦点不转移语音模式')
    assert.equal(mic.active,mode==='toggle','toggle 保持收音，once 等待回复时保持关麦')
    host.jobs.at(-1).resolve();tail.resolve();await flow;await tick();relay()
    assert.equal(host.jobs.length,jobs,'activeVoiceSession 也不得继续合成旧流余句')
    assert.equal(host.events().filter(e=>e.type==='audio' && e.final).length,finals)
    assert.equal(host.events().filter(e=>e.type==='tts-idle').length,0,'停播不伪造回合结束')
    await r.advance(12000)
    assert.equal(c.bus.activeSessionId,'A','回合仍 running 时 once 不提前退出')
    host.hooks.get('agent/turn-stopping')({agent:{id:'A'}});relay()
    assert.equal(host.events().filter(e=>e.type==='tts-idle').at(-1).turn,1,'取消后正常回合结束仍发 tts-idle')
    running=false;await r.render();await r.advance(1300)
    assert.equal(c.bus.activeSessionId,mode==='once'?null:'A')
    assert.equal(mic.active,mode==='toggle')
    // 切回后按原模式进入新回合；once 已自然退出，需要再次点麦克风。
    c.bus.setFocusedSession('A','navigation');await r.flush()
    if(mode==='once'){await r.advance(2500);r.button().props.onClick({detail:1});await r.flush()}
    const nextMic=globalThis.__micEngine
    assert.equal(nextMic.active,true)
    nextMic.segmentFn('新回合',{force:true});await r.flush()
    running=true;await r.render()
    host.pre('A',2);await host.speak('A','切回后的新回合正常朗读。')
    host.jobs.at(-1).resolve();await tick();relay();await r.flush()
    assert.equal(c.bus.ui.playing,true)
    assert.equal(c.bus.ui.playingCaption,'切回后的新回合正常朗读。')
    host.hooks.get('agent/turn-stopping')({agent:{id:'A'}});relay()
    running=false;await r.render();c.finishAudio();await r.advance(1300)
    assert.equal(c.bus.activeSessionId,mode==='once'?null:'A','新回合按原模式正常收尾')
    assert.equal(nextMic.active,mode==='toggle')
    await r.advance(31000)
    assert.equal(c.bus.activeSessionId,mode==='once'?null:'A','旧 once 计时不会污染后续状态')
    console.log(`  ✓ ${mode}：activeVoiceSession 切走停播，麦克风/收尾自洽，切回后新回合正常`)
    // 导航确实卸载 A 时，走组件自己的 cleanup，不能遗留麦克风和 once 等待。
    if(mode==='once'){r.button().props.onClick({detail:1});await r.flush()}
    const retiringMic=globalThis.__micEngine
    retiringMic.segmentFn('卸载前回合',{force:true});await r.flush()
    running=true;await r.render()
    r.unmount();await r.flush()
    assert.equal(retiringMic.active,false,'卸载必须关麦')
    assert.equal(c.bus.activeSessionId,null,'卸载经 toggle-off / mode 广播让出语音会话')
    assert.equal(host.events().filter(e=>e.type==='mode').at(-1).active,null)
    const modes=host.events().filter(e=>e.type==='mode').length
    await r.advance(31000)
    assert.equal(host.events().filter(e=>e.type==='mode').length,modes,'卸载后无残留 once 计时触发退出')
    running=false
    c.bus.setFocusedSession(null,'navigation')
    await r.mount(()=>c.MicButton(props))
    r.button().props.onClick({detail:1});await r.flush()
    globalThis.__micEngine.segmentFn('重新挂载后的回合',{force:true});await r.flush()
    running=true;await r.render()
    host.pre('A',3);await host.speak('A','重新挂载后正常朗读。')
    host.jobs.at(-1).resolve();await tick();relay();await r.flush()
    assert.equal(c.bus.ui.playing,true)
    host.hooks.get('agent/turn-stopping')({agent:{id:'A'}});relay()
    running=false;await r.render();c.finishAudio();await r.advance(1300)
    assert.equal(c.bus.activeSessionId,mode==='once'?null:'A')
    console.log(`  ✓ ${mode}：卸载释放语音模式、麦克风与等待计时，重新挂载后可朗读及收尾`)
  } finally {r.close();await tick();c.close();await host.close();delete globalThis.__micEngine}
}
