// GAS 對照測試（計畫 §4 階段 1 第 3 步，保留到切換）：
// 同一組案例，分別在舊後端（legacy/gas/Code.gs，經 gas-fakes 載入）跑 v1 op，和在 core（記憶體伺服器）跑 v2 mutation，
// 每一步比較 ok／錯誤碼／duplicate／ignored／overwritten，以及之後所有資料列（欄位名稱對映：
// store → store_id、deleted → deleted_at、fav → favorites、Config 字串 → 有型別的欄位）。
//
// 注意：這裡用相對路徑 import legacy/test/gas-fakes.ts。core 的測試在切換（legacy/ 刪除）之前可以依賴 legacy，
// 切換後這個檔案連同 legacy/ 一起刪除；src/ 不得 import legacy。
//
// 刪除語意對齊 v1.1.4 的 softDelete_：owner 刪不存在、已刪除的列都回 ok 且不寫入（v2 回 ignored:'missing'／'deleted'，
// v1 只回 {ok:true}，所以比對時 delete 步驟的 ignored 不比；改用 step.expect 另外斷言 v2 的值）；
// Kyujin 刪 Logs 列不存在或不是 kyujin 的 → forbidden。復原的語意不變。
//
// 明確記載的有意差異清單（v2 與 Code.gs 不同之處，所以案例刻意避開或比對時正規化）：
//   - created_by 不是參數（依 actor）：所以沒有「Kyujin 帶 created_by:'app' 建店／建品項 → forbidden」的案例；
//   - v1 的 items.fav 不存在（改 favorites.set）；
//   - 復原一個本來沒被刪的列：v1 回 ok 並改 updated_at，v2 回 ignored:'not_deleted'（比對時視為普通 ok）；
//   - stores.restore 撞名回 duplicate_name、ts 必須是 +08:00、編輯一般紀錄會重驗 qty／grams（v1 沒檢查）；
//   - logs.update 的 name 存去掉頭尾空白後的值（v1 驗證時 trim、寫入時卻寫原字串；v2 有意改善），所以案例的 name 不帶空白；
//     v2 對這點有專屬測試（test/logs.test.ts）；
//   - items.restore 一個店家品項時，店家已刪除或不存在 → bad_record『這家店已經刪除』（v1 的 restore_ 不檢查店家，
//     會讓未刪除的品項出現在已刪除的店；v2 有意擋下，必須先 stores.restore）。所以案例刻意避開這種情況；專屬測試在 test/items.test.ts；
//   - delete／restore 的 ignored 旗標：v1 只回 {ok:true}，比對時忽略，v2 的值用 step.expect 斷言。
import { describe, expect, test } from 'vitest'
import { KYUJIN, OWNER } from '../src/actor'
import type { Actor } from '../src/actor'
import { configToStrings, defaultConfigRow } from '../src/schema/config'
import { addDays, taipeiToday } from '../src/time'
import { MemoryServer, MemoryTx } from '../src/testing'
import { readyGas } from '../../../legacy/test/gas-fakes'

type Rec = Record<string, unknown>
type Who = 'owner' | 'kyujin'
type Step = { label: string; who?: Who; v1: Rec | Rec[]; v2: [name: string, args: unknown]; expect?: Rec }
type Case = { name: string; steps: Step[] }
type Outcome = { ok: boolean; error?: string; duplicate?: true; ignored?: string; overwritten?: true; existingId?: string }

// ---------- 日期：用相對今天的日子，不受測試執行日影響（v1 的 read 有 35／90 天視窗）----------
const TODAY = taipeiToday(Date.now())
const day = (back: number) => addDays(TODAY, -back)
const at = (d: string, hhmm = '12:00') => `${d}T${hhmm}:00+08:00`
const D1 = day(1)
const D2 = day(2)
const D3 = day(3)

// ---------- 步驟建構：一份「v1 風格」的紀錄，自動轉成 v2 參數 ----------
function toLogArgs(rec: Rec): Rec {
  const { store: st, deleted: _d, updated_at: _u, ...rest } = rec
  return { ...rest, ...(st !== undefined ? { store_id: st === '' ? null : st } : {}) }
}
function toItemArgs(rec: Rec): Rec {
  const { store: st, deleted: _d, updated_at: _u, fav: _f, created_by: _c, ...rest } = rec
  return { ...rest, ...(st !== undefined ? { store_id: st === '' ? null : st } : {}) }
}
function toStoreArgs(rec: Rec): Rec {
  const { created_by: _c, deleted: _d, updated_at: _u, last_eaten_at: _l, ...rest } = rec
  return rest
}

