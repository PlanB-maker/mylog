/* On-device OCR for bank slips: PaddleOCR PP-OCRv5 (mobile det + Thai rec) through onnxruntime-web.
   Image in, text boxes out. No network: models are loaded from the app's own files.
   Works in the app WebView (window.SlipOCR) and in Node for tests (require). */
(function (root) {
  'use strict';
  const DB_THRESH = 0.3, BOX_THRESH = 0.6, UNCLIP = 1.5, MIN_SIDE = 3;
  const REC_H = 48, REC_MIN_W = 320, REC_MAX_W = 3200;
  const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

  /* Bilinear sample of an RGBA image region into a float CHW tensor, channels in BGR order
     (the Paddle models were trained on OpenCV BGR images). norm(v, c) maps 0..255 to model input. */
  function toTensor(img, sx0, sy0, sw, sh, outW, outH, padW, norm) {
    const { data, width, height } = img;
    const W = padW || outW;
    const t = new Float32Array(3 * outH * W);       // padding stays 0 (= value after normalisation)
    const fx = sw / outW, fy = sh / outH;
    for (let y = 0; y < outH; y++) {
      let syf = sy0 + (y + 0.5) * fy - 0.5;
      syf = Math.min(Math.max(syf, 0), height - 1);
      const y0 = Math.floor(syf), y1 = Math.min(y0 + 1, height - 1), wy = syf - y0;
      for (let x = 0; x < outW; x++) {
        let sxf = sx0 + (x + 0.5) * fx - 0.5;
        sxf = Math.min(Math.max(sxf, 0), width - 1);
        const x0 = Math.floor(sxf), x1 = Math.min(x0 + 1, width - 1), wx = sxf - x0;
        const i00 = (y0 * width + x0) * 4, i01 = (y0 * width + x1) * 4, i10 = (y1 * width + x0) * 4, i11 = (y1 * width + x1) * 4;
        for (let c = 0; c < 3; c++) {
          const src = 2 - c;                         // BGR: c0=B(rgba[2]), c1=G(rgba[1]), c2=R(rgba[0])
          const v = (data[i00 + src] * (1 - wx) + data[i01 + src] * wx) * (1 - wy) +
                    (data[i10 + src] * (1 - wx) + data[i11 + src] * wx) * wy;
          t[c * outH * W + y * W + x] = norm(v, c);
        }
      }
    }
    return t;
  }

  /* DB post-process for horizontal text: connected components of the probability map,
     axis-aligned box per component, score = mean probability inside, then "unclip" (grow). */
  function dbBoxes(prob, mw, mh, scaleX, scaleY, imgW, imgH) {
    const n = mw * mh;
    const label = new Int32Array(n);
    const boxes = [];
    const stack = new Int32Array(n);
    let next = 0;
    for (let p = 0; p < n; p++) {
      if (label[p] || prob[p] <= DB_THRESH) continue;
      next++;
      let sp = 0, x0 = mw, y0 = mh, x1 = -1, y1 = -1;
      stack[sp++] = p; label[p] = next;
      while (sp) {
        const q = stack[--sp], qx = q % mw, qy = (q - qx) / mw;
        if (qx < x0) x0 = qx; if (qx > x1) x1 = qx; if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = qy + dy;
          if (ny < 0 || ny >= mh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = qx + dx;
            if (nx < 0 || nx >= mw || (!dx && !dy)) continue;
            const r = ny * mw + nx;
            if (!label[r] && prob[r] > DB_THRESH) { label[r] = next; stack[sp++] = r; }
          }
        }
      }
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      if (Math.min(w, h) < MIN_SIDE) continue;
      let sum = 0, cnt = 0;
      for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) { sum += prob[yy * mw + xx]; cnt++; }
      if (sum / cnt < BOX_THRESH) continue;
      const d = (w * h * UNCLIP) / (2 * (w + h));
      const bx0 = Math.max(0, (x0 - d) * scaleX), by0 = Math.max(0, (y0 - d) * scaleY);
      const bx1 = Math.min(imgW, (x1 + 1 + d) * scaleX), by1 = Math.min(imgH, (y1 + 1 + d) * scaleY);
      if (Math.min(bx1 - bx0, by1 - by0) < MIN_SIDE + 2) continue;
      boxes.push([bx0, by0, bx1, by1]);
    }
    return boxes;
  }

  function ctcDecode(logits, steps, classes, dict) {
    let out = '', prev = -1;
    for (let t = 0; t < steps; t++) {
      let best = 0, bv = -Infinity;
      const off = t * classes;
      for (let k = 0; k < classes; k++) { const v = logits[off + k]; if (v > bv) { bv = v; best = k; } }
      if (best !== prev && best !== 0) out += dict[best - 1] || '';
      prev = best;
    }
    return out;
  }

  /* opts: { ort, loadBytes(name) -> Promise<Uint8Array|ArrayBuffer>, loadText(name) -> Promise<string> } */
  async function create(opts) {
    const { ort } = opts;
    const DET_MAX_SIDE = opts.detMaxSide || 1280;  // long side for detection (slips are ~1000-1500 px)
    const sOpts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const [detBytes, recBytes, dictText] = await Promise.all([
      opts.loadBytes('PP-OCRv5_mobile_det.onnx'), opts.loadBytes('th_PP-OCRv5_mobile_rec.onnx'), opts.loadText('th_dict.txt')]);
    const det = await ort.InferenceSession.create(detBytes, sOpts);
    const rec = await ort.InferenceSession.create(recBytes, sOpts);
    const dict = dictText.replace(/\r/g, '').split('\n').filter((c, i, a) => c !== '' || i < a.length - 1);
    dict.push(' ');                                   // use_space_char

    async function detect(img) {
      const s = Math.min(1, DET_MAX_SIDE / Math.max(img.width, img.height));
      const mw = Math.max(32, Math.round(img.width * s / 32) * 32), mh = Math.max(32, Math.round(img.height * s / 32) * 32);
      const input = toTensor(img, 0, 0, img.width, img.height, mw, mh, 0, (v, c) => (v / 255 - MEAN[c]) / STD[c]);
      const out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, mh, mw]) });
      const prob = out[det.outputNames[0]].data;
      return dbBoxes(prob, mw, mh, img.width / mw, img.height / mh, img.width, img.height);
    }

    async function recognize(img, box) {
      const [x0, y0, x1, y1] = box;
      const w = x1 - x0, h = y1 - y0;
      const outW = Math.min(REC_MAX_W, Math.max(1, Math.ceil(REC_H * w / h)));
      const padW = Math.max(REC_MIN_W, outW);
      const input = toTensor(img, x0, y0, w, h, outW, REC_H, padW, v => (v / 255 - 0.5) / 0.5);
      const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, REC_H, padW]) });
      const t = out[rec.outputNames[0]];
      return ctcDecode(t.data, t.dims[1], t.dims[2], dict);
    }

    /* img: { data: RGBA Uint8(Clamped)Array, width, height } -> [[x0,y0,x1,y1,text], ...] */
    async function read(img) {
      const boxes = await detect(img);
      const res = [];
      for (const b of boxes) {
        const text = (await recognize(img, b)).trim();
        if (text) res.push([Math.round(b[0]), Math.round(b[1]), Math.round(b[2]), Math.round(b[3]), text]);
      }
      return res;
    }
    return { read, detect, recognize, classes: dict.length + 1 };
  }

  const api = { create, _toTensor: toTensor, _dbBoxes: dbBoxes, _ctcDecode: ctcDecode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SlipOCR = api;
})(typeof window !== 'undefined' ? window : globalThis);
