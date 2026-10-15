// ===== Schema.gs =====
/**
 * food-log：Sheet 結構。這個檔案同時被 Code.gs、Setup.gs 和本機測試使用。
 */
var SCHEMA = {
  Items:   ['id', 'ts', 'deleted', 'updated_at', 'kind', 'base_id', 'src', 'name', 'serving', 'serving_g', 'kcal', 'protein', 'fat', 'carb', 'fav', 'created_by', 'store'],
  Logs:    ['id', 'ts', 'deleted', 'updated_at', 'day', 'item_id', 'name', 'src', 'qty', 'grams', 'kcal', 'protein', 'fat', 'carb', 'source', 'store'],
  Weights: ['day', 'ts', 'deleted', 'updated_at', 'kg', 'id'],
  Stores:  ['id', 'ts', 'deleted', 'updated_at', 'name', 'last_eaten_at', 'created_by'],
  Config:  ['key', 'value', 'updated_at']
};

var TEXT_COLS = {
  Items:   ['id', 'ts', 'updated_at', 'kind', 'base_id', 'src', 'name', 'serving', 'created_by', 'store'],
  Logs:    ['id', 'ts', 'updated_at', 'day', 'item_id', 'name', 'src', 'source', 'store'],
  Stores:  ['id', 'ts', 'updated_at', 'name', 'last_eaten_at', 'created_by'],
  Weights: ['day', 'ts', 'updated_at', 'id']
};

/** ScriptProperties：文字欄遷移已跑過。不要放進 Config，也不要改 SCHEMA_VERSION。 */
var TEXT_COLS_FLAG_KEY = 'text_cols_version';
var TEXT_COLS_FLAG = '1';

var LOG_TABLES = ['Logs'];
var KEY_COL = { Items: 'id', Logs: 'id', Weights: 'day', Stores: 'id', Config: 'key' };
var SRC_OK = ['7-11', '全家', '其他'];
var OFFSET = 8 * 3600 * 1000;
/** 寫在 Config 的 schema_version。第一次請求 migrate 完就寫入，之後跳過。不要放進 DEFAULT_CONFIG。 */
var SCHEMA_VERSION = 2;
var SCHEMA_VERSION_KEY = 'schema_version';

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
 * - 建立分頁與表頭（已存在就只補缺少的欄位，不會清資料）
 * - 寫入尚不存在的 Config 預設（不覆蓋已有）
 * - 不寫示範飲食或示範體重
 * - 沒有 SHARED_SECRET 就用兩個 uuid 去掉連字號產生，並 Logger.log 一次
 * 要重新產生密鑰請執行 rotateSharedSecret()。
 * 舊表升級請執行 migrateFoodLog()（只補分頁與欄，不碰密鑰、不補 Config）。
 * 不要 Drive 資料夾、不要 PARTNER_EMAIL。
 */
function setupFoodLog() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureFoodLogSheets_(ss);

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

function migrateFoodLog() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var report = ensureFoodLogSheets_(ss);
  report.textFixes = migrateTextColumns_(ss);
  writeSchemaVersion_();
  PropertiesService.getScriptProperties().setProperty(TEXT_COLS_FLAG_KEY, TEXT_COLS_FLAG);
  Logger.log(JSON.stringify(report));
  return report;
}

function readSchemaVersion_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Config');
  if (!sh) return '';
  var all = sh.getDataRange().getValues();
  if (!all.length) return '';
  var header = all[0];
  var keyIdx = header.indexOf('key');
  var valIdx = header.indexOf('value');
  if (keyIdx < 0 || valIdx < 0) return '';
  for (var i = 1; i < all.length; i++) {
    if (String(all[i][keyIdx]) === SCHEMA_VERSION_KEY) return configValueToString_(all[i][valIdx]);
  }
  return '';
}