const S = {
  append: (label: string, rec: Rec, who?: Who): Step => ({ label, who, v1: { action: 'append', table: 'Logs', record: rec }, v2: ['logs.add@1', { log: toLogArgs(rec) }] }),
  /** 補填或自建品項 + 紀錄：v1 是兩個 op（先 upsertItem 再 append），v2 是一個 logs.add@1。 */
  appendWithItem: (label: string, item: Rec, rec: Rec, who?: Who): Step => ({
    label, who,
    v1: [{ action: 'upsertItem', record: item }, { action: 'append', table: 'Logs', record: rec }],
    v2: ['logs.add@1', { log: toLogArgs(rec), item: toItemArgs(item) }],
  }),
  update: (label: string, id: string, patch: Rec, who?: Who): Step => ({ label, who, v1: { action: 'update', table: 'Logs', id, patch }, v2: ['logs.update@1', { id, patch }] }),
  /** expect：v2 結果應該帶的 ignored（v1 只回 ok，不比；這裡另外斷言 v2）。 */
  del: (label: string, table: 'Logs' | 'Items' | 'Stores' | 'Weights', id: string, who?: Who, expectIgnored?: 'missing' | 'deleted'): Step => ({
    label, who, v1: { action: 'softDelete', table, id }, v2: [`${table.toLowerCase()}.delete@1`, { id }],
    ...(expectIgnored ? { expect: { ignored: expectIgnored } } : {}),
  }),
  restore: (label: string, table: 'Logs' | 'Items' | 'Stores' | 'Weights', id: string, who?: Who): Step => ({
    label, who, v1: { action: 'restore', table, id }, v2: [`${table.toLowerCase()}.restore@1`, { id }],
  }),
  item: (label: string, rec: Rec, who?: Who): Step => ({ label, who, v1: { action: 'upsertItem', record: rec }, v2: ['items.upsert@1', toItemArgs(rec)] }),
  store: (label: string, rec: Rec, who?: Who): Step => ({ label, who, v1: { action: 'upsertStore', record: rec }, v2: ['stores.upsert@1', toStoreArgs(rec)] }),
  weight: (label: string, rec: Rec, who?: Who): Step => ({ label, who, v1: { action: 'upsertWeight', record: rec }, v2: ['weights.upsert@1', rec] }),
  config: (label: string, key: string, value: unknown, who?: Who): Step => ({ label, who, v1: { action: 'setConfig', key, value }, v2: ['config.set@1', { key, value }] }),
}

// ---------- 共用的資料 ----------
const nut = { kcal: 106, protein: 20.8, fat: 1.5, carb: 2.3 }
const log = (id: string, over: Rec = {}): Rec => ({ id, ts: at(D1), day: D1, item_id: 'fm:1', name: '雞胸', src: '全家', qty: 1, ...nut, ...over })
const quick = (id: string, over: Rec = {}): Rec => ({ id, ts: at(D1), day: D1, item_id: '', name: '', src: '其他', qty: 1, kcal: 300, protein: 10, fat: 10, carb: 40, source: 'quick', ...over })
const item = (id: string, over: Rec = {}): Rec => ({
  id, ts: at(D1), kind: '自建', base_id: '', src: '其他', name: '乳清', serving: '1 匙', serving_g: 30, kcal: 120, protein: 24, fat: 1, carb: 2, fav: false, created_by: 'app', ...over,
})
const kitem = (id: string, over: Rec = {}): Rec => item(id, { created_by: 'kyujin', ...over })
const sto = (id: string, name: string, over: Rec = {}): Rec => ({ id, name, ts: at(D1), created_by: 'app', ...over })
const w = (id: string, kg: number, d = D1, over: Rec = {}): Rec => ({ id, day: d, kg, ts: at(d, '08:00'), ...over })

