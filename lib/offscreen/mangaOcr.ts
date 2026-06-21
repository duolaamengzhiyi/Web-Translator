import * as ort from 'onnxruntime-web';

// manga-ocr（kha-white，VisionEncoderDecoder）：日语漫画专用识别，竖排/假名/花体强。
// 算法已在 Node 端原型验证（scripts/test-mangaocr.mjs）。模型打包在 public/manga-ocr。
const getPublicUrl = browser.runtime.getURL as (path: string) => string;
ort.env.wasm.wasmPaths = getPublicUrl('/ort/');
ort.env.wasm.numThreads = 1;

const SIZE = 224;
const START_TOKEN = 2;
const EOS_TOKEN = 3;
const MAX_LEN = 150;

interface MangaModel {
  encoder: ort.InferenceSession;
  decoder: ort.InferenceSession;
  vocab: string[];
}

let modelPromise: Promise<MangaModel> | null = null;

function getModel(): Promise<MangaModel> {
  if (!modelPromise) {
    modelPromise = loadModel().catch((error: unknown) => {
      modelPromise = null; // 失败不缓存，允许重试
      throw error;
    });
  }
  return modelPromise;
}

async function loadModel(): Promise<MangaModel> {
  const [encBuf, decBuf, vocabText] = await Promise.all([
    fetchBuffer('/manga-ocr/encoder_model.onnx'),
    fetchBuffer('/manga-ocr/decoder_model.onnx'),
    fetchText('/manga-ocr/vocab.txt'),
  ]);
  const encoder = await ort.InferenceSession.create(encBuf, { executionProviders: ['wasm'] });
  const decoder = await ort.InferenceSession.create(decBuf, { executionProviders: ['wasm'] });
  const vocab = vocabText.split('\n').map((line) => line.replace(/\r$/, ''));
  return { encoder, decoder, vocab };
}

/** 识别单个文字块裁剪图，返回日文文本。 */
export async function recognizeManga(crop: HTMLCanvasElement): Promise<string> {
  const { encoder, decoder, vocab } = await getModel();
  const encOut = await encoder.run({ pixel_values: preprocess(crop) });
  const hidden = encOut.last_hidden_state;
  if (!hidden) throw new Error('manga-ocr 编码器无输出');

  const ids: number[] = [START_TOKEN];
  for (let step = 0; step < MAX_LEN; step++) {
    const inputIds = new ort.Tensor('int64', BigInt64Array.from(ids.map((v) => BigInt(v))), [
      1,
      ids.length,
    ]);
    const out = await decoder.run({ input_ids: inputIds, encoder_hidden_states: hidden });
    const logits = out.logits;
    const vocabSize = logits?.dims[2] ?? 0;
    const seqLen = logits?.dims[1] ?? 0;
    if (!logits || vocabSize === 0) break;
    const data = logits.data as Float32Array;
    const offset = (seqLen - 1) * vocabSize;
    let best = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < vocabSize; i++) {
      const v = data[offset + i]!;
      if (v > bestVal) {
        bestVal = v;
        best = i;
      }
    }
    if (best === EOS_TOKEN) break;
    ids.push(best);
  }

  return ids
    .slice(1)
    .map((i) => vocab[i] ?? '')
    .filter((t) => t && !/^\[.*\]$/.test(t)) // 去掉 [CLS]/[SEP]/[PAD] 等特殊 token
    .map((t) => t.replace(/^##/, '')) // 去掉 wordpiece 连接符
    .join('');
}

/** 裁剪图缩放到 224、归一化(均值/方差 0.5) → CHW 张量。 */
function preprocess(crop: HTMLCanvasElement): ort.Tensor {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建画布上下文');
  ctx.drawImage(crop, 0, 0, crop.width, crop.height, 0, 0, SIZE, SIZE);
  const data = ctx.getImageData(0, 0, SIZE, SIZE).data;

  const plane = SIZE * SIZE;
  const arr = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    arr[i] = ((data[i * 4] ?? 0) / 255 - 0.5) / 0.5;
    arr[plane + i] = ((data[i * 4 + 1] ?? 0) / 255 - 0.5) / 0.5;
    arr[2 * plane + i] = ((data[i * 4 + 2] ?? 0) / 255 - 0.5) / 0.5;
  }
  return new ort.Tensor('float32', arr, [1, 3, SIZE, SIZE]);
}

async function fetchBuffer(path: string): Promise<ArrayBuffer> {
  const res = await fetch(getPublicUrl(path));
  if (!res.ok) throw new Error(`加载 manga-ocr 模型失败 ${path}（${res.status}）`);
  return res.arrayBuffer();
}

async function fetchText(path: string): Promise<string> {
  const res = await fetch(getPublicUrl(path));
  if (!res.ok) throw new Error(`加载 manga-ocr 词表失败 ${path}（${res.status}）`);
  return res.text();
}
