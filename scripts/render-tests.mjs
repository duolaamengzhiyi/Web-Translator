// 把 test-images 下所有图按语言跑完整翻译管线，输出翻译图到 test-images-translated/ 供 review。
// 日图(ja*): comic-text-detector 块级框 + manga-ocr 识别 + seg 取色/擦除。
// 英/韩(en*/ko*): PaddleOCR det 行级框 + rec 识别 + 行框取色/擦除。
// 全用 onnxruntime-node + sharp + SVG 复现（Node 无 canvas，softVeil 的 blur 出不来）。
// 用法：先 `set -a && . ./.env.local && set +a`，再 `node scripts/render-tests.mjs [可选:单个文件名]`
import ort from 'onnxruntime-node';
import sharp from 'sharp';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';

const S = 1024,
  CONF = 0.4,
  IOU = 0.35,
  SEG_TH = 0.3,
  INK_DIST = 55,
  MASK_DILATE = 2;
const DET_LIMIT = 1536,
  DET_TH = 0.3,
  PAD_H = 0.6,
  PAD_V = 0.4;
const FONT = 'PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif';
const MAX_FONT = 30,
  MIN_FONT = 9,
  LINE_RATIO = 1.2,
  PAD = 3;
const vocab = readFileSync('public/manga-ocr/vocab.txt', 'utf8')
  .split('\n')
  .map((l) => l.replace(/\r$/, ''));

let detSess, comicSess, enc, dec;
const recSess = {},
  dicts = {};

const langOf = (f) => (/^ja/i.test(f) ? 'ja' : /^ko/i.test(f) ? 'ko' : 'en');
const SRC_LABEL = { ja: '日本語（日语）', en: '英语', ko: '韩语' };