// ---------- 案例 ----------
const CASES: Case[] = [
  // ===== 體重（至少 3 個）=====
  {
    name: 'weights: 同日覆寫保留第一個 id；重送第一個 id 是 duplicate 且不改回去',
    steps: [
      S.weight('第一筆', w('w1', 72.0)),
      S.weight('同日新 id → overwritten', w('w2', 72.8)),
      S.weight('重送 w1 → duplicate', w('w1', 72.0)),
      S.weight('重送 w2（已不在列上）→ 仍是覆寫，一筆、kg 不變', w('w2', 72.8)),
    ],
  },
  {
    name: 'weights: 範圍、小數、未來日期、day≠ts、缺欄位',
    steps: [
      S.weight('29.9', w('a', 29.9)),
      S.weight('250.1', w('b', 250.1)),
      S.weight('72.44', w('c', 72.44)),
      S.weight('30 可以', w('lo', 30, D2)),
      S.weight('250 可以', w('hi', 250, D3)),
      S.weight('未來日期', w('f', 72, day(-5))),
      S.weight('day 和 ts 不符', w('g', 72, D1, { ts: at(D2, '08:00') })),
      S.weight('缺 id', { day: D1, kg: 72, ts: at(D1, '08:00') }),
      S.weight('kg 是字串', w('h', 72, D1, { kg: '72' })),
    ],
  },
  {
    name: 'weights: 軟刪除後同一天可再新增；復原撞到同一天 → bad_record；先刪掉那筆就能復原',
    steps: [
      S.weight('w1', w('w1', 72.0)),
      S.del('刪 w1', 'Weights', 'w1'),
      S.weight('同天 w3 不是覆寫', w('w3', 73.1)),
      S.restore('復原 w1 撞到 w3', 'Weights', 'w1'),
      S.del('刪 w3', 'Weights', 'w3'),
      S.restore('復原 w1', 'Weights', 'w1'),
      S.del('刪不存在的 → ok（v1.1.4）', 'Weights', 'nope', undefined, 'missing'),
      S.restore('復原不存在的', 'Weights', 'nope'),
    ],
  },
  {
    name: 'weights: Kyujin 可以 upsert，不能刪除或復原（forbidden 先於 not_found）',
    steps: [
      S.weight('Kyujin upsert', w('w1', 72.4), 'kyujin'),
      S.del('Kyujin 刪', 'Weights', 'w1', 'kyujin'),
      S.restore('Kyujin 復原', 'Weights', 'w1', 'kyujin'),
      S.del('Kyujin 刪不存在的', 'Weights', 'nope', 'kyujin'),
    ],
  },

  // ===== 店家 =====
  {
    name: 'stores: 重複店名（含標點、空白、全形）→ duplicate_name；已刪除的名字可以再用',
    steps: [
      S.store('建立', sto('s:1', '阿財牛肉麵')),
      S.store('含標點的同名', sto('s:2', ' 阿財・牛肉麵 ')),
      S.store('全形英文大小寫', sto('s:3', 'ＡＢＣ（麵）')),
      S.store('同名不同寫法', sto('s:4', 'abc 麵')),
      S.store('自己改名不算重複', sto('s:1', '阿財・牛肉麵')),
      S.del('刪 s:1', 'Stores', 's:1'),
      S.store('刪除後名字可再用', sto('s:5', '阿財牛肉麵')),
      S.store('id 前綴不對', sto('x:1', '別家')),
      S.store('店名空白', sto('s:6', '   ')),
      S.store('缺 id', { name: '沒有 id', ts: at(D1) }),
    ],
  },
  {
    name: 'stores: 連帶刪除品項；復原只還原當時一起刪的（早刪的不動）；Logs 不動',
    steps: [
      S.store('店', sto('s:1', '阿財牛肉麵')),
      S.item('品項 beef', item('u:beef', { name: '牛肉麵', serving: '1 份', serving_g: null, kcal: 520, protein: 28, fat: 18, carb: 62, store: 's:1' })),
      S.item('品項 old', item('u:old', { name: '早刪的', serving: '1 份', serving_g: null, store: 's:1' })),
      S.del('早刪 old', 'Items', 'u:old'),
      S.append('記一筆', log('l1', { item_id: 'u:beef', name: '牛肉麵', src: '其他', kcal: 520, protein: 28, fat: 18, carb: 62, store: 's:1' })),
      S.del('刪店', 'Stores', 's:1'),
      S.restore('復原店', 'Stores', 's:1'),
      S.del('再刪店', 'Stores', 's:1'),
      S.del('刪不存在的店 → ok', 'Stores', 'nope', undefined, 'missing'),
    ],
  },
  {
    name: 'stores: 記錄帶店家會更新 last_eaten_at，只往後；店家不存在 → bad_record',
    steps: [
      S.store('店', sto('s:1', '阿財')),
      S.append('12:00', log('l1', { item_id: 'x', name: 'x', src: '其他', ts: at(D1, '12:00'), store: 's:1' })),
      S.append('往回補記 08:00', log('l0', { item_id: 'x', name: 'x', src: '其他', ts: at(D1, '08:00'), store: 's:1' })),
      S.append('往後 18:00', log('l2', { item_id: 'x', name: 'x', src: '其他', ts: at(D1, '18:00'), store: 's:1' })),
      S.append('店家不存在', log('l3', { item_id: 'x', name: 'x', src: '其他', store: 's:none' })),
    ],
  },
  {
    name: 'stores: Kyujin 可以建店、改 App 店名（created_by 保留）；不能刪除或復原（含不存在的）',
    steps: [
      S.store('Kyujin 建店', sto('s:k', 'K店', { created_by: 'kyujin' }), 'kyujin'),
      S.store('App 建店', sto('s:app', '阿財')),
      S.store('Kyujin 改 App 店名', sto('s:app', '阿財麵', { created_by: 'kyujin' }), 'kyujin'),
      S.del('Kyujin 刪店', 'Stores', 's:app', 'kyujin'),
      S.restore('Kyujin 復原不存在的店', 'Stores', 'nope', 'kyujin'),
    ],
  },

  // ===== Kyujin forbidden 矩陣 =====
  {
    name: 'kyujin: Logs（非 kyujin source）、ov:、官方 id、setConfig、改 App 的 u: 全部 forbidden',
    steps: [
      S.append('沒有 source', log('l'), 'kyujin'),
      S.append('source=app', log('l', { source: 'app' }), 'kyujin'),
      S.append('source=quick', quick('l'), 'kyujin'),
      S.update('改不存在的 log（forbidden 先於 not_found）', 'l', { qty: 2 }, 'kyujin'),
      S.del('刪不存在的 log', 'Logs', 'l', 'kyujin'),
      S.restore('復原不存在的 log', 'Logs', 'l', 'kyujin'),
      S.item('ov:', item('ov:fm:1', { kind: '補填', base_id: 'fm:1', created_by: 'app' }), 'kyujin'),
      S.item('fm:', item('fm:1'), 'kyujin'),
      S.item('711:', item('711:abc'), 'kyujin'),
      S.config('tdee', 'tdee', '2000', 'kyujin'),
      S.item('App 建 u:', item('u:app')),
      S.item('Kyujin 改 App 的 u:', item('u:app', { name: '被改', created_by: 'kyujin' }), 'kyujin'),
      S.del('Kyujin 刪品項', 'Items', 'u:app', 'kyujin'),
      S.restore('Kyujin 復原品項', 'Items', 'u:app', 'kyujin'),
    ],
  },
  {
    name: 'kyujin: 可以寫 u:（再寫是更新）、店家品項（含 App 建的）、source=kyujin 的 Logs；不能動 app／quick 的 Logs',
    steps: [
      S.item('Kyujin 建 u:', kitem('u:kyu-1'), 'kyujin'),
      S.item('Kyujin 再寫同一個', kitem('u:kyu-1', { name: '乳清蛋白' }), 'kyujin'),
      S.item('owner 改 Kyujin 建的', item('u:kyu-1', { name: 'owner 改名' })),
      S.store('App 店', sto('s:app', '阿財')),
      S.item('App 的店家品項', item('u:app-store', { name: '麵', serving: '1 份', serving_g: null, store: 's:app' })),
      S.item('Kyujin 改 App 的店家品項', kitem('u:app-store', { name: '麵加大', serving: '1 份', serving_g: null, store: 's:app' }), 'kyujin'),
      S.append('Kyujin 估算', log('lk', { item_id: '', name: '估的', src: '其他', kcal: 250, protein: 20, fat: 8, carb: 15, source: 'kyujin' }), 'kyujin'),
      S.append('App 一般記錄', log('la', { item_id: 'u:1', name: 'app', src: '其他' })),
      S.append('App 快速記錄', quick('lq')),
      S.update('Kyujin 改 app 的 log', 'la', { kcal: 99 }, 'kyujin'),
      S.update('Kyujin 改 quick 的 log', 'lq', { kcal: 99 }, 'kyujin'),
      S.del('Kyujin 刪 app 的 log', 'Logs', 'la', 'kyujin'),
      S.update('Kyujin 改自己的 log', 'lk', { kcal: 260 }, 'kyujin'),
      S.update('Kyujin 改 source', 'lk', { source: 'app' }, 'kyujin'),
      S.del('Kyujin 刪自己的 log', 'Logs', 'lk', 'kyujin'),
      S.restore('Kyujin 復原自己的 log', 'Logs', 'lk', 'kyujin'),
    ],
  },
  {
    name: 'kyujin: 店家品項的 src／店家檢查仍適用',
    steps: [
      S.item('店家不存在', kitem('u:x', { store: 's:none' }), 'kyujin'),
      S.store('店', sto('s:1', '店')),
      S.item('店家品項 src 不是其他', kitem('u:y', { store: 's:1', src: '全家' }), 'kyujin'),
      S.item('正常店家品項', kitem('u:z', { store: 's:1' }), 'kyujin'),
    ],
  },

  // ===== 記錄驗證（含快速記錄）=====
  {
    name: 'quick log: 缺營養素、qty≠1、grams、src≠其他、帶店家 → bad_record；四項 0 可以',
    steps: [
      S.append('缺 protein', quick('q1', { protein: null })),
      S.append('qty=2', quick('q2', { qty: 2 })),
      S.append('有 grams', quick('q3', { grams: 100 })),
      S.append('src=全家', quick('q4', { src: '全家' })),
      S.append('帶店家', quick('q5', { store: 's:none' })),
      S.append('四項 0', quick('q6', { kcal: 0, protein: 0, fat: 0, carb: 0 })),
      S.append('重送 → duplicate', quick('q6', { kcal: 0, protein: 0, fat: 0, carb: 0 })),
    ],
  },
  {
    name: 'log validation: 營養素、day/ts、未來日期、qty、grams、source、重複 id',
    steps: [
      S.append('protein null', log('a', { protein: null })),
      S.append('fat 負數', log('b', { fat: -1 })),
      S.append('carb 字串', log('c', { carb: '2.3' })),
      S.append('0 可以', log('d', { protein: 0, fat: 0, carb: 0 })),
      S.append('day≠ts', log('e', { day: D2 })),
      S.append('未來日期', log('f', { day: day(-3), ts: at(day(-3)) })),
      S.append('qty 0', log('g', { qty: 0 })),
      S.append('grams 0', log('h', { grams: 0 })),
      S.append('grams 150、qty 1.5', log('i', { grams: 150, qty: 1.5 })),
      S.append('name 空白', log('j', { name: '  ' })),
      S.append('source 不認得（owner）', log('k', { source: 'weird' })),
      S.append('owner 寫 source=kyujin', log('m', { source: 'kyujin' })),
      S.append('src 不認得', log('n', { src: '麥當勞' })),
      S.append('重送 d → duplicate', log('d', { protein: 0, fat: 0, carb: 0 })),
      S.append('缺 id', { ts: at(D1), day: D1, item_id: 'x', name: 'x', src: '全家', qty: 1, ...nut }),
    ],
  },
  {
    name: 'log update: 白名單欄位、不能改 source、day≠ts、未來、快速記錄 qty',
    steps: [
      S.append('一般記錄', log('a')),
      S.append('快速記錄', quick('q')),
      S.update('改 qty、kcal、name', 'a', { qty: 2, kcal: 212, name: '新名' }),
      S.update('source 換掉', 'a', { source: 'quick' }),
      S.update('source 不變', 'a', { source: 'app', kcal: 213 }),
      S.update('kcal 負數', 'a', { kcal: -5 }),
      S.update('day≠ts', 'a', { day: D2 }),
      S.update('未來', 'a', { day: day(-2), ts: at(day(-2)) }),
      S.update('改成別天（day 和 ts 一起）', 'a', { day: D2, ts: at(D2) }),
      S.update('快速記錄 qty=2', 'q', { qty: 2 }),
      S.update('快速記錄 grams', 'q', { grams: 100 }),
      S.update('快速記錄改 kcal', 'q', { kcal: 350 }),
      S.update('不存在', 'nope', { kcal: 1 }),
    ],
  },

  // ===== 刪除語意（v1.1.4）：不存在、重複刪除都是 ok 且不寫入 =====
  {
    name: 'delete: ignored:missing／deleted — 四張表刪不存在的列、重複刪除都回 ok 且資料不變；復原不存在的仍是 not_found',
    steps: [
      S.append('記錄 l1', log('l1')),
      S.item('品項 u:1', item('u:1')),
      S.store('店 s:1', sto('s:1', '阿財')),
      S.weight('體重 w1', w('w1', 72)),
      S.del('Logs 不存在 → ok', 'Logs', 'nope', undefined, 'missing'),
      S.del('Items 不存在 → ok', 'Items', 'nope', undefined, 'missing'),
      S.del('Stores 不存在 → ok', 'Stores', 'nope', undefined, 'missing'),
      S.del('Weights 不存在 → ok', 'Weights', 'nope', undefined, 'missing'),
      S.del('刪 l1', 'Logs', 'l1'),
      S.del('刪 u:1', 'Items', 'u:1'),
      S.del('刪 s:1', 'Stores', 's:1'),
      S.del('刪 w1', 'Weights', 'w1'),
      S.del('Logs 重複刪 → ok', 'Logs', 'l1', undefined, 'deleted'),
      S.del('Items 重複刪 → ok', 'Items', 'u:1', undefined, 'deleted'),
      S.del('Stores 重複刪 → ok', 'Stores', 's:1', undefined, 'deleted'),
      S.del('Weights 重複刪 → ok', 'Weights', 'w1', undefined, 'deleted'),
      S.restore('復原不存在的 Logs → not_found', 'Logs', 'nope'),
      S.restore('復原不存在的 Items → not_found', 'Items', 'nope'),
      S.restore('復原 l1', 'Logs', 'l1'),
      S.restore('復原 l1 兩次', 'Logs', 'l1'),
    ],
  },
  {
    name: 'delete: Kyujin 刪 Logs — 不存在、別人的（含已刪除）→ forbidden；自己的列重複刪 → ok',
    steps: [
      S.append('Kyujin 估算', log('lk', { item_id: '', name: '估的', src: '其他', kcal: 250, protein: 20, fat: 8, carb: 15, source: 'kyujin' }), 'kyujin'),
      S.append('App 記錄', log('la')),
      S.del('Kyujin 刪不存在的 → forbidden', 'Logs', 'nope', 'kyujin'),
      S.del('Kyujin 刪 app 的 → forbidden', 'Logs', 'la', 'kyujin'),
      S.del('owner 刪 la', 'Logs', 'la'),
      S.del('Kyujin 刪已刪除的 app 列 → 仍 forbidden', 'Logs', 'la', 'kyujin'),
      S.del('Kyujin 刪自己的', 'Logs', 'lk', 'kyujin'),
      S.del('Kyujin 重複刪自己的 → ok', 'Logs', 'lk', 'kyujin', 'deleted'),
    ],
  },

  // ===== 刪除後的 update／upsert =====
  {
    name: 'conflict: 刪除後 update／upsertItem／upsertStore 回 ignored:deleted 且資料不變',
    steps: [
      S.store('店', sto('s:1', '店')),
      S.item('品項', item('u:1', { name: '麵', serving: '1 份', serving_g: null, kcal: 100, protein: 1, fat: 1, carb: 1 })),
      S.append('記錄', log('l1', { item_id: 'u:1', name: '麵', src: '其他', kcal: 100, protein: 1, fat: 1, carb: 1 })),
      S.del('刪記錄', 'Logs', 'l1'),
      S.del('刪品項', 'Items', 'u:1'),
      S.del('刪店', 'Stores', 's:1'),
      S.update('update 已刪的記錄', 'l1', { qty: 2, kcal: 200 }),
      S.item('upsertItem 已刪的品項', item('u:1', { name: '改', kcal: 9, serving: '1 份', serving_g: null })),
      S.store('upsertStore 已刪的店', sto('s:1', '改名')),
      S.update('Kyujin update 別人的已刪記錄', 'l1', { qty: 3 }, 'kyujin'),
    ],
  },

  // ===== 品項 =====
  {
    name: 'items: id 前綴、ov: 規則、u: 規則、欄位驗證',
    steps: [
      S.item('fm:', item('fm:1')),
      S.item('711:', item('711:x')),
      S.item('x: 前綴', item('x:1')),
      S.item('缺 id', { ...item('u:q'), id: '' }),
      S.item('ov: 正常', item('ov:fm:1', { kind: '補填', base_id: 'fm:1', src: '全家' })),
      S.item('ov: kind 不對', item('ov:fm:2', { kind: '自建', base_id: 'fm:2' })),
      S.item('ov: base_id 不對', item('ov:fm:3', { kind: '補填', base_id: 'fm:other' })),
      S.item('u: kind 不對', item('u:1', { kind: '補填' })),
      S.item('u: base_id 不空', item('u:2', { base_id: 'fm:1' })),
      S.item('name 空', item('u:3', { name: '' })),
      S.item('serving 空', item('u:4', { serving: '' })),
      S.item('serving_g 0', item('u:5', { serving_g: 0 })),
      S.item('kcal 負數', item('u:6', { kcal: -1 })),
      S.item('protein null', item('u:7', { protein: null })),
      S.item('serving_g null 可以', item('u:8', { serving_g: null })),
      S.item('src 不認得', item('u:9', { src: 'x' })),
      S.item('店家不存在', item('u:10', { store: 's:none' })),
      S.item('刪除 → 復原', item('u:11')),
      S.del('刪品項', 'Items', 'u:11'),
      S.restore('復原品項', 'Items', 'u:11'),
      S.del('刪不存在的品項 → ok', 'Items', 'u:none', undefined, 'missing'),
    ],
  },
  {
    name: 'items: created_by 建立後不變（owner 改 Kyujin 建的、Kyujin 改自己建的）',
    steps: [
      S.item('Kyujin 建', kitem('u:k'), 'kyujin'),
      S.item('owner 改', item('u:k', { name: 'owner 改' })),
      S.item('Kyujin 再改', kitem('u:k', { name: 'Kyujin 改' }), 'kyujin'),
    ],
  },
  {
    name: 'logs.add 帶 item（v1 是 upsertItem + append，v2 是一個 mutation）：補填與自建',
    steps: [
      S.appendWithItem('補填官方品項', item('ov:fm:1', { kind: '補填', base_id: 'fm:1', src: '全家', name: '雞胸' }), log('l1', { item_id: 'fm:1' })),
      S.appendWithItem('自建補營養素', item('u:c'), log('l2', { item_id: 'u:c', src: '其他', name: '乳清' })),
      S.append('用補填後的品項再記一筆', log('l3', { item_id: 'fm:1' })),
    ],
  },

  // ===== 設定 =====
  {
    name: 'config: 各鍵的驗證與寫入；Kyujin forbidden（壞鍵也先 forbidden）',
    steps: [
      S.config('提醒用餐', 'remind_meal_times', '12:30,19:00'),
      S.config('提醒體重', 'remind_weight_time', '07:15'),
      S.config('提醒體重改', 'remind_weight_time', '07:30'),
      S.config('壞的提醒時間', 'remind_weight_time', '25:00'),
      S.config('壞的用餐時間', 'remind_meal_times', '12:30,xx'),
      S.config('tdee 2650', 'tdee', '2650'),
      S.config('tdee 太小', 'tdee', '1199'),
      S.config('tdee 小數', 'tdee', '2650.5'),
      S.config('tdee 清除', 'tdee', ''),
      S.config('target_kcal 1800', 'target_kcal', '1800'),
      S.config('target_kcal 空', 'target_kcal', ''),
      S.config('target_kcal 小數', 'target_kcal', '18.5'),
      S.config('target_protein 150.5', 'target_protein', '150.5'),
      S.config('target_fat 負數', 'target_fat', '-1'),
      S.config('target_carb 非數字', 'target_carb', 'abc'),
      S.config('不能寫的鍵', 'schema_version', '9'),
      S.config('Kyujin 寫設定', 'target_kcal', '1', 'kyujin'),
      S.config('Kyujin 寫壞鍵', 'nope', 'x', 'kyujin'),
    ],
  },
]

