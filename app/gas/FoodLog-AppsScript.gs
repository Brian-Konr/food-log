// ===== Schema.gs =====
/**
 * food-log：Sheet 結構。這個檔案同時被 Code.gs、Setup.gs 和本機測試使用。
 */
var SCHEMA = {
  Items:   ['id', 'ts', 'deleted', 'updated_at', 'kind', 'base_id', 'src', 'name', 'serving', 'serving_g', 'kcal', 'protein', 'fat', 'carb', 'fav', 'created_by'],
  Logs:    ['id', 'ts', 'deleted', 'updated_at', 'day', 'item_id', 'name', 'src', 'qty', 'grams', 'kcal', 'protein', 'fat', 'carb'],
  Weights: ['day', 'ts', 'deleted', 'updated_at', 'kg', 'id'],
  Config:  ['key', 'value', 'updated_at']
};

var LOG_TABLES = ['Logs'];
var KEY_COL = { Items: 'id', Logs: 'id', Weights: 'day', Config: 'key' };
var SRC_OK = ['7-11', '全家', '其他'];
var OFFSET = 8 * 3600 * 1000;

/** Config 預設值（與前端 src/data/defaults.ts 相同，測試會比對）。值都是字串。沒有 theme。 */
var DEFAULT_CONFIG = [
  ['target_kcal', '2000'],
  ['target_protein', '150'],
  ['target_fat', '60'],
  ['target_carb', '200'],
  ['tdee', ''],
  ['remind_meal_times', ''],
  ['remind_weight_time', ''],
  ['fav_ids', '']
];

// ===== Setup.gs =====
/**
 * 一次性初始化：在「綁定在試算表上的 Apps Script」裡執行 setupFoodLog()。
 * - 建立 4 個分頁與表頭（已存在就只補缺少的欄位，不會清資料）
 * - 寫入尚不存在的 Config 預設（不覆蓋已有）
 * - 不寫示範飲食或示範體重
 * - 沒有 SHARED_SECRET 就用兩個 uuid 去掉連字號產生，並 Logger.log 一次
 * 要重新產生密鑰請執行 rotateSharedSecret()。
 * 不要 Drive 資料夾、不要 PARTNER_EMAIL。
 */
function setupFoodLog() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SCHEMA).forEach(function (name) { ensureSheet_(ss, name, SCHEMA[name]); });

  var cfgSheet = ss.getSheetByName('Config');
  var have = {};
  cfgSheet.getDataRange().getValues().slice(1).forEach(function (r) { have[r[0]] = true; });
  var now = taipeiIso_(Date.now());
  DEFAULT_CONFIG.forEach(function (kv) {
    if (!have[kv[0]]) cfgSheet.appendRow([kv[0], kv[1], now]);
  });

  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SHARED_SECRET')) props.setProperty('SHARED_SECRET', newSecret_());

  var sheet1 = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (sheet1 && ss.getSheets().length > 1 && sheet1.getLastRow() === 0) ss.deleteSheet(sheet1);

  Logger.log('共享密鑰（請私下傳給自己和 Kazuha，第一次開 App 時輸入）：' + props.getProperty('SHARED_SECRET'));
}

function rotateSharedSecret() {
  var s = newSecret_();
  PropertiesService.getScriptProperties().setProperty('SHARED_SECRET', s);
  Logger.log('新的共享密鑰：' + s + '（舊密鑰立即失效，手機都要重新輸入）');
}

function newSecret_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function ensureSheet_(ss, name, cols) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  var header = header_(sh);
  if (header.length === 0) {
    sh.getRange(1, 1, 1, cols.length).setValues([cols]);
  } else {
    cols.forEach(function (c) {
      if (header.indexOf(c) < 0) { header.push(c); sh.getRange(1, header.length).setValue(c); }
    });
  }
  sh.setFrozenRows(1);
  return sh;
}