function writeSchemaVersion_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Config');
  if (!sh) return;
  var cols = header_(sh);
  var keyIdx = cols.indexOf('key');
  var valIdx = cols.indexOf('value');
  var tsIdx = cols.indexOf('updated_at');
  if (keyIdx < 0 || valIdx < 0) return;
  var now = nowIso_();
  var v = String(SCHEMA_VERSION);
  var all = sh.getDataRange().getValues();
  for (var r = 1; r < all.length; r++) {
    if (String(all[r][keyIdx]) === SCHEMA_VERSION_KEY) {
      sh.getRange(r + 1, valIdx + 1).setNumberFormat('@').setValue(v);
      if (tsIdx >= 0) sh.getRange(r + 1, tsIdx + 1).setValue(now);
      return;
    }
  }
  var row = cols.map(function (c) {
    if (c === 'key') return SCHEMA_VERSION_KEY;
    if (c === 'value') return v;
    if (c === 'updated_at') return now;
    return '';
  });
  sh.appendRow(row);
  sh.getRange(sh.getLastRow(), valIdx + 1).setNumberFormat('@').setValue(v);
}

function rotateSharedSecret() {
  var s = newSecret_();
  PropertiesService.getScriptProperties().setProperty('SHARED_SECRET', s);
  Logger.log('新的共享密鑰：' + s + '（舊密鑰立即失效，手機都要重新輸入）');
}

function newSecret_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function formatColText_(sh, col) {
  var n = sh.getMaxRows();
  if (!n || n < 1) n = 1;
  sh.getRange(1, col, n, 1).setNumberFormat('@');
}

function migrateTextColumns_(ss) {
  var names = ['Items', 'Logs', 'Stores', 'Weights'];
  var counts = { Items: 0, Logs: 0, Stores: 0, Weights: 0 };
  var t;
  for (t = 0; t < names.length; t++) {
    var name = names[t];
    var sh = ss.getSheetByName(name);
    if (!sh) continue;
    var header = header_(sh);
    if (!header.length) continue;
    var textList = TEXT_COLS[name] || [];
    var i;
    for (i = 0; i < textList.length; i++) {
      var idx = header.indexOf(textList[i]);
      if (idx >= 0) formatColText_(sh, idx + 1);
    }
    var values = sh.getDataRange().getValues();
    var r, c;
    for (r = 1; r < values.length; r++) {
      for (c = 0; c < header.length; c++) {
        var col = String(header[c] || '');
        var v = values[r][c];
        var rowIndex = r + 1;
        var colIndex = c + 1;
        if (col === 'day') {
          if (isDate_(v)) {
            writeCell_(sh, rowIndex, colIndex, 'day', taipeiDay_(v));
            counts[name]++;
          } else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
            writeCell_(sh, rowIndex, colIndex, 'day', v.slice(0, 10));
            counts[name]++;
          }
        } else if (col === 'src') {
          if (isDate_(v) && taipeiDay_(v).slice(5, 10) === '07-11') {
            writeCell_(sh, rowIndex, colIndex, 'src', '7-11');
            counts[name]++;
          } else if (typeof v === 'string' && /^\d{4}-07-11(?:$|T)/.test(v)) {
            writeCell_(sh, rowIndex, colIndex, 'src', '7-11');
            counts[name]++;
          }
        }
      }
    }
  }
  Logger.log('migrateTextColumns_ ' + JSON.stringify(counts));
  return counts;
}

