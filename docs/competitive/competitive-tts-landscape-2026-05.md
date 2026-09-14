# Open-Source SOTA TTS / Voice Cloning — Competitive Landscape (2026-05)

> **Survey date**: 2026-05 (per user prompt); host clock observed 2026-09-14.
> **Method**: PRIMARY sources only — GitHub README / HuggingFace model card / arXiv / official Space or blog.
> **Comparison baseline**: dsh-voice-mode plugin current engines (`Edge TTS` cloud, `VITS Chinese` local, `Kokoro int8+fp32` local). See `CONTEXT.md`.
> **Unverified items** are marked **待核**.

---

## At-a-glance ranking

| Model | Pos. | Pop (GH★) | Zero-shot clone | Real-time | 1st-packet | Emotion/prosody | Voice design (text→voice) | Multi-char | Cross-lang mix | Long-form | RTF (consumer GPU) | License (commercial) | Δ vs dsh-voice-mode |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **CosyVoice 3** | 阿里 FunAudioLLM，多语流式 | 23.5k | ✅ cross-lingual | ✅ bidirectional | 150 ms | ✅ Instruct | ✅ | ⚠️待核 | ✅ 9 langs + 18 ZH dialects | ✅ | ⚠️待核 | Apache-2.0 ✅ | **better (中文/方言/流式)** |
| **F5-TTS** | ConvNeXt+DiT flow matching | 15.2k | ✅ | ✅ (TRT-LLM) | ⚠️待核 | ⚠️ ref-style only | ❌ | ✅ multi-voice | ✅ code-switch | ⚠️ chunk seam | 0.15 (paper); 0.04 (TRT) | CC-BY-NC-4.0 ❌ | **disqualified for commercial** |
| **Spark-TTS** | Qwen2.5+BiCodec 极简 | 11.0k | ✅ | ✅ | ⚠️待核 | ✅ pitch/rate | ⚠️ param (non-text) | ❌ | ✅ ZH/EN | ⚠️ GUI crash report | 0.14 (L20, c=1) | CC-BY-NC-SA 4.0 ❌ | **disqualified for commercial** |
| **IndexTTS2 / 2.5** | bilibili AR 范式时长控制 | 23.9k | ✅ | ✅ (vLLM recipe) | ⚠️待核 | ✅✅✅ multi-modal 8-dim | ⚠️ partial (pronunciation only) | ⚠️待核 | ✅ ZH/EN/JA/ES/AR | ⚠️待核 | 0.21–0.37 (RTX 4090) | bilibili Custom (MAU>1亿需授权) ⚠️ | **better (中文+情感解耦)**; license risk |
| **XTTS-v2 / Coqui** | 17-lang zero-shot | 46.0k dormant / 2.3k idiap fork | ✅ (6 s ref) | ✅ | <200 ms | ⚠️ ref-style only | ❌ | ❌ | ✅ 17 langs | ⚠️待核 | ⚠️待核 (≈0.18 RTX 3090, secondary) | CPML 1.0 ❌ non-commercial | **disqualified for commercial** |
| **OpenVoice v2** | tone-color + base TTS | 37.5k | ✅ | ✅ MyShell widget | ⚠️待核 | ✅ explicit knobs | ❌ | ❌ | ✅ 6 langs native | ⚠️待核 | ⚠️待核 | MIT ✅ | **borrowable: tone-color decoder for custom voices** |
| **Kokoro TTS** | StyleTTS2+ISTFTNet | 8.8k | ❌ (54 presets) | ✅ streaming | ⚠️待核 | ⚠️ IPA only | ❌ | ⚠️待核 | ⚠️ 8 langs 单段单语 | ⚠️ Rushing >400 tokens | ⚠️待核 | Apache-2.0 ✅ | **already integrated (int8/fp32)** |
| **Orpheus TTS** | Llama-3B + SNAC | 6.3k | ✅ (pretrained, prompt) | ✅ vLLM | 200 ms → 100 ms | ✅ 8 inline tags | ⚠️ via prompt | ⚠️ voice switch | ⚠️ EN + 6-lang research | ⚠️待核 | ⚠️待核 | Apache-2.0 ✅ | **borrowable: emotion tags + low-latency streaming** |
| **Parler-TTS** | NL description-driven | 5.6k | ❌ (34 named) | ⚠️ only "fast" | <500 ms (SDPA+compile) | ⚠️ text prompt | ✅ primary | ❌ | ⚠️ multilingual-v1.1 (8 EU) | ⚠️待核 | ⚠️待核 (SDPA ~1.4×, compile ~3-4×) | Apache-2.0 ✅ | **borrowable: text-prompted voice design pattern** |
| **Zonos / ZONOS2** | Zyphra DAC token AR | 7.2k | ✅ (10–30 s ref) | ✅ RTF 2× | ⚠️待核 | ✅ explicit knobs | ❌ (ref emb) | ❌ | ✅ 30+ langs (v2 code-switch) | ⚠️ ~1 min | ~2× (RTX 4090) | Apache-2.0 ✅ | **borrowable: zero-shot clone + multi-lang code-switch** |
| **Tortoise TTS v2** | GPT+diffusion UnivNet | 14.9k | ✅ (5–10 s ref + latent arithmetic) | ❌ "insanely slow" | <500 ms (author claim) | ✅ `[...]` prompts | ⚠️ random/latent | ✅ | ❌ EN-centric | ⚠️ no cross-sentence prosody | 0.25–0.3 / 4GB VRAM | Apache-2.0 ✅ | **already surpassed by newer zero-shot models** |
| **Bark (Suno)** | AudioLM+VALL-E+EnCodec | 39.3k | ❌ (no custom clone, 100 presets) | ⚠️ RTX 3080 Ti+ | ❌ no native | ✅ `[laugh]` etc. | ❌ | ⚠️ raw | ✅ 13 langs code-switch | ⚠️ ~13 s windows, seams | ~7.45 s/gen on TITAN RTX | MIT ✅ (since 2023.05) | **misses goal: no custom clone, no streaming** |
| **Dia 1.6B / Dia2** | Nari Labs 双工对话 TTS | 19.4k | ✅ few-shot (5–10 s ref) | ✅ RTF 1.5–2.2× (4090) | ⚠️待核 (1.6B no streaming); Dia2 streaming | ✅ via audio prompt | ⚠️ audio prompt only | ✅ `[S1]/[S2]` native | ❌ EN only (1.6B) | ⚠️ >20 s unnatural fast | 1.5–2.1× (4090) | Apache-2.0 ✅ | **borrowable: native dialogue + non-verbal tags** |
| **Sesame CSM (Maya/Miles)** | Llama+Mimi RVQ dialogue | 1.65k org followers | ✅ context audio | ⚠️ off (iOS only) | ⚠️待核 | ✅ contextual prosody | ⚠️ not zero-shot voice design | ✅ multi-speaker | ⚠️ weak, roadmap 20+ | ✅ up to 2 min | ⚠️待核 (A100/H100 required) | Apache-2.0 ✅ | **borrowable: contextual prosody / conversation flow** |

---

## 1. CosyVoice 2 / CosyVoice 3 (FunAudioLLM / Alibaba 通义)

### 1.1 核心定位
阿里通义 FunAudioLLM 零样本多语种流式 TTS 系列；v2 统一流式/非流式、150 ms 首包延迟，v3 以 100× 数据 + RL 后训练提升 in-the-wild 自然度（**待核 v3 human-parity 来自上游自评**）。