// ===== Code.gs =====
/**
 * food-log：Apps Script Web App 後端
 *
 * 部署：以「我」的身分執行、任何人可存取；網址公開，所以每個請求都要帶共享密鑰。
 * 密鑰存在 Script Properties 的 SHARED_SECRET（由 Setup.gs 產生），程式碼裡不放。
 *
 * 前端一律用 POST + Content-Type: text/plain（避免 CORS preflight），body 是 JSON：
 *   { secret, action, client?, ... }
 */
var API_VERSION = 1;
var LOCK_WAIT_MS = 10000;
var NUT_MSG = '紀錄必須有熱量、蛋白質、脂肪、碳水';
var KYU_MSG = 'Kyujin 只能寫入自建品項或體重';

function doPost(e) {
  return respond_(handle_(parseBody_(e)));
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!p.secret) return respond_({ ok: true, service: 'food-log', version: API_VERSION });
  return respond_(handle_({ secret: p.secret, action: 'read' }));
}

function parseBody_(e) {
  try {
    return JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return { __parseError: true };
  }
}

function handle_(req) {
  try {
    if (req.__parseError) return fail_('bad_json', '請求內容不是合法 JSON');
    if (!checkSecret_(req.secret)) return fail_('unauthorized', '共享密鑰不正確');
    var kyujin = req.client === 'kyujin';
    switch (req.action) {
      case 'read':          return readAll_(req.since);
      case 'append':        return withLock_(function () { return appendLog_(req.table, req.record, kyujin); });
      case 'update':        return withLock_(function () { return updateLog_(req.table, req.id, req.patch, kyujin); });
      case 'softDelete':    return withLock_(function () { return softDelete_(req.table, req.id, kyujin); });
      case 'restore':       return withLock_(function () { return restore_(req.table, req.id, kyujin); });
      case 'upsertItem':    return withLock_(function () { return upsertItem_(req.record, kyujin); });
      case 'upsertWeight':  return withLock_(function () { return upsertWeight_(req.record, kyujin); });
      case 'setConfig':     return withLock_(function () { return setConfig_(req.key, req.value, kyujin); });
      case 'history':       return history_(req);
      case 'summary':       return summary_(req.day);
      case 'trends':        return trendsAction_(req.weekStart);
      default:              return fail_('bad_action', '未知的 action：' + req.action);
    }
  } catch (err) {
    return fail_('server_error', String(err && err.message || err));
  }
}

function respond_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message) {
  return { ok: false, error: code, message: message };
}

function checkSecret_(given) {
  var expected = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
  if (!expected || typeof given !== 'string' || given.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return fail_('busy', '另一個人正在寫入，請再試一次');
  try {
    var result = fn();
    SpreadsheetApp.flush();
    return result;
  } finally {
    lock.releaseLock();
  }
}

function taipeiDay_(date) {
  var t;
  if (date instanceof Date) t = date.getTime();
  else t = Date.parse(date);
  return new Date(t + OFFSET).toISOString().slice(0, 10);
}

function taipeiIso_(ms) {
  return new Date(ms + OFFSET).toISOString().slice(0, 19) + '+08:00';
}

function taipeiToday_() {
  return taipeiDay_(new Date());
}

function nowIso_() {
  return taipeiIso_(Date.now());
}

function sheet_(table) {
  if (!SCHEMA[table]) throw new Error('未知的分頁：' + table);
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(table);
  if (!sh) throw new Error('找不到分頁 ' + table + '，請先執行 setupFoodLog()');
  return sh;
}

function rows_(table) {
  var sh = sheet_(table);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var header = values[0];
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var obj = { __row: r + 1 };
    for (var c = 0; c < header.length; c++) obj[header[c]] = normalizeCell_(values[r][c]);
    out.push(obj);
  }
  return out;
}

function normalizeCell_(v) {
  if (v instanceof Date) return taipeiIso_(v.getTime());
  return v;
}

function toCell_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return v;
}

function strip_(obj) {
  var copy = {};
  for (var k in obj) if (k !== '__row') copy[k] = obj[k];
  return copy;
}