// ---------- comic-text-detector（日：块级框 + seg） ----------
async function comicDetect(path) {
  const meta = await sharp(path).metadata();
  const ratio = Math.min(S / meta.width, S / meta.height);
  const nw = Math.round(meta.width * ratio),
    nh = Math.round(meta.height * ratio);
  const padX = Math.floor((S - nw) / 2),
    padY = Math.floor((S - nh) / 2);
  const { data } = await sharp(path)
    .resize(nw, nh)
    .extend({
      top: padY,
      bottom: S - nh - padY,
      left: padX,
      right: S - nw - padX,
      background: { r: 114, g: 114, b: 114 },
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = S * S,
    inp = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    inp[i] = data[i * 3] / 255;
    inp[n + i] = data[i * 3 + 1] / 255;
    inp[2 * n + i] = data[i * 3 + 2] / 255;
  }
  comicSess ??= await ort.InferenceSession.create('public/manga-ocr/detector.onnx');
  const r = await comicSess.run({ images: new ort.Tensor('float32', inp, [1, 3, S, S]) });
  const blk = r.blk.data,
    seg = r.seg.data,
    R = 64512,
    C = 7;
  let cand = [];
  for (let i = 0; i < R; i++) {
    const o = blk[i * C + 4];
    if (o <= CONF) continue;
    const cx = blk[i * C],
      cy = blk[i * C + 1],
      w = blk[i * C + 2],
      h = blk[i * C + 3];
    cand.push({ x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2, score: o });
  }
  cand = nms(cand);
  const boxes = cand
    .map((b) => {
      const x = Math.max(0, Math.round((b.x1 - padX) / ratio));
      const y = Math.max(0, Math.round((b.y1 - padY) / ratio));
      return {
        x,
        y,
        w: Math.min(Math.round((b.x2 - b.x1) / ratio), meta.width - x),
        h: Math.min(Math.round((b.y2 - b.y1) / ratio), meta.height - y),
      };
    })
    .filter((b) => b.w >= 6 && b.h >= 6);
  return {
    boxes,
    seg,
    lb: { ratioX: ratio, ratioY: ratio, padX, padY, segW: S, segH: S },
    W: meta.width,
    H: meta.height,
  };
}
function nms(b) {
  b.sort((a, c) => c.score - a.score);
  const k = [];
  for (const x of b) {
    const ok = !k.some((y) => {
      const ix = Math.max(0, Math.min(x.x2, y.x2) - Math.max(x.x1, y.x1));
      const iy = Math.max(0, Math.min(x.y2, y.y2) - Math.max(x.y1, y.y1));
      const inter = ix * iy;
      const ua = (x.x2 - x.x1) * (x.y2 - x.y1) + (y.x2 - y.x1) * (y.y2 - y.y1) - inter;
      return inter / (ua || 1) > IOU;
    });
    if (ok) k.push(x);
  }
  return k;
}
function segAt(seg, lb, ox, oy) {
  const lx = Math.round(ox * lb.ratioX + lb.padX),
    ly = Math.round(oy * lb.ratioY + lb.padY);
  if (lx < 0 || ly < 0 || lx >= lb.segW || ly >= lb.segH) return 0;
  return seg[ly * lb.segW + lx];
}

// ---------- PaddleOCR det（英/韩：行级框 + prob 概率图当 seg） ----------
// 动态尺寸（保持比例、对齐 32，不 letterbox，宽/高图都不损分辨率）→ prob 当 seg，
// 配 lb 映射复用 segAt/inkColorSeg/eraseSeg 做笔画级精准取色与擦除（不留矩形遮挡）。
async function paddleDet(path) {
  const meta = await sharp(path).metadata();
  const scale = Math.min(1, DET_LIMIT / Math.max(meta.width, meta.height));
  const rw = Math.max(32, Math.round((meta.width * scale) / 32) * 32);
  const rh = Math.max(32, Math.round((meta.height * scale) / 32) * 32);
  const { data } = await sharp(path)
    .resize(rw, rh, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mean = [0.485, 0.456, 0.406],
    std = [0.229, 0.224, 0.225];
  const n = rw * rh,
    inp = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    inp[i] = (data[i * 3] / 255 - mean[0]) / std[0];
    inp[n + i] = (data[i * 3 + 1] / 255 - mean[1]) / std[1];
    inp[2 * n + i] = (data[i * 3 + 2] / 255 - mean[2]) / std[2];
  }
  detSess ??= await ort.InferenceSession.create('public/paddleocr/det.ort');
  const out = await detSess.run({ x: new ort.Tensor('float32', inp, [1, 3, rh, rw]) });
  const prob = out.fetch_name_0.data;
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) bin[i] = prob[i] > DET_TH ? 1 : 0;
  const comps = cc(bin, rw, rh).filter((c) => c.size >= 20);
  const sx = meta.width / rw,
    sy = meta.height / rh;
  const boxes = comps
    .map((c) => {
      let x = Math.max(0, c.minx * sx),
        y = Math.max(0, c.miny * sy),
        w = (c.maxx - c.minx + 1) * sx,
        h = (c.maxy - c.miny + 1) * sy;
      x = Math.max(0, x - (w * PAD_H) / 2);
      y = Math.max(0, y - (h * PAD_V) / 2);
      w = Math.min(meta.width - x, w * (1 + PAD_H));
      h = Math.min(meta.height - y, h * (1 + PAD_V));
      return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    })
    .filter((b) => b.w >= 6 && b.h >= 6)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  return {
    boxes,
    prob,
    lb: { ratioX: rw / meta.width, ratioY: rh / meta.height, padX: 0, padY: 0, segW: rw, segH: rh },
    W: meta.width,
    H: meta.height,
  };
}
function cc(bin, W, H) {
  const lab = new Int32Array(W * H);
  const comps = [];
  const st = [];
  for (let s = 0; s < W * H; s++) {
    if (bin[s] === 0 || lab[s]) continue;
    const id = comps.length + 1;
    let minx = W,
      miny = H,
      maxx = 0,
      maxy = 0,
      size = 0;
    st.push(s);
    lab[s] = id;
    while (st.length) {
      const p = st.pop();
      const x = p % W,
        y = (p / W) | 0;
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
      size++;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (bin[q] === 1 && lab[q] === 0) {
            lab[q] = id;
            st.push(q);
          }
        }
    }
    comps.push({ minx, miny, maxx, maxy, size });
  }
  return comps;
}

