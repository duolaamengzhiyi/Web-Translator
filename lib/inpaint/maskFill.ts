type Bbox = [number, number, number, number];

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface RegionColors {
  /** 框周边背景主色（保留备用）。 */
  bg: RGB;
  /** 归一化后的回填文字色（深色为主，仅真彩色文字保留色相）。 */
  text: RGB;
}

const INK_DIST = 55; // 与框周边背景的色距超过此值才算文字"墨色"（调低以纳入淡粉等浅彩字）

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 统一擦除：不论背景是纯色还是纹理，都用「模糊 + 浅色半透明面板」覆盖原文，
 * 让整页所有译文框底色保持一致（不再按区域采样实心填充，避免出现粉/肤色块）。
 * 返回归一化后的原文文字色（见 normalizeInk），供回填译文配色。
 */
export function eraseRegion(ctx: CanvasRenderingContext2D, bbox: Bbox, pad = 2): RegionColors {
  const rect = clampRect(ctx, bbox, pad);
  const info = analyze(ctx, rect);
  if (rect.w > 0 && rect.h > 0) frost(ctx, rect);
  return { bg: info.bg, text: normalizeInk(info.text) };
}

/** 只分析颜色、不改画布（LaMa 路径需在擦除前取原文颜色）。 */
export function analyzeColors(ctx: CanvasRenderingContext2D, bbox: Bbox, pad = 2): RegionColors {
  const info = analyze(ctx, clampRect(ctx, bbox, pad));
  return { bg: info.bg, text: normalizeInk(info.text) };
}

const GRAY_CHROMA = 30; // 主色彩度低于此值视为黑/灰系，吸附成干净近黑（不误伤粉/蓝等彩字）
const DARK_INK: RGB = { r: 30, g: 30, b: 30 };
const MAX_TEXT_LUM = 205; // 极浅彩字亮度上限，过亮才略压暗，便于浅底可读（描边兜底）

/**
 * 忠实还原原文笔画色：众数法采到的主色基本就是真实文字色，这里只做两点微调——
 * 黑/灰系（彩度极低）吸附成干净近黑，避免发灰；极浅的彩字略微压暗便于浅底辨认。
 * 不再把彩字压黑，故粉色/蓝色等原文配色得以保留。
 */
function normalizeInk(ink: RGB): RGB {
  const chroma = Math.max(ink.r, ink.g, ink.b) - Math.min(ink.r, ink.g, ink.b);
  if (chroma < GRAY_CHROMA) return DARK_INK;
  const lum = luminance(ink);
  if (lum <= MAX_TEXT_LUM) return ink;
  const k = MAX_TEXT_LUM / lum;
  return { r: Math.round(ink.r * k), g: Math.round(ink.g * k), b: Math.round(ink.b * k) };
}

function clampRect(ctx: CanvasRenderingContext2D, bbox: Bbox, pad: number): Rect {
  const { width, height } = ctx.canvas;
  const x = Math.max(0, Math.round(bbox[0]) - pad);
  const y = Math.max(0, Math.round(bbox[1]) - pad);
  const w = Math.min(width - x, Math.round(bbox[2] - bbox[0]) + pad * 2);
  const h = Math.min(height - y, Math.round(bbox[3] - bbox[1]) + pad * 2);
  return { x, y, w, h };
}

/**
 * 统一面板：先重模糊抹掉原文笔画，再叠一层「浅色」半透明，配深色译文清晰可读。
 * 用浅灰统一面板（不彩色、不暗沉），整页观感一致；提亮底色以承托深色译文。
 * 真正"抹掉原文只剩一层字"需 inpainting，请用 LaMa 高质量模式。
 */
function frost(ctx: CanvasRenderingContext2D, rect: Rect): void {
  const { x, y, w, h } = rect;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip(); // 防止模糊外溢到框外

  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext('2d');
  if (tctx) {
    tctx.drawImage(ctx.canvas, x, y, w, h, 0, 0, w, h);
    ctx.filter = 'blur(8px)'; // 重模糊把原文笔画化开，避免浅面板下残留鬼影
    ctx.drawImage(tmp, x, y, w, h);
    ctx.filter = 'none';
  }
  ctx.fillStyle = 'rgba(245,245,245,0.5)'; // 浅色半透明，统一面板、提亮底色以承托深色译文
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

function analyze(ctx: CanvasRenderingContext2D, rect: Rect): { bg: RGB; text: RGB } {
  const bg = sampleBorder(ctx, rect);
  const { x, y, w, h } = rect;
  if (w <= 0 || h <= 0) return { bg, text: contrast(bg) };

  const data = ctx.getImageData(x, y, w, h).data;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 4000))); // 控制采样开销
  // 把"墨色"像素按每通道 16 级量化做直方图，取众数桶均值作为笔画主色：
  // 比直接平均鲁棒——文字笔画是框内最一致的大块异色会胜出，背景杂线只是分散噪声，
  // 既修复"五颜六色"，又忠实保留文字真实色相（如淡粉、蓝字）。
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  let ink = 0;
  let total = 0;
  for (let py = 0; py < h; py += step) {
    for (let px = 0; px < w; px += step) {
      const i = (py * w + px) * 4;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      total++;
      if (dist(r, g, b, bg) <= INK_DIST) continue;
      ink++;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const acc = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
      acc.r += r;
      acc.g += g;
      acc.b += b;
      acc.n++;
      buckets.set(key, acc);
    }
  }
  if (ink <= Math.max(8, total * 0.03)) return { bg, text: contrast(bg) };

  let best = { r: 0, g: 0, b: 0, n: 0 };
  for (const acc of buckets.values()) if (acc.n > best.n) best = acc;
  return {
    bg,
    text: {
      r: Math.round(best.r / best.n),
      g: Math.round(best.g / best.n),
      b: Math.round(best.b / best.n),
    },
  };
}