function header_(sh) {
  var lastCol = sh.getLastColumn();
  var h = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  while (h.length && h[h.length - 1] === '') h.pop();
  return h;
}

function findById_(table, id) {
  var all = rows_(table);
  for (var i = 0; i < all.length; i++) if (String(all[i].id) === String(id)) return all[i];
  return null;
}

function isFiniteNonNegNumber_(v) {
  return typeof v === 'number' && isFinite(v) && v >= 0;
}

function nutritionOk_(rec) {
  return isFiniteNonNegNumber_(rec.kcal) && isFiniteNonNegNumber_(rec.protein) &&
    isFiniteNonNegNumber_(rec.fat) && isFiniteNonNegNumber_(rec.carb);
}

function srcOk_(src) {
  return SRC_OK.indexOf(src) >= 0;
}

function isDeleted_(r) {
  return r.deleted === true || r.deleted === 'TRUE';
}

function appendLog_(table, record, kyujin) {
  if (kyujin) return fail_('forbidden', KYU_MSG);
  if (table !== 'Logs') return fail_('bad_table', '這個分頁不能用 append：' + table);
  if (!record) return fail_('bad_record', '缺少 record');
  if (!record.id || !record.ts || !record.day || !record.item_id || !record.name || !record.src || record.qty == null) {
    return fail_('bad_record', '缺少必填欄位');
  }
  if (!nutritionOk_(record)) return fail_('bad_record', NUT_MSG);
  if (typeof record.qty !== 'number' || !isFinite(record.qty) || record.qty <= 0) return fail_('bad_record', 'qty 必須是大於 0 的數字');
  var grams = record.grams;
  if (!(grams === undefined || grams === null || grams === '' || (typeof grams === 'number' && isFinite(grams) && grams > 0))) {
    return fail_('bad_record', 'grams 格式不對');
  }
  if (!srcOk_(record.src)) return fail_('bad_record', 'src 只能是 7-11、全家或其他');
  var day = String(record.day);
  var tsDay = taipeiDay_(record.ts);
  if (day !== tsDay) return fail_('bad_record', 'day 必須等於台北日');
  if (day > taipeiToday_()) return fail_('bad_record', '不能記未來的日期');
  var existing = findById_('Logs', record.id);
  if (existing) return { ok: true, duplicate: true, record: strip_(existing) };
  var sh = sheet_('Logs');
  var now = nowIso_();
  var row = header_(sh).map(function (c) {
    if (c === 'deleted') return toCell_(!!record.deleted);
    if (c === 'updated_at') return now;
    return toCell_(record[c]);
  });
  sh.appendRow(row);
  return { ok: true, record: strip_(findById_('Logs', record.id)) };
}

function updateLog_(table, id, patch, kyujin) {
  if (kyujin) return fail_('forbidden', KYU_MSG);
  if (table !== 'Logs') return fail_('bad_table', '這個分頁不能用 update：' + table);
  var existing = findById_('Logs', id);
  if (!existing) return fail_('not_found', '找不到這筆紀錄：' + id);
  var merged = {};
  var k;
  for (k in existing) if (k !== '__row') merged[k] = existing[k];
  var allowed = { qty: 1, grams: 1, kcal: 1, protein: 1, fat: 1, carb: 1, ts: 1, day: 1, name: 1 };
  Object.keys(patch || {}).forEach(function (key) {
    if (allowed[key]) merged[key] = patch[key];
  });
  if (!nutritionOk_(merged)) return fail_('bad_record', NUT_MSG);
  if (String(merged.day) !== taipeiDay_(merged.ts)) return fail_('bad_record', 'day 必須等於台北日');
  if (String(merged.day) > taipeiToday_()) return fail_('bad_record', '不能記未來的日期');
  var sh = sheet_('Logs');
  var cols = header_(sh);
  var now = nowIso_();
  Object.keys(patch || {}).forEach(function (key) {
    if (key === 'id' || !allowed[key]) return;
    var c = cols.indexOf(key);
    if (c >= 0) sh.getRange(existing.__row, c + 1).setValue(toCell_(patch[key]));
  });
  var uc = cols.indexOf('updated_at');
  if (uc >= 0) sh.getRange(existing.__row, uc + 1).setValue(now);
  return { ok: true, record: strip_(findById_('Logs', id)) };
}

