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
  writeSchemaVersion_();
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
  var n = Math.max(sh.getLastRow(), 1);
  sh.getRange(1, col, n, 1).setNumberFormat('@');
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
      if (name === 'Stores') {
        for (var i = 0; i < cols.length; i++) formatColText_(sh, i + 1);
      }
    } else {
      cols.forEach(function (c) {
        if (header.indexOf(c) < 0) {
          header.push(c);
          sh.getRange(1, header.length).setValue(c);
          formatColText_(sh, header.length);
          added.push(c);
        }
      });
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
