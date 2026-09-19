#!/usr/bin/env node
// capture-demo.mjs —— 录制「全双工语音」演示帧（真实链路，非模拟）
//
// 原理：用 `addInitScript` 覆写 `navigator.mediaDevices.getUserMedia`，返回一个由
// **真实语音音频**经 Web Audio 解码后驱动的 MediaStream。插件照常走 VAD → zipformer2
// 流式识别 → 定稿 → 自动发送 → LLM 回复 → 按句朗读 + 字幕的完整链路。
// 因此录到的是**真机真实行为**，不是 UI 摆拍。
//
// 用法：
//   DSH_TOKEN=<token> node screenshots/scripts/capture-demo.mjs --speech /tmp/demo-speech/audio.mp3
//
// 环境变量：
//   DSH_BASE / DSH_TOKEN / DSH_URL / CHROME_PATH —— 同 capture-live.mjs
//
// 语音素材（不随仓库分发，自行生成）：
//   cd plugin/dsh-voice-mode && node -e "
//     import('msedge-tts').then(async (m) => {
//       const t = new m.MsEdgeTTS();
//       await t.setMetadata('zh-CN-XiaoxiaoNeural', m.OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
//       await t.toFile('/tmp/demo-speech', '请用一句话介绍你自己');
//     })"
//
// 产物：/tmp/demo-frames/fNN.png（再用 make-demo-gif.py 合成 GIF）

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const PLUGIN = join(REPO, 'plugin', 'dsh-voice-mode');

const DSH_BASE = (process.env.DSH_BASE || 'http://127.0.0.1:3018').replace(/\/+$/, '');
const DSH_TOKEN = process.env.DSH_TOKEN || '';
const DSH_URL = process.env.DSH_URL || (DSH_TOKEN ? `${DSH_BASE}/?token=${DSH_TOKEN}` : DSH_BASE);

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const SPEECH = arg('--speech', '/tmp/demo-speech/audio.mp3');
const FRAMES = arg('--frames', '/tmp/demo-frames');

function loadChromium() {
  const req = createRequire(join(PLUGIN, 'package.json'));
  try {
    return req('playwright-core').chromium;
  } catch {
    return createRequire(import.meta.url)('playwright-core').chromium;
  }
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(root)) return undefined;
  const revs = readdirSync(root)
    .map((n) => /^chromium-(\d+)$/.exec(n))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => b - a);
  for (const rev of revs) {
    const exe = join(root, `chromium-${rev}`, 'chrome-linux64', 'chrome');
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

async function main() {
  if (!existsSync(SPEECH)) {
    console.error(`缺语音素材：${SPEECH}（生成方法见本文件头部注释）`);
    process.exit(1);
  }
  mkdirSync(FRAMES, { recursive: true });
  const mp3 = readFileSync(SPEECH).toString('base64');

  const browser = await loadChromium().launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
    await context.addInitScript(({ b64 }) => {
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      window.__demoReady = (async () => {
        const ac = new AudioContext();
        window.__demoAC = ac;
        window.__demoBuf = await ac.decodeAudioData(buf.buffer);
        window.__demoDest = ac.createMediaStreamDestination();
        return window.__demoBuf.duration;
      })();
      navigator.mediaDevices.getUserMedia = async () => {
        await window.__demoReady;
        return window.__demoDest.stream;
      };
      window.__playDemo = async () => {
        await window.__demoAC.resume();
        const s = window.__demoAC.createBufferSource();
        s.buffer = window.__demoBuf;
        s.connect(window.__demoDest);
        s.start();
      };
    }, { b64: mp3 });

    const page = await context.newPage();
    await page.goto(DSH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    if ((await page.locator('body').innerText()).includes('authentication required')) {
      throw new Error('未通过 dsh Web 鉴权——请确认 DSH_TOKEN 为 journalctl 里最新那条');
    }

    // 建新会话，避免污染已有会话
    await page.getByText('新会话', { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(2500);

    // 进入语音模式（点 composer 的「语音」按钮；快捷键在 headless 下不一定生效）
    await page.getByText('语音', { exact: true }).last().click();
    await page.waitForTimeout(4500);

    await page.evaluate(() => window.__playDemo());
    console.log(`开始录制：语音素材 ${await page.evaluate(() => window.__demoReady)}s`);

    for (let i = 1; i <= 40; i++) {
      await page.waitForTimeout(1000);
      await page.screenshot({ path: join(FRAMES, `f${String(i).padStart(2, '0')}.png`) });
      const tail = (await page.locator('body').innerText()).slice(-140).replace(/\n+/g, ' | ');
      console.log(`[${i}s] ${tail}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`错误：${err?.stack || err}`);
  process.exit(1);
});
