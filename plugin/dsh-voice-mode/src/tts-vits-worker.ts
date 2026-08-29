/**
 * fork 新增：本地 TTS 合成子进程（child_process.fork），支持 vits / kokoro 两种引擎。
 *
 * 运行时分工：
 *  - vits（纯中文）：sherpa-onnx WASM（createOfflineTts）。WASM 在 worker_threads
 *    下有 Abort() 缺陷，子进程主线程形态实测稳定，故仍走子进程。
 *  - kokoro（中英多语言）：sherpa-onnx-node 原生 addon（new OfflineTts）。
 *    原生 onnxruntime 无 WASM 内存上限/累积 Abort 问题，2026-08 spike 实测
 *    连续 98+ 句合成无崩溃，不再需要"每 3 句重启子进程"；numThreads=4 时
 *    RTF≈0.55（WASM 无真线程）。
 *
 * 协议（主进程 → 子进程）：
 *   init { type:'init', id, kind:'vits'|'kokoro', paths }
 *     vits   paths: { model, lexicon, tokens, date, phone, number }
 *     kokoro paths: { model, voices, tokens, dataDir, lexicon }
 *   { type: 'synth', id, text, sid, speed }  → 回 { id, ok, sampleRate, samples(base64 f32) }
 *   { type: 'close', id }                    → 回 { id, ok }
 */
import sherpa_onnx from 'sherpa-onnx'
import sherpa_node from 'sherpa-onnx-node'
import { sanitizeForTts } from './segmenter'

interface WasmTts {
  generate(input: { text: string; sid: number; speed: number }): { samples: Float32Array; sampleRate: number }
  free(): void
}

interface NativeTts {
  generate(input: { text: string; generationConfig: unknown }): { samples: Float32Array; sampleRate: number }
  free(): void
}

const { createOfflineTts } = sherpa_onnx as unknown as {
  createOfflineTts(config: Record<string, unknown>): WasmTts
}

const { OfflineTts, GenerationConfig } = sherpa_node as unknown as {
  OfflineTts: new (config: Record<string, unknown>) => NativeTts
  GenerationConfig: new (opts: Record<string, unknown>) => unknown
}

const send = (msg: Record<string, unknown>): void => {
  if (typeof process.send === 'function') process.send(msg)
}

let wasmTts: WasmTts | null = null
let nativeTts: NativeTts | null = null
let initKind: 'vits' | 'kokoro' = 'vits'
let initPaths: Record<string, string> = {}

function createEngine(): void {
  if (initKind === 'kokoro') {
    nativeTts = new OfflineTts({
      model: {
        kokoro: {
          model: initPaths.model,
          voices: initPaths.voices,
          tokens: initPaths.tokens,
          dataDir: initPaths.dataDir,
          lexicon: initPaths.lexicon,
        },
        // 2 线程：留核给主进程的 ASR 解码（4 线程满核会饿死识别，
        // 打断后定稿等待分钟级；2 线程 RTF≈1 仍实时）。
        numThreads: 2,
        debug: 0,
        provider: 'cpu',
      },
      // 中文数字/日期/电话规范化（与 VITS 同源 FST）：阿拉伯数字按中文读。
      ruleFsts: [initPaths.date, initPaths.phone, initPaths.number].filter(Boolean).join(','),
      maxNumSentences: 1,
    })
    return
  }
  wasmTts = createOfflineTts({
    model: {
      vits: {
        model: initPaths.model,
        lexicon: initPaths.lexicon,
        tokens: initPaths.tokens,
      },
      numThreads: 1,
      debug: 0,
      provider: 'cpu',
    },
    ruleFsts: [initPaths.date, initPaths.phone, initPaths.number].join(','),
    ruleFars: '',
    maxNumSentences: 1,
  })
}

function reply(id: unknown, payload: Record<string, unknown>): void {
  send({ id: typeof id === 'number' ? id : 0, ...payload })
}

process.on('message', (msg: Record<string, unknown>) => {
  try {
    if (msg.type === 'init') {
      initKind = msg.kind === 'kokoro' ? 'kokoro' : 'vits'
      initPaths = msg.paths as Record<string, string>
      createEngine()
      reply(msg.id, { ok: true })
      return
    }
    if (msg.type === 'synth') {
      // 剥离 emoji/特殊符号（本地引擎词表不认识，逐字打 "Unknown token" 噪音）；
      // "1. 2."式编号消毒：数字后接 ASCII 句点改为顿号；
      // 再兜底剔除会被英文念出的 markdown 噪声字符（试听等不经分句器的路径）。
      const text = sanitizeForTts(
        String(msg.text ?? '')
          .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, ' ')
          .replace(/(\d)[.．]\s*/g, '$1、'),
      )
      if (!text.trim()) {
        // 清洗后为空（纯 emoji/符号段）：回 0.2s 静音，避免引擎报
        // "Failed to convert '' to token IDs" 噪音（队列继续、该句无声）。
        const sr = 24000
        reply(msg.id, {
          ok: true,
          sampleRate: sr,
          samples: Buffer.alloc(Math.floor(sr * 0.2) * 4).toString('base64'),
        })
        return
      }
      const sid = Number(msg.sid ?? 0)
      const speed = Number(msg.speed ?? 1)
      let audio: { samples: Float32Array; sampleRate: number }
      if (initKind === 'kokoro') {
        if (!nativeTts) {
          reply(msg.id, { ok: false, error: 'tts child not initialized' })
          return
        }
        const gc = new GenerationConfig({ sid, speed, silenceScale: 0.2 })
        audio = nativeTts.generate({ text, generationConfig: gc })
      } else {
        if (!wasmTts) {
          reply(msg.id, { ok: false, error: 'tts child not initialized' })
          return
        }
        audio = wasmTts.generate({ text, sid, speed })
      }
      // 本环境 fork IPC 为 JSON 序列化（Buffer/ArrayBuffer 会被降级成对象）——
      // 用 base64 字符串传输样本（帧约数百 KB，开销可忽略）。
      const buf = Buffer.from(audio.samples.buffer, audio.samples.byteOffset, audio.samples.byteLength)
      reply(msg.id, { ok: true, sampleRate: audio.sampleRate, samples: buf.toString('base64') })
      return
    }
    if (msg.type === 'close') {
      try {
        wasmTts?.free()
      } catch {
        // ignore
      }
      try {
        nativeTts?.free()
      } catch {
        // ignore
      }
      wasmTts = null
      nativeTts = null
      reply(msg.id, { ok: true })
      return
    }
    reply(msg.id, { ok: false, error: `unknown message type: ${String(msg.type)}` })
  } catch (e) {
    reply(typeof msg?.id === 'number' ? msg.id : 0, { ok: false, error: String(e) })
  }
})