// ---------- 兩邊的執行與正規化 ----------
function v1Outcome(res: Rec): Outcome {
  const o: Outcome = { ok: res.ok === true }
  if (res.error !== undefined) o.error = String(res.error)
  if (res.duplicate) o.duplicate = true
  if (res.ignored) o.ignored = String(res.ignored)
  if (res.overwritten) o.overwritten = true
  if (res.existingId !== undefined) o.existingId = String(res.existingId)
  return o
}

function v2Outcome(res: Awaited<ReturnType<MemoryServer['mutateRaw']>>, name: string): Outcome {
  if (!res.ok) {
    const o: Outcome = { ok: false, error: res.error }
    const existingId = res.details?.existingId
    if (typeof existingId === 'string') o.existingId = existingId
    return o
  }
  const r = (res.result ?? {}) as Rec
  const o: Outcome = { ok: true }
  if (r.duplicate) o.duplicate = true
  // 'not_deleted'（v1 沒有）、'missing'（v1 刪除不存在的列只回 ok）視為普通 ok；delete／restore 的 ignored 一律不比（見 step.expect）。
  if (r.ignored === 'deleted' && !/\.(delete|restore)@/.test(name)) o.ignored = 'deleted'
  if (r.overwritten === true) o.overwritten = true
  return o
}

