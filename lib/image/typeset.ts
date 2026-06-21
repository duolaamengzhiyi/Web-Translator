type Bbox = [number, number, number, number];

export interface TextItem {
  text: string;
  bbox: Bbox;
  /** 原文文字颜色，用于回填译文以保留角色配色。 */
  color: { r: number; g: number; b: number };
}

const FONT_STACK = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
const FONT_WEIGHT = 500;
const MAX_FONT = 30; // 字号上限，避免短文本被放超大
const MIN_FONT = 9;
const LINE_RATIO = 1.2;
const PAD = 3;

/**
 * 统一排版整页译文：先算每个框各自能容纳的最大字号，取中位数作为全页统一字号，
 * 每个框用 min(自身上限, 统一字号) 绘制——既观感一致又绝不溢出，并裁剪到框内防止压线。
 */
export function drawTexts(ctx: CanvasRenderingContext2D, items: TextItem[]): void {
  const cleaned = items
    .map((item) => ({ ...item, text: item.text.trim() }))
    .filter((item) => item.text);
  if (cleaned.length === 0) return;

  const fits = cleaned.map((item) =>
    bestFontSize(ctx, item.text, boxWidth(item.bbox), boxHeight(item.bbox)),
  );
  const target = median(fits);

  cleaned.forEach((item, i) => {
    const size = Math.max(MIN_FONT, Math.min(fits[i]!, target));
    paintText(ctx, item.text, item.bbox, item.color, size);
  });
}

function boxWidth(bbox: Bbox): number {
  return Math.max(8, bbox[2] - bbox[0] - PAD * 2);
}
function boxHeight(bbox: Bbox): number {
  return Math.max(10, bbox[3] - bbox[1] - PAD * 2);
}

/** 在框内绘制单块译文：用原文颜色、居中、裁剪、细描边。 */
function paintText(
  ctx: CanvasRenderingContext2D,
  text: string,
  bbox: Bbox,
  color: { r: number; g: number; b: number },
  size: number,
): void {
  ctx.save();
  // 裁剪到文字框，保证译文绝不溢出、压到画框或邻近气泡
  ctx.beginPath();
  ctx.rect(bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]);
  ctx.clip();

  ctx.font = fontOf(size);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const lines = wrap(ctx, text, boxWidth(bbox));
  const lineHeight = size * LINE_RATIO;

  // 用原文文字色填充；描边取对比色提升可读性（浅字描深、深字描浅）。
  ctx.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
  ctx.strokeStyle = luminance(color) < 140 ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.45)';
  ctx.lineWidth = Math.max(1, size / 12);
  ctx.lineJoin = 'round';

  const centerX = (bbox[0] + bbox[2]) / 2;
  const totalH = lines.length * lineHeight;
  let y = bbox[1] + Math.max(PAD, (bbox[3] - bbox[1] - totalH) / 2);
  for (const line of lines) {
    ctx.strokeText(line, centerX, y);
    ctx.fillText(line, centerX, y);
    y += lineHeight;
  }
  ctx.restore();
}

/** 从大到小找能在框内放下全部文字的最大字号（单行高度不超过框高）。 */
function bestFontSize(
  ctx: CanvasRenderingContext2D,
  text: string,
  boxW: number,
  boxH: number,
): number {
  const cap = Math.min(MAX_FONT, Math.floor(boxH));
  for (let size = cap; size >= MIN_FONT; size--) {
    ctx.font = fontOf(size);
    const lines = wrap(ctx, text, boxW);
    if (lines.length * size * LINE_RATIO <= boxH) return size;
  }
  return MIN_FONT;
}

/** 按词换行；过长的词（或 CJK 连续串）退化为按字符断行。 */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/(\s+)/).filter((w) => w.length > 0);
    let current = '';
    const pushWord = (word: string) => {
      const candidate = current + word;
      if (ctx.measureText(candidate).width <= maxW || current === '') {
        current = candidate;
      } else {
        lines.push(current.trimEnd());
        current = word.trimStart();
      }
    };
    for (const word of words) {
      if (ctx.measureText(word).width > maxW) {
        for (const ch of word) {
          if (ctx.measureText(current + ch).width <= maxW || current === '') {
            current += ch;
          } else {
            lines.push(current);
            current = ch;
          }
        }
      } else {
        pushWord(word);
      }
    }
    if (current.trim()) lines.push(current.trimEnd());
  }
  return lines.length > 0 ? lines : [text];
}

function fontOf(size: number): string {
  return `${FONT_WEIGHT} ${size}px ${FONT_STACK}`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return MIN_FONT;
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

function luminance(c: { r: number; g: number; b: number }): number {
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}
