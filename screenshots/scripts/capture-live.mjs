#!/usr/bin/env node
// capture-live.mjs —— 真机截图（驱动真实 dsh Web UI，仅截设置对话框，不含左侧会话列表）
//
// 与 capture.mjs 的区别（重要）：
//   capture.mjs 只 `page.goto()` 后截整页，无法把界面带到目标状态，且整页会带上
//   左侧会话列表（隐私）。本脚本**真实驱动 UI**（打开 设置 → 插件 → 展开语音模式），
//   并且**只截设置对话框**。
//
// 用法：
//   DSH_TOKEN=<token> node screenshots/scripts/capture-live.mjs --id S01
//   DSH_TOKEN=<token> node screenshots/scripts/capture-live.mjs --all
//
// 环境变量：
//   DSH_BASE    dsh Web 基址，默认 http://127.0.0.1:3018
//   DSH_TOKEN   访问令牌（**必填**）。取法：`journalctl -u dsh.service | grep -o 'http://127.0.0.1:3018/?token=[^ ]*' | tail -1`
//   DSH_URL     也可直接给带 token 的完整 URL（优先于 DSH_BASE + DSH_TOKEN）
//   CHROME_PATH 自定义 Chromium 可执行文件路径（默认自动探测 ms-playwright 缓存）
//
// 依赖：playwright-core —— 复用插件工程已装的副本，**不新增依赖、不改 package.json**（不变量 I1/I9）。
// 产物：screenshots/<ID>-<slug>.png

import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT_DIR = join(REPO, 'screenshots');
const PLUGIN = join(REPO, 'plugin', 'dsh-voice-mode');

const DSH_BASE = (process.env.DSH_BASE || 'http://127.0.0.1:3018').replace(/\/+$/, '');
const DSH_TOKEN = process.env.DSH_TOKEN || '';
const DSH_URL = process.env.DSH_URL || (DSH_TOKEN ? `${DSH_BASE}/?token=${DSH_TOKEN}` : DSH_BASE);

// 设置对话框里需要校验的 4 个新字段
const CONFIG_FIELDS = [
  { key: 'senseITN', type: 'boolean' },
  { key: 'captionFontSize', type: 'number' },
  { key: 'captionMaxWidth', type: 'number' },
  { key: 'backchannelYield', type: 'boolean' },
];

const SHOTS = [
  {
    id: 'S01',
    file: 'S01-install-config-4fields.png',
    desc: '插件页含「语音模式」（安装成功）+ /voice-mode/config 4 字段校验',
    // 只展开到「插件」列表，不展开语音模式
    expandVoice: false,
    anchor: null,
  },
  {
    id: 'S02',
    file: 'S02-settings-chinese-labels.png',
    desc: '语音模式设置展开：字幕字号 / 字幕宽度 / 短应答让位 等中文标签',
    expandVoice: true,
    anchor: '字幕字号',
  },
];

function loadChromium() {
  // 1) 优先复用插件工程已装的 playwright-core
  const req = createRequire(join(PLUGIN, 'package.json'));
  try {
    return req('playwright-core').chromium;
  } catch {
    /* 继续尝试 */
  }
  try {
    return createRequire(import.meta.url)('playwright-core').chromium;
  } catch {
    console.error('错误：未找到 playwright-core。请先在 plugin/dsh-voice-mode 内安装（它是 devDependency）。');
    process.exit(1);
  }
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(root)) return undefined;
  // chromium-<rev>/chrome-linux64/chrome —— 取版本号最大者
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

function parseArgs(argv) {
  const ids = [];
  let all = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--id') ids.push(argv[++i]);
    else if (argv[i] === '--all') all = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('用法: DSH_TOKEN=<token> node screenshots/scripts/capture-live.mjs --id S01 | --all');
      process.exit(0);
    } else {
      console.error(`未知参数：${argv[i]}`);
      process.exit(1);
    }
  }
  if (!all && ids.length === 0) {
    console.error('需要 --id <ID> 或 --all');
    process.exit(1);
  }
  return all ? SHOTS : SHOTS.filter((s) => ids.includes(s.id));
}

/** 打开 设置 → 插件（两个入口都需要真实点击，UI 无 ARIA role） */
async function openPluginsPane(page) {
  await page.getByText('设置', { exact: true }).first().click();
  await page.waitForTimeout(1200);
  await page.getByText('插件', { exact: true }).first().click();
  await page.waitForTimeout(1500);
}

/** 定位设置对话框面板：带阴影、尺寸像对话框、且含「打开配置文件」的那个 div */
async function dialogBox(page) {
  const box = await page.evaluate(() => {
    const hit = [...document.querySelectorAll('div')].find((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return (
        s.boxShadow !== 'none' &&
        r.width > 500 && r.height > 400 && r.width < 1300 &&
        el.innerText.includes('打开配置文件')
      );
    });
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });
  if (!box) throw new Error('未找到设置对话框面板');
  return box;
}

async function main() {
  const targets = parseArgs(process.argv.slice(2));
  const chromium = loadChromium();
  const executablePath = findChrome();
  if (!executablePath) console.warn('警告：未探测到 Chromium，将使用 playwright-core 默认路径（可能失败）');

  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await context.newPage();

    // ① S01 的字段校验：不依赖 UI，先打接口
    if (targets.some((s) => s.id === 'S01')) {
      try {
        const res = await fetch(`${DSH_BASE}/voice-mode/config`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const bad = CONFIG_FIELDS.filter(
          (f) => data[f.key] === null || data[f.key] === undefined || typeof data[f.key] !== f.type,
        );
        if (bad.length) console.warn(`⚠️ /voice-mode/config 字段异常：${bad.map((b) => b.key).join('、')}`);
        else console.log('✓ /voice-mode/config 4 字段全部非 null 且类型正确');
      } catch (err) {
        console.warn(`⚠️ config 请求失败：${err.message}`);
      }
    }

    await page.goto(DSH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    if ((await page.locator('body').innerText()).includes('authentication required')) {
      throw new Error('未通过 dsh Web 鉴权（页面返回 authentication required）——请确认 DSH_TOKEN 为 journalctl 里最新那条');
    }
    await openPluginsPane(page);

    for (const shot of targets) {
      if (shot.expandVoice) {
        await page.getByText('语音模式', { exact: true }).first().click();
        await page.waitForTimeout(1300);
        if (shot.anchor) {
          await page.getByText(shot.anchor, { exact: true }).first().scrollIntoViewIfNeeded().catch(() => {});
          await page.waitForTimeout(700);
        }
      }
      const box = await dialogBox(page);
      const out = join(OUT_DIR, shot.file);
      await page.screenshot({ path: out, clip: box });
      console.log(`已保存 ${shot.id} → screenshots/${shot.file}（${box.width}×${box.height}@2x）— ${shot.desc}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`错误：${err?.stack || err}`);
  process.exit(1);
});