const nn = (v: unknown) => (v === '' || v === undefined ? null : v)
const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id))

type Snap = { logs: Rec[]; items: Rec[]; stores: Rec[]; weights: Rec[]; config: Record<string, string>; favorites?: unknown }

function snapV1(read: Rec): Snap {
  const rows = (k: string) => (read[k] as Rec[]) ?? []
  const cfg = { ...(read.config as Record<string, string>) }
  delete cfg.fav_ids // 收藏改放 favorites 表
  delete cfg.schema_version // 試算表 migration 用，v2 沒有
  return {
    logs: byId(rows('logs').map((r) => ({
      id: r.id, day: String(r.day).slice(0, 10), item_id: nn(r.item_id), name: r.name, src: r.src, qty: r.qty, grams: nn(r.grams),
      kcal: r.kcal, protein: r.protein, fat: r.fat, carb: r.carb, source: r.source, store_id: nn(r.store), deleted: r.deleted === true,
    })) as { id: string }[]) as Rec[],
    items: byId(rows('items').map((r) => ({
      id: r.id, kind: r.kind, base_id: nn(r.base_id), src: r.src, name: r.name, serving: r.serving, serving_g: nn(r.serving_g),
      kcal: r.kcal, protein: r.protein, fat: r.fat, carb: r.carb, created_by: r.created_by, store_id: nn(r.store), deleted: r.deleted === true,
    })) as { id: string }[]) as Rec[],
    stores: byId(rows('stores').map((r) => ({
      id: r.id, name: r.name, last_eaten_at: nn(r.last_eaten_at), created_by: r.created_by, deleted: r.deleted === true,
    })) as { id: string }[]) as Rec[],
    weights: byId(rows('weights').map((r) => ({
      id: r.id, day: String(r.day).slice(0, 10), kg: r.kg, deleted: r.deleted === true,
    })) as { id: string }[]) as Rec[],
    config: cfg,
  }
}

