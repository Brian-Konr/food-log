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
