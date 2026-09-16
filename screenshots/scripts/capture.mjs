#!/usr/bin/env node
// capture.mjs —— dsh-voice-mode 截图脚本模板（Playwright + Chromium headless）
//
// 用法：
//   node screenshots/scripts/capture.mjs --id S01    # 只截 S01 一张
//   node screenshots/scripts/capture.mjs --all       # 全部 12 张
//   node screenshots/scripts/capture.mjs --help      # 帮助（不报错，不初始化任何重资源）
//
// 环境变量：
//   DSH_URL    目标 dsh Web 地址，默认 http://127.0.0.1:3018
//   DSH_COOKIE 登录态 cookie（可选）。格式为原始 Cookie 头，如
//              "dsh_session=xxxx; other=yyy"，会原样注入每次请求的 Cookie 头。
//
// 依赖：npm 包 `playwright`（本模板不改 package.json，由使用者自备，
//      安装方式见 scripts/README.md）。import 失败时给出友好提示。
//
// 状态说明（与 ../MANIFEST.md 一致）：
//   status: "ready"    —— 无需麦克风，可直接实测；
//   status: "manual"   —— 需要麦克风/屏录等真实语音交互，脚本只做页面截屏，
//                          由人工先把页面带到目标状态再运行（--id 模式）。

// —— 顶层先处理 --help / --version，之后才允许初始化（导入 playwright 等）——
const RAW_ARGS = process.argv.slice(2);

function printHelp() {
  console.log(`dsh-voice-mode 截图脚本（Playwright 模板）

用法:
  node screenshots/scripts/capture.mjs --id <ID>   截指定一张（如 --id S01）
  node screenshots/scripts/capture.mjs --all       截全部 12 张（manual 状态的会跳过并提示）
  node screenshots/scripts/capture.mjs --help      显示本帮助

环境变量:
  DSH_URL     目标 dsh Web 地址（默认 http://127.0.0.1:3018）
  DSH_COOKIE  登录态 cookie，原始 Cookie 头格式（可选）

示例:
  DSH_URL=http://127.0.0.1:3018 node screenshots/scripts/capture.mjs --id S01
`);
}

if (RAW_ARGS.includes('--help') || RAW_ARGS.includes('-h')) {
  printHelp();
  process.exit(0);
}

// —— 以下才开始正常初始化 ——
const DSH_URL = (process.env.DSH_URL || 'http://127.0.0.1:3018').replace(/\/+$/, '');
const DSH_COOKIE = process.env.DSH_COOKIE || '';

// 12 张截图定义（与 screenshots/MANIFEST.md、plan §2.2 一一对应）
const SHOTS = [
  { id: 'S01', file: 'S01-install-config-7fields.png',  status: 'ready',  desc: '安装成功 + /voice-mode/config 返回 4 字段' },
  { id: 'S02', file: 'S02-settings-chinese-labels.png', status: 'ready',  desc: '设置面板中文标签（字幕字号/字幕宽度等新字段）' },
  { id: 'S03', file: 'S03-hotword-partial.png',         status: 'manual', desc: '热词即时生效：partial 显示 dsh-voice-mode（需麦克风）' },
  { id: 'S04', file: 'S04-language-lock-en.png',        status: 'manual', desc: '锁 en 不抖回中文：final 全英文（需麦克风）' },
  { id: 'S05', file: 'S05-caption-24px-90vw.png',       status: 'ready',  desc: '字幕 24px + 90vw（先在设置里把字幕字号调到特大）' },
  { id: 'S06', file: 'S06-backchannel-yield.png',       status: 'manual', desc: '让位语义「嗯」跳句（需麦克风）' },
  { id: 'S07', file: 'S07-emotion-tag-order.png',       status: 'manual', desc: 'emotion 标签顺序（需屏录）' },
  { id: 'S08', file: 'S08-long-60s-cold-start.png',     status: 'manual', desc: '60s 长段 cold start（需屏录）' },
  { id: 'S09', file: 'S09-engine-switch-download.png',  status: 'ready',  desc: '引擎切换下载进度 + 试听 disable（人工触发下载后截屏）' },
  { id: 'S10', file: 'S10-idle-warn-toast.png',         status: 'manual', desc: 'idle 4:30 预警 toast（需等待 4 分 30 秒）' },
  { id: 'S11', file: 'S11-error-classify-toast.png',    status: 'ready',  desc: '错误归类 toast（人工触发后截屏）' },
  { id: 'S12', file: 'S12-autoresume-hint.png',         status: 'ready',  desc: 'autoResume 引导 notice（人工切会话后截屏）' },
];