async function snapV2(server: MemoryServer): Promise<Snap> {
  const s = server.snapshot()
  const cfgRow = s.config[0] ?? (await new MemoryTx(server.db).getConfig())
  return {
    logs: byId(s.logs.map((r) => ({
      id: r.id, day: r.day, item_id: r.item_id, name: r.name, src: r.src, qty: r.qty, grams: r.grams,
      kcal: r.kcal, protein: r.protein, fat: r.fat, carb: r.carb, source: r.source, store_id: r.store_id, deleted: r.deleted_at !== null,
    }))) as Rec[],
    items: byId(s.items.map((r) => ({
      id: r.id, kind: r.kind, base_id: r.base_id, src: r.src, name: r.name, serving: r.serving, serving_g: r.serving_g,
      kcal: r.kcal, protein: r.protein, fat: r.fat, carb: r.carb, created_by: r.created_by, store_id: r.store_id, deleted: r.deleted_at !== null,
    }))) as Rec[],
    stores: byId(s.stores.map((r) => ({
      id: r.id, name: r.name, last_eaten_at: r.last_eaten_at, created_by: r.created_by, deleted: r.deleted_at !== null,
    }))) as Rec[],
    weights: byId(s.weights.map((r) => ({ id: r.id, day: r.day, kg: r.kg, deleted: r.deleted_at !== null }))) as Rec[],
    config: { ...configToStrings(cfgRow) },
  }
}

