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
