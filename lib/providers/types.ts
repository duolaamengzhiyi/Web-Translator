/** 一行 OCR 结果：识别到的文字 + 在源图上的像素包围盒。 */
export interface OcrLine {
  text: string;
  /** 源图像素坐标 [x1, y1, x2, y2]（左上、右下）。 */
  bbox: [number, number, number, number];
  /** 本地视觉用 seg 蒙版精准采到的原文笔画色（云模型缺省，由回填时盲采兜底）。 */
  color?: { r: number; g: number; b: number };
}

/** 文本翻译服务商契约。新增模型只需实现此接口并登记到 registry。 */
export interface TranslationProvider {
  readonly id: string;
  readonly label: string;
  /** 批量翻译，输入与输出按下标一一对应、保持顺序。 */
  translateBatch(
    texts: string[],
    sourceLang: string,
    targetLang: string,
    apiKey: string,
    model?: string,
  ): Promise<string[]>;
}

export interface VisionOptions {
  /** DashScope 区域：国际站 / 国内站。 */
  region?: 'intl' | 'cn';
  /** 覆盖默认视觉模型 ID（不传则用 provider 默认）。 */
  model?: string;
  /** 关闭服务端内容安全审查（需账号已开通该权限）。 */
  disableInspection?: boolean;
}

/** 视觉 OCR 服务商契约：从图片识别文字并返回坐标。 */
export interface VisionOcrProvider {
  readonly id: string;
  readonly label: string;
  detectText(imageDataUrl: string, apiKey: string, options?: VisionOptions): Promise<OcrLine[]>;
}
