/**
 * fork：神经标点（方案 B）——sherpa-onnx-node 原生 addon 的 ct-transformer 标点模型。
 *
 * 识别定稿后自动补逗号/句号/问号/顿号（实测标点级准确率 92%，见
 * release/docs 评估文档）。纯后处理：识别器本身不受影响。
 *
 * 可靠性契约：模型未就绪/下载失败/推理异常一律回退原文——标点只是增益，
 * 绝不阻塞或破坏识别结果。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { ensureModelFile, type ModelFileSpec } from './models.ts'

const require = createRequire(import.meta.url)
const sherpaNode = require('sherpa-onnx-node') as unknown as {
  OfflinePunctuation: new (config: Record<string, unknown>) => { addPunct(text: string): string }
}

export const PUNCT_MODEL_REPO = 'csukuangfj/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12'

const PUNCT_FILES: ModelFileSpec[] = [
  { file: 'model.onnx', sha256: 'e93593a6dbd69a07f8734ef269dbe861a379755f8d1c8354719432116f2c44bd' },
]

/** 超长文本跳过标点：同步推理在主线程，长段会阻塞事件循环（罕见：3 分钟连说）。 */
const MAX_PUNCT_CHARS = 800

export interface PunctuatorOptions {
  cacheDir: string
  /** 已规范化的模型源 origin getter（下载期读最新设置）。 */
  modelHost: () => string
  allowCustomHost: boolean
  broadcast: (event: string, payload: unknown) => void
}

export interface Punctuator {
  /** 给文本补标点；任何失败/未就绪回退原文（绝不抛错）。 */
  punctuate(text: string): Promise<string>
}

export function createPunctuator(options: PunctuatorOptions): Punctuator {
  const { cacheDir, modelHost, allowCustomHost, broadcast } = options
  const repoDir = join(cacheDir, PUNCT_MODEL_REPO)

  let punct: { addPunct(text: string): string } | null = null
  let ready = false
  let loading: Promise<boolean> | null = null

  const ensure = async (): Promise<boolean> => {
    if (ready) return true
    if (!loading) {
      loading = (async () => {
        for (const spec of PUNCT_FILES) {
          const ok = await ensureModelFile({
            repo: PUNCT_MODEL_REPO,
            repoDir,
            spec,
            primaryHost: modelHost(),
            allowCustomHost,
            broadcast,
          })
          if (!ok) return false
        }
        punct = new sherpaNode.OfflinePunctuation({
          model: {
            ctTransformer: join(repoDir, 'model.onnx'),
            numThreads: 4,
            debug: 0,
            provider: 'cpu',
          },
        })
        ready = true
        broadcast('punct-ready', {})
        return true
      })().finally(() => {
        loading = null
      })
    }
    return loading
  }

  return {
    async punctuate(text) {
      const t = String(text ?? '').trim()
      if (!t || t.length > MAX_PUNCT_CHARS) return text
      if (!(await ensure())) return text
      try {
        const out = punct?.addPunct(t)
        return out && out.trim() ? out : text
      } catch {
        return text
      }
    },
  }
}