function softDelete_(table, id, kyujin) {
  if (table !== 'Logs' && table !== 'Weights' && table !== 'Items') return fail_('bad_table', table);
  if (kyujin) return fail_('forbidden', KYU_MSG);
  var existing = findById_(table, id);
  if (!existing) return fail_('not_found', '找不到這筆紀錄：' + id);
  var sh = sheet_(table);
  var cols = header_(sh);
  var now = nowIso_();
  sh.getRange(existing.__row, cols.indexOf('deleted') + 1).setValue('TRUE');
  var uc = cols.indexOf('updated_at');
  if (uc >= 0) sh.getRange(existing.__row, uc + 1).setValue(now);
  return { ok: true, record: strip_(findById_(table, id)) };
}

function restore_(table, id, kyujin) {
  if (table !== 'Logs' && table !== 'Weights' && table !== 'Items') return fail_('bad_table', table);
  if (kyujin) return fail_('forbidden', KYU_MSG);
  var existing = findById_(table, id);
  if (!existing) return fail_('not_found', '找不到這筆紀錄：' + id);
  if (table === 'Weights') {
    var day = String(existing.day).slice(0, 10);
    var all = rows_('Weights');
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === id) continue;
      if (String(all[i].day).slice(0, 10) === day && !isDeleted_(all[i])) {
        return fail_('bad_record', '這天已經有一筆體重');
      }
    }
  }
  var sh = sheet_(table);
  var cols = header_(sh);
  var now = nowIso_();
  sh.getRange(existing.__row, cols.indexOf('deleted') + 1).setValue('FALSE');
  var uc = cols.indexOf('updated_at');
  if (uc >= 0) sh.getRange(existing.__row, uc + 1).setValue(now);
  return { ok: true, record: strip_(findById_(table, id)) };
}

function upsertItem_(record, kyujin) {
  if (!record || !record.id) return fail_('bad_record', '缺少 id');
  var id = String(record.id);
  if (id.indexOf('fm:') === 0 || id.indexOf('711:') === 0) return fail_('forbidden', '不能改官方品項');
  if (id.indexOf('ov:') === 0) {
    if (kyujin) return fail_('forbidden', KYU_MSG);
    if (record.kind !== '補填') return fail_('bad_record', '補填的 kind 必須是補填');
    if (record.base_id !== id.slice(3)) return fail_('bad_record', 'base_id 必須等於官方 id');
    if (record.created_by !== 'app') return fail_('bad_record', '補填的 created_by 必須是 app');
  } else if (id.indexOf('u:') === 0) {
    if (record.kind !== '自建') return fail_('bad_record', '自建的 kind 必須是自建');
    if (record.base_id && String(record.base_id) !== '') return fail_('bad_record', '自建的 base_id 必須空白');
    if (kyujin) {
      if (record.created_by !== 'kyujin') return fail_('forbidden', KYU_MSG);
    }
  } else {
    return fail_('bad_record', 'id 格式不對');
  }
  if (typeof record.name !== 'string' || !record.name) return fail_('bad_record', 'name 不能空白');
  if (typeof record.serving !== 'string' || !record.serving) return fail_('bad_record', 'serving 不能空白');
  var sg = record.serving_g;
  if (!(sg === undefined || sg === null || sg === '' || (typeof sg === 'number' && isFinite(sg) && sg > 0))) {
    return fail_('bad_record', 'serving_g 格式不對');
  }
  if (!nutritionOk_(record)) return fail_('bad_record', NUT_MSG);
  if (!srcOk_(record.src)) return fail_('bad_record', 'src 只能是 7-11、全家或其他');
  if (typeof record.fav !== 'boolean') return fail_('bad_record', 'fav 必須是布林');
  var existing = findById_('Items', id);
  if (kyujin) {
    if (id.indexOf('u:') !== 0) return fail_('forbidden', KYU_MSG);
    if (existing && existing.created_by !== 'kyujin') return fail_('forbidden', KYU_MSG);
  }
  var createdBy = record.created_by;
  if (existing && existing.created_by === 'kyujin') createdBy = 'kyujin';
  var sh = sheet_('Items');
  var cols = header_(sh);
  var now = nowIso_();
  var toWrite = {};
  for (var k in record) toWrite[k] = record[k];
  toWrite.created_by = createdBy;
  toWrite.updated_at = now;
  if (!toWrite.ts) toWrite.ts = now;
  if (toWrite.deleted == null) toWrite.deleted = false;
  if (existing) {
    cols.forEach(function (c, i) {
      if (c in toWrite) sh.getRange(existing.__row, i + 1).setValue(toCell_(toWrite[c]));
    });
  } else {
    sh.appendRow(cols.map(function (c) { return toCell_(toWrite[c]); }));
  }
  return { ok: true, record: strip_(findById_('Items', id)) };
}