function ensureFoodLogSheets_(ss) {
  var created = [];
  var addedColumns = { Items: [], Logs: [], Stores: [] };
  Object.keys(SCHEMA).forEach(function (name) {
    var cols = SCHEMA[name];
    var existed = !!ss.getSheetByName(name);
    var sh = existed ? ss.getSheetByName(name) : ss.insertSheet(name);
    if (!existed) created.push(name);
    var header = header_(sh);
    var added = [];
    if (header.length === 0) {
      sh.getRange(1, 1, 1, cols.length).setValues([cols]);
      header = cols.slice();
    } else {
      cols.forEach(function (c) {
        if (header.indexOf(c) < 0) {
          header.push(c);
          sh.getRange(1, header.length).setValue(c);
          added.push(c);
        }
      });
    }
    var textList = TEXT_COLS[name] || [];
    var i;
    for (i = 0; i < textList.length; i++) {
      var idx = header.indexOf(textList[i]);
      if (idx >= 0) formatColText_(sh, idx + 1);
    }
    if (name === 'Items' || name === 'Logs' || name === 'Stores') addedColumns[name] = added;
    sh.setFrozenRows(1);
  });
  return { created: created, addedColumns: addedColumns };
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
  if (!p.secret) {
    var schemaErr = ensureSchema_();
    var text = { textFixes: 0, version: PropertiesService.getScriptProperties().getProperty(TEXT_COLS_FLAG_KEY) || '' };
    if (!schemaErr) text = ensureTextCols_();
    return respond_({
      ok: true,
      service: 'food-log',
      version: API_VERSION,
      migration: { textFixes: text.textFixes, version: text.version }
    });
  }
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
    var schemaErr = ensureSchema_();
    if (schemaErr) return schemaErr;
    ensureTextCols_();
    var kyujin = req.client === 'kyujin';
    switch (req.action) {
      case 'read':          return readAll_(req.since);
      case 'append':        return withLock_(function () { return appendLog_(req.table, req.record, kyujin); });
      case 'update':        return withLock_(function () { return updateLog_(req.table, req.id, req.patch, kyujin); });
      case 'softDelete':    return withLock_(function () { return softDelete_(req.table, req.id, kyujin); });
      case 'restore':       return withLock_(function () { return restore_(req.table, req.id, kyujin); });
      case 'upsertItem':    return withLock_(function () { return upsertItem_(req.record, kyujin); });
      case 'upsertStore':   return withLock_(function () { return upsertStore_(req.record, kyujin); });
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
    for (var c = 0; c < header.length; c++) obj[header[c]] = normalizeCell_(values[r][c], String(header[c] || ''));
    out.push(obj);
  }
  return out;
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

function normalizeCell_(v, col) {
  col = col || '';
  if (col === 'src') {
    if (isDate_(v)) return taipeiDay_(v).slice(5, 10) === '07-11' ? '7-11' : taipeiIso_(v.getTime());
    if (typeof v === 'string' && /^\d{4}-07-11(?:$|T)/.test(v)) return '7-11';
    return v;
  }
  if (col === 'day') {
    if (isDate_(v)) return taipeiDay_(v);
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
    return v;
  }
  if ((col === 'ts' || col === 'updated_at' || col === 'last_eaten_at') && isDate_(v)) {
    return taipeiIso_(v.getTime());
  }
  if (isDate_(v)) return taipeiIso_(v.getTime());
  return v;
}

function toCell_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return v;
}

function isTextCol_(table, col) {
  var list = TEXT_COLS[table] || [];
  return list.indexOf(col) >= 0;
}

/** 先把文字欄設成 @，再 setValues。不要對整列 setNumberFormat('@')，否則 kcal 會變成文字，nutritionOk_ 的 typeof number 會失敗。 */
function writeRow_(sh, rowIndex, cols, values) {
  var table = sh.getName();
  var i;
  for (i = 0; i < cols.length; i++) {
    if (isTextCol_(table, cols[i])) sh.getRange(rowIndex, i + 1).setNumberFormat('@');
  }
  sh.getRange(rowIndex, 1, 1, cols.length).setValues([values]);
}

function writeCell_(sh, rowIndex, colIndex, colName, value) {
  var range = sh.getRange(rowIndex, colIndex);
  if (isTextCol_(sh.getName(), colName)) range.setNumberFormat('@');
  range.setValue(value);
}

function textFixesTotal_(counts) {
  return (counts.Items || 0) + (counts.Logs || 0) + (counts.Stores || 0) + (counts.Weights || 0);
}

/**
 * 文字欄遷移：ScriptProperties 旗標 + Lock，只跑一次。函式本身冪等。
 * 已跑過就回 textFixes: 0。拿不到鎖且尚未跑過時回目前旗標（可能是空字串）與 0，下次請求再試。
 */
