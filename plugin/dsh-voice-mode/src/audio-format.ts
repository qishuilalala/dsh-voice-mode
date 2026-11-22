/**
 * 音频容器嗅探：容器魔数（WAV / ID3 MP3 / Ogg / FLAC / WebM / MP4）委托 `@voice-mode/core`，
 * 并补充 DSH 宿主侧对裸 `0xFF` 帧同步头（ADTS AAC 与严格 MPEG Layer II/III，排除 UTF-16LE BOM）及回落值的适配。
 */
import { sniffAudioMime as sniffCoreAudioMime } from '@voice-mode/core'

export function sniffAudioMime(buf: Buffer, fallback: string): string {
  if (buf.length === 0) return fallback
  if (buf[0] === 0xff) {
    // ADTS AAC 同步字（0xFF 0xF0/0xF1/0xF8/0xF9，layer 位为 00）
    if (buf.length >= 7 && (buf[1]! & 0xf6) === 0xf0) return 'audio/aac'
    // MPEG Audio 帧同步（Layer II/III）：排除保留版本(0x08)、保留/ADTS层(0x00)、
    // Layer I/UTF-16LE BOM(0xFF 0xFE，layer=0x06) 及非法码率/采样率位（0xF0 / 0x0C）。
    if (
      buf.length >= 3 &&
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
  return sniffCoreAudioMime(buf) ?? fallback
}
