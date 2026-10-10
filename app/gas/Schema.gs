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