function ensureTextCols_() {
  var props = PropertiesService.getScriptProperties();
  var cur = props.getProperty(TEXT_COLS_FLAG_KEY) || '';
  if (cur === TEXT_COLS_FLAG) return { textFixes: 0, version: TEXT_COLS_FLAG };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return { textFixes: 0, version: cur };
  try {
    cur = props.getProperty(TEXT_COLS_FLAG_KEY) || '';
    if (cur === TEXT_COLS_FLAG) return { textFixes: 0, version: TEXT_COLS_FLAG };
    var counts = migrateTextColumns_(SpreadsheetApp.getActiveSpreadsheet());
    props.setProperty(TEXT_COLS_FLAG_KEY, TEXT_COLS_FLAG);
    SpreadsheetApp.flush();
    return { textFixes: textFixesTotal_(counts), version: TEXT_COLS_FLAG };
  } finally {
    lock.releaseLock();
  }
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

function assertSchema_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var stores = ss.getSheetByName('Stores');
  var items = ss.getSheetByName('Items');
  var logs = ss.getSheetByName('Logs');
  if (!stores || !items || !logs) return fail_('schema_outdated', '資料表結構不完整，請在編輯器執行 migrateFoodLog');
  var ih = header_(items);
  var lh = header_(logs);
  if (ih.indexOf('store') < 0 || lh.indexOf('source') < 0 || lh.indexOf('store') < 0) {
    return fail_('schema_outdated', '資料表結構不完整，請在編輯器執行 migrateFoodLog');
  }
  return null;
}

/**
 * 第一次收到請求時在 LockService 裡自動 migrate（編輯器的 migrateFoodLog 仍可用）。
 * Config.schema_version 已是 SCHEMA_VERSION 就跳過。migrate 之前不回 schema_outdated。
 * 只新增 Stores、往最後加欄，不改舊儲存格。
 */
function ensureSchema_() {
  if (readSchemaVersion_() === String(SCHEMA_VERSION)) return null;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return fail_('busy', '後端正在更新資料表，請再試一次');
  try {
    if (readSchemaVersion_() !== String(SCHEMA_VERSION)) {
      ensureFoodLogSheets_(SpreadsheetApp.getActiveSpreadsheet());
      writeSchemaVersion_();
      SpreadsheetApp.flush();
    }
  } finally {
    lock.releaseLock();
  }
  return assertSchema_();
}

function normName_(s) {
  return String(s).normalize('NFKC').toLowerCase().replace(/[\s\-·・（）()【】[\]、，。．/／]/g, '');
}

function logSourceOf_(v) {
  return v === 'quick' || v === 'kyujin' ? v : 'app';
}

function bumpLastEaten_(storeId, ts) {
  if (!storeId) return;
  var store = findById_('Stores', storeId);
  if (!store) return;
  var prev = String(store.last_eaten_at || '');
  var next = String(ts || '');
  if (prev && prev >= next) return;
  var sh = sheet_('Stores');
  var c = header_(sh).indexOf('last_eaten_at');
  if (c >= 0) writeCell_(sh, store.__row, c + 1, 'last_eaten_at', toCell_(next));
}

function resolveLogSource_(record, kyujin) {
  var source = record.source;
  if (kyujin) {
    if (source !== 'kyujin') return fail_('forbidden', KYU_MSG);
    return source;
  }
  if (source === 'kyujin') return fail_('bad_record', '不能寫 kyujin 的 source');
  if (!source || source === '') return 'app';
  if (source !== 'app' && source !== 'quick') return fail_('bad_record', 'source 只能是 app、quick 或 kyujin');
  return source;
}

