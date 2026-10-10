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