// ---------- 识别 ----------
async function recogManga(path, b) {
  if (!enc) {
    enc = await ort.InferenceSession.create('public/manga-ocr/encoder_model.onnx');
    dec = await ort.InferenceSession.create('public/manga-ocr/decoder_model.onnx');
  }
  const { data } = await sharp(path)
    .extract({ left: b.x, top: b.y, width: b.w, height: b.h })
    .resize(224, 224, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = 224 * 224,
    a = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    a[i] = (data[i * 3] / 255 - 0.5) / 0.5;
    a[n + i] = (data[i * 3 + 1] / 255 - 0.5) / 0.5;
    a[2 * n + i] = (data[i * 3 + 2] / 255 - 0.5) / 0.5;
  }
  const eo = await enc.run({ pixel_values: new ort.Tensor('float32', a, [1, 3, 224, 224]) });
  const hh = eo.last_hidden_state;
  const ids = [2];
  for (let s = 0; s < 150; s++) {
    const ii = new ort.Tensor('int64', BigInt64Array.from(ids.map((v) => BigInt(v))), [
      1,
      ids.length,
    ]);
    const o = await dec.run({ input_ids: ii, encoder_hidden_states: hh });
    const lg = o.logits,
      V = lg.dims[2],
      t = lg.dims[1],
      dd = lg.data;
    let bi = 0,
      bv = -Infinity,
      off = (t - 1) * V;
    for (let i = 0; i < V; i++)
      if (dd[off + i] > bv) {
        bv = dd[off + i];
        bi = i;
      }
    if (bi === 3) break;
    ids.push(bi);
  }
  return ids
    .slice(1)
    .map((i) => vocab[i] || '')
    .filter((t) => t && !/^\[.*\]$/.test(t))
    .map((t) => t.replace(/^##/, ''))
    .join('')
    .trim();
}
async function recogPaddle(path, b, lang) {
  const model = lang === 'ko' ? 'rec_korean' : 'rec_multi';
  const dictLang = lang === 'ko' ? 'korean' : 'multi';
  recSess[model] ??= await ort.InferenceSession.create(`public/paddleocr/${model}.onnx`);
  dicts[model] ??= readFileSync(`public/paddleocr/dict_${dictLang}.txt`, 'utf8')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''));
  const dict = dicts[model];
  const H = 48,
    W = Math.max(16, Math.min(1600, Math.round((H * b.w) / b.h)));
  const { data } = await sharp(path)
    .extract({ left: b.x, top: b.y, width: b.w, height: b.h })
    .resize(W, H, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = W * H,
    a = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    a[i] = (data[i * 3] / 255 - 0.5) / 0.5;
    a[n + i] = (data[i * 3 + 1] / 255 - 0.5) / 0.5;
    a[2 * n + i] = (data[i * 3 + 2] / 255 - 0.5) / 0.5;
  }
  const out = await recSess[model].run({ x: new ort.Tensor('float32', a, [1, 3, H, W]) });
  const o = out.fetch_name_0,
    T = o.dims[1],
    Cn = o.dims[2],
    d = o.data;
  let last = -1,
    text = '';
  for (let t = 0; t < T; t++) {
    let bi = 0,
      bv = -Infinity,
      off = t * Cn;
    for (let c = 0; c < Cn; c++)
      if (d[off + c] > bv) {
        bv = d[off + c];
        bi = c;
      }
    if (bi !== 0 && bi !== last) text += dict[bi] ?? '';
    last = bi;
  }
  return text.trim();
}

// ---------- 取色 ----------
function mode(px) {
  const bk = new Map();
  for (const [r, g, b] of px) {
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const a = bk.get(k) ?? { r: 0, g: 0, b: 0, n: 0 };
    a.r += r;
    a.g += g;
    a.b += b;
    a.n++;
    bk.set(k, a);
  }
  let best = { r: 0, g: 0, b: 0, n: 0 };
  for (const a of bk.values()) if (a.n > best.n) best = a;
  return best.n ? [best.r / best.n, best.g / best.n, best.b / best.n] : null;
}
// 从一组像素里取「底色分离 + 最偏离端众数」的笔画色
function inkFromPixels(px) {
  if (px.length < 12) return [30, 30, 30];
  const base = mode(px);
  if (!base) return [30, 30, 30];
  const cand = px
    .map((p) => [p[0], p[1], p[2], Math.hypot(p[0] - base[0], p[1] - base[1], p[2] - base[2])])
    .filter((p) => p[3] > INK_DIST)
    .sort((a, b) => b[3] - a[3]);
  if (cand.length < 8) return [30, 30, 30];
  const top = cand.slice(0, Math.max(8, Math.floor(cand.length * 0.4)));
  const c = mode(top.map((p) => [p[0], p[1], p[2]]));
  return c ? c.map(Math.round) : [30, 30, 30];
}
function inkColorSeg(raw, W, box, seg, lb) {
  const px = [];
  for (let oy = box.y; oy < box.y + box.h; oy++)
    for (let ox = box.x; ox < box.x + box.w; ox++) {
      if (segAt(seg, lb, ox, oy) <= SEG_TH) continue;
      const i = (oy * W + ox) * 3;
      px.push([raw[i], raw[i + 1], raw[i + 2]]);
    }
  return inkFromPixels(px);
}

