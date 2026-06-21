// OCR 测试台浏览器端：在普通网页里跑 ppu/web(PaddleOCR) 与 manga-ocr，
// 供 Node + Puppeteer 调用，打印每框文字+置信度，用于用真实图调阈值。
import { PaddleOcrService } from 'ppu-paddle-ocr/web';
import * as ort from 'onnxruntime-web';

ort.env.wasm.wasmPaths = '/ort/';
ort.env.wasm.numThreads = 1;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败 ' + url));
    img.src = url;
  });
}

function toCanvas(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}

const svcCache = {};
async function getService(rec, dict) {
  if (svcCache[rec]) return svcCache[rec];
  const s = new PaddleOcrService({
    model: { detection: '/paddleocr/det.ort', recognition: rec, charactersDictionary: dict },
    processing: { engine: 'canvas-native' },
    detection: { maxSideLength: 1536 },
  });
  await s.initialize();
  svcCache[rec] = s;
  return s;
}

// PaddleOCR：返回每框 文字+置信度+尺寸
window.runPaddle = async (imgUrl, rec, dict) => {
  const svc = await getService(rec, dict);
  const canvas = toCanvas(await loadImage(imgUrl));
  const res = await svc.recognize(canvas, { flatten: true });
  return res.results.map((r) => ({
    text: r.text,
    conf: Number(r.confidence.toFixed(3)),
    w: Math.round(r.box.width),
    h: Math.round(r.box.height),
  }));
};

// ---- manga-ocr（裸 ort）----
let manga = null;
async function getManga() {
  if (manga) return manga;
  const [e, d, v] = await Promise.all([
    fetch('/manga-ocr/encoder_model.onnx').then((r) => r.arrayBuffer()),
    fetch('/manga-ocr/decoder_model.onnx').then((r) => r.arrayBuffer()),
    fetch('/manga-ocr/vocab.txt').then((r) => r.text()),
  ]);
  const enc = await ort.InferenceSession.create(e, { executionProviders: ['wasm'] });
  const dec = await ort.InferenceSession.create(d, { executionProviders: ['wasm'] });
  manga = { enc, dec, vocab: v.split('\n').map((l) => l.replace(/\r$/, '')) };
  return manga;
}
function preprocess(crop) {
  const c = document.createElement('canvas');
  c.width = 224;
  c.height = 224;
  const x = c.getContext('2d');
  x.drawImage(crop, 0, 0, crop.width, crop.height, 0, 0, 224, 224);
  const d = x.getImageData(0, 0, 224, 224).data;
  const n = 224 * 224;
  const a = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    a[i] = (d[i * 4] / 255 - 0.5) / 0.5;
    a[n + i] = (d[i * 4 + 1] / 255 - 0.5) / 0.5;
    a[2 * n + i] = (d[i * 4 + 2] / 255 - 0.5) / 0.5;
  }
  return new ort.Tensor('float32', a, [1, 3, 224, 224]);
}
async function recogManga(crop) {
  const { enc, dec, vocab } = await getManga();
  const eo = await enc.run({ pixel_values: preprocess(crop) });
  const h = eo.last_hidden_state;
  const ids = [2];
  for (let s = 0; s < 150; s++) {
    const ii = new ort.Tensor('int64', BigInt64Array.from(ids.map((v) => BigInt(v))), [
      1,
      ids.length,
    ]);
    const o = await dec.run({ input_ids: ii, encoder_hidden_states: h });
    const lg = o.logits;
    const V = lg.dims[2];
    const t = lg.dims[1];
    const dd = lg.data;
    let bi = 0;
    let bv = -Infinity;
    const off = (t - 1) * V;
    for (let i = 0; i < V; i++) {
      if (dd[off + i] > bv) {
        bv = dd[off + i];
        bi = i;
      }
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
function cropOf(canvas, b) {
  const w = Math.max(1, Math.round(b.width));
  const hh = Math.max(1, Math.round(b.height));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hh;
  c.getContext('2d').drawImage(canvas, Math.round(b.x), Math.round(b.y), w, hh, 0, 0, w, hh);
  return c;
}

// 日语：PaddleOCR 检测 + manga-ocr 识别
window.runManga = async (imgUrl) => {
  const svc = await getService('/paddleocr/rec_multi.onnx', '/paddleocr/dict_multi.txt');
  const canvas = toCanvas(await loadImage(imgUrl));
  const res = await svc.recognize(canvas, { flatten: true });
  const out = [];
  for (const r of res.results) {
    if (r.box.width < 4 || r.box.height < 4) continue;
    const text = (await recogManga(cropOf(canvas, r.box))).trim();
    if (text) out.push({ text, w: Math.round(r.box.width), h: Math.round(r.box.height) });
  }
  return out;
};

window.__ready = true;