/** 框外缘多点采样，按通道取中位数，抗个别落在线条上的点。 */
function sampleBorder(ctx: CanvasRenderingContext2D, rect: Rect): RGB {
  const { width, height } = ctx.canvas;
  const { x, y, w, h } = rect;
  const m = 3;
  const points: Array<[number, number]> = [
    [x - m, y - m],
    [x + w / 2, y - m],
    [x + w + m, y - m],
    [x - m, y + h / 2],
    [x + w + m, y + h / 2],
    [x - m, y + h + m],
    [x + w / 2, y + h + m],
    [x + w + m, y + h + m],
  ];
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (const [px, py] of points) {
    const cx = clamp(Math.round(px), 0, width - 1);
    const cy = clamp(Math.round(py), 0, height - 1);
    const d = ctx.getImageData(cx, cy, 1, 1).data;
    rs.push(d[0] ?? 255);
    gs.push(d[1] ?? 255);
    bs.push(d[2] ?? 255);
  }
  return { r: median(rs), g: median(gs), b: median(bs) };
}

function dist(r: number, g: number, b: number, c: RGB): number {
  return Math.sqrt((r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2);
}

function luminance(c: RGB): number {
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}

/** 与背景对比的兜底文字色（无法识别原文色时用）。 */
function contrast(bg: RGB): RGB {
  return luminance(bg) >= 140 ? { r: 20, g: 20, b: 20 } : { r: 255, g: 255, b: 255 };
}

function median(values: number[]): number {
  if (values.length === 0) return 255;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted[mid] ?? 255);
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/**
 * 用 seg 文字蒙版精准擦除原文：逐框用「框内非笔画像素」的底色填掉笔画像素，
 * 只动笔画、保留画面（远比盖整框面板干净）。mask 为整图 PNG（白=笔画），拉伸到画布尺寸。
 */
export async function erasePreciseMask(
  ctx: CanvasRenderingContext2D,
  boxes: Bbox[],
  maskDataUrl: string,
): Promise<void> {
  const { width, height } = ctx.canvas;
  const mask = await loadMaskData(maskDataUrl, width, height);
  for (const bbox of boxes) eraseBoxByMask(ctx, bbox, mask, width);
}

/**
 * 精准擦除后的「很透明模糊蒙层」（豆包式衬底）：对文字框轻模糊 + 叠一层很透明的浅色，
 * 柔化背景、提升译文可读性，又不挡住画面。原文笔画已由 erasePreciseMask 抹除。
 */
export function softVeil(ctx: CanvasRenderingContext2D, bbox: Bbox, pad = 2): void {
  const rect = clampRect(ctx, bbox, pad);
  if (rect.w <= 0 || rect.h <= 0) return;
  const { x, y, w, h } = rect;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip(); // 防止模糊外溢到框外
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext('2d');
  if (tctx) {
    tctx.drawImage(ctx.canvas, x, y, w, h, 0, 0, w, h);
    ctx.filter = 'blur(4px)';
    ctx.drawImage(tmp, x, y, w, h);
    ctx.filter = 'none';
  }
  ctx.fillStyle = 'rgba(250,250,250,0.3)'; // 很透明的浅色衬底（豆包式，不挡画面）
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

function loadMaskData(dataUrl: string, w: number, h: number): Promise<Uint8ClampedArray> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const cx = c.getContext('2d', { willReadFrequently: true });
      if (!cx) {
        reject(new Error('无法创建蒙版画布'));
        return;
      }
      cx.drawImage(img, 0, 0, w, h); // 拉伸到画布尺寸（蒙版可能基于 OCR 缩小图）
      resolve(cx.getImageData(0, 0, w, h).data);
    };
    img.onerror = () => reject(new Error('蒙版加载失败'));
    img.src = dataUrl;
  });
}

function eraseBoxByMask(
  ctx: CanvasRenderingContext2D,
  bbox: Bbox,
  mask: Uint8ClampedArray,
  imgW: number,
): void {
  const rect = clampRect(ctx, bbox, 2);
  if (rect.w <= 0 || rect.h <= 0) return;
  const region = ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
  const d = region.data;

  // 框内非笔画像素 → 底色（量化众数）
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  for (let yy = 0; yy < rect.h; yy++) {
    for (let xx = 0; xx < rect.w; xx++) {
      if ((mask[((rect.y + yy) * imgW + (rect.x + xx)) * 4] ?? 0) >= 128) continue; // 笔画，跳过
      const i = (yy * rect.w + xx) * 4;
      const r = d[i] ?? 0;
      const g = d[i + 1] ?? 0;
      const b = d[i + 2] ?? 0;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const a = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
      a.r += r;
      a.g += g;
      a.b += b;
      a.n++;
      buckets.set(key, a);
    }
  }
  let best = { r: 0, g: 0, b: 0, n: 0 };
  for (const a of buckets.values()) if (a.n > best.n) best = a;
  const bg =
    best.n > 0
      ? {
          r: Math.round(best.r / best.n),
          g: Math.round(best.g / best.n),
          b: Math.round(best.b / best.n),
        }
      : sampleBorder(ctx, rect);

  // 笔画像素用底色填掉
  for (let yy = 0; yy < rect.h; yy++) {
    for (let xx = 0; xx < rect.w; xx++) {
      if ((mask[((rect.y + yy) * imgW + (rect.x + xx)) * 4] ?? 0) < 128) continue;
      const i = (yy * rect.w + xx) * 4;
      d[i] = bg.r;
      d[i + 1] = bg.g;
      d[i + 2] = bg.b;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(region, rect.x, rect.y);
}