// ---------- 擦除 ----------
function eraseSeg(raw, W, H, boxes, seg, lb) {
  for (const box of boxes) {
    const x0 = Math.max(0, box.x - 2),
      y0 = Math.max(0, box.y - 2),
      x1 = Math.min(W, box.x + box.w + 2),
      y1 = Math.min(H, box.y + box.h + 2);
    const isInk = (ox, oy) => {
      for (let dy = -MASK_DILATE; dy <= MASK_DILATE; dy++)
        for (let dx = -MASK_DILATE; dx <= MASK_DILATE; dx++)
          if (segAt(seg, lb, ox + dx, oy + dy) > SEG_TH) return true;
      return false;
    };
    const bgpx = [],
      ink = [];
    for (let oy = y0; oy < y1; oy++)
      for (let ox = x0; ox < x1; ox++) {
        const k = isInk(ox, oy);
        ink.push(k);
        if (!k) {
          const i = (oy * W + ox) * 3;
          bgpx.push([raw[i], raw[i + 1], raw[i + 2]]);
        }
      }
    const bg = (bgpx.length ? mode(bgpx) : [245, 245, 245]).map(Math.round);
    let idx = 0;
    for (let oy = y0; oy < y1; oy++)
      for (let ox = x0; ox < x1; ox++) {
        if (ink[idx++]) {
          const i = (oy * W + ox) * 3;
          raw[i] = bg[0];
          raw[i + 1] = bg[1];
          raw[i + 2] = bg[2];
        }
      }
  }
}

// 合并相邻行成段落（英/韩 PaddleOCR det 出的是行级框，逐行翻译会断裂、排版字号过小）。
function mergeLines(items, sep) {
  const sorted = [...items].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const groups = [];
  for (const it of sorted) {
    const b = it.box;
    const g = groups.find((g) => {
      const gap = b.y - (g.y + g.h); // 垂直间距
      const xov = Math.min(b.x + b.w, g.x + g.w) - Math.max(b.x, g.x);
      return gap > -b.h * 0.5 && gap < b.h * 1.0 && xov > Math.min(b.w, g.w) * 0.3;
    });
    if (g) {
      const nx = Math.min(g.x, b.x),
        ny = Math.min(g.y, b.y);
      g.w = Math.max(g.x + g.w, b.x + b.w) - nx;
      g.h = Math.max(g.y + g.h, b.y + b.h) - ny;
      g.x = nx;
      g.y = ny;
      g.texts.push(it.text);
    } else groups.push({ x: b.x, y: b.y, w: b.w, h: b.h, texts: [it.text] });
  }
  return groups.map((g) => ({ box: { x: g.x, y: g.y, w: g.w, h: g.h }, text: g.texts.join(sep) }));
}

// ---------- 排版 SVG ----------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const charW = (ch, size) => (/[\x00-\xff]/.test(ch) ? size * 0.55 : size);
function wrap(text, maxW, size) {
  const lines = [];
  for (const para of text.split('\n')) {
    let cur = '',
      w = 0;
    for (const ch of para) {
      const cw = charW(ch, size);
      if (w + cw > maxW && cur) {
        lines.push(cur);
        cur = ch;
        w = cw;
      } else {
        cur += ch;
        w += cw;
      }
    }
    if (cur) lines.push(cur);
  }
  return lines.length ? lines : [text];
}
function bestFont(text, boxW, boxH) {
  const cap = Math.min(MAX_FONT, Math.floor(boxH));
  for (let size = cap; size >= MIN_FONT; size--)
    if (wrap(text, boxW, size).length * size * LINE_RATIO <= boxH) return size;
  return MIN_FONT;
}
function buildSvg(W, H, items) {
  const fits = items.map((it) =>
    bestFont(it.text, Math.max(8, it.box.w - PAD * 2), Math.max(10, it.box.h - PAD * 2)),
  );
  const sorted = [...fits].sort((a, b) => a - b);
  const target = sorted[Math.floor(sorted.length / 2)] ?? MIN_FONT;
  let body = '';
  items.forEach((it, i) => {
    const size = Math.max(MIN_FONT, Math.min(fits[i], target));
    const lines = wrap(it.text, Math.max(8, it.box.w - PAD * 2), size);
    const lh = size * LINE_RATIO;
    const cx = it.box.x + it.box.w / 2;
    const top = it.box.y + Math.max(PAD, (it.box.h - lines.length * lh) / 2);
    const fill = `rgb(${it.color[0]},${it.color[1]},${it.color[2]})`;
    const stroke = lum(it.color) < 140 ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.45)';
    const sw = Math.max(1, size / 12);
    body += `<rect x="${it.box.x}" y="${it.box.y}" width="${it.box.w}" height="${it.box.h}" fill="rgba(250,250,250,0.3)"/>`;
    const spans = lines
      .map(
        (ln, j) =>
          `<tspan x="${cx.toFixed(1)}" ${j === 0 ? `y="${(top + size * 0.85).toFixed(1)}"` : `dy="${lh.toFixed(1)}"`}>${esc(ln)}</tspan>`,
      )
      .join('');
    body += `<text text-anchor="middle" font-family="${FONT}" font-weight="500" font-size="${size}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" style="paint-order:stroke">${spans}</text>`;
  });
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