function upsertWeight_(record, _kyujin) {
  if (!record) return fail_('bad_record', '缺少 record');
  var kg = record.kg;
  if (typeof kg !== 'number' || !isFinite(kg) || kg < 30 || kg > 250) return fail_('bad_record', 'kg 必須在 30 到 250 之間');
  if (Math.round(kg * 10) / 10 !== kg) return fail_('bad_record', 'kg 最多一位小數');
  if (!record.ts || !record.day || !record.id) return fail_('bad_record', '缺少 id、ts 或 day');
  var day = String(record.day);
  if (day !== taipeiDay_(record.ts)) return fail_('bad_record', 'day 必須等於台北日');
  if (day > taipeiToday_()) return fail_('bad_record', '不能記未來的日期');
  var all = rows_('Weights');
  var i;
  for (i = 0; i < all.length; i++) {
    if (String(all[i].id) === String(record.id)) {
      return { ok: true, duplicate: true, record: strip_(all[i]) };
    }
  }
  var live = null;
  for (i = 0; i < all.length; i++) {
    if (String(all[i].day).slice(0, 10) === day && !isDeleted_(all[i])) { live = all[i]; break; }
  }
  var sh = sheet_('Weights');
  var cols = header_(sh);
  var now = nowIso_();
  if (live) {
    sh.getRange(live.__row, cols.indexOf('kg') + 1).setValue(kg);
    sh.getRange(live.__row, cols.indexOf('ts') + 1).setValue(toCell_(record.ts));
    sh.getRange(live.__row, cols.indexOf('updated_at') + 1).setValue(now);
    return { ok: true, overwritten: true, record: strip_(findById_('Weights', live.id)) };
  }
  var row = cols.map(function (c) {
    if (c === 'deleted') return 'FALSE';
    if (c === 'updated_at') return now;
    return toCell_(record[c]);
  });
  sh.appendRow(row);
  return { ok: true, record: strip_(findById_('Weights', record.id)) };
}

function allowedConfigKey_(key) {
  for (var i = 0; i < DEFAULT_CONFIG.length; i++) if (DEFAULT_CONFIG[i][0] === key) return true;
  return false;
}

