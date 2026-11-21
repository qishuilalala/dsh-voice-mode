/**
 * 预设音色表回归（2026-11-20 级联重构 Slice 1）。
 *
 * 背景：openai/mimo 的音色下拉被写死 []，用户选完服务没有音色可选。
 * 本测试锁住：每个预设都有非空 voices 表；默认 voice 必须在表内；
 * MiMo 音色表非空且含服务端默认。
 */
import assert from "node:assert/strict"
import { OPENAI_PRESETS } from "../src/tts-openai.ts"
import { MIMO_VOICES } from "../src/voice-catalog.ts"

let passed = 0
const t = (name, fn) => {
  fn()
  passed += 1
  console.log("  ok " + name)
}

console.log("preset-voices")

t("每个预设都有非空 voices 表", () => {
  for (const entry of Object.entries(OPENAI_PRESETS)) {
    const id = entry[0]
    const p = entry[1]
    assert.ok(Array.isArray(p.voices) && p.voices.length > 0, "预设 " + id + " 没有可选音色")
  }
})

t("每个预设的默认 voice 必须在 voices 表内", () => {
  for (const entry of Object.entries(OPENAI_PRESETS)) {
    const id = entry[0]
    const p = entry[1]
    assert.ok(p.voices.includes(p.voice), "预设 " + id + " 的默认音色不在表内")
  }
})

t("托管预设至少 8 个音色（单音色等于级联空架子）", () => {
  const ids = ["siliconflow-cosyvoice2", "siliconflow-fish", "openrouter-openai", "openai-official"]
  for (const id of ids) {
    assert.ok(OPENAI_PRESETS[id].voices.length >= 8, "预设 " + id + " 音色不足 8 个")
  }
})

t("硅基两预设共用 8 系统音色（仅模型前缀不同）", () => {
  const strip = (arr) => arr.map((v) => v.split(":")[1]).sort()
  const a = strip(OPENAI_PRESETS["siliconflow-cosyvoice2"].voices)
  const b = strip(OPENAI_PRESETS["siliconflow-fish"].voices)
  assert.deepEqual(a, b)
  assert.ok(a.includes("alex") && a.includes("anna"), "缺少文档示例音色 alex/anna")
})

t("MiMo 音色表非空且含服务端默认", () => {
  assert.ok(MIMO_VOICES.length >= 5, "MiMo 音色过少")
  assert.ok(MIMO_VOICES.includes("mimo_default"), "缺少 mimo_default")
})

console.log(passed + " passed")
