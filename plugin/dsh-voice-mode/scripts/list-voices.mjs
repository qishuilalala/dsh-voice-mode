#!/usr/bin/env node
/**
 * 打印 msedge-tts 可用的音色清单（README 音色参考表的权威来源）。
 *
 * 用法：
 *   node scripts/list-voices.mjs            # 全部音色
 *   node scripts/list-voices.mjs zh         # 仅中文（zh-CN / zh-HK / zh-TW）
 *   node scripts/list-voices.mjs zh,en      # 多区域过滤（逗号分隔前缀）
 */
import { MsEdgeTTS } from 'msedge-tts'

const filter = (process.argv[2] ?? '').split(',').filter(Boolean).map((s) => s.trim().toLowerCase())

const tts = new MsEdgeTTS()
const voices = await tts.getVoices()
const rows = voices
  .filter((v) => filter.length === 0 || filter.some((f) => v.Locale.toLowerCase().startsWith(f)))
  .sort((a, b) => a.Locale.localeCompare(b.Locale) || a.ShortName.localeCompare(b.ShortName))
  .map((v) => `${v.ShortName}\t${v.Locale}\t${v.Gender}\t${v.FriendlyName}`)

if (rows.length === 0) {
  console.error('未获取到音色（网络不可达或服务变更），请检查后重试。')
  process.exitCode = 1
} else {
  console.log(`共 ${rows.length} 个音色（ShortName 即配置 voice 的取值）：`)
  console.log('ShortName\tLocale\tGender\tFriendlyName')
  console.log(rows.join('\n'))
}
await tts.close()