// ---------- 翻译 ----------
async function translate(texts, srcLabel) {
  if (!texts.length) return [];
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return texts.map(() => '【未配置 KEY】');
  const SYSTEM = `你是专业漫画/网页翻译引擎。源语言为「${srcLabel}」。把用户给出的 JSON 字符串数组中每一项翻译成「简体中文」，输出与输入等长、顺序一致。要求：①每一项都必须输出简体中文，绝不保留原文语种；②拟声词/音效译成贴近的中文拟声词；③原文可能有 OCR 误识，结合上下文合理意译；④保留 ♡ 等符号。仅输出 JSON 对象 {"translations": string[]}。`;
  const body = JSON.stringify({
    model: process.env.DS_MODEL ?? 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify(texts) },
    ],
    temperature: 1.3,
    response_format: { type: 'json_object' },
  });
  // 偶发 API 错误（429/5xx/网络）重试，避免 review 图出现「翻译失败」。
  let lastInfo = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(data).slice(0, 200)}`);
      return JSON.parse(data.choices[0].message.content).translations;
    } catch (e) {
      lastInfo = e instanceof Error ? e.message : String(e);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  if (process.env.DBG)
    console.error('\n[translate 失败]', lastInfo, '输入:', JSON.stringify(texts).slice(0, 200));
  return texts.map(() => '【翻译失败】');
}

// ---------- 主流程 ----------
const OUT = 'test-images-translated';
mkdirSync(OUT, { recursive: true });
const only = process.argv[2];
const files = readdirSync('test-images')
  .filter((f) => /\.(png|webp|jpe?g)$/i.test(f))
  .filter((f) => !only || f === only)
  .sort();

for (const f of files) {
  const path = `test-images/${f}`;
  const lang = langOf(f);
  process.stdout.write(`渲染 ${f} (${lang}) … `);
  const raw = Buffer.from(
    (await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true })).data,
  );
  let items, kept, W, H;
  if (lang === 'ja') {
    const det = await comicDetect(path);
    W = det.W;
    H = det.H;
    kept = [];
    const texts = [];
    for (const b of det.boxes) {
      const t = await recogManga(path, b);
      if (t) {
        kept.push(b);
        texts.push(t);
      }
    }
    const zh = await translate(texts, SRC_LABEL.ja);
    items = kept.map((b, i) => ({
      box: b,
      text: zh[i] ?? '',
      color: inkColorSeg(raw, W, b, det.seg, det.lb),
    }));
    eraseSeg(raw, W, H, kept, det.seg, det.lb);
  } else {
    // 英/韩：comic 检测块 + seg（干净不误检）；块内用 PaddleOCR det 分行 + rec 识别。
    const det = await comicDetect(path);
    W = det.W;
    H = det.H;
    const sep = lang === 'en' ? ' ' : '';
    kept = [];
    const texts = [];
    for (const box of det.boxes) {
      if (box.w < 6 || box.h < 6) continue;
      const cropBuf = await sharp(path)
        .extract({ left: box.x, top: box.y, width: box.w, height: box.h })
        .png()
        .toBuffer();
      const blockDet = await paddleDet(cropBuf); // 块内行框（crop 坐标）
      const parts = [];
      for (const lineBox of blockDet.boxes) {
        const t = await recogPaddle(cropBuf, lineBox, lang === 'ko' ? 'korean' : 'multi');
        if (t) parts.push(t);
      }
      const text = parts.join(sep).trim();
      if (!text) continue;
      kept.push(box);
      texts.push(text);
    }
    const zh = await translate(texts, SRC_LABEL[lang]);
    items = kept.map((b, i) => ({
      box: b,
      text: zh[i] ?? '',
      color: inkColorSeg(raw, W, b, det.seg, det.lb),
    }));
    eraseSeg(raw, W, H, kept, det.seg, det.lb);
  }
  const svg = buildSvg(W, H, items);
  await sharp(raw, { raw: { width: W, height: H, channels: 3 } })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toFile(`${OUT}/${f.replace(/\.\w+$/, '.png')}`);
  console.log(`✓ ${kept.length} 块`);
}
console.log('完成。');
