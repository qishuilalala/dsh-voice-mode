import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'

export declare const name = 'voice-mode'
export declare const inject: string[]

export type TtsEngineKind = 'edge' | 'vits' | 'kokoro' | 'openai' | 'mimo'
export type KokoroModel = 'int8' | 'fp32'

export interface AsrReplacement {
  from: string[]
  to: string
}

export interface OpenAiTtsConfig {
  baseUrl: string
  apiKey: string
  apiKeys: Record<string, string>
  model: string
  voice: string
  instructions: string
  responseFormat: 'mp3' | 'wav'
  timeoutMs: number
  fallback: 'none' | 'vits' | 'kokoro'
  fallbackVoice: string
}

export declare const OpenAiTtsConfig: z<OpenAiTtsConfig>

export interface MimoTtsConfig {
  apiKey: string
  baseUrl: string
  model: string
  voice: string
  instructions: string
  responseFormat: 'wav' | 'mp3'
  timeoutMs: number
  fallback: 'none' | 'vits' | 'kokoro'
  fallbackVoice: string
}

export declare const MimoTtsConfig: z<MimoTtsConfig>

export interface VoiceSettingsValue {
  ttsEngine: TtsEngineKind
  kokoroModel: KokoroModel
  voice: string
  rate: number
  interruptLevel: 0 | 1 | 2
  silenceMs: number
  idleTimeoutMinutes: number
  modelHost: string
  autoSend: boolean
  autoResume: boolean
  mode: 'toggle' | 'hold' | 'once'
  readAloud: 'voice' | 'always' | 'off'
  showCaptions: boolean
  showStatusBar: boolean
  bargeInMode: 'auto' | 'manual' | 'detect'
  echoGateDb: number
  shortcut: string
  composerShortcut: string
  spokenFormat: boolean
  senseVoice: boolean
  wakeWord: string
  toolBeep: boolean
  senseITN: boolean
  captionFontSize: 0 | 1 | 2 | 3
  captionMaxWidth: 0 | 1 | 2
  backchannelYield: boolean
  bargeInSalvage: boolean
  asrReplacements: AsrReplacement[]
  llmCorrect: boolean
  openaiPreset: string
  openaiBaseUrl: string
  openaiModel: string
  openaiApiKey: string
  openaiApiKeys: Record<string, string>
  mimoApiKey: string
  yieldMs: number
}

export declare function createVoiceSettingsSchema(defs?: Partial<VoiceSettingsValue>): z<VoiceSettingsValue>
export declare const VoiceSettingsSchema: z<VoiceSettingsValue>

export interface Config {
  enabled: boolean
  cacheDir: string
  modelHost: string
  ttsEngine: TtsEngineKind
  kokoroModel: KokoroModel
  openaiTts: OpenAiTtsConfig
  mimoTts: MimoTtsConfig
  allowLan: boolean
  asrReplacements: AsrReplacement[]
  allowCustomModelHost: boolean
  voice: string
  rate: number
  interruptLevel: 0 | 1 | 2
  silenceMs: number
  idleTimeoutMinutes: number
  autoSend: boolean
  autoResume: boolean
  mode: 'toggle' | 'hold' | 'once'
  readAloud: 'voice' | 'always' | 'off'
  showCaptions: boolean
  showStatusBar: boolean
  bargeInMode: 'auto' | 'manual' | 'detect'
  echoGateDb: number
  shortcut: string
  composerShortcut: string
  spokenFormat: boolean
  senseVoice: boolean
  wakeWord: string
  toolBeep: boolean
  senseITN: boolean
  captionFontSize: 0 | 1 | 2 | 3
  captionMaxWidth: 0 | 1 | 2
  backchannelYield: boolean
  bargeInSalvage: boolean
  llmCorrect: boolean
  yieldMs: number
}

export declare const Config: z<Config>

export declare function apply(ctx: Context, config: Config): void
