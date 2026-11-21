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
  // Ogg / Opus 容器（OggS）与 FLAC 容器（fLaC）
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg'
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'fLaC') return 'audio/flac'
  // ID3v2 标签（MP3）
  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'audio/mpeg'
  // ADTS AAC 同步字（0xFF 0xF0/0xF1/0xF8/0xF9，layer 位为 00）
  if (buf.length >= 7 && buf[0] === 0xff && (buf[1]! & 0xf6) === 0xf0) return 'audio/aac'
  // MPEG Audio 帧同步（Layer II/III）：排除保留版本(0x08)、保留/ADTS层(0x00)、
  // Layer I/UTF-16LE BOM(0xFF 0xFE，layer=0x06) 及非法码率/采样率位（0xF0 / 0x0C）。
  if (
    buf.length >= 3 &&
    buf[0] === 0xff &&
    (buf[1]! & 0xe0) === 0xe0 &&
    (buf[1]! & 0x18) !== 0x08 &&
    ((buf[1]! & 0x06) === 0x02 || (buf[1]! & 0x06) === 0x04) &&
    (buf[2]! & 0xf0) !== 0xf0 &&
    (buf[2]! & 0x0c) !== 0x0c
  ) {
    return 'audio/mpeg'
  }
  return fallback
}