const actorOf = (who: Who | undefined): Actor => (who === 'kyujin' ? KYUJIN : OWNER)

async function runStepBoth(step: Step, gas: ReturnType<typeof readyGas>, server: MemoryServer): Promise<{ v1: Outcome; v2: Outcome }> {
  const ops = Array.isArray(step.v1) ? step.v1 : [step.v1]
  let v1: Outcome = { ok: true }
  for (const op of ops) {
    const res = gas.call({ ...op, ...(step.who === 'kyujin' ? { client: 'kyujin' } : {}) }) as Rec
    v1 = v1Outcome(res)
    if (!v1.ok) break
  }
  const raw = await server.mutateRaw(step.v2[0], step.v2[1], actorOf(step.who))
  if (step.expect) expect(raw.ok && raw.result, `「${step.label}」的 v2 結果`).toEqual(step.expect)
  const v2 = v2Outcome(raw, step.v2[0])
  return { v1, v2 }
}

describe('GAS 對照：同一組案例在 Code.gs（v1 op）與 core（v2 mutation）結果相同', () => {
  test.each(CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const gas = readyGas()
    const server = new MemoryServer({ now: () => Date.now() })
    for (const step of c.steps) {
      const { v1, v2 } = await runStepBoth(step, gas, server)
      expect(v2, `「${step.label}」的 ok／錯誤碼／旗標`).toEqual(v1)
      const a = snapV1(gas.call({ action: 'read' }) as Rec)
      const b = await snapV2(server)
      expect(b, `「${step.label}」之後的資料列`).toEqual(a)
    }
  })
})

