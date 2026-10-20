/**
 * My Log — Google Sheets sync backend (Apps Script web app).
 *
 * Setup:
 *  1. Create a Google Sheet, then Extensions > Apps Script, paste this file.
 *  2. Set TOKEN below to a long random secret (the same one you type in the app).
 *  3. Deploy > New deployment > Web app: Execute as "Me", Who has access "Anyone".
 *  4. Copy the Web app URL into the app (MY LOG > ตั้งค่า > ซิงค์กับ Google Sheets).
 *
 * The "docs" tab is the app's data — do not edit it by hand.
 * The "ลา" and "Timesheet" tabs are read-only views rebuilt on every sync;
 * edits there are not sent back to the app.
 */
const TOKEN = 'CHANGE_ME';

const DOCS_SHEET = 'docs';
const HEADER = ['path', 'json', 'updatedAt', 'deleted', 'serverAt'];
const PATH_RE = /^(leaves|timesheets|holidays|settings|fuel|places|vehicle|months)\/[A-Za-z0-9_\-.~:@+]{1,200}$/;
const MAX_DOCS_PER_CALL = 500;

function doGet() {
  return json_({ ok: true, app: 'mylog' });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad_json' }); }
  if (!TOKEN || TOKEN === 'CHANGE_ME' || !req || req.token !== TOKEN) return json_({ ok: false, error: 'unauthorized' });
  if (req.action !== 'sync') return json_({ ok: false, error: 'bad_action' });
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return json_({ ok: false, error: 'busy' });
  try {
    return json_(sync_(req));
  } finally {
    lock.releaseLock();
  }
}

function sync_(req) {
  const sh = docsSheet_();
  const values = sh.getDataRange().getValues();
  const rows = values.slice(1);
  const index = {};
  rows.forEach((r, i) => { if (r[0]) index[r[0]] = i; });
  const now = new Date().toISOString();
  const incoming = Array.isArray(req.docs) ? req.docs.slice(0, MAX_DOCS_PER_CALL) : [];
  let changed = false;
  incoming.forEach(d => {
    if (!d || typeof d.path !== 'string' || !PATH_RE.test(d.path)) return;
    const updatedAt = String(d.updatedAt || '');
    if (!/^\d{4}-\d{2}-\d{2}T/.test(updatedAt)) return;
    const deleted = !!d.deleted;
    const body = deleted ? '' : JSON.stringify(d.data || {});
    if (body.length > 45000) return;
    const row = [d.path, body, updatedAt, deleted, now];
    if (d.path in index) {
      const cur = rows[index[d.path]];
      if (String(cur[2]) > updatedAt) return; // newer copy already stored
      rows[index[d.path]] = row;
    } else {
      index[d.path] = rows.length;
      rows.push(row);
    }
    changed = true;
  });
  if (changed) {
    sh.getRange(2, 1, rows.length, HEADER.length).setNumberFormat('@').setValues(rows);
    rebuildViews_(rows);
  }
  const since = req.since ? String(req.since) : '';
  const out = rows
    .filter(r => r[0] && (!since || String(r[4]) > since))
    .map(r => ({ path: String(r[0]), data: r[3] === true || r[3] === 'TRUE' || r[1] === '' ? null : JSON.parse(r[1]), updatedAt: String(r[2]), deleted: r[3] === true || r[3] === 'TRUE' }));
  return { ok: true, serverTime: now, docs: out };
}

function docsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(DOCS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(DOCS_SHEET);
    sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

const TYPE_TH_ = { sick: 'ลาป่วย', personal: 'ลากิจ', vacation: 'ลาพักร้อน', unknown: 'ยังไม่ระบุ' };
const HALF_TH_ = { am: 'ครึ่งเช้า', pm: 'ครึ่งบ่าย' };

function rebuildViews_(rows) {
  const live = rows.filter(r => r[0] && !(r[3] === true || r[3] === 'TRUE') && r[1] !== '');
  const leaves = live.filter(r => String(r[0]).indexOf('leaves/') === 0).map(r => JSON.parse(r[1]))
    .filter(l => l.date).sort((a, b) => a.date < b.date ? -1 : 1)
    .map(l => [l.date, TYPE_TH_[l.type] || l.type, l.half ? (HALF_TH_[l.half] || l.half) : 'เต็มวัน', l.reason || '',
      yes_(l.docs && l.docs.form), yes_(l.docs && l.docs.cert), yes_(l.docs && l.docs.evidence)]);
  writeView_('ลา', ['วันที่', 'ประเภท', 'ระยะเวลา', 'เหตุผล', 'ใบลา', 'ใบรับรองแพทย์', 'หลักฐาน'], leaves);
  const ts = live.filter(r => String(r[0]).indexOf('timesheets/') === 0)
    .map(r => [String(r[0]).split('/')[1], JSON.parse(r[1])]).sort((a, b) => a[0] < b[0] ? -1 : 1)
    .map(([k, t]) => [k, yes_(t.signed), yes_(t.sent)]);
  writeView_('Timesheet', ['เดือน', 'หัวหน้าเซ็นแล้ว', 'ส่ง HR แล้ว'], ts);
}

function yes_(v) { return v ? 'ใช่' : '-'; }

function writeView_(name, header, data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.clearContents();
  const all = [header].concat(data);
  sh.getRange(1, 1, all.length, header.length).setNumberFormat('@').setValues(all);
  sh.getRange(1, 1, 1, header.length).setFontWeight('bold');
  sh.setFrozenRows(1);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
