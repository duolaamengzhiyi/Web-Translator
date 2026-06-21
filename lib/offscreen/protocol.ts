export type Bbox = [number, number, number, number];

/** background → offscreen 的 LaMa 修复请求（用 target 字段区分接收方）。 */
export interface LamaInpaintRequest {
  target: 'offscreen';
  type: 'lama-inpaint';
  imageDataUrl: string;
  boxes: Bbox[];
}

export interface LamaInpaintResponse {
  ok: boolean;
  dataUrl?: string;
  error?: string;
}

/** 本地 OCR 识别：通用(中/英/日) / 韩语 / 日语漫画(manga-ocr 专用)。 */
export type PaddleOcrLang = 'multi' | 'korean' | 'manga';

/** background → offscreen 的本地 PaddleOCR 识别请求。 */
export interface PaddleOcrRequest {
  target: 'offscreen';
  type: 'paddle-ocr';
  imageDataUrl: string;
  lang: PaddleOcrLang;
}

export interface PaddleOcrLineDto {
  text: string;
  bbox: Bbox;
  /** seg 蒙版精准采到的原文笔画色（取不到时缺省，由上层盲采兜底）。 */
  color?: { r: number; g: number; b: number };
}

export interface PaddleOcrResponse {
  ok: boolean;
  lines?: PaddleOcrLineDto[];
  /** 整图文字蒙版（PNG dataURL，白=笔画），供回填时精准擦除原文。 */
  maskDataUrl?: string;
  error?: string;
}
