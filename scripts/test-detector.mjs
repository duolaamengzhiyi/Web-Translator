// 原型：comic-text-detector 检测文字块 → manga-ocr 识别（Node 端验证后移植）。
// 用法：node scripts/test-detector.mjs [图片路径]
import ort from 'onnxruntime-node';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const DET = 'public/manga-ocr/detector.onnx';
const ENC = 'public/manga-ocr/encoder_model.onnx';
const DEC = 'public/manga-ocr/decoder_model.onnx';
const vocab = readFileSync('public/manga-ocr/vocab.txt', 'utf8')
  .split('\n')
  .map((l) => l.replace(/\r$/, ''));
const S = 1024;
const CONF = 0.4;
const IOU = 0.35;

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1),
    y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2),
    y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const ua = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return inter / (ua || 1);
}
function nms(boxes) {
  boxes.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const b of boxes) {
    if (!keep.some((k) => iou(b, k) > IOU)) keep.push(b);
  }
  return keep;
}

let detSess, enc, dec;

async function detect(path) {
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
  detSess ??= await ort.InferenceSession.create(DET);
  const r = await detSess.run({ images: new ort.Tensor('float32', inp, [1, 3, S, S]) });
  const blk = r.blk.data,
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
  return cand.map((b) => {
    const x = Math.max(0, Math.round((b.x1 - padX) / ratio));
    const y = Math.max(0, Math.round((b.y1 - padY) / ratio));
    return {
      x,
      y,
      w: Math.min(Math.round((b.x2 - b.x1) / ratio), meta.width - x),
      h: Math.min(Math.round((b.y2 - b.y1) / ratio), meta.height - y),
      score: Number(b.score.toFixed(2)),
    };
  });
}

async function recog(buf) {
  if (!enc) {
    enc = await ort.InferenceSession.create(ENC);
    dec = await ort.InferenceSession.create(DEC);
  }
  const { data } = await sharp(buf)
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
  const h = eo.last_hidden_state;
  const ids = [2];
  for (let s = 0; s < 150; s++) {
    const ii = new ort.Tensor('int64', BigInt64Array.from(ids.map((v) => BigInt(v))), [
      1,
      ids.length,
    ]);
    const o = await dec.run({ input_ids: ii, encoder_hidden_states: h });
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
    .join('');
}

// 与扩展 deepseek.ts 完全一致的翻译 prompt（target=简体中文，源语言=日语）。
const SYSTEM =
  '你是专业漫画/网页翻译引擎。源语言为「日本語（日语）」。' +
  '把用户给出的 JSON 字符串数组中每一项翻译成「简体中文」，输出与输入等长、顺序一致。要求：' +
  '①每一项都必须输出「简体中文」，绝不原样保留原文语种（日文假名、韩文、其它外文等）；' +
  '②拟声词/音效(SFX)译成贴近的「简体中文」拟声词（如 噗嗤、啪、哈啊♥）；' +
  '③原文可能有 OCR 误识，请结合上下文合理意译，宁可猜一个通顺译文也不要照搬原文；' +
  '④保留 ♡ 等符号与必要标点，不要添加解释。仅输出 JSON 对象 {"translations": string[]}。';

async function translate(texts) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.DS_MODEL ?? 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: JSON.stringify(texts) },
      ],
      response_format: { type: 'json_object' },
    }),
  });
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content).translations;
}

const path = process.argv[2] ?? 'test-images/ja.webp';
const boxes = await detect(path);
const texts = [];
for (const b of boxes) {
  if (b.w < 6 || b.h < 6) continue;
  const crop = await sharp(path)
    .extract({ left: b.x, top: b.y, width: b.w, height: b.h })
    .toBuffer();
  const t = await recog(crop);
  if (t) texts.push(t);
}
console.log(`检测+识别 ${texts.length} 块`);
const zh = await translate(texts);
if (!zh) {
  texts.forEach((t) => console.log('  JP:', t));
  process.exit(0);
}
let kana = 0;
texts.forEach((t, i) => {
  const out = zh[i] ?? '';
  const hasKana = /[぀-ヿ]/.test(out);
  if (hasKana) kana++;
  console.log(`  ${hasKana ? '❌残日文' : '✅'} ${JSON.stringify(t)} → ${JSON.stringify(out)}`);
});
console.log(`\n残留假名块: ${kana}/${texts.length}`);