function validHhmm_(s) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function setConfig_(key, value, kyujin) {
  if (kyujin) return fail_('forbidden', KYU_MSG);
  if (!allowedConfigKey_(key)) return fail_('bad_record', '不能寫這個設定');
  var v = value === undefined || value === null ? '' : String(value);
  if (key === 'tdee') {
    if (v !== '' && (!/^\d+$/.test(v) || Number(v) < 1200 || Number(v) > 5000)) {
      return fail_('bad_record', '每日消耗必須是 1200 到 5000 的整數');
    }
  }
  if (key === 'target_kcal') {
    if (!/^\d+$/.test(v) || Number(v) < 0) return fail_('bad_record', '熱量目標必須是 ≥ 0 的整數');
  }
  if (key === 'target_protein' || key === 'target_fat' || key === 'target_carb') {
    if (v === '' || Number(v) < 0 || !isFinite(Number(v))) return fail_('bad_record', '營養素目標必須 ≥ 0');
  }
  if (key === 'remind_meal_times') {
    if (v !== '') {
      var parts = v.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      for (var i = 0; i < parts.length; i++) if (!validHhmm_(parts[i])) return fail_('bad_record', '提醒時間格式不對');
    }
  }
  if (key === 'remind_weight_time') {
    if (v !== '' && !validHhmm_(v)) return fail_('bad_record', '提醒時間格式不對');
  }
  var sh = sheet_('Config');
  var cols = header_(sh);
  var now = nowIso_();
  var all = rows_('Config');
  var existing = null;
  for (var j = 0; j < all.length; j++) if (String(all[j].key) === String(key)) existing = all[j];
  if (existing) {
    sh.getRange(existing.__row, cols.indexOf('value') + 1).setValue(v);
    sh.getRange(existing.__row, cols.indexOf('updated_at') + 1).setValue(now);
  } else {
    sh.appendRow(cols.map(function (c) {
      if (c === 'key') return key;
      if (c === 'value') return v;
      if (c === 'updated_at') return now;
      return '';
    }));
  }
  return { ok: true };
}

function readConfig_() {
  var cfg = {};
  DEFAULT_CONFIG.forEach(function (kv) { cfg[kv[0]] = kv[1]; });
  rows_('Config').forEach(function (r) {
    if (r.key) cfg[r.key] = r.value === null || r.value === undefined ? '' : String(r.value);
  });
  return cfg;
}

function dayCutoff_(today) {
  return addDays_(today, -34);
}

function readAll_(since) {
  var today = taipeiToday_();
  var cutoff = dayCutoff_(today);
  var sinceDay = since ? String(since) : '';
  var items = rows_('Items').map(strip_);
  var logs = rows_('Logs').filter(function (r) {
    var day = String(r.day || '').slice(0, 10);
    if (day < cutoff) return false;
    if (sinceDay && String(r.updated_at || '') < sinceDay) return false;
    return true;
  }).map(strip_);
  var weights = rows_('Weights').filter(function (r) {
    var day = String(r.day || '').slice(0, 10);
    if (day < cutoff) return false;
    if (sinceDay && String(r.updated_at || '') < sinceDay) return false;
    return true;
  }).map(strip_);
  return {
    ok: true,
    version: API_VERSION,
    serverTime: nowIso_(),
    config: readConfig_(),
    items: items,
    logs: logs,
    weights: weights
  };
}

function history_(req) {
  var table = req.table;
  if (table !== 'Logs' && table !== 'Weights') return fail_('bad_table', table);
  var before = String(req.before || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(before)) return fail_('bad_record', 'before 必須是 YYYY-MM-DD');
  var limit = parseInt(req.limit, 10);
  if (!isFinite(limit) || limit <= 0) limit = 35;
  if (limit > 90) limit = 90;
  var all = rows_(table).filter(function (r) {
    return String(r.day || '').slice(0, 10) < before;
  }).map(strip_);
  all.sort(function (a, b) {
    return String(b.day).localeCompare(String(a.day));
  });
  var hasMore = all.length > limit;
  return { ok: true, table: table, records: all.slice(0, limit), hasMore: hasMore };
}

function summary_(day) {
  var d = String(day || taipeiToday_());
  var logs = rows_('Logs').filter(function (r) {
    return String(r.day || '').slice(0, 10) === d;
  });
  var totals = sumLogs_(logs);
  var cfg = readConfig_();
  var targets = {
    kcal: numCfg_(cfg, 'target_kcal', 0),
    protein: numCfg_(cfg, 'target_protein', 0),
    fat: numCfg_(cfg, 'target_fat', 0),
    carb: numCfg_(cfg, 'target_carb', 0)
  };
  return {
    ok: true,
    day: d,
    count: totals.count,
    totals: { kcal: totals.kcal, protein: totals.protein, fat: totals.fat, carb: totals.carb },
    targets: targets,
    remaining: {
      kcal: targets.kcal - totals.kcal,
      protein: targets.protein - totals.protein,
      fat: targets.fat - totals.fat,
      carb: targets.carb - totals.carb
    }
  };
}

