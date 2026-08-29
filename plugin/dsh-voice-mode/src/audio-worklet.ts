/**
 * Voice capture AudioWorklet —— 专用音频渲染线程采集（P3-4 性能整洁项）。
 *
 * 背景：ScriptProcessor 的 onaudioprocess 跑在主线程，主线程被 GC/React 渲染/大对象
 * 分配占住时，其音频回调超时 → glitch/丢帧。AudioWorklet 在独立高优先级音频线程
 * 执行 process()，主线程忙时帧在 port 消息队列自然排队，不丢帧、不卡渲染。
 *
 * 职责：按 context 采样率收 mic 单声道 → 线性重采样到 16k → 每 1024 样本（64ms）
 * 经 port.postMessage（transferable）传给主线程 handleAudio。重采样从主线程挪到本线程，
 * 进一步减小主线程每帧开销。
 *
 * 本文件由 build.mjs 独立打包为 IIFE 字符串，经 esbuild define 注入 client bundle，
 * 运行时用 URL.createObjectURL(Blob) 交给 audioCtx.audioWorklet.addModule 加载——
 * 规避「浏览器仅服务 client.js、无法 addModule 独立 lib 文件」的部署约束。
 */

// AudioWorkletGlobalScope 专用全局（不在 TS DOM/Worker lib 中，做最小环境声明）。
declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, processorCtor: unknown): void

import { resampleLinear } from './resample.ts'

const TARGET_RATE = 16000
/** 输出块大小（16k 下 1024 = 64ms，与主线程 durationMs 口径一致）。 */
const CHUNK = 1024
/** 每产出一块 16k 输出所需输入样本数（含 ceil，非整数比下有 1 样本余量，块边界误差可忽略）。 */
const RATIO = sampleRate / TARGET_RATE
const NEED = Math.ceil(CHUNK * RATIO)

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  private acc = new Float32Array(0)
  private accLen = 0

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0]
    if (ch && ch.length > 0) this.push(ch)
    this.drain()
    return true // 持续存活（不返回 false 终止）
  }

  private push(ch: Float32Array): void {
    if (this.accLen + ch.length > this.acc.length) {
      let cap = this.acc.length > 0 ? this.acc.length : NEED * 2
      while (cap < this.accLen + ch.length) cap *= 2
      const next = new Float32Array(cap)
      next.set(this.acc.subarray(0, this.accLen))
      this.acc = next
    }
    this.acc.set(ch, this.accLen)
    this.accLen += ch.length
  }

  private drain(): void {
    while (this.accLen >= NEED) {
      const out = resampleLinear(this.acc.subarray(0, NEED), sampleRate, TARGET_RATE)
      const chunk = out.length >= CHUNK ? out.subarray(0, CHUNK) : (() => {
        const p = new Float32Array(CHUNK)
        p.set(out)
        return p
      })()
      this.port.postMessage(chunk, [chunk.buffer])
      this.acc.copyWithin(0, NEED, this.accLen)
      this.accLen -= NEED
    }
  }
}

registerProcessor('voice-capture', VoiceCaptureProcessor)
