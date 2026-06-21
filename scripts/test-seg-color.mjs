// 可行性验证：用 comic-text-detector 的 seg 像素蒙版，在每个文字框内只取"笔画像素"的颜色，
// 与现在的"框内盲采众数"对比，看 seg 取色是否更干净（接近原文真实色）。
// 用法：node scripts/test-seg-color.mjs [图片路径]
import ort from 'onnxruntime-node';
import sharp from 'sharp';

const DET = 'public/manga-ocr/detector.onnx';
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
  for (const b of boxes) if (!keep.some((k) => iou(b, k) > IOU)) keep.push(b);
  return keep;
}

const path = process.argv[2] ?? 'test-images/ja.webp';
const meta = await sharp(path).metadata();
const ratio = Math.min(S / meta.width, S / meta.height);
const nw = Math.round(meta.width * ratio),
  nh = Math.round(meta.height * ratio);
const padX = Math.floor((S - nw) / 2),
  padY = Math.floor((S - nh) / 2);

// letterbox 输入
const { data: lb } = await sharp(path)
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
  inp[i] = lb[i * 3] / 255;
  inp[n + i] = lb[i * 3 + 1] / 255;
  inp[2 * n + i] = lb[i * 3 + 2] / 255;
}

const sess = await ort.InferenceSession.create(DET);
const r = await sess.run({ images: new ort.Tensor('float32', inp, [1, 3, S, S]) });
const blk = r.blk.data,
  seg = r.seg.data;

// seg 值域
let smin = Infinity,
  smax = -Infinity,
  ssum = 0;
for (let i = 0; i < seg.length; i++) {
  if (seg[i] < smin) smin = seg[i];
  if (seg[i] > smax) smax = seg[i];
  ssum += seg[i];
}
console.log(
  `seg 值域: min=${smin.toFixed(3)} max=${smax.toFixed(3)} mean=${(ssum / seg.length).toFixed(3)}`,
);

// 解码检测框
const R = 64512,
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
const boxes = cand.map((b) => {
  const x = Math.max(0, Math.round((b.x1 - padX) / ratio));
  const y = Math.max(0, Math.round((b.y1 - padY) / ratio));
  return {
    x,
    y,
    w: Math.min(Math.round((b.x2 - b.x1) / ratio), meta.width - x),
    h: Math.min(Math.round((b.y2 - b.y1) / ratio), meta.height - y),
  };
});

// 原图像素
const { data: img, info } = await sharp(path)
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const W = info.width,
  H = info.height;

// 原图坐标 → letterbox seg 概率
const TH = Number(process.env.TH ?? 0.3); // seg 文字概率阈值（按上面打印的值域可调）
function segAt(ox, oy) {
  const lx = Math.round(ox * ratio + padX),
    ly = Math.round(oy * ratio + padY);
  if (lx < 0 || ly < 0 || lx >= S || ly >= S) return 0;
  return seg[ly * S + lx];
}

function median(a) {
  if (!a.length) return -1;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

// 盲采众数（复刻浏览器端 analyze 逻辑，作对照）
function blindMode(box) {
  // 框外缘中位数作背景
  const bx = [];
  for (const [ox, oy] of [
    [box.x - 3, box.y - 3],
    [box.x + box.w / 2, box.y - 3],
    [box.x + box.w + 3, box.y + box.h / 2],
    [box.x + box.w / 2, box.y + box.h + 3],
  ]) {
    const cx = Math.min(Math.max(Math.round(ox), 0), W - 1),
      cy = Math.min(Math.max(Math.round(oy), 0), H - 1);
    const i = (cy * W + cx) * 3;
    bx.push([img[i], img[i + 1], img[i + 2]]);
  }
  const bg = [
    median(bx.map((p) => p[0])),
    median(bx.map((p) => p[1])),
    median(bx.map((p) => p[2])),
  ];
  const buckets = new Map();
  for (let oy = box.y; oy < box.y + box.h; oy += 2)
    for (let ox = box.x; ox < box.x + box.w; ox += 2) {
      const i = (oy * W + ox) * 3;
      const rr = img[i],
        gg = img[i + 1],
        bb = img[i + 2];
      const d = Math.hypot(rr - bg[0], gg - bg[1], bb - bg[2]);
      if (d <= 55) continue;
      const key = ((rr >> 4) << 8) | ((gg >> 4) << 4) | (bb >> 4);
      const a = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
      a.r += rr;
      a.g += gg;
      a.b += bb;
      a.n++;
      buckets.set(key, a);
    }
  let best = { r: 0, g: 0, b: 0, n: 0 };
  for (const a of buckets.values()) if (a.n > best.n) best = a;
  if (!best.n) return null;
  return [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)];
}

// 量化众数主色。
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

// seg 蒙版取色：seg 是"文字区域 mask"（含底色+笔画）。区域内底色=众数(面积最大)，
// 笔画=偏离底色的主色。白底气泡→底白→笔画黑；深底→底深→笔画粉/白。都正确不取反。
const D = 55;
function segMode(box) {
  const px = [];
  for (let oy = box.y; oy < box.y + box.h; oy++)
    for (let ox = box.x; ox < box.x + box.w; ox++) {
      if (segAt(ox, oy) <= TH) continue;
      const i = (oy * W + ox) * 3;
      px.push([img[i], img[i + 1], img[i + 2]]);
    }
  if (px.length < 12) return null;
  const base = mode(px); // 区域底色（面积最大的簇）
  if (!base) return null;
  // 笔画 = 偏离底色的像素，取「最偏离」的一端（白底→最黑、深底→最亮），避免半透明中间调主导。
  const cand = px
    .map((p) => [p[0], p[1], p[2], Math.hypot(p[0] - base[0], p[1] - base[1], p[2] - base[2])])
    .filter((p) => p[3] > D)
    .sort((a, b) => b[3] - a[3]);
  if (cand.length < 8) return null;
  const top = cand.slice(0, Math.max(8, Math.floor(cand.length * 0.4)));
  const c = mode(top.map((p) => [p[0], p[1], p[2]]));
  return c ? [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), cand.length] : null;
}

const hex = (c) =>
  c
    ? '#' +
      c
        .slice(0, 3)
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('')
    : '—';
console.log(`\n框数: ${boxes.length}  (seg 阈值 ${TH})\n`);
boxes.forEach((b, i) => {
  const blind = blindMode(b);
  const segc = segMode(b);
  console.log(
    `#${i} [${b.w}x${b.h}]  盲采众数=${hex(blind)}  seg蒙版=${hex(segc)}  (seg命中${segc ? segc[3] : 0}px)`,
  );
});
if (process.env.DUMP) {
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.w < 6 || b.h < 6) continue;
    await sharp(path)
      .extract({ left: b.x, top: b.y, width: b.w, height: b.h })
      .toFile(`test-images/_dbg_${i}.png`);
  }
}
