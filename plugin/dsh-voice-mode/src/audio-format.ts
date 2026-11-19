/**
 * 音频容器嗅探（2026-11-19 抽为共享模块）。
 *
 * 为什么不能信配置：MiMo 实测「请求 mp3 仍返回 WAV」；自建/代理的 OpenAI 兼容服务也常见
 * 忽略 response_format。若按配置标 MIME，客户端会拿 RIFF 当 MP3 解码——该句静默播不出声，
 * 且没有任何报错可查。故一律以响应字节的魔数为准，配置值只在魔数不认识时兜底。
 */
export function sniffAudioMime(buf: Buffer, fallback: string): string {
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WAVE'
  ) {
    return 'audio/wav'
  }
  // ID3 标签或 MPEG 帧同步（0xFF 0xEx）
  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'audio/mpeg'
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0) return 'audio/mpeg'
  return fallback
}