function appendLog_(table, record, kyujin) {
  if (table !== 'Logs') return fail_('bad_table', '這個分頁不能用 append：' + table);
  if (!record) return fail_('bad_record', '缺少 record');
  if (!record.id || !record.ts || !record.day || !record.src || record.qty == null) {
    return fail_('bad_record', '缺少必填欄位');
  }
  var sourceOrErr = resolveLogSource_(record, kyujin);
  if (sourceOrErr && sourceOrErr.ok === false) return sourceOrErr;
  var source = sourceOrErr;
  var itemId = record.item_id == null ? '' : String(record.item_id);
  var name = String(record.name == null ? '' : record.name).trim();
  var storeId = record.store == null ? '' : String(record.store);
  if (itemId === '') {
    if (!nutritionOk_(record)) return fail_('bad_record', NUT_MSG);
    if (record.qty !== 1) return fail_('bad_record', 'qty 必須是大於 0 的數字');
    var qg = record.grams;
    if (!(qg === undefined || qg === null || qg === '')) return fail_('bad_record', 'grams 格式不對');
    if (record.src !== '其他') return fail_('bad_record', 'src 只能是 7-11、全家或其他');
    if (storeId) return fail_('bad_record', '找不到這家店');
  } else {
    if (!name) return fail_('bad_record', '缺少必填欄位');
    if (!nutritionOk_(record)) return fail_('bad_record', NUT_MSG);
    if (typeof record.qty !== 'number' || !isFinite(record.qty) || record.qty <= 0) return fail_('bad_record', 'qty 必須是大於 0 的數字');
    var grams = record.grams;
    if (!(grams === undefined || grams === null || grams === '' || (typeof grams === 'number' && isFinite(grams) && grams > 0))) {
      return fail_('bad_record', 'grams 格式不對');
    }
    if (!srcOk_(record.src)) return fail_('bad_record', 'src 只能是 7-11、全家或其他');
  }
  var day = String(record.day);
  var tsDay = taipeiDay_(record.ts);
  if (day !== tsDay) return fail_('bad_record', 'day 必須等於台北日');
  if (day > taipeiToday_()) return fail_('bad_record', '不能記未來的日期');
  if (storeId) {
    var st = findById_('Stores', storeId);
    if (!st) return fail_('bad_record', '找不到這家店');
  }
  var existing = findById_('Logs', record.id);
  if (existing) return { ok: true, duplicate: true, record: strip_(existing) };
  var sh = sheet_('Logs');
  var now = nowIso_();
  var toWrite = {};
  for (var k in record) toWrite[k] = record[k];
  toWrite.item_id = itemId;
  toWrite.name = name;
  toWrite.source = source;
  toWrite.store = storeId;
  var cols = header_(sh);
  var row = cols.map(function (c) {
    if (c === 'deleted') return toCell_(!!record.deleted);
    if (c === 'updated_at') return now;
    return toCell_(toWrite[c]);
  });
  writeRow_(sh, sh.getLastRow() + 1, cols, row);
  if (storeId) bumpLastEaten_(storeId, record.ts);
  return { ok: true, record: strip_(findById_('Logs', record.id)) };
}

function updateLog_(table, id, patch, kyujin) {
  if (table !== 'Logs') return fail_('bad_table', '這個分頁不能用 update：' + table);
  var existing = findById_('Logs', id);
  if (kyujin) {
    if (!existing || logSourceOf_(existing.source) !== 'kyujin') return fail_('forbidden', KYU_MSG);
  }
  if (!existing) return fail_('not_found', '找不到這筆紀錄：' + id);
  if (isDeleted_(existing)) return { ok: true, ignored: 'deleted' };
  if (patch && patch.source != null && logSourceOf_(patch.source) !== logSourceOf_(existing.source)) {
    return fail_('bad_record', '不能改 source');
  }
  var merged = {};
  var k;
  for (k in existing) if (k !== '__row') merged[k] = existing[k];
  var allowed = { qty: 1, grams: 1, kcal: 1, protein: 1, fat: 1, carb: 1, ts: 1, day: 1, name: 1 };
  Object.keys(patch || {}).forEach(function (key) {
    if (allowed[key]) merged[key] = patch[key];
  });
  if (merged.name == null) merged.name = '';
  else merged.name = String(merged.name).trim();
  var origSource = logSourceOf_(existing.source);
  var itemId = String(merged.item_id || '');
  if (itemId === '' || origSource === 'quick') {
    if (merged.qty !== 1) return fail_('bad_record', 'qty 必須是大於 0 的數字');
    var qg = merged.grams;
    if (!(qg === undefined || qg === null || qg === '')) return fail_('bad_record', 'grams 格式不對');
  }
  if (!nutritionOk_(merged)) return fail_('bad_record', NUT_MSG);
  if (String(merged.day) !== taipeiDay_(merged.ts)) return fail_('bad_record', 'day 必須等於台北日');
  if (String(merged.day) > taipeiToday_()) return fail_('bad_record', '不能記未來的日期');
  var sh = sheet_('Logs');
  var cols = header_(sh);
  var now = nowIso_();
  Object.keys(patch || {}).forEach(function (key) {
    if (key === 'id' || !allowed[key]) return;
    var c = cols.indexOf(key);
    if (c >= 0) writeCell_(sh, existing.__row, c + 1, key, toCell_(patch[key]));
  });
  var uc = cols.indexOf('updated_at');
  if (uc >= 0) writeCell_(sh, existing.__row, uc + 1, 'updated_at', now);
  return { ok: true, record: strip_(findById_('Logs', id)) };
}

