// OCR 测试台：本地静态服务 + Puppeteer 开普通网页跑 ppu/web，打印各框文字+置信度。
// 用法：node scripts/ocr-harness/run.mjs
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = process.cwd();
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HARNESS = join(ROOT, 'scripts', 'ocr-harness');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.ort': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
};

// URL 前缀 → 磁盘目录
const MOUNTS = [
  ['/paddleocr/', join(ROOT, 'public', 'paddleocr')],
  ['/ort/', join(ROOT, 'public', 'ort')],
  ['/manga-ocr/', join(ROOT, 'public', 'manga-ocr')],
  ['/img/', join(ROOT, 'test-images')],
];

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  let file;
  if (url === '/') file = join(HARNESS, 'harness.html');
  else if (url === '/bundle.js') file = join(HARNESS, 'bundle.js');
  else {
    for (const [prefix, dir] of MOUNTS) {
      if (url.startsWith(prefix)) {
        file = join(dir, url.slice(prefix.length));
        break;
      }
    }
  }
  if (!file || !existsSync(file)) {
    res.writeHead(404);
    res.end('not found: ' + url);
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox'],
  protocolTimeout: 600000,
});
const page = await browser.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (/error|fail|warn/i.test(t)) console.log('  [page]', t.slice(0, 160));
});
page.on('pageerror', (e) => console.log('  [pageerror]', e.message.slice(0, 200)));

try {
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true', { timeout: 60000 });

  const cases = [
    { name: '韩语 (korean 模型)', fn: 'runPaddle', args: ['/img/ko.webp', '/paddleocr/rec_korean.onnx', '/paddleocr/dict_korean.txt'] },
    { name: '英语 (multi 模型)', fn: 'runPaddle', args: ['/img/en.webp', '/paddleocr/rec_multi.onnx', '/paddleocr/dict_multi.txt'] },
    { name: '日语 (manga-ocr)', fn: 'runManga', args: ['/img/ja.webp'] },
  ];

  for (const c of cases) {
    console.log(`\n===== ${c.name} =====`);
    const t = Date.now();
    const out = await page.evaluate((fn, args) => window[fn](...args), c.fn, c.args);
    console.log(`(${((Date.now() - t) / 1000).toFixed(1)}s, ${out.length} 块)`);
    for (const r of out) {
      const conf = r.conf !== undefined ? ` conf=${r.conf}` : '';
      console.log(`  [${r.w}x${r.h}]${conf}  ${JSON.stringify(r.text)}`);
    }
  }
} catch (e) {
  console.log('harness error:', e.message);
} finally {
  await browser.close();
  server.close();
}