### 1.2 用户规模
- GitHub [`QwenAudio/CosyVoice`](https://github.com/QwenAudio/CosyVoice)：**23.5k stars / 2.7k forks**
- HF [`FunAudioLLM/Fun-CosyVoice3-0.5B-2512`](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)：**638 likes**，1.08k followers
- HF [`FunAudioLLM/CosyVoice2-0.5B`](https://huggingface.co/FunAudioLLM/CosyVoice2-0.5B)：91 likes
- HF 月下载：**待核**

### 1.3 能力清单
- 零样本克隆：✅ 跨语言零样本（v2/v3）；SFT/RL checkpoint 路径
- 实时推理：✅ 双向流式（v2 起）
- 流式首包延迟：**150 ms**（上游宣传值；v3 未单独标新值）
- 情感/韵律控制：✅ Instruct（emotion, accent, role, vocal bursts）
- Voice design：✅ Instruct 自然语言驱动
- 多角色/对话：⚠️待核（v3 README 重点 SFT/Instruct，未显式声明 dialogue）
- 跨语种混读：✅ 9 语 + 18+ 中文方言（v3）
- 长文一致性：test-hard CER v2=6.83% → v3 base 6.71% → RL 5.44%
- 推理速度：README "TensorRT-LLM 4× 加速"；**RTF 数字待核**
- License：**Apache-2.0 ✅ 商用 OK**

### 1.4 对比 dsh-voice-mode
**Missing / weak**: 当前 Edge TTS 是云端闭源、Kokoro 仅英文预设、VITS 中文预设。CosyVoice 3 同时具备：(1) 跨语种零样本克隆（Edge 没有），(2) 中文方言覆盖（VITS/Kokoro 无），(3) 流式低首包延迟（与 dsh 双工链匹配），(4) Apache-2.0 可商用。**已具备但更好**: 情感/韵律控制比 Edge 仅 SSML 强很多。

### 1.5 Borrowable effort (priority order)
1. **(Medium)** `instruct` 模式 + 中文方言作为新增 `ttsEngine=cosyvoice` 选项；权重 ~0.5B，RTF 在消费级 GPU 待实测。
2. **(Small)** 流式协议 → 借鉴其双向流式接口设计接入 tts-queue。
3. **(Large)** 全文级 RL 后训练数据管线（不直接复用，但作为差异化卖点）。

### 1.6 PRIMARY URLs
- GitHub: [FunAudioLLM/CosyVoice](https://github.com/FunAudioLLM/CosyVoice) (mirror [QwenAudio/CosyVoice](https://github.com/QwenAudio/CosyVoice))
- arXiv v2: [2412.10117](https://arxiv.org/abs/2412.10117)
- arXiv v3: [2505.17589](https://arxiv.org/abs/2505.17589)
- arXiv v1: [2407.05407](https://arxiv.org/abs/2407.05407)
- HF v2: [FunAudioLLM/CosyVoice2-0.5B](https://huggingface.co/FunAudioLLM/CosyVoice2-0.5B)
- HF v3: [FunAudioLLM/Fun-CosyVoice3-0.5B-2512](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)
- Demo v2: [funaudiollm.github.io/cosyvoice2](https://funaudiollm.github.io/cosyvoice2/) (v3 站 404, **待核**)

### 1.7 待核
- 消费级 GPU (RTX 4090) 实测 RTF
- v3 native multi-speaker dialogue
- 第三方独立 benchmark（TTS-Arena2 / Artificial Analysis）

---

## 2. F5-TTS (SWivid / SJTU X-LANCE + Shanghai AI Lab + Pengcheng)

### 2.1 核心定位
开源非自回归 flow-matching TTS，ConvNeXt V2 + DiT + Sway Sampling，零样本克隆 + code-switch + 速度可控；**代码 MIT / 权重 CC-BY-NC-4.0**。

### 2.2 用户规模
- GitHub [SWivid/F5-TTS](https://github.com/SWivid/F5-TTS)：**15.2k stars / 2.2k forks**
- HF [`SWivid/F5-TTS`](https://huggingface.co/SWivid/F5-TTS)：**1.2k likes，924,782 月下载**；149 finetunes / 6 quantizations / 2 adapters
- arXiv: [HF papers page](https://huggingface.co/papers/2410.06885)

### 2.3 能力清单
- 零样本克隆：✅ "highly natural and expressive zero-shot ability"
- 少样本克隆：✅ via Gradio 多 voice `.toml` 配置
- 实时推理：✅（主要离线 + Triton/TRT-LLM 部署路径）
- 流式首包延迟：**待核**（README 仅给 RTF）
- 情感/韵律控制：⚠️ 通过 ref audio 间接 style transfer；社区反馈 expressive 范围较窄（**非 PRIMARY，待核**）
- Voice design：❌
- 多角色/对话：✅ Gradio "Multi-Style / Multi-Speaker" + `story.toml`
- 跨语种混读：✅ "seamless code-switching"
- 长文一致性：⚠️ 主分支不支持，分块+拼接 seam 问题（社区报告）
- 推理速度：**RTF 0.15**（论文）；TRT-LLM 后 0.0394（L20, 16 NFE）
- License：**CC-BY-NC-4.0 ❌ 不可商用**（代码 MIT，权重不可商用）

### 2.4 对比 dsh-voice-mode
**Disqualified**: 权重不可商用 → 不适合作为 dsh-voice-mode 默认引擎。

### 2.5 Borrowable effort
1. **(Small)** Sway Sampling 加速思路 → 借鉴到 VITS 的推理路径
2. **(Skip)** 商用合规阻挡了直接集成；社区方案可作"实验引擎"选项（明示 license）

### 2.6 PRIMARY URLs
- GitHub: [SWivid/F5-TTS](https://github.com/SWivid/F5-TTS)
- arXiv: [2410.06885](https://arxiv.org/abs/2410.06885)
- HF: [SWivid/F5-TTS](https://huggingface.co/SWivid/F5-TTS)
- Demo: [swivid.github.io/F5-TTS](https://swivid.github.io/F5-TTS/)
- HF Space: [mrfakename/E2-F5-TTS](https://huggingface.co/spaces/mrfakename/E2-F5-TTS)

### 2.7 待核
- 流式首包 ms
- 消费级 GPU 实测
- TRT-LLM 路径是否真正流式

---

## 3. Spark-TTS (SparkAudio)

### 3.1 核心定位
基于 Qwen2.5 LLM + 自研 BiCodec（单流解耦 speech token）的零样本 TTS，强调简洁（无 flow-matching），可控虚拟说话人（gender/pitch/rate）。

### 3.2 用户规模
- GitHub [`SparkAudio/Spark-TTS`](https://github.com/SparkAudio/Spark-TTS)：**11,003 stars**
- HF [`SparkAudio/Spark-TTS-0.5B`](https://huggingface.co/SparkAudio/Spark-TTS-0.5B)：747 likes，累计 downloads 943（**待核 HF 月下载**）
- 30+ Spaces，vLLM-Omni [#4295](https://github.com/vllm-project/vllm-omni/issues/4295) 集成中

### 3.3 能力清单
- 零样本克隆：✅ "state-of-the-art zero-shot voice cloning"
- Few-shot：**待核**
- 实时推理：✅ CLI + Gradio；未标硬实时
- 流式首包延迟：**待核**
- 情感/韵律：✅ pitch/rate 参数化（emotion 未单独成轴）
- Voice design：⚠️ 参数化（gender/pitch/rate），**非纯文本描述**
- 多角色/对话：**待核**（无 dialogue 脚本机制）
- 跨语种混读：✅ ZH/EN，README "code-switching scenarios"
- 长文一致性：⚠️ Issue #10 报告 GUI 长文会崩
- 推理速度：L20 + TRT-LLM：concurrency=1 RTF **0.1362** / latency 876.24 ms；c=2 RTF 0.0737；c=4 RTF 0.0704
- License：**权重 CC-BY-NC-SA-4.0 ❌**（代码 Apache-2.0）；权重曾从 Apache-2.0 改为 CC-BY-NC-SA

### 3.4 对比 dsh-voice-mode
**Disqualified**: 权重非商用。架构值得借鉴。

### 3.5 Borrowable
1. **(Small)** BiCodec 单流解耦 → 思考 VITS 的轻量化替代
2. **(Skip)** 商用阻断

### 3.6 PRIMARY URLs
- GitHub: [SparkAudio/Spark-TTS](https://github.com/SparkAudio/Spark-TTS)
- HF: [SparkAudio/Spark-TTS-0.5B](https://huggingface.co/SparkAudio/Spark-TTS-0.5B)
- arXiv: [2503.01710](https://arxiv.org/abs/2503.01710)
- Demo: [sparkaudio.github.io/spark-tts](https://sparkaudio.github.io/spark-tts/)
- HF DOI: [10.57967/hf/4650](https://doi.org/10.57967/hf/4650)

### 3.7 待核
- Few-shot 克隆
- 消费级 GPU PyTorch RTF
- HF 月下载
- 长文稳定性

---

## 4. IndexTTS2 / IndexTTS-2.5 (bilibili IndexTeam)

### 4.1 核心定位
工业级零样本 AR TTS，首次实现 AR 范式下时长精确控制；timbre × emotion 解耦；多模态情感输入（参考音频 / 8 维情绪向量 / 文本情绪描述）。**IndexTTS-2.5**（2026-08-10）已更新 README，但 v2 权重仍独立维护。

### 4.2 用户规模
- GitHub [`index-tts/index-tts`](https://github.com/index-tts/index-tts)：**23,943 stars / 2,858 forks**
- HF [`IndexTeam/IndexTTS-2`](https://huggingface.co/IndexTeam/IndexTTS-2)：782 likes，**月下载 9,604**
- 35+ Spaces，vLLM recipe（[recipes.vllm.ai/IndexTeam/IndexTTS-2.5](https://recipes.vllm.ai/IndexTeam/IndexTTS-2.5)），Discord 社区

### 4.3 能力清单
- 零样本克隆：✅ "Voice cloning with a single reference audio"
- Few-shot：**待核**（仅声明 zero-shot）
- 实时推理：✅ WebUI + vLLM recipe
- 流式首包延迟：**待核**（仅 overall RTF）
- 情感/韵律：✅✅✅ 5 种输入模态（emo_alpha 音频 / 8 维情绪向量 / `use_emo_text` / `emo_text` / `use_random`）
- Voice design：⚠️ 2.5 支持 Pinyin/CMU/Kana 字符级发音控制；**音色仍需参考音频**
- 多角色/对话：**待核**（无原生对话 API）
- 跨语种混读：✅ ZH/EN/JA/ES/AR（2.5）；跨语种评估表
- 长文一致性：200 字符 RTF 行体现，无独立指标 **待核**
- 推理速度：**RTX 4090 + kv_cache**：2.0 fp16 RTF 0.3257 / fp32 0.3748；2.5 bf16 0.2065 / fp32 0.2060
- License：**bilibili 自定义许可**：①可商用；②**MAU>1亿 或 年营收>10亿 RMB 须另行书面许可**；③不得用于改进其他 AI 模型；④医疗/自动驾驶/军事/关键基础设施/大规模生物识别/自动决策**禁止**；⑤中国法 / 上海仲裁

### 4.4 对比 dsh-voice-mode
**Better (中文+情感)**: 中文零样本 + 多模态情感 → 对 VITS 中文和 Edge 中文都更强。
**License risk**: MAU/营收阈值 → 普通 dsh 用户低于门槛时 OK，但 dsh 总用户规模难讲清，**需要法务复核**。

### 4.5 Borrowable
1. **(Medium)** 8 维情绪向量 + `emo_text` 软指令设计 → 借鉴加到 dsh-voice-mode 的 TTS 参数面板（让用户在设置里调情感权重）
2. **(Small)** 时长控制思路 → 长文分段播放的拼接平滑（已存在的 tts-queue 可吸收）
3. **(Skip direct)** 权重受 bilibili 自定义许可约束，先与法务确认合规面

### 4.6 PRIMARY URLs
- GitHub: [index-tts/index-tts](https://github.com/index-tts/index-tts)
- HF v2: [IndexTeam/IndexTTS-2](https://huggingface.co/IndexTeam/IndexTTS-2)
- HF 2.5: [IndexTeam/IndexTTS-2.5](https://huggingface.co/IndexTeam/IndexTTS-2.5)
- arXiv v2: [2506.21619](https://arxiv.org/abs/2506.21619) (Siyi Zhou 等)
- arXiv v1: [2502.05512](https://arxiv.org/abs/2502.05512)
- arXiv 2.5: [2601.03888](https://arxiv.org/abs/2601.03888)
- Demo v2: [index-tts.github.io/index-tts2.github.io](https://index-tts.github.io/index-tts2.github.io/)
- Demo 2.5: [index-tts.github.io/index-tts2-5.github.io](https://index-tts.github.io/index-tts2-5.github.io/)
- vLLM recipe: [recipes.vllm.ai/IndexTeam/IndexTTS-2.5](https://recipes.vllm.ai/IndexTeam/IndexTTS-2.5)
- License: [LICENSE.txt](https://huggingface.co/IndexTeam/IndexTTS-2/raw/main/LICENSE.txt)

### 4.7 待核
- Few-shot、流式首包、长文一致性、训练代码/数据集

---

## 5. XTTS-v2 / Coqui XTTS

### 5.1 核心定位
17 语零样本克隆 TTS；Coqui 已 2023 末关停，主仓 frozen，社区 fork 由 [idiap](https://github.com/idiap/coqui-ai-TTS) 维护。

### 5.2 用户规模
- 主仓 [coqui-ai/TTS](https://github.com/coqui-ai/TTS)：**46,009 stars / 6,154 forks**，last push 2024-08-16（frozen）
- 活跃 fork [`idiap/coqui-ai-TTS`](https://github.com/idiap/coqui-ai-TTS)：**2,321 stars / 290 forks**，last push 2026-06-10，PyPI [`coqui-tts`](https://pypi.org/project/coqui-tts/)
- HF [`coqui/XTTS-v2`](https://huggingface.co/coqui/XTTS-v2)：**3.8k likes，~7,211,784 月下载**（最强公开指标）
- 注：用户提到的 `daspartho/xtts-v2` 不存在（404）

### 5.3 能力清单
- 零样本克隆：✅ 6 s 参考片段；可多 ref + interpolation
- Few-shot：✅
- 实时推理：✅ streaming "<200ms latency"（待核细节）
- 流式首包延迟：**<200 ms**（声称）
- 情感/韵律：⚠️ 仅 ref-clone style transfer，无文本提示 prosody 旋钮
- Voice design：❌
- 多角色/对话：❌（需手动拼接）
- 跨语种混读：✅ 17 语（en/es/fr/de/it/pt/pl/tr/ru/nl/cs/ar/zh-cn/ja/hu/ko/hi）
- 长文一致性：⚠️待核
- 推理速度：第三方 Gigagpu 基准 RTX 3090 RTF ~0.18 / ~5.6× real-time（**secondary, 待核**）
- License：**CPML 1.0.0 ❌ 非商用**

### 5.4 对比 dsh-voice-mode
**Disqualified**: CPML 非商用。强克隆 + 17 语是亮点但不能进 dsh 默认引擎。

### 5.5 Borrowable
1. **(Skip)** 商用阻断
2. **(Small)** "<200 ms streaming" 协议层借鉴（结合自家 tts-queue）

### 5.6 PRIMARY URLs
- HF model card: [coqui/XTTS-v2](https://huggingface.co/coqui/XTTS-v2)
- HF license: [LICENSE.txt](https://huggingface.co/coqui/XTTS-v2/blob/main/LICENSE.txt)
- HF Space: [coqui/xtts](https://huggingface.co/spaces/coqui/xtts)
- 主仓（frozen）: [coqui-ai/TTS](https://github.com/coqui-ai/TTS)
- 活跃 fork: [idiap/coqui-ai-TTS](https://github.com/idiap/coqui-ai-TTS)
- PyPI: [coqui-tts](https://pypi.org/project/coqui-tts/)
- arXiv: [2406.04904](https://arxiv.org/abs/2406.04904) (Casanova 等, INTERSPEECH 2024)
- 关闭讨论: [TTS#3488](https://github.com/coqui-ai/TTS/issues/3488)

### 5.7 待核
- 流式首包分布、RTF 数字、native dialogue、长文评估

---

## 6. OpenVoice v2 (MyShell)

### 6.1 核心定位
解耦 **tone-color cloning** + base TTS（V2 用 MeloTTS）的 MIT 克隆系统；细粒度 style 控制（emotion/accent/rhythm/pauses/intonation）。

### 6.2 用户规模
- GitHub [myshell-ai/OpenVoice](https://github.com/myshell-ai/OpenVoice)：**37,521 stars / 4,210 forks**，last push 2025-04-19
- HF V1 [`myshell-ai/OpenVoice`](https://huggingface.co/myshell-ai/OpenVoice)：493 likes（**HF 不追踪下载**）
- HF V2 [`myshell-ai/OpenVoiceV2`](https://huggingface.co/myshell-ai/OpenVoiceV2)：502 likes
- Trendshift: #797（**待核时点**）
- 自报："Until Nov 2023, used tens of millions of times by users worldwide"（**自报告，非独立审计**）

### 6.3 能力清单
- 零样本克隆：✅ "Accurate Tone Color Cloning"
- Few-shot：✅ 单 ref 是典型，多 ref 可平均（**待核**）
- 实时推理：✅ MyShell widget；**RTF 待核**
- 流式首包延迟：**待核**
- 情感/韵律：✅ 显式 knobs（emotion/accent/rhythm/pauses/intonation）
- Voice design：⚠️ 数值旋钮，**非 NL 描述**
- 多角色/对话：❌
- 跨语种混读：✅ V2 原生 EN/ES/FR/ZH/JA/KO；V1 zero-shot 跨语种（含未见语种）
- 长文一致性：**待核**
- 推理速度：**待核**
- License：**MIT ✅** 自 2024-04 起商用 OK

### 6.4 对比 dsh-voice-mode
**Borrowable**: 音色解耦思路 + 显式 style 旋钮 → 给 dsh TTS 加一组风格控制。
**Missing**: V2 没有真参考克隆的"音色注入"工作流（base TTS 仍依赖 MeloTTS）。

### 6.5 Borrowable
1. **(Small)** tone-color 解耦 → 给 Kokoro 或 VITS 加一层轻量 tone-color adapter（用户上传 5–10 s 录音作为参考音色）
2. **(Small)** 显式 emotion/accent/rhythm knobs → 在 settings-form.tsx 增加风格滑块

### 6.6 PRIMARY URLs
- GitHub: [myshell-ai/OpenVoice](https://github.com/myshell-ai/OpenVoice)
- Raw README: [raw main README.md](https://raw.githubusercontent.com/myshell-ai/OpenVoice/main/README.md)
- USAGE: [docs/USAGE.md](https://github.com/myshell-ai/OpenVoice/blob/main/docs/USAGE.md)
- HF V1: [myshell-ai/OpenVoice](https://huggingface.co/myshell-ai/OpenVoice)
- HF V2: [myshell-ai/OpenVoiceV2](https://huggingface.co/myshell-ai/OpenVoiceV2)
- HF Space: [myshell-ai/OpenVoice](https://huggingface.co/spaces/myshell-ai/OpenVoice)
- arXiv V1: [2312.01479](https://arxiv.org/abs/2312.01479)（**V2 无独立 paper**）
- Trendshift: [trendshift.io/repositories/6161](https://trendshift.io/repositories/6161)

### 6.7 待核
- V2 是否有独立 paper、streaming 首包、RTF、长文

---

## 7. Kokoro TTS (Kokoro-82M / v1.0)

### 7.1 核心定位
Apache-2.0 82M 参数轻量 TTS（StyleTTS 2 + ISTFTNet），定位"小模型大模型质量、API 价格 < $1/M 字符"。

### 7.2 用户规模
- HF [`hexgrad/Kokoro-82M`](https://huggingface.co/hexgrad/Kokoro-82M)：**6.9k likes**
- GitHub [`hexgrad/kokoro`](https://github.com/hexgrad/kokoro)：**8,823 stars / 972 forks**
- HF Space [hexgrad/Kokoro-TTS](https://huggingface.co/spaces/hexgrad/Kokoro-TTS)：3.46k likes
- 第三方基准：EVAL.md 收录 TTS Spaces Arena、TTS Arena、Artificial Analysis（截图 2025-02-26）

### 7.3 能力清单
- 零样本克隆：❌ **v1.0 仅 54 个预设声音**（8 语种）；社区 Space 自训混合（**非官方**）
- 实时推理：✅ generator yield 24 kHz audio chunk
- 流式首包延迟：**待核**（README 未给；ONNX 社区有数据）
- 情感/韵律：⚠️ 通过 SSML/IPA phoneme 标记
- Voice design：❌（仅预设 voice tensor / `voice.pt`）
- 多角色/对话：⚠️待核（理论换 voice ID 可行）
- 跨语种混读：⚠️ 单段单语（lang_code 切换）；不支持单段文本混合语种
- 长文一致性：⚠️ ">400 tokens rushing" / "<10–20 tokens weak"
- 推理速度：**待核**（"significantly faster" 描述无数字）
- License：**Apache-2.0 ✅**

### 7.4 对比 dsh-voice-mode
**已具备**: int8/fp32 双精度已在 dsh 内（详见 CONTEXT.md）；**本身是 dsh 当前主引擎之一**。
**Missing**: 无真参考克隆路径（仅预设）。

### 7.5 Borrowable
1. **(Skip direct)** 已在 dsh 中
2. **(Small)** IPA 标记控制思路 → 加到 Kokoro 设置（已有但 UI 可更显眼）
3. **(Large)** 等 v1.1+ 官方新权重（**待核**）

### 7.6 PRIMARY URLs
- HF model: [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)
- HF EVAL.md: [EVAL.md](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/EVAL.md)
- HF VOICES.md: [VOICES.md](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)
- GitHub: [hexgrad/kokoro](https://github.com/hexgrad/kokoro)
- Space: [hf.co/spaces/hexgrad/Kokoro-TTS](https://hf.co/spaces/hexgrad/Kokoro-TTS)
- StyleTTS 2 paper (basis): [arXiv 2306.07691](https://arxiv.org/abs/2306.07691)
- ISTFTNet (basis): [arXiv 2203.02395](https://arxiv.org/abs/2203.02395)
- G2P: [hexgrad/misaki](https://github.com/hexgrad/misaki)

### 7.7 待核
- 精确 RTF、流式首包 ms、2026 是否官方新权重

---

## 8. Orpheus TTS (Canopy Labs)

### 8.1 核心定位
基于 Llama-3B 主干 + SNAC 音频 token 的 LLM-style TTS，强调自然情感 + 零样本克隆 + 低延迟流式；**org 路径是 `canopyai`（非 `canopylabs`）**。

### 8.2 用户规模
- GitHub [`canopyai/Orpheus-TTS`](https://github.com/canopyai/Orpheus-TTS)：**6,337 stars / 535 forks**
- HF [`canopylabs/orpheus-3b-0.1-ft`](https://huggingface.co/canopylabs/orpheus-3b-0.1-ft)：734 likes
- HF pretrained: 173 likes（**需登录 + 分享联系信息才能访问 raw README**）
- TTS-Arena-V2 收录；Baseten / GroqCloud 推理合作

### 8.3 能力清单
- 零样本克隆：✅ pretrained 通过 prompt 注入 1+ text-speech 对；"more pairs → more reliable"
- Few-shot：✅（即 prompt 多对）
- 实时推理：✅ vLLM 流式 + `model.generate_speech()` + `syn_tokens` streaming
- 流式首包延迟：**~200 ms → 可压到 ~100 ms（输入流式）**
- 情感/韵律：✅ 内联 8 tags：`<laugh>` `<chuckle>` `<sigh>` `<cough>` `<sniffle>` `<groan>` `<yawn>` `<gasp>`
- Voice design：⚠️ finetune-prod 8 names；pretrained 走 prompt
- 多角色/对话：⚠️ 8 voice 切换；无 turn-taking API
- 跨语种混读：⚠️ 仅 EN 主模型；2025-04 多语言研究版（Hindi/Mandarin/Korean/Spanish/Italian 等 6 语种），单段混合未声明
- 长文一致性：**待核**（Llama context window）
- 推理速度：第三方 taresh18/orpheus-streaming TTFB ~160 ms（**非官方，待核**）
- License：**Apache-2.0 ✅**

### 8.4 对比 dsh-voice-mode
**Borrowable**: 8 个情感内联标签（`<laugh>` 等）→ 立即可借鉴加到 dsh TTS 文本预处理（用户无需写 SSML）
**Missing**: 零样本克隆 + 流式 ~100 ms 是 dsh 当前 Edge/Kokoro/VITS 都达不到的

### 8.5 Borrowable
1. **(Small)** 情感内联标签（`<laugh>` 等）→ 在 tts-local 文本归一化里加 "可朗读内联标签" 选项
2. **(Medium)** pretrained 模型 + vLLM 流式 → 作为 dsh 第四个 `ttsEngine=orpheus` 选项（需要消费级 GPU，**待核 RTF**）
3. **(Small)** "~100 ms 流式首包" 协议 → 借鉴到 tts-queue 的 epoch 切换

### 8.6 PRIMARY URLs
- GitHub: [canopyai/Orpheus-TTS](https://github.com/canopyai/Orpheus-TTS)
- HF ft: [canopylabs/orpheus-3b-0.1-ft](https://huggingface.co/canopylabs/orpheus-3b-0.1-ft)
- HF pretrained: [canopylabs/orpheus-3b-0.1-pretrained](https://huggingface.co/canopylabs/orpheus-3b-0.1-pretrained)
- Multilingual collection: [orpheus-multilingual-research-release](https://huggingface.co/collections/canopylabs/orpheus-multilingual-research-release-67f5894cd16794db163786ba)
- Baseten: [blog](https://www.baseten.co/blog/canopy-labs-selects-baseten-as-preferred-inference-provider-for-orpheus-tts-model)
- GroqCloud: [blog](https://groq.com/blog/canopy-labs-orpheus-tts-is-live-on-groqcloud)
- TTS-Arena-V2: [discussion #94](https://huggingface.co/spaces/TTS-AGI/TTS-Arena-V2/discussions/94)
- Official blog: [canopylabs.ai/model-releases](https://canopylabs.ai/model-releases)（**正文待核**）

### 8.7 待核
- 官方 v2/v3（**未见**；社区 v2/v3 为第三方微调）
- Finetune-prod 在 consumer GPU 上的 RTF
- HF 下载量

---

## 9. Parler-TTS (HuggingFace)

### 9.1 核心定位
HuggingFace 出品的 NL 文本提示驱动 TTS（"gender/accent/rate/pitch/reverb" 等特征），是 [arXiv:2402.01912](https://arxiv.org/abs/2402.01912) (Lyth & King 2024) 的复现；34 个内置命名说话人。

### 9.2 用户规模
- GitHub [`huggingface/parler-tts`](https://github.com/huggingface/parler-tts)：**5.6k stars / 585 forks / 57 watchers**
- HF likes: mini-v1 153, large-v1 275, mini-multilingual-v1.1 58
- HF 月下载：**待核**

### 9.3 能力清单
- 零样本/少样本克隆：❌ **不支持真参考克隆**；34 个命名说话人 + 描述驱动一致性（Mini 最高 Jon 0.908, Large 最高 Will 0.906）；Multilingual v1.1 16 个命名说话人
- 实时推理：⚠️ 文档未声称实时，仅"快速生成"
- 流式首包延迟：**<500 ms**（SDPA + torch.compile + `ParlerTTSStreamer`；86 token ≈ 1 s 块）
- 情感/韵律：⚠️ 通过文本提示（含 "happy/angry/sad" 语义词 + "speaking rate/pitch/reverb" 特征词）
- Voice design：✅ **主功能**，NL 描述驱动
- 多角色/对话：❌（单说话人整段）
- 跨语种混读：⚠️ mini-multilingual-v1.1 8 种欧洲语（en/fr/es/pt/pl/de/it/nl）；基础 Mini/Large v1 仅英语
- 长文一致性：⚠️ AR DAC 生成，社区反馈长文漂移；**官方未声明上限**
- 推理速度：SDPA ~1.4×；torch.compile `reduce-overhead` ~3-4×；**特定 GPU RTF 待核**
- License：**Apache-2.0 ✅**

### 9.4 对比 dsh-voice-mode
**Borrowable**: NL 描述驱动 voice design → 给 dsh 设置面板加 "voice description" 文本框（"a warm female voice with subtle British accent"），可叠加在 Kokoro/VITS/Edge 上层
**Missing**: 无真参考克隆
**Note**: 2025–2026 无新 checkpoint（Mini-multilingual v1.1 是 2025 的最后一次更新）

### 9.5 Borrowable
1. **(Small)** Parler 风格的"voice description" 文本字段 → 作为 dsh 设置面板的新选项，让用户用 NL 描述期望音色
2. **(Skip)** 主干模型本身已落伍（2024，无 2026 更新）

### 9.6 PRIMARY URLs
- GitHub: [huggingface/parler-tts](https://github.com/huggingface/parler-tts)
- HF org: [parler-tts](https://huggingface.co/parler-tts)
- mini-v1: [parler-tts/parler-tts-mini-v1](https://huggingface.co/parler-tts/parler-tts-mini-v1)
- large-v1: [parler-tts/parler-tts-large-v1](https://huggingface.co/parler-tts/parler-tts-large-v1)
- mini-v1.1: [parler-tts/parler-tts-mini-v1.1](https://huggingface.co/parler-tts/parler-tts-mini-v1.1)
- multilingual-v1.1: [parler-tts/parler-tts-mini-multilingual-v1.1](https://huggingface.co/parler-tts/parler-tts-mini-multilingual-v1.1)
- tiny-v1: [parler-tts/parler-tts-tiny-v1](https://huggingface.co/parler-tts/parler-tts-tiny-v1)
- INFERENCE.md: [流式/编译指南](https://github.com/huggingface/parler-tts/blob/main/INFERENCE.md)
- Space: [parler-tts/parler_tts](https://huggingface.co/spaces/parler-tts/parler_tts)
- arXiv: [2402.01912](https://arxiv.org/abs/2402.01912) (Lyth & King, 2024)

### 9.7 待核
- HF 月下载、最新 commit、v1.1 release date、长文稳定性、特定 GPU RTF、emotion token 集合

---

## 10. Zonos / ZONOS2 (Zyphra)

### 10.1 核心定位
Zyphra 开源权重 TTS：高质量零样本克隆 + 细粒度情绪/速度/音高控制 + 实时生成，原生 44 kHz；架构 eSpeak→音素→DAC token AR（transformer 或 SSM-hybrid backbone）。

### 10.2 用户规模
- GitHub [`Zyphra/Zonos`](https://github.com/Zyphra/Zonos) v0.1：**7.2k stars / 816 forks**
- HF [`Zyphra/Zonos-v0.1-hybrid`](https://huggingface.co/Zyphra/Zonos-v0.1-hybrid)：**1.11k likes**
- HF [`Zyphra/Zonos-v0.1-transformer`](https://huggingface.co/Zyphra/Zonos-v0.1-transformer)：435 likes
- HF [`Zyphra/ZONOS2`](https://huggingface.co/Zyphra/ZONOS2)：145 likes
- 自有 [ZTTS1-Eval](https://github.com/Zyphra/ZTTS1-Eval) 基准

### 10.3 能力清单 (v0.1)
- 零样本克隆：✅ 10–30 s ref → 高质量；speaker embedding + audio prefix
- 少样本：✅ audio prefix 更丰富口音
- 实时推理：✅ RTF ~2× on RTX 4090（每秒算力生成 2 秒音频）
- 流式首包延迟：v0.1 **待核**；ZONOS2 "maintains good streaming latency" + 4× 吞吐
- 情感/韵律：✅ speaking rate / pitch / max-freq / audio quality / 情绪（happiness/anger/sadness/fear 等）旋钮（`CONDITIONING_README.md`）
- Voice design：❌（ref embedding / audio prefix，非 NL 描述）
- 多角色/对话：❌
- 跨语种混读：v0.1 5 语（EN/JA/ZH/FR/DE）；**ZONOS2：30+ 语 Tier 1–3**，UTF-8 byte 文本输入 → **原生 code-switch**
- 长文一致性：ZONOS2 "up to one minute"；v0.1 **待核**
- 推理速度：v0.1 RTX 4090 RTF ~2×；ZONOS2 8B 总参/900M 活跃 (MoE++) → 4× 吞吐
- License：**Apache-2.0 ✅**

### 10.4 ZONOS2 (2026-06)
- arXiv [2606.24320](https://arxiv.org/abs/2606.24320) Technical Report（v1 2026-06-23, v2 2026-06-25）
- 1.6B → **8B 总参 / 900M 活跃 (MoE++/ZAYA)**
- 训练数据 200k h → **6M+ h**
- UTF-8 byte 文本输入 + ECAPA-TDNN speaker embedding（"20× 上一版带宽"）
- DAC 44.1 kHz 输出
- 推理栈 [Mini-SGLang](https://github.com/sgl-project/mini-sglang)（默认 `:1919` HTTP）
- Zyphra Cloud（AMD 后端）限时免费

### 10.5 对比 dsh-voice-mode
**Borrowable**: 零样本克隆 + 多语种 code-switch + RTF 2×（v0.1）→ 这是 Kokoro 当前最大缺口
**Missing vs Kokoro**: Kokoro 已有 8 语种预设但无克隆；Zonos 给"任意用户上传 10–30 s"的能力
**Note**: v0.1 消费级 GPU 可跑（RTF 2× on 4090），ZONOS2 MoE 在 8B 时需更多算力

### 10.6 Borrowable
1. **(Medium)** Zonos v0.1 hybrid 集成 → 新增 `ttsEngine=zonos`，权重 ~1.6B（**具体大小待核**），消费级 GPU 实测 RTF 2× → 与 Kokoro 同档
2. **(Small)** emotion knobs → 加到 dsh 设置面板（happiness/anger/sadness/fear 4 档 + speaking rate/pitch）
3. **(Skip 大)** ZONOS2 8B MoE 部署门槛高，等社区缩小型

### 10.7 PRIMARY URLs
- GitHub v0.1: [Zyphra/Zonos](https://github.com/Zyphra/Zonos)
- GitHub ZONOS2: [Zyphra/ZONOS2](https://github.com/Zyphra/ZONOS2)
- HF hybrid: [Zyphra/Zonos-v0.1-hybrid](https://huggingface.co/Zyphra/Zonos-v0.1-hybrid)
- HF transformer: [Zyphra/Zonos-v0.1-transformer](https://huggingface.co/Zyphra/Zonos-v0.1-transformer)
- HF ZONOS2: [Zyphra/ZONOS2](https://huggingface.co/Zyphra/ZONOS2)
- ZONOS2 blog: [zyphra.com/our-work/zonos2](https://www.zyphra.com/our-work/zonos2)
- Zonos beta blog: [zyphra.com/our-work/beta-release-of-zonos-v0-1](https://www.zyphra.com/our-work/beta-release-of-zonos-v0-1)
- arXiv: [2606.24320](https://arxiv.org/abs/2606.24320) (Clark et al., 2026)
- 基准: [ZTTS1-Eval](https://github.com/Zyphra/ZTTS1-Eval)
- Mini-SGLang: [sgl-project/mini-sglang](https://github.com/sgl-project/mini-sglang)

### 10.8 待核
- v0.1 流式首包 ms、长文上限、多角色对话、HF 月下载、第三方独立基准

---

## 11. Tortoise TTS v2 (neonbjb / James Betker)

### 11.1 核心定位
"质量优先" 多声音 TTS：AR GPT 解码器 + 扩散解码器 + UnivNet 声码器；把真实感放速度之上。

### 11.2 用户规模
- GitHub [`neonbjb/tortoise-tts`](https://github.com/neonbjb/tortoise-tts)：**14.9k stars / 2.0k forks / 179 watchers / 357 commits**
- HF [`jbetker/tortoise-tts-v2`](https://huggingface.co/jbetker/tortoise-tts-v2)：251 likes，100+ Spaces
- arXiv [2305.07243](https://arxiv.org/abs/2305.07243) **201 次引用**

### 11.3 能力清单
- 零样本/少样本克隆：✅ 5–10 s ref + 条件 latent（**含 voice latent arithmetic**：两 voice 平均）；README 自称 strong multi-voice（2024 后有更强对手 **待核**）
- 实时推理：❌ "insanely slow"；DeepSpeed+KV cache+FP16 时 RTF 0.25–0.3 / 4GB VRAM（≈ 4× 慢于实时）
- 流式首包延迟：`tortoise/socket_server.py`；README 声称 "<500 ms latency"（**作者自报，未与 2025 SOTA 交叉验证，待核**）
- 情感/韵律：✅ `[...]` 提示重写（如 `[I am really sad,]`）；CLVP 重排；latent 影响音调/语速/缺陷
- Voice design：⚠️ `--voice random` 随机；预设音色库；**非纯文本描述**
- 多角色/对话：✅ `do_tts.py` 支持逗号分隔多 voice
- 跨语种混读：❌ EN-centric（~50k h 有声书）
- 长文一致性：⚠️ `read.py` 句级分段 + `--regenerate` 重抽；段间无连续韵律建模
- 推理速度：**RTF 0.25–0.3 on 4GB VRAM**
- License：**Apache-2.0 ✅**

### 11.4 对比 dsh-voice-mode
**Already surpassed**: dsh 当前 Edge/Kokoro/VITS 在速度/克隆质量上都已优于 Tortoise
**Borrowable**: voice latent arithmetic 思路值得参考做"voice blending" UI

### 11.5 Borrowable
1. **(Small)** voice latent arithmetic 思路 → 借鉴给用户做 "voice mixing" 实验功能
2. **(Skip direct)** 主线已被 Xtts/CosyVoice/Zonos 替代

### 11.6 PRIMARY URLs
- GitHub: [neonbjb/tortoise-tts](https://github.com/neonbjb/tortoise-tts)
- HF v2: [jbetker/tortoise-tts-v2](https://huggingface.co/jbetker/tortoise-tts-v2)
- arXiv: [2305.07243](https://arxiv.org/abs/2305.07243)
- Space: [Manmay/tortoise-tts](https://huggingface.co/spaces/Manmay/tortoise-tts)
- 架构设计: [nonint.com/2022/04/25/tortoise-architectural-design-doc](https://nonint.com/2022/04/25/tortoise-architectural-design-doc/)
- LICENSE: [LICENSE](https://github.com/neonbjb/tortoise-tts/blob/main/LICENSE)

### 11.7 待核
- v3/新 release、HF 月下载、RTX 4090 实测、客观 MOS

---

## 12. Bark (Suno)

### 12.1 核心定位
完全生成式 transformer 文本→音频模型（AudioLM/VALL-E 架构 + EnCodec 量化），从文本直接产出多语种语音 + 非人声（笑、叹气）+ 音乐/环境音。

### 12.2 用户规模
- GitHub [`suno-ai/bark`](https://github.com/suno-ai/bark)：**39.3k stars / 4.7k forks / 335 watchers**
- HF [`suno/bark`](https://huggingface.co/suno/bark)：**1.55k likes**，100+ Spaces
- 2023-05-01 改 MIT；Suno 公司 v5.5 + Voices 于 2026-03-26 发布（**商用音乐，非 Bark 开源 TTS**）；**Bark 仓库自 2023-05 后静态**

### 12.3 能力清单
- 零样本/少样本克隆：❌ **README 明确不支持 custom voice cloning**；100+ 预设 + 随机
- 实时推理：⚠️ "On enterprise GPUs and PyTorch nightly, roughly real-time"；Salad 基准：RTX 3080 Ti/4070+ 才稳定 1.0×
- 流式首包延迟：❌ 无原生流式 API；`generate_audio` 一次性产出 ~13 s 窗口
- 情感/韵律：✅ `[laughter]` `[laughs]` `[sighs]` `[gasps]` `[clears throat]`、CAPS 强调、`—/...` 犹豫、`[MAN]/[WOMAN]`
- Voice design：⚠️ 100+ 预设 + 随机；无文本描述
- 多角色/对话：⚠️ README `dialog.webm` 示例；GPT 风格上下文窗口；跨段一致性粗糙
- 跨语种混读：✅ 自动检测语言，13 语种（en/de/es/fr/hi/it/ja/ko/pl/pt/ru/tr/zh）
- 长文一致性：⚠️ `notebooks/long_form_generation.ipynb`；默认 ~13 s 窗口；可拼接但有 discontinuity
- 推理速度：完整 ~12 GB VRAM；small ~8 GB；CPU offload ~2 GB；HF Transformers fp16 + BetterTransformer：TITAN RTX ~7.45 s/次；RTX 3090 单句 10–20 s
- License：**MIT ✅** (since 2023-05-01)

### 12.4 对比 dsh-voice-mode
**Misses goal**: 无自定义克隆、无流式
**Borrowable**: `[laughter]` `[sighs]` 等内联标签 → 借鉴给 dsh TTS 文本预处理（和 Orpheus 标签互为补充）

### 12.5 Borrowable
1. **(Small)** Bark 的非人声标签集 → 借鉴扩展 Orpheus 的 `<laugh>` 等
2. **(Skip direct)** 主线已陈旧（2023 后无新 release）

### 12.6 PRIMARY URLs
- GitHub: [suno-ai/bark](https://github.com/suno-ai/bark)
- HF: [suno/bark](https://huggingface.co/suno/bark)
- HF Transformers docs: [transformers/model_doc/bark](https://huggingface.co/docs/transformers/model_doc/bark)
- LICENSE: [LICENSE](https://github.com/suno-ai/bark/blob/main/LICENSE)
- HF Space: [suno/bark](https://huggingface.co/spaces/suno/bark)
- 长文 notebook: [notebooks/](https://github.com/suno-ai/bark/tree/main/notebooks)
- 音色预设库: [suno-ai.notion.site/8b8e8749...](https://suno-ai.notion.site/8b8e8749ed514b0cbf3f699013548683)

### 12.7 待核
- 2024–2026 隐藏 tag/commit 升级、原生流式、与 Tortoise 头对头 MOS、HF 月下载、small vs full 质量差距

---

## 13. Dia 1.6B / Dia2 (Nari Labs)

### 13.1 核心定位
1.6B 参数 text-to-dialogue TTS，一次前向从转写文本生成高拟真双角色对话；通过音频 prompt 控制情感/音色/语气；支持非语言发声。

### 13.2 用户规模
- GitHub [nari-labs/dia](https://github.com/nari-labs/dia)：**≈19.4k stars**（star-history 2026 snapshot）
- HF [nari-labs/Dia-1.6B](https://huggingface.co/nari-labs/Dia-1.6B)：**2.91k likes**；`Nari Labs` org 8.82k followers
- 第三方 benchmark：Dia demo 页与 ElevenLabs Studio + Sesame CSM-1B 对比（**主观听感，非客观指标**）

### 13.3 能力清单 (1.6B)
- 零样本/少样本克隆：✅ few-shot（5–10 s ref + 转写；`example/voice_clone.py`）
- 实时推理：✅ 4090 RTF 1.5–2.2×（无/有 compile），VRAM ≈ 4.4 GB (bf16) / 7.9 GB (fp32)
- 流式首包延迟：**待核**（1.6B 无 streaming）；**Dia2 streaming**（见 13.4）
- 情感/韵律：✅ 通过音频 prompt
- Voice design：⚠️ 仅音频 prompt / seed，无纯文本
- 多角色/对话：✅ `[S1]/[S2]` 原生双角色
- 跨语种混读：❌ **"English generation at the moment"**
- 长文一致性：⚠️ README 警告 >20 s 音频会"unnaturally fast"
- 推理速度：4090 bf16 RTF 1.5×（无 compile）/ 2.1×（compile）
- License：**Apache-2.0 ✅**

### 13.4 Dia2 (2025-11 release)
- README UPDATE: "Dia2 is released on Github and HuggingFace"
- **streaming dialogue TTS**：前几个词即可开始生成
- 提供 1B / 2B 权重（[`nari-labs/Dia2-1B`](https://huggingface.co/nari-labs/Dia2-1B), [`nari-labs/Dia2-2B`](https://huggingface.co/nari-labs/Dia2-2B)）
- 单次生成上限 2 分钟
- 英文；Apache-2.0
- CLI `--cuda-graph`；可选 Sori（Rust 语音-到-语音引擎，**待核**）

### 13.5 对比 dsh-voice-mode
**Borrowable**: 原生双角色对话 `[S1]/[S2]` + 非语言发声 → dsh 当前没有任何引擎支持原生多角色（用户需手动切换 voice）
**Missing**: 仅英文（中文场景需等后续）
**Note**: Dia2 streaming 2025-11 已发布，若 dsh 想支持"双角色对话"（双工 + 多人）值得集成

### 13.6 Borrowable
1. **(Medium)** Dia2 1B streaming 集成 → 作为 dsh `ttsEngine=dia2`；支持 `[S1]/[S2]` 内联
2. **(Small)** 非语言发声标签（`(laughs) (coughs) (sighs) (gasps) (singing) (sniffs)`） → 借鉴到 Orpheus/Bark 标签集合

### 13.7 PRIMARY URLs
- GitHub: [nari-labs/dia](https://github.com/nari-labs/dia)
- HF 1.6B: [nari-labs/Dia-1.6B](https://huggingface.co/nari-labs/Dia-1.6B)
- HF 0626: [nari-labs/Dia-1.6B-0626](https://huggingface.co/nari-labs/Dia-1.6B-0626)
- HF Space: [nari-labs/Dia-1.6B](https://huggingface.co/spaces/nari-labs/Dia-1.6B)
- 第三方对比 demo: [yummy-fir-7a4.notion.site/dia](https://yummy-fir-7a4.notion.site/dia)
- HF Dia2 1B: [nari-labs/Dia2-1B](https://huggingface.co/nari-labs/Dia2-1B)
- HF Dia2 2B: [nari-labs/Dia2-2B](https://huggingface.co/nari-labs/Dia2-2B)

### 13.8 待核
- HF 月下载、streaming 首包 ms、arXiv 编号（**HF card 上挂 arXiv:2305.09636 实为 SoundStorm，非 Dia**）、star 精确值、Dia2 发布日期

---

## 14. Sesame CSM (Maya / Miles) (Sesame AI)

### 14.1 核心定位
Sesame CSM（Conversational Speech Model）：用 Llama backbone + Mimi RVQ 解码器，把对话历史（文本 + 音频 token）作为端到端多模态输入，生成上下文感知对话语音；Maya/Miles 是 CSM 的产品层微调角色。

### 14.2 用户规模
- HF [`sesame/csm-1b`](https://huggingface.co/sesame/csm-1b)：**2.45k likes**；`Sesame` org 1.65k followers
- 训练数据 ≈ **1M 小时**（博客自报）；模型三档（Tiny 1B / Small 3B / Medium 8B），公开仅 Tiny 1B
- 产品热度：2025-04 估值 ~$1B（Sequoia/Spark 领投 $200M）；2026-05-27 iOS preview，39 国开服（Maya/Miles/Simone/Charlie 四角色）
- 第三方基准：博客自建评估套件（Homograph Disambiguation、Pronunciation Consistency、Expresso CMOS 80 人 × 15 例），**第三方独立 benchmark 待核**

### 14.3 能力清单
- 零样本/少样本克隆：✅ few-shot 通过 `Segment(text, speaker, audio)` 上下文给参考
- 实时推理：⚠️ iOS 优化栈；开源版未声明 RTF
- 流式首包延迟：⚠️ 博客 "~200 ms 对话轮换间隙" 为人类基线；公开模型离线生成
- 情感/韵律：✅ **核心卖点** —— 上下文感知韵律（"Contextual expressivity"、"Paralinguistics"）
- Voice design：⚠️ 公开模型未微调到具体 voice；Maya/Miles 是产品层角色
- 多角色/对话：✅ Llama backbone 接收交错文本+音频；示例显式多 speaker
- 跨语种混读：⚠️ data contamination 引入部分多语能力 "but it likely won't do well"；2026 路线图扩展到 20+ 语种
- 长文一致性：✅ 训练序列 2048 token ≈ 2 分钟；RVQ TTFA 较差（博客明确）
- 推理速度：⚠️ CSM README 要求 CUDA 12.4/12.6 + A100/H100；**RTF 待核**
- License：**Apache-2.0 ✅**

### 14.4 关于 Maya/Miles 与 "zero-shot emotion"
- Maya/Miles **不是独立模型**，是 CSM 产品层微调角色（每个角色有自己的 memory/人设/音色）
- "Zero-shot emotion" 严格对应博客的 "Contextual expressivity" 与 "Paralinguistics" 样本（输入带上下文的对话 → 输出去得体的情感/韵律）
- **模型层不是零样本情绪克隆**，是"上下文感知的对话语音"

### 14.5 对比 dsh-voice-mode
**Borrowable**: 上下文感知韵律 → dsh 当前没有任何引擎把"前面对话内容"作为韵律条件输入
**Missing**: Maya/Miles 不开源权重（仅 CSM-1B 开源）
**Note**: CSM-1B 仅在 A100/H100 级 GPU 上能跑；消费级 GPU 难以本地化

### 14.6 Borrowable
1. **(Large)** CSM 架构做"上下文感知对话语音"实验 → 优先级低（消费级 GPU 难跑），但作为差异化卖点
2. **(Small)** "Paralinguistics" 标签 → 借鉴非人声发声扩展（与 Orpheus/Bark/Dia 标签合集）
3. **(Skip direct)** Maya/Miles 不可用（产品层角色，未开源）

### 14.7 PRIMARY URLs
- GitHub: [SesameAILabs/csm](https://github.com/SesameAILabs/csm)
- HF: [sesame/csm-1b](https://huggingface.co/sesame/csm-1b)
- HF Space: [sesame/csm-1b](https://huggingface.co/spaces/sesame/csm-1b)
- Blog 2025-02-27 "Crossing the uncanny valley of conversational voice": [sesame.com/blog/crossing-the-uncanny-valley-of-voice](https://www.sesame.com/blog/crossing-the-uncanny-valley-of-voice)
- Blog 2026-05-27 "Voice your curiosity": [sesame.com/blog/voice-your-curiosity](https://www.sesame.com/blog/voice-your-curiosity)
- Blog 2026-08-28 "TurnBench": [sesame.com/blog/turnbench](https://www.sesame.com/blog/turnbench) / arXiv [2608.25218](https://arxiv.org/abs/2608.25218)
- 依赖: [Llama-3.2-1B](https://huggingface.co/meta-llama/Llama-3.2-1B)、[Mimi](https://huggingface.co/kyutai/mimi) (Kyutai 12.5 Hz split-RVQ)
- SoundStorm 引用: [arXiv:2305.09636](https://arxiv.org/abs/2305.09636)

### 14.8 待核
- CSM 主论文 arXiv 编号（**未见独立 paper，仅 TurnBench `2608.25218`**）、HF 月下载、GitHub stars、CSM-1B RTF、iOS 端是否同款 1B、第三方独立 benchmark

---

## Synthesis: Recommended priority for dsh-voice-mode

### Tier 1 — Quick wins (small effort, high value)
| Action | Source model | Effort |
|---|---|---|
| 加 `<laugh>`/`<sigh>` 等内联情感标签解析到 tts-local 文本归一化（Orpheus 风格） | Orpheus | small |
| 加 `(laughs)`/`(coughs)`/`(sighs)`/`(gasps)`/`(singing)`/`(sniffs)` 解析（Bark + Dia 风格） | Bark + Dia | small |
| 设置面板加 `voice description` 文本字段（NL 描述驱动风格，Parler 风格） | Parler-TTS | small |
| 显式 emotion/accent/rhythm 滑块（OpenVoice 风格） | OpenVoice v2 | small |
| voice latent arithmetic 思路 → 实验性 "voice blending" UI | Tortoise | small |

### Tier 2 — Medium effort (new ttsEngine option)
| Action | Source model | Effort | License |
|---|---|---|---|
| 集成 Orpheus pretrained（Llama-3B，~100 ms 流式首包）作为 `ttsEngine=orpheus` | Orpheus | medium | Apache-2.0 ✅ |
| 集成 Zonos v0.1 hybrid（~1.6B，RTF 2× on 4090，零样本克隆）作为 `ttsEngine=zonos` | Zonos v0.1 | medium | Apache-2.0 ✅ |
| 集成 Dia2 1B streaming（多角色 `[S1]/[S2]`）作为 `ttsEngine=dia2` | Dia2 | medium | Apache-2.0 ✅ |
| 集成 CosyVoice 3（中文方言 + 跨语种零样本）作为 `ttsEngine=cosyvoice`（**需法务先确认 Apache-2.0 路径**) | CosyVoice 3 | medium | Apache-2.0 ✅ |
| 集成 OpenVoice v2 的 tone-color decoder 给 Kokoro 加"参考音色" | OpenVoice v2 | medium | MIT ✅ |

### Tier 3 — License-risk or experimental
| Action | Source model | Effort | License |
|---|---|---|---|
| 集成 XTTS-v2（17 语种零样本克隆，<200 ms 流式） | XTTS-v2 | medium | **CPML ❌ 非商用** — 跳过 |
| 集成 F5-TTS / Spark-TTS / IndexTTS2 主力 | F5-TTS / Spark-TTS / IndexTTS2 | medium-large | **CC-BY-NC / bilibili 自定义** — 需法务复核 |
| CSM 架构做"上下文感知对话语音"（差异化） | Sesame CSM | large | Apache-2.0 ✅ 但需 A100+ |

### Tier 4 — Skip
| Action | Reason |
|---|---|
| Tortoise v2 主力集成 | 已被 Xtts/CosyVoice/Zonos 替代 |
| Bark 主力集成 | 无自定义克隆、无流式 |
| Kokoro 替换 | 已在 dsh 中 |

---

## License Summary (commercial gate)

| License | Models | dsh-voice-mode 商用? |
|---|---|---|
| Apache-2.0 | CosyVoice 2/3, Kokoro, Orpheus, Parler-TTS, Zonos v0.1+ZONOS2, Dia/Dia2, Sesame CSM, Tortoise v2 | ✅ |
| MIT | OpenVoice v2, Bark (since 2023-05) | ✅ |
| CC-BY-NC-4.0 | F5-TTS (weight only) | ❌ |
| CC-BY-NC-SA-4.0 | Spark-TTS (weight only; code Apache-2.0) | ❌ |
| CPML 1.0.0 | XTTS-v2 | ❌ |
| bilibili Custom | IndexTTS2 / 2.5 | ⚠️ MAU>1亿 或 年营收>10亿RMB 需书面许可；高风险场景禁用 |

---

## 待核 cross-cutting
1. **HF 月下载**（多数模型 page 直接不显示，需 API 二次抓取）
2. **流式首包 ms**（除 CosyVoice 150ms、Orpheus 200/100ms、XTTS <200ms、Parler <500ms 外，多数模型未公开）
3. **消费级 GPU（RTX 4090）实测 RTF**（F5-TTS、Spark-TTS、Zonos 等仅给 L20/H100/A100 数字）
4. **长文一致性上限**（多数模型未声明）
5. **第三方独立 benchmark**（仅 Kokoro/Zonos 收录 TTS Arena 系；其余仅自评）
6. **host clock 偏差**：报告依据用户提示的 2026-05，但 host clock 为 2026-09-14；部分模型（如 Dia2 2025-11 release）已在 2026-05 之前实际发布。