function softDelete_(table, id, kyujin) {
  if (table !== 'Logs' && table !== 'Weights' && table !== 'Items' && table !== 'Stores') return fail_('bad_table', table);
  if (table === 'Stores' && kyujin) return fail_('forbidden', KYU_MSG);
  if ((table === 'Weights' || table === 'Items') && kyujin) return fail_('forbidden', KYU_MSG);
  var existing = findById_(table, id);
  if (table === 'Logs' && kyujin) {
    if (!existing || logSourceOf_(existing.source) !== 'kyujin') return fail_('forbidden', KYU_MSG);
  } else if (kyujin) {
    return fail_('forbidden', KYU_MSG);
  }
  // App，或已通過檢查的 Kyujin Logs：不存在、已刪除都當成功，不寫儲存格。
  if (!existing || isDeleted_(existing)) return { ok: true };
  var sh = sheet_(table);
  var cols = header_(sh);
  var now = nowIso_();
  sh.getRange(existing.__row, cols.indexOf('deleted') + 1).setValue('TRUE');
  var uc = cols.indexOf('updated_at');
  if (uc >= 0) writeCell_(sh, existing.__row, uc + 1, 'updated_at', now);
  if (table === 'Stores') {
    var items = rows_('Items');
    var itemSh = sheet_('Items');
    var itemCols = header_(itemSh);
    var idel = itemCols.indexOf('deleted');
    var iuc = itemCols.indexOf('updated_at');
    for (var i = 0; i < items.length; i++) {
      if (String(items[i].store || '') !== String(id)) continue;
      if (isDeleted_(items[i])) continue;
      if (idel >= 0) itemSh.getRange(items[i].__row, idel + 1).setValue('TRUE');
      if (iuc >= 0) writeCell_(itemSh, items[i].__row, iuc + 1, 'updated_at', now);
    }
  }
  return { ok: true, record: strip_(findById_(table, id)) };
}

function restore_(table, id, kyujin) {
  if (table !== 'Logs' && table !== 'Weights' && table !== 'Items' && table !== 'Stores') return fail_('bad_table', table);
  if (table === 'Stores' && kyujin) return fail_('forbidden', KYU_MSG);
  if ((table === 'Weights' || table === 'Items') && kyujin) return fail_('forbidden', KYU_MSG);
  var existing = findById_(table, id);
  if (table === 'Logs' && kyujin) {
    if (!existing || logSourceOf_(existing.source) !== 'kyujin') return fail_('forbidden', KYU_MSG);
  } else if (kyujin) {
    return fail_('forbidden', KYU_MSG);
  }
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
  var oldUpdated = existing.updated_at;
  var sh = sheet_(table);
  var cols = header_(sh);
  var now = nowIso_();
  sh.getRange(existing.__row, cols.indexOf('deleted') + 1).setValue('FALSE');
  var uc = cols.indexOf('updated_at');
  if (uc >= 0) writeCell_(sh, existing.__row, uc + 1, 'updated_at', now);
  if (table === 'Stores') {
    var items = rows_('Items');
    var itemSh = sheet_('Items');
    var itemCols = header_(itemSh);
    var idel = itemCols.indexOf('deleted');
    var iuc = itemCols.indexOf('updated_at');
    for (var j = 0; j < items.length; j++) {
      if (String(items[j].store || '') !== String(id)) continue;
      if (!isDeleted_(items[j])) continue;
      if (String(items[j].updated_at) !== String(oldUpdated)) continue;
      if (idel >= 0) itemSh.getRange(items[j].__row, idel + 1).setValue('FALSE');
      if (iuc >= 0) writeCell_(itemSh, items[j].__row, iuc + 1, 'updated_at', now);
    }
  }
  return { ok: true, record: strip_(findById_(table, id)) };
}

