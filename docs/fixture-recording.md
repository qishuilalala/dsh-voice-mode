# 真机 fixture 录制指引

给一个人、一台机器、十几分钟用的。目标不是把 ADR-0005 的完整 fixture 矩阵录满，
而是**先回答一个问题**：真机上 AEC 后残差是否保留语音包络（crest ≥ 7dB）？

这一个数决定 [findings/2026-09-02-echo-gate-ratchet.md](findings/2026-09-02-echo-gate-ratchet.md) 的哪个分支成立。

---

## 准备（一次）

1. 确认插件是本地版本：浏览器控制台应有 `[dsh-voice] build=<git 短哈希>`
2. 打开录制开关（控制台执行，然后**刷新页面**）：

```js
localStorage.setItem('dsh-voice-mode.record', 'full')
```

| 档位 | 内容 | 体积 |
|---|---|---|
| `meta` | 只录逐帧统计（rms/floor/peak/doubleTalk/playing） | 几十 KB / 分钟 |
| `full` | 统计 + mic/参考音轨（可离线重放全链路） | 约 4 MB / 分钟 |

回答上面那个问题 **`meta` 就够**；`full` 留给后续重放。先用 `full`，反正不大。

关掉：`localStorage.removeItem('dsh-voice-mode.record')`

---

## 录制中的操作

进入语音模式后右上角出现红色 `● REC` 徽标，实时显示 `resid / floor / peak`——**这三个数就是诊断行**，录制时能直接看出地板有没有塌。

| 键 | 作用 |
|---|---|
| `F8` | 标注「我开始说话 / 我说完了」（切换） |
| `F9` | 立即保存并下载 |
| 退出语音模式 | 自动保存并下载 |

上限 180 秒，到点自动落盘。

---

## 要录的（3 条，约 10 分钟）

### ① 纯听（最重要，**不需要任何标注**）

> 外放。进语音模式 → 问一句能让 AI 说满 20-30 秒的话（比如"给我讲讲全双工语音的难点"）
> → **然后闭嘴，一个字都别说，听完** → 退出语音模式。

这条直接给出纯回声窗口的 crest。**没有它其它都白搭。**

### ② 打断（需要 F8 标注）

> 外放。问一句 → AI 读到一半时，**先按 F8**，然后说话打断 → 说完**再按 F8**
> → 等它回应完 → 退出。

给出：真实打断时的确认延迟、门控在打断时刻的状态。

### ③ 耳机对照

> 插耳机，重复 ①。

对照组：耳机场景的残差形态与外放差多少。

> 如果只有时间录一条，录 **①**。

---

## 录完

下载的文件名形如 `dshvm-fixture-2026-09-02T...-exit.json`。

```bash
node scripts/analyze-fixture.mjs <文件路径>
```

直接输出结论段（crest 判定 + 门控重放 + 打断事件核对）。把这份输出发我就行，
或者把 json 给我，我来跑。

---

## 注意

- 录制含**你的真实语音**。这些 fixture **不要直接进公开仓库**——先放本地，
  确定要入库时走独立私有仓或只保留派生特征（`meta` 档位不含音轨，相对安全）。
- 录制期间 `● REC` 徽标是 `pointer-events:none`，不会挡点击。
- 徽标和 F8/F9 只在开关打开时存在；关掉开关刷新后完全消失。

---

## 这套东西装在哪（用完要拆的话）

| 文件 | 作用 |
|---|---|
| `src/fixture-recorder.ts` | 录制器本体（自包含，不接 React 状态） |
| `src/asr.ts` | 2 处：入口留 `recMicPre`/`recRef`，门控算完后 `fixtureRecorder.frame(...)` |
| `src/client.tsx` | 5 处：`begin` / `native-aec` 标注 / `tts-sentence` 标注 / `noteIsSpeech` / `interrupt` 标注 / `save` |
| `scripts/analyze-fixture.mjs` | 离线分析 |

删掉 `fixture-recorder.ts` + 这 7 处调用即可完全移除，无残留。
