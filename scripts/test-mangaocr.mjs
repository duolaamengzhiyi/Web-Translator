// manga-ocr 推理原型（Node 端验证算法，确认后移植到扩展 offscreen）。
// 用法：node scripts/test-mangaocr.mjs <图片路径...>
import ort from 'onnxruntime-node';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const DIR = 'public/manga-ocr';
const vocab = readFileSync(`${DIR}/vocab.txt`, 'utf8')
  .split('\n')
  .map((l) => l.replace(/\r$/, ''));
const START = 2;
const EOS = 3;
const MAX_LEN = 150;
const SIZE = 224;

async function preprocess(path) {
  const { data } = await sharp(path)
    .resize(SIZE, SIZE, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = SIZE * SIZE;
  const arr = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    arr[i] = (data[i * 3] / 255 - 0.5) / 0.5;
    arr[n + i] = (data[i * 3 + 1] / 255 - 0.5) / 0.5;
    arr[2 * n + i] = (data[i * 3 + 2] / 255 - 0.5) / 0.5;
  }
  return new ort.Tensor('float32', arr, [1, 3, SIZE, SIZE]);
}

function argmax(data, off, len) {
  let bi = 0;
  let bv = -Infinity;
  for (let i = 0; i < len; i++) {
    const v = data[off + i];
    if (v > bv) {
      bv = v;
      bi = i;
    }
  }
  return bi;
}

function detokenize(ids) {
  return ids
    .map((i) => vocab[i] ?? '')
    .filter((t) => t && !/^\[.*\]$/.test(t))
    .map((t) => t.replace(/^##/, ''))
    .join('');
}

async function recognize(enc, dec, path) {
  const pixel = await preprocess(path);
  const encOut = await enc.run({ pixel_values: pixel });
  const ehs = encOut.last_hidden_state;
  const ids = [START];
  for (let step = 0; step < MAX_LEN; step++) {
    const inputIds = new ort.Tensor('int64', BigInt64Array.from(ids.map((v) => BigInt(v))), [
      1,
      ids.length,
    ]);
    const out = await dec.run({ input_ids: inputIds, encoder_hidden_states: ehs });
    const logits = out.logits;
    const V = logits.dims[2];
    const t = logits.dims[1];
    const next = argmax(logits.data, (t - 1) * V, V);
    if (next === EOS) break;
    ids.push(next);
  }
  return detokenize(ids.slice(1));
}

const enc = await ort.InferenceSession.create(`${DIR}/encoder_model.onnx`);
const dec = await ort.InferenceSession.create(`${DIR}/decoder_model.onnx`);
for (const path of process.argv.slice(2)) {
  const t = Date.now();
  const text = await recognize(enc, dec, path);
  console.log(`${path} (${Date.now() - t}ms): ${text}`);
}
