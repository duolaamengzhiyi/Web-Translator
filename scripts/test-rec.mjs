// 验证：PaddleOCR det.ort(行级检测) + rec onnx(识别) 全用 onnxruntime-node 跑（绕过 ppu 库）。
// 用法：node scripts/test-rec.mjs [图] [multi|korean]
import ort from 'onnxruntime-node';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const DET_LIMIT = 1536;
const DET_TH = 0.3;
const PAD_H = 0.6,
  PAD_V = 0.4; // ppu 默认 padding（相对框宽/高扩展）
let detS;
const recSess = {};
const dicts = {};

// ---------- PaddleOCR det（DBNet）----------
async function detPaddle(path) {
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
  detS ??= await ort.InferenceSession.create('public/paddleocr/det.ort');
  const out = await detS.run({ x: new ort.Tensor('float32', inp, [1, 3, rh, rw]) });
  const prob = out.fetch_name_0.data; // [1,1,rh,rw]
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) bin[i] = prob[i] > DET_TH ? 1 : 0;
  const comps = connectedComponents(bin, rw, rh).filter((c) => c.size >= 20);
  const sx = meta.width / rw,
    sy = meta.height / rh;
  return comps
    .map((c) => {
      let x = c.minx * sx,
        y = c.miny * sy,
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
}

function connectedComponents(bin, W, H) {
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

// ---------- PaddleOCR rec（CRNN + CTC）----------
async function recPaddle(path, box, lang) {
  const model = lang === 'korean' ? 'rec_korean' : 'rec_multi';
  recSess[model] ??= await ort.InferenceSession.create(`public/paddleocr/${model}.onnx`);
  dicts[model] ??= readFileSync(`public/paddleocr/dict_${lang}.txt`, 'utf8')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''));
  const dict = dicts[model];
  const H = 48,
    W = Math.max(16, Math.min(1600, Math.round((H * box.w) / box.h)));
  const { data } = await sharp(path)
    .extract({ left: box.x, top: box.y, width: box.w, height: box.h })
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
  const o = out.fetch_name_0;
  const T = o.dims[1],
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

const path = process.argv[2] ?? 'test-images/en-1.png';
const lang = process.argv[3] ?? 'multi';
const boxes = await detPaddle(path);
console.log(`${path}  PaddleOCR det 检出 ${boxes.length} 行  (lang=${lang})\n`);
for (const b of boxes) {
  const t = await recPaddle(path, b, lang);
  if (t) console.log(`  [${b.w}x${b.h}] ${t}`);
}