// S01 校验的 4 个字段（真源：docs/qa/real-machine-acceptance-checklist.md 阶段 7.4）
const CONFIG_FIELDS = [
  { key: 'senseITN',           type: 'boolean' },
  { key: 'captionFontSize',    type: 'number' },
  { key: 'captionMaxWidth',    type: 'number' },
  { key: 'backchannelYield',   type: 'boolean' },
];

function parseArgs() {
  let id = null;
  let all = false;
  for (let i = 0; i < RAW_ARGS.length; i++) {
    const a = RAW_ARGS[i];
    if (a === '--id') {
      id = RAW_ARGS[i + 1];
      if (!id) { console.error('错误：--id 需要一个参数，如 --id S01'); process.exit(1); }
      i++;
    } else if (a === '--all') {
      all = true;
    } else if (a === '--help' || a === '-h') {
      // 已在顶层处理，这里兜底
      printHelp();
      process.exit(0);
    } else {
      console.error(`错误：未知参数 ${a}`);
      printHelp();
      process.exit(1);
    }
  }
  if (!id && !all) { console.error('错误：需要 --id <ID> 或 --all'); printHelp(); process.exit(1); }
  return { id, all };
}

async function main() {
  const { id, all } = parseArgs();

  // playwright 是运行时依赖，延迟 import，保证 --help 在未安装时也不报错
  let chromium;
  try {
    const mod = await import('playwright');
    chromium = mod.chromium;
  } catch (err) {
    console.error('错误：未找到 playwright npm 包。请先安装（见 screenshots/scripts/README.md）：');
    console.error('  pnpm install playwright && pnpm exec playwright install chromium');
    process.exit(1);
  }

  // 目标截图集合
  let targets;
  if (id) {
    const shot = SHOTS.find((s) => s.id === id);
    if (!shot) {
      console.error(`错误：未知 ID ${id}。可选：${SHOTS.map((s) => s.id).join(' ')}`);
      process.exit(1);
    }
    targets = [shot];
  } else {
    targets = SHOTS;
  }

  const outputDir = new URL('../', import.meta.url).pathname; // screenshots/
  const skipped = [];

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2, // 2x 高清截图
    });

    // 注入登录态 cookie（若提供）
    if (DSH_COOKIE) {
      await context.addCookies(
        DSH_COOKIE.split(';')
          .map((pair) => pair.trim())
          .filter(Boolean)
          .map((pair) => {
            const eq = pair.indexOf('=');
            return {
              name: pair.slice(0, eq),
              value: pair.slice(eq + 1),
              url: DSH_URL,
            };
          }),
      );
    }

    const page = await context.newPage();

    for (const shot of targets) {
      if (shot.status === 'manual') {
        skipped.push(shot.id);
        console.log(`跳过 ${shot.id}：${shot.desc}（状态 = 待真机，需人工先到目标状态后用 --id ${shot.id} 截屏）`);
        continue;
      }

      const outPath = outputDir + shot.file;

      if (shot.id === 'S01') {
        // S01：先用 Node 原生 fetch 校验 /voice-mode/config 的 4 个字段，再截页面
        let ok = true;
        try {
          const res = await fetch(`${DSH_URL}/voice-mode/config`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          const bad = CONFIG_FIELDS.filter((f) => data[f.key] === null || data[f.key] === undefined || typeof data[f.key] !== f.type);
          if (bad.length > 0) {
            console.warn(`警告：S01 字段校验异常：${bad.map((b) => `${b.key}(期望 ${b.type})`).join('、')}`);
            ok = false;
          } else {
            console.log('S01 /voice-mode/config 4 字段全部非 null 且类型正确 ✓');
          }
        } catch (err) {
          console.warn(`警告：S01 config 请求失败：${err.message}（仍会截屏当前页面）`);
          ok = false;
        }
        await page.goto(DSH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1500); // 等客户端渲染
        await page.screenshot({ path: outPath });
        console.log(`已保存 ${shot.id} → ${shot.file}${ok ? '' : '（含告警，见上）'}`);
      } else {
        // S02 / S05 / S09 / S11 / S12：打开页面，等用户/人工处于目标状态后截当前画面。
        // 脚本不模拟点击（面板结构可能变化），只保证 URL 可达 + 渲染稳定。
        try {
          await page.goto(DSH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(1500);
        } catch (err) {
          console.error(`错误：${shot.id} 打开 ${DSH_URL} 失败：${err.message}`);
          process.exitCode = 1;
          continue;
        }
        await page.screenshot({ path: outPath });
        console.log(`已保存 ${shot.id} → ${shot.file}（提示：${shot.desc}）`);
      }
    }

    await browser.close();
  } catch (err) {
    console.error(`错误：${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  } finally {
    if (skipped.length > 0) {
      console.log(`跳过 ${skipped.length} 张（待真机）：${skipped.join(' ')}`);
    }
  }
}

main().catch((err) => {
  console.error(`错误：${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
