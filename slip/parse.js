/* Slip parser: OCR boxes of a K PLUS / MAKE by KBank slip -> structured fields.
   Pure functions, no DOM. Works as a browser script (window.SlipParse) and in Node (require). */
(function (root) {
  'use strict';
  const TH_MONTHS = ['มค', 'กพ', 'มีค', 'เมย', 'พค', 'มิย', 'กค', 'สค', 'กย', 'ตค', 'พย', 'ธค'];
  const TYPES = ['โอนเงิน', 'ชำระเงิน', 'จ่ายบิล', 'เติมเงิน'];
  const MONEY = /\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2}/;
  const ACCT = /[xX%]{1,4}[-.]?[xX%]{1,4}[-.]?[xX%]*(\d{3,4})[-.]?[xX]?/i;
  const NOISE = /^(K\+|make|by KBank|cry|baby|bab|POP ?MART|©.*|สแกน.*|ตรวจสอบ.*|โอนแล้ว.*|Rec|OF)$/i;
  const NON_WORD = /[^\p{L}\p{N}_]/gu;

  const norm = s => String(s).replace(/ํา/g, 'ำ').replace(/ำา/g, 'ำ').replace(/\s+/g, ' ').trim();
  const thaiLetters = s => s.replace(/[^ก-ฮ]/g, '');
  const pad2 = n => String(n).padStart(2, '0');
  const iso = (y, m, d) => y + '-' + pad2(m) + '-' + pad2(d);
  // keyword matching ignores Thai above/below marks and spaces: OCR often drops a tone mark ("ค่า" -> "คา")
  const skel = s => s.replace(/[\u0e31\u0e34-\u0e3a\u0e47-\u0e4e\s]/g, '');
  const isLower = s => /[a-z]/.test(s) && s === s.toLowerCase() && !/[A-Z]/.test(s);

  function validDate(y, m, d) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  function parseDate(text) {
    const m = text.match(/(\d{1,2})\s*([฀-๿.\s]{2,8}?)\s*(\d{4}|\d{2})\s+(\d{1,2})[:.](\d{2})/);
    if (!m) return [null, null];
    const [, d, mon, yStr, hh, mm] = m;
    const time = pad2(+hh) + ':' + mm;
    const key = thaiLetters(mon);
    const mi = TH_MONTHS.findIndex(k => thaiLetters(k) === key);
    if (mi < 0) return [null, time];
    let y = +yStr;
    y = y > 2400 ? y - 543 : (y < 100 ? 2500 + y - 543 : y);
    return validDate(y, mi + 1, +d) ? [iso(y, mi + 1, +d), time] : [null, time];
  }

  /* Both apps embed <last digit of year><day of year> at ref[2..5]; K PLUS also HHMM at ref[6..9]. */
  function dateFromRef(ref, yearHint) {
    const m = (ref || '').match(/^\d{2}(\d)(\d{3})(\d{4})?/);
    if (!m) return [null, null];
    const [, ydig, doyS, hhmm] = m;
    let y = yearHint - (yearHint % 10) + +ydig;
    if (y > yearHint) y -= 10;
    const doy = +doyS;
    if (doy < 1 || doy > 366) return [null, null];
    const dt = new Date(Date.UTC(y, 0, 1) + (doy - 1) * 86400000);
    const d = iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    const t = hhmm && +hhmm.slice(0, 2) < 24 && +hhmm.slice(2) < 60 ? hhmm.slice(0, 2) + ':' + hhmm.slice(2) : null;
    return [d, t];
  }

  /* OCR boxes [x0,y0,x1,y1,text] -> segments {x0,text,parts} in reading order.
     Boxes whose vertical centres overlap form a row; inside a row, boxes closer than ~1.5 line
     heights merge into one segment, so far-away cartoon labels stay separate. */
  function groupRows(boxes) {
    // drop icon blobs: very short text in a square-ish box (bank logos read as "OBO", "=", "H")
    const kept = boxes.filter(b => !(b[4].replace(NON_WORD, '').length <= 3 && (b[2] - b[0]) < 1.3 * (b[3] - b[1])));
    const items = kept.slice().sort((a, b) => (a[1] + a[3]) - (b[1] + b[3]));
    const rows = [];
    for (const b of items) {
      const cy = (b[1] + b[3]) / 2, h = b[3] - b[1];
      const last = rows[rows.length - 1];
      if (last && Math.abs(cy - last.cy) < 0.5 * Math.min(h, last.h)) last.b.push(b);
      else rows.push({ cy, h, b: [b] });
    }
    const segs = [];
    for (const r of rows) {
      let cur = null;
      for (const b of r.b.slice().sort((p, q) => p[0] - q[0])) {
        const h = b[3] - b[1];
        if (cur && b[0] - cur.x1 < 1.5 * h) { cur.text += ' ' + b[4]; cur.x1 = b[2]; cur.parts.push([b[0], b[4]]); }
        else { cur = { x0: b[0], x1: b[2], text: b[4], parts: [[b[0], b[4]]] }; segs.push(cur); }
      }
    }
    return segs;
  }

  function parse(boxes, yearHint) {
    yearHint = yearHint || new Date().getFullYear();
    const width = Math.max(1, ...boxes.map(b => b[2]));
    const segs = groupRows(boxes).map(s => ({ x0: s.x0, text: norm(s.text), parts: s.parts })).filter(s => s.text);
    const L = segs.map(s => s.text), xs = segs.map(s => s.x0);
    const full = L.join('\n');
    const r = { app: /make|KBank/i.test(full) ? 'make' : 'kplus' };
    const compact = full.replace(/ /g, '');
    r.type = TYPES.find(t => skel(compact).includes(skel(t))) || null;
    [r.date, r.time] = parseDate(full);

    const moneyAfter = kw => {
      const idx = L.findIndex(l => skel(l).includes(skel(kw)));
      if (idx < 0) return null;
      for (const l of L.slice(idx, idx + 4)) {
        const m = l.replace(/ /g, '').match(MONEY);
        if (m) return m[0].replace(/,/g, '');
      }
      return null;
    };
    r.amount = moneyAfter('จำนวน');
    r.fee = moneyAfter('ค่าธรรม');

    r.ref = null;
    const ri = L.findIndex(l => skel(l).includes('รายการ'));
    if (ri >= 0) {
      for (const l of L.slice(ri, ri + 5)) {
        const m = l.split(':').pop().match(/(?<![0-9A-Za-z])(0\d{5}[0-9A-Za-z]{8,16})(?![0-9A-Za-z])/);
        if (m) { r.ref = m[1]; break; }
      }
    }
    const [rd, rt] = dateFromRef(r.ref, yearHint);
    r.date_from_ref = rd;
    if (!r.date && rd) r.date = rd;
    if (!r.time && rt) r.time = rt;

    // accounts + recipient: recipient = first real text line after the sender's masked account,
    // in the same column as the sender's name
    const accts = [];
    L.forEach((l, i) => { const m = l.match(ACCT); if (m) accts.push([i, m[1]]); });
    r.from_acct = accts[0] ? accts[0][1] : null;
    r.to_acct = accts[1] ? accts[1][1] : null;
    // sender name: closest real text line above the sender's masked account, in the same column
    // (K PLUS: name / bank / account, MAKE: name / account)
    r.from_name = null;
    if (accts.length) {
      const ai = accts[0][0], col = xs[ai], tol = 0.05 * width;
      for (let j = ai - 1; j >= Math.max(0, ai - 3); j--) {
        const l = L[j];
        if (Math.abs(xs[j] - col) > tol || /^ธ\.|ธนาคาร|kbank/i.test(l) || /\d{1,2}:\d{2}/.test(l)) continue;
        if (l.replace(/[^A-Za-zก-์]/g, '').length >= 3) { r.from_name = l; break; }
      }
    }
    r.to = null;
    if (accts.length) {
      const start = accts[0][0] + 1, col = xs[accts[0][0]], tol = 0.05 * width;
      for (let j = start; j < Math.min(start + 6, L.length); j++) {
        let l = L[j];
        if (Math.abs(xs[j] - col) > tol) {
          // a logo glued in front of the name: restart at the part that sits in the column
          const cut = segs[j].parts.findIndex(p => Math.abs(p[0] - col) <= tol);
          if (cut < 0) continue;
          l = norm(segs[j].parts.slice(cut).map(p => p[1]).join(' '));
        }
        const letters = l.replace(/[^A-Za-zก-์]/g, '');
        if (NOISE.test(l) || letters.length < 4 || (isLower(l) && l.length <= 4)) continue;
        if (ACCT.test(l) || /^(?=.*\d)[A-Z0-9]{8,}$/.test(l.replace(/ /g, ''))) continue;
        let name = l, nxt = '';
        for (let k = j + 1; k < Math.min(j + 3, L.length); k++) {
          if (Math.abs(xs[k] - col) <= tol) { nxt = L[k]; break; }
        }
        const open = (name.match(/\(/g) || []).length > (name.match(/\)/g) || []).length;
        if (open || /^(CO\.|LTD|จำกัด|\(?มหาชน)/i.test(nxt)) name += ' ' + nxt;
        r.to = name;
        break;
      }
    }
    return r;
  }

  /* Slip QR = EMVCo-style TLV: tag 00 holds a nested TLV whose tag 02 is the transaction ref. */
  function refFromQr(payload) {
    const tlv = s => {
      const out = {};
      let i = 0;
      while (i + 4 <= s.length) {
        const n = s.slice(i + 2, i + 4);
        if (!/^\d\d$/.test(n)) break;
        out[s.slice(i, i + 2)] = s.slice(i + 4, i + 4 + +n);
        i += 4 + +n;
      }
      return out;
    };
    try {
      const inner = tlv(tlv(payload || '')['00'] || '');
      return { ref: inner['02'] || null, bank: inner['01'] || null };
    } catch (e) { return { ref: null, bank: null }; }
  }

  const api = { parse, refFromQr, groupRows, parseDate, dateFromRef, norm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SlipParse = api;
})(typeof window !== 'undefined' ? window : globalThis);