function trendsAction_(weekStart) {
  var ws = String(weekStart || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ws) || weekStart_(ws) !== ws) return fail_('bad_record', 'weekStart 必須是週一');
  var logs = rows_('Logs').map(strip_);
  var cfg = readConfig_();
  var today = taipeiToday_();
  var summary = weekSummary_(logs, cfg, today, ws);
  summary.ok = true;
  return summary;
}

// ===== Trends.gs =====
// 改一邊的演算法必須改另一邊。兩個檔案頂端都寫這句。
var DAY_MS = 86400000;

function addDays_(day, days) {
  return new Date(Date.parse(day + 'T00:00:00Z') + days * DAY_MS).toISOString().slice(0, 10);
}

function weekStart_(day) {
  var d = new Date(Date.parse(day + 'T00:00:00Z'));
  var wd = d.getUTCDay();
  var back = wd === 0 ? 6 : wd - 1;
  return addDays_(day, -back);
}

function weekEnd_(monday) {
  return addDays_(monday, 6);
}

function isIncomplete_(count, kcal, targetKcal, day, today) {
  if (day >= today) return false;
  return count <= 1 || kcal < 0.5 * targetKcal;
}

function sumLogs_(logs) {
  var kcal = 0, proteinTenth = 0, fatTenth = 0, carbTenth = 0, count = 0;
  for (var i = 0; i < logs.length; i++) {
    var l = logs[i];
    if (l.deleted === true || l.deleted === 'TRUE') continue;
    count += 1;
    kcal += Number(l.kcal) || 0;
    proteinTenth += Math.round((Number(l.protein) || 0) * 10);
    fatTenth += Math.round((Number(l.fat) || 0) * 10);
    carbTenth += Math.round((Number(l.carb) || 0) * 10);
  }
  return { kcal: kcal, protein: proteinTenth / 10, fat: fatTenth / 10, carb: carbTenth / 10, count: count };
}

function totalsByDay_(logs) {
  var groups = {};
  for (var i = 0; i < logs.length; i++) {
    var l = logs[i];
    var day = String(l.day || '').slice(0, 10);
    if (!day) continue;
    if (!groups[day]) groups[day] = [];
    groups[day].push(l);
  }
  var out = {};
  Object.keys(groups).forEach(function (d) { out[d] = sumLogs_(groups[d]); });
  return out;
}

function emptyTotals_() {
  return { kcal: 0, protein: 0, fat: 0, carb: 0, count: 0 };
}

function numCfg_(config, key, d) {
  var v = config && config[key];
  if (v === '' || v == null) return d;
  var n = Number(v);
  return isFinite(n) ? n : d;
}

function weekSummary_(logs, config, today, weekMonday) {
  var targetKcal = numCfg_(config, 'target_kcal', 0);
  var targetProtein = numCfg_(config, 'target_protein', 0);
  var tdeeRaw = config && config.tdee != null ? String(config.tdee).trim() : '';
  var tdee = tdeeRaw === '' ? null : Number(tdeeRaw);
  var byDay = totalsByDay_(logs);
  var days = [];
  var i;
  for (i = 0; i < 7; i++) {
    var d = addDays_(weekMonday, i);
    if (d <= today) days.push(d);
  }
  var complete = [];
  var proteinHit = 0;
  var incompleteDays = 0;
  for (i = 0; i < days.length; i++) {
    var day = days[i];
    var t = byDay[day] || emptyTotals_();
    var inc = isIncomplete_(t.count, t.kcal, targetKcal, day, today);
    if (day < today && inc) incompleteDays += 1;
    if (day < today && !inc) complete.push(t.kcal);
    if (t.protein >= targetProtein) proteinHit += 1;
  }
  var avgKcal = null;
  if (complete.length) {
    var s = 0;
    for (i = 0; i < complete.length; i++) s += complete[i];
    avgKcal = Math.round(s / complete.length);
  }
  var avgDeficit = (tdee == null || !isFinite(tdee) || avgKcal == null) ? null : tdee - avgKcal;
  return {
    weekStart: weekMonday,
    weekEnd: weekEnd_(weekMonday),
    avgKcal: avgKcal,
    avgDeficit: avgDeficit,
    proteinHit: proteinHit,
    proteinDenom: days.length,
    incompleteDays: incompleteDays
  };
}

