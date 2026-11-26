/* Browser glue for slip scanning: lazy-loads the OCR engine, turns an image URL into parsed slip fields.
   Everything runs inside the app; nothing is sent anywhere. */
(function (root) {
  'use strict';
  let enginePromise = null;

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src));
      document.head.appendChild(s);
    });
  }

  /* base: folder holding ocr.js, parse.js, models/, vendor/ (default 'slip/') */
  function init(base) {
    if (enginePromise) return enginePromise;
    base = base || 'slip/';
    enginePromise = (async () => {
      for (const f of ['vendor/ort.wasm.min.js', 'vendor/jsQR.js', 'ocr.js', 'parse.js']) {
        if (f === 'vendor/jsQR.js' && root.jsQR) continue;
        await loadScript(base + f);
      }
      const ort = root.ort;
      ort.env.wasm.numThreads = 1;              // WebView is not cross-origin isolated: no threads
      ort.env.logLevel = 'error';
      // Hand the wasm runtime over as blob/bytes so it never depends on how the local server labels .mjs/.wasm
      const [mjs, wasm] = await Promise.all([
        fetch(base + 'vendor/ort-wasm-simd-threaded.mjs').then(r => { if (!r.ok) throw new Error('mjs'); return r.text(); }),
        fetch(base + 'vendor/ort-wasm-simd-threaded.wasm').then(r => { if (!r.ok) throw new Error('wasm'); return r.arrayBuffer(); }),
      ]);
      ort.env.wasm.wasmPaths = { mjs: URL.createObjectURL(new Blob([mjs], { type: 'text/javascript' })) };
      ort.env.wasm.wasmBinary = wasm;
      const get = n => fetch(base + 'models/' + n).then(r => { if (!r.ok) throw new Error(n); return r; });
      const ocr = await root.SlipOCR.create({
        ort,
        loadBytes: async n => new Uint8Array(await (await get(n)).arrayBuffer()),
        loadText: async n => (await get(n)).text(),
      });
      return { ocr, parse: root.SlipParse };
    })();
    enginePromise.catch(() => { enginePromise = null; });   // allow retry after a failure
    return enginePromise;
  }

  async function imageData(url) {
    const blob = await (await fetch(url)).blob();
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    return g.getImageData(0, 0, c.width, c.height);
  }

  /* Returns null when the image has no bank-slip QR (not a slip -> no OCR, saves time).
     Otherwise: { app, type, date, time, amount, fee, ref, bank, to, from_acct, to_acct, ms } */
  async function scanUrl(url, opts) {
    opts = opts || {};
    const { ocr, parse } = await init(opts.base);
    const t0 = performance.now();
    const img = await imageData(url);
    const qr = root.jsQR(img.data, img.width, img.height);
    const q = qr ? parse.refFromQr(qr.data) : { ref: null, bank: null };
    if (!q.ref && !opts.force) return null;
    const boxes = await ocr.read(img);
    const r = parse.parse(boxes, opts.yearHint);
    r.ref = q.ref || r.ref;
    r.bank = q.bank;
    r.ms = Math.round(performance.now() - t0);
    if (opts.debug) r.boxes = boxes;
    return r;
  }

  root.SlipScan = { init, scanUrl, imageData };
})(window);