describe('對照案例的涵蓋', () => {
  test('至少涵蓋：體重 3 個、店家重名與連帶刪除復原、Kyujin 矩陣、快速記錄驗證、已刪除列的 update', () => {
    const names = CASES.map((c) => c.name)
    expect(names.filter((n) => n.startsWith('weights:')).length).toBeGreaterThanOrEqual(3)
    expect(names.some((n) => n.includes('duplicate_name'))).toBe(true)
    expect(names.some((n) => n.includes('連帶刪除'))).toBe(true)
    expect(names.filter((n) => n.startsWith('kyujin:')).length).toBeGreaterThanOrEqual(2)
    expect(names.some((n) => n.startsWith('quick log'))).toBe(true)
    expect(names.some((n) => n.includes('ignored:deleted'))).toBe(true)
  })

  test('每個步驟的 v2 mutation 名稱都存在於 registry', async () => {
    const { lookupMutation } = await import('../src/registry')
    for (const c of CASES) for (const s of c.steps) expect(lookupMutation(s.v2[0]), `${c.name} / ${s.label}`).toBeDefined()
  })

  test('預設 config 和 v1 一致（對照的基準）', () => {
    expect(configToStrings(defaultConfigRow())).toEqual({
      target_kcal: '2000', target_protein: '150', target_fat: '60', target_carb: '200', tdee: '', remind_meal_times: '', remind_weight_time: '',
    })
  })
})