function latestKgByDay_(weights) {
  var best = {};
  for (var i = 0; i < weights.length; i++) {
    var w = weights[i];
    if (w.deleted === true || w.deleted === 'TRUE') continue;
    var day = String(w.day || '').slice(0, 10);
    var prev = best[day];
    if (!prev || String(w.updated_at) > String(prev.updated_at)) best[day] = w;
  }
  var out = {};
  Object.keys(best).forEach(function (d) { out[d] = Number(best[d].kg); });
  return out;
}

function avg7_(kgByDay, day) {
  var sum = 0, n = 0, i;
  for (i = 0; i <= 6; i++) {
    var kg = kgByDay[addDays_(day, i - 6)];
    if (kg != null) { sum += kg; n += 1; }
  }
  return n >= 3 ? sum / n : null;
}

function weightSeries_(logs, weights, config, today) {
  var targetKcal = numCfg_(config, 'target_kcal', 0);
  var tdeeRaw = config && config.tdee != null ? String(config.tdee).trim() : '';
  var tdee = tdeeRaw === '' ? null : Number(tdeeRaw);
  var kgByDay = latestKgByDay_(weights);
  var byDay = totalsByDay_(logs);
  var points = [];
  var avg7pts = [];
  var windowStart = addDays_(today, -28);
  var d;
  for (d = windowStart; d <= today; d = addDays_(d, 1)) {
    if (kgByDay[d] != null) points.push({ day: d, kg: kgByDay[d] });
    var a = avg7_(kgByDay, d);
    if (a != null) avg7pts.push({ day: d, kg: a });
  }
  var todayAvg = avg7_(kgByDay, today);
  var endDay = todayAvg != null ? today : null;
  var endAvg = todayAvg;
  if (endAvg == null) {
    for (d = addDays_(today, -1); d >= windowStart; d = addDays_(d, -1)) {
      var a2 = avg7_(kgByDay, d);
      if (a2 != null) { endDay = d; endAvg = a2; break; }
    }
  }
  var startDay = null, startAvg = null;
  for (d = windowStart; d <= today; d = addDays_(d, 1)) {
    var a3 = avg7_(kgByDay, d);
    if (a3 != null) { startDay = d; startAvg = a3; break; }
  }
  var deltaKg = (endAvg != null && startAvg != null) ? endAvg - startAvg : null;
  var expected = [];
  var expectedDeltaKg = null;
  if (tdee != null && isFinite(tdee) && startDay != null && startAvg != null) {
    expected.push({ day: startDay, kg: startAvg });
    var prev = startAvg;
    for (d = addDays_(startDay, 1); d < today; d = addDays_(d, 1)) {
      var t = byDay[d] || emptyTotals_();
      var inc = isIncomplete_(t.count, t.kcal, targetKcal, d, today);
      var deficit = inc ? tdee - targetKcal : tdee - t.kcal;
      prev = prev - deficit / 7700;
      expected.push({ day: d, kg: prev });
    }
    var lastExp = expected[expected.length - 1];
    expectedDeltaKg = lastExp ? lastExp.kg - startAvg : null;
  }
  return {
    points: points,
    avg7: avg7pts,
    expected: expected,
    startDay: startDay,
    startAvg: startAvg,
    endAvg: endAvg,
    endDay: endDay,
    deltaKg: deltaKg,
    expectedDeltaKg: expectedDeltaKg
  };
}
