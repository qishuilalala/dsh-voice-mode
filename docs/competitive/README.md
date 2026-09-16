# docs/competitive/ —— 竞品调研

> 6 轮 + 8 轮深度调研产出（18 份子报告 ≈ 7,500 行）+ 1 主扫描汇总 + 1 backlog。

## 主文档

| 文件 | 说明 |
| --- | --- |
| [scan-2026-09.md](scan-2026-09.md) | 2026-09 主扫描汇总：声学层不是壁垒 / 拟人度是真难处 |
| [backlog.md](backlog.md) | 43 项 P0-P3 backlog，go/plan/blocked/drop 四档决策 |
| [round6-summary.md](round6-summary.md) | 第 6 轮调研收尾（拟人度 / 让位语义 / emotion DSL） |
| [competitive-tts-landscape-2026-05.md](competitive-tts-landscape-2026-05.md) | TTS 竞品格局（Edge / Kokoro / VITS / Azure / Google / ElevenLabs） |

## 子报告（sources/）

按轮次组织的 18 份子代理深挖报告：

- **Round 1-2**：早期调研（开源 ASR / TTS 选型）
- **Round 3-4**：Kokoro / VITS 模型精度对比 / 实时性测试
- **Round 5-6**：拟人度（人格 + 情绪 + 非语言发声）/ 让位语义 / 多语种识别
- **Round 7-8**：edge-tts / elevenlabs / azure 横向对比

详见 [sources/](sources/) 目录。

## 关键结论

1. **声学层已不是壁垒** —— WebRTC APM3 / Silero v5 / TEN-VAD 等公开 SOTA 可下载；本插件 ADR-0001/0006 已接近头部
2. **真正的难处是「社会-语用层」** —— 发言权调度（轮次让位）+ 人格一致性 + 延迟与人性张力
3. **本插件最薄弱一格**：拟人度（人格 + 情绪 + 非语言发声 + 多角色对话）+ TTS 流式首包 ≤200ms

## 维护纪律

- 新增轮次 → 在 `sources/scan-<日期>.md` 命名
- 主扫描 `scan-2026-09.md` 季度更新（或重大变更时）
- backlog 项决策后更新状态列（go / plan / blocked / drop）