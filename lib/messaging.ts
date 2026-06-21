import type { OcrLine } from '@/lib/providers/types';

/**
 * content/popup <-> background 的类型化消息协议。
 * 每种消息声明 req（请求）与 res（响应）两种数据形状。
 */
export interface MessageMap {
  /** 批量翻译文本。 */
  translateBatch: {
    req: { texts: string[]; sourceLang: string; targetLang: string };
    res: string[];
  };
  /** 对图片做 OCR，返回文字行 + 像素坐标；本地视觉附带整图擦除蒙版。 */
  ocrImage: {
    req: { imageDataUrl: string };
    res: { lines: OcrLine[]; maskDataUrl?: string };
  };
  /** 由 background 跨域拉取图片字节，避免 canvas 跨域污染。 */
  fetchImage: {
    req: { url: string };
    res: { dataUrl: string };
  };
  /** LaMa 高质量擦除：在 offscreen 文档运行模型，返回擦除后的图片。 */
  lamaInpaint: {
    req: { imageDataUrl: string; boxes: [number, number, number, number][] };
    res: { dataUrl: string };
  };
}

export type MessageType = keyof MessageMap;

interface Envelope<T extends MessageType = MessageType> {
  type: T;
  payload: MessageMap[T]['req'];
}

type Result<T extends MessageType> =
  | { ok: true; data: MessageMap[T]['res'] }
  | { ok: false; error: string };

export type MessageHandlers = {
  [T in MessageType]: (payload: MessageMap[T]['req']) => Promise<MessageMap[T]['res']>;
};

/** 发送消息到 background，自动解包错误为异常。 */
export async function sendMessage<T extends MessageType>(
  type: T,
  payload: MessageMap[T]['req'],
): Promise<MessageMap[T]['res']> {
  const envelope: Envelope<T> = { type, payload };
  const result = (await browser.runtime.sendMessage(envelope)) as Result<T> | undefined;
  if (!result) throw new Error('background 无响应');
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

/** 在 background 注册全部消息处理器。 */
export function registerHandlers(handlers: MessageHandlers): void {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const envelope = message as Envelope;
    const handler = handlers[envelope.type] as
      | ((payload: MessageMap[MessageType]['req']) => Promise<unknown>)
      | undefined;
    if (!handler) return false;
    handler(envelope.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error: unknown) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    // 返回 true 以保持消息通道开放，支持异步 sendResponse
    return true;
  });
}