function upsertItem_(record, kyujin) {
  if (!record || !record.id) return fail_('bad_record', '缺少 id');
  var id = String(record.id);
  var storeId = record.store == null ? '' : String(record.store);
  if (id.indexOf('fm:') === 0 || id.indexOf('711:') === 0) return fail_('forbidden', '不能改官方品項');
  if (id.indexOf('ov:') === 0) {
    if (kyujin) return fail_('forbidden', KYU_MSG);
    if (record.kind !== '補填') return fail_('bad_record', '補填的 kind 必須是補填');
    if (record.base_id !== id.slice(3)) return fail_('bad_record', 'base_id 必須等於官方 id');
    if (record.created_by !== 'app') return fail_('bad_record', '補填的 created_by 必須是 app');
  } else if (id.indexOf('u:') === 0) {
    if (record.kind !== '自建') return fail_('bad_record', '自建的 kind 必須是自建');
    if (record.base_id && String(record.base_id) !== '') return fail_('bad_record', '自建的 base_id 必須空白');
    if (storeId) {
      if (record.src !== '其他') return fail_('bad_record', 'src 只能是 7-11、全家或其他');
      var storeRow = findById_('Stores', storeId);
      if (!storeRow || isDeleted_(storeRow)) return fail_('bad_record', '找不到這家店');
    }
    if (kyujin && !storeId && record.created_by !== 'kyujin') return fail_('forbidden', KYU_MSG);
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
  if (existing && isDeleted_(existing)) return { ok: true, ignored: 'deleted' };
  var existStore = existing ? String(existing.store || '') : '';
  var isStoreItem = !!(storeId || existStore);
  if (kyujin) {
    if (id.indexOf('u:') !== 0) return fail_('forbidden', KYU_MSG);
    if (!isStoreItem && existing && existing.created_by !== 'kyujin') return fail_('forbidden', KYU_MSG);
  }
  var createdBy = record.created_by;
  if (existing) createdBy = existing.created_by;
  var sh = sheet_('Items');
  var cols = header_(sh);
  var now = nowIso_();
  var toWrite = {};
  for (var k in record) toWrite[k] = record[k];
  toWrite.created_by = createdBy;
  toWrite.store = storeId || existStore;
  toWrite.updated_at = now;
  if (!toWrite.ts) toWrite.ts = now;
  if (toWrite.deleted == null) toWrite.deleted = false;
  if (existing) {
    cols.forEach(function (c, i) {
      if (c in toWrite) writeCell_(sh, existing.__row, i + 1, c, toCell_(toWrite[c]));
    });
  } else {
    writeRow_(sh, sh.getLastRow() + 1, cols, cols.map(function (c) { return toCell_(toWrite[c]); }));
  }
  return { ok: true, record: strip_(findById_('Items', id)) };
}

function upsertStore_(record, kyujin) {
  if (!record || !record.id) return fail_('bad_record', '缺少 id');
  var id = String(record.id);
  if (id.indexOf('s:') !== 0) return fail_('bad_record', 'id 格式不對');
  var existing = findById_('Stores', id);
  if (existing && isDeleted_(existing)) return { ok: true, ignored: 'deleted' };
  var name = String(record.name == null ? '' : record.name).trim();
  if (!name) return fail_('bad_record', '店名不能空白');
  var all = rows_('Stores');
  var i;
  for (i = 0; i < all.length; i++) {
    if (isDeleted_(all[i])) continue;
    if (String(all[i].id) === id) continue;
    if (normName_(all[i].name) === normName_(name)) {
      return {
        ok: false,
        error: 'duplicate_name',
        message: '已經有「' + all[i].name + '」',
        existingId: all[i].id,
        existingName: all[i].name
      };
    }
  }
  var createdBy;
  if (existing) {
    createdBy = existing.created_by;
  } else if (kyujin) {
    if (record.created_by !== 'kyujin') return fail_('forbidden', KYU_MSG);
    createdBy = 'kyujin';
  } else {
    createdBy = 'app';
  }
  var sh = sheet_('Stores');
  var cols = header_(sh);
  var now = nowIso_();
  var toWrite = {};
  for (var k in record) toWrite[k] = record[k];
  toWrite.name = name;
  toWrite.created_by = createdBy;
  toWrite.updated_at = now;
  if (!toWrite.ts) toWrite.ts = now;
  if (toWrite.deleted == null) toWrite.deleted = false;
  if (toWrite.last_eaten_at == null) toWrite.last_eaten_at = existing ? existing.last_eaten_at : '';
  if (existing) {
    cols.forEach(function (c, i) {
      if (c === 'last_eaten_at' && !('last_eaten_at' in record)) return;
      if (c in toWrite) writeCell_(sh, existing.__row, i + 1, c, toCell_(toWrite[c]));
    });
  } else {
    writeRow_(sh, sh.getLastRow() + 1, cols, cols.map(function (c) { return toCell_(toWrite[c]); }));
  }
  return { ok: true, record: strip_(findById_('Stores', id)) };
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
    writeCell_(sh, live.__row, cols.indexOf('ts') + 1, 'ts', toCell_(record.ts));
    writeCell_(sh, live.__row, cols.indexOf('updated_at') + 1, 'updated_at', now);
    return { ok: true, overwritten: true, record: strip_(findById_('Weights', live.id)) };
  }
  var row = cols.map(function (c) {
    if (c === 'deleted') return 'FALSE';
    if (c === 'updated_at') return now;
    return toCell_(record[c]);
  });
  writeRow_(sh, sh.getLastRow() + 1, cols, row);
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
    sh.getRange(existing.__row, cols.indexOf('value') + 1).setNumberFormat('@').setValue(v);
    sh.getRange(existing.__row, cols.indexOf('updated_at') + 1).setValue(now);
  } else {
    sh.appendRow(cols.map(function (c) {
      if (c === 'key') return key;
      if (c === 'value') return v;
      if (c === 'updated_at') return now;
      return '';
    }));
    sh.getRange(sh.getLastRow(), cols.indexOf('value') + 1).setNumberFormat('@').setValue(v);
  }
  return { ok: true };
}

