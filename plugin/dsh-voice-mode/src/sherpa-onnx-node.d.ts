/**
 * sherpa-onnx-node（CJS 原生 addon）最小类型声明。
 * 仅覆盖本插件用到的 API；完整 API 见官方 nodejs-addon-examples。
 */
declare module 'sherpa-onnx-node' {
  const mod: {
    OfflineTts: new (config: Record<string, unknown>) => {
      generate(input: { text: string; generationConfig: unknown }): { samples: Float32Array; sampleRate: number }
      free(): void
    }
    GenerationConfig: new (opts: Record<string, unknown>) => unknown
    OfflinePunctuation: new (config: Record<string, unknown>) => {
      addPunct(text: string): string
    }
    writeWave(filename: string, audio: { samples: Float32Array; sampleRate: number }): void
  }
  export default mod
}