// 試算表會把「12:30」自動轉成時間（Date），讀回來變成「Sat Dec 30 1899 …」，前端就顯示空白。
// 寫入時把儲存格設成純文字；讀的時候若已經是 Date（舊資料），轉回台北時間 HH:mm。
function configValueToString_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, 'Asia/Taipei', 'HH:mm');
  return String(v);
}

function readConfig_() {
  var cfg = {};
  DEFAULT_CONFIG.forEach(function (kv) { cfg[kv[0]] = kv[1]; });
  rows_('Config').forEach(function (r) {
    if (r.key) cfg[r.key] = configValueToString_(r.value);
  });
  return cfg;
}

function logCutoff_(today) { return addDays_(today, -34); }
function weightCutoff_(today) { return addDays_(today, -89); }

function readAll_(since) {
  var today = taipeiToday_();
  var logCut = logCutoff_(today);
  var weightCut = weightCutoff_(today);
  var sinceDay = since ? String(since) : '';
  var items = rows_('Items').map(strip_);
  var stores = rows_('Stores').map(strip_);
  var logs = rows_('Logs').filter(function (r) {
    var day = String(r.day || '').slice(0, 10);
    if (day < logCut) return false;
    if (sinceDay && String(r.updated_at || '') < sinceDay) return false;
    return true;
  }).map(strip_);
  var weights = rows_('Weights').filter(function (r) {
    var day = String(r.day || '').slice(0, 10);
    if (day < weightCut) return false;
    if (sinceDay && String(r.updated_at || '') < sinceDay) return false;
    return true;
  }).map(strip_);
  return {
    ok: true,
    version: API_VERSION,
    serverTime: nowIso_(),
    config: readConfig_(),
    items: items,
    stores: stores,
    logs: logs,
    weights: weights,
    weightDays: 90
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

function weightSeries_(logs, weights, config, today, spanDays) {
  var targetKcal = numCfg_(config, 'target_kcal', 0);
  var tdeeRaw = config && config.tdee != null ? String(config.tdee).trim() : '';
  var tdee = tdeeRaw === '' ? null : Number(tdeeRaw);
  var kgByDay = latestKgByDay_(weights);
  var byDay = totalsByDay_(logs);
  var points = [];
  var avg7pts = [];
  var span = (spanDays == null || !isFinite(spanDays) || spanDays < 2) ? 29 : Math.floor(spanDays);
  var windowStart = addDays_(today, -(span - 1));
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
