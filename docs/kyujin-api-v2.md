# Kyujin API v2

food-log 搬到 Cloudflare Worker 之後的 Kyujin API。取代 [`kyujin-api.md`](kyujin-api.md)（舊的 Apps Script `/exec`）。權限規則沒有變（PRD §3.1），變的是網址、驗證方式、請求格式和欄位名。

這份文件不放真實網址或 key。

## 連線

- **Base URL**：`<WORKER_ORIGIN>/bot/v1`，`<WORKER_ORIGIN>` 是 Worker 的網址（例如 `https://food-log.<subdomain>.workers.dev`），由 Brian 提供。
- **驗證**：`Authorization: Bearer <KEY>`。Key 放在共用電腦的 `~/.config/studio/bots/kyujin.env`（權限 600，內容是 `FOODLOG_API_BASE` 和 `FOODLOG_API_KEY`），不進 git、不貼在聊天裡。
- **Scope**：`foodlog:read`（讀取、summary、trends、history）、`foodlog:write.kyujin`（`mutate`）。身分（actor）由 key 決定，請求裡不用也不能自己報 `client:"kyujin"`。
- **格式**：全部 JSON，`Content-Type: application/json`。
- **OpenAPI**：`GET <WORKER_ORIGIN>/bot/v1/openapi.json`（同樣要帶 Bearer key）。

下面的範例用 `$BASE` 和 `$KEY`：

```bash
set -a; . ~/.config/studio/bots/kyujin.env; set +a
BASE="$FOODLOG_API_BASE"      # <WORKER_ORIGIN>/bot/v1
KEY="$FOODLOG_API_KEY"
```

## 回應格式

成功：HTTP 200，`{ "ok": true, … }`。失敗：`{ "ok": false, "error": "<code>", "message": "…", "details"?: {…} }`，HTTP 狀態碼如下。

| `error` | HTTP | 意思 | 要不要重試 |
|---|---|---|---|
| `unauthorized` | 401 | 沒帶 key、key 不認得、已撤銷、已過期 | **不要**。把這件事告訴 Brian，由他發新的 key |
| `forbidden` | 403 | 這把 key 或這個動作沒有權限（權限矩陣、不在 `mutate` 的七個名稱內、scope 不夠） | 不要 |
| `bad_record` | 400 | 參數或欄位不合法（含改 Log 的 `source`、`weekStart` 不是週一） | 不要，修正內容 |
| `not_found` | 404 | 找不到要處理的列。Kyujin 目前遇不到：Log 的列不存在時先回 `forbidden` | 不要 |
| `duplicate_name` | 409 | 店名正規化後和另一家未刪除的店重複；`details` 有 `existingId`、`existingName` | 不要，改用既有的店 |
| `unavailable` | 503 | 暫時性錯誤（並行寫入太多、儲存層暫時失敗） | **可以**，等幾秒再送同一個請求（見下方「重送」） |

### `unauthorized`（key 被撤銷）

```json
{ "ok": false, "error": "unauthorized", "message": "missing, unknown, revoked or expired API key" }
```

撤銷後的**下一個請求**就會是這個。重送一定還是 `unauthorized`，不要排進重試佇列；告訴 Brian，他會用 `scripts/bot-key.ts` 發新 key 並更新 `kyujin.env`。

### `read_only`（還在打舊的 `/exec`）

搬家後，舊的 Apps Script `/exec` 會把所有寫入回成 `read_only`（`read`、`history`、`summary`、`trends` 還能讀）：

```json
{ "ok": false, "error": "read_only", "message": "food-log 已搬到新網址，這裡只能讀" }
```

意思是服務已經搬家，**不要重試**，也不要把這筆寫入排進重試佇列。把這件事告訴 Brian，換成本文件的網址和 key。v2 的 API 本身不會回 `read_only`。

### 重送

`mutate` 的每個動作都用紀錄的 `id` 當冪等鍵：同一個 `logs.add`、`weights.upsert` 送兩次（例如逾時後重送）只會生效一次，第二次得到 `{"ok":true,"result":{"duplicate":true}}`；`upsert` 類（店家、品項）重送只是再寫一次同樣的列。所以 `503`、逾時、斷線都可以放心用**同一個 body** 重送；其他錯誤碼不要重送。

## 讀取

### `GET /read`

```bash
curl -sS "$BASE/read" -H "Authorization: Bearer $KEY"
```

回 `ok`、`serverTime`、`config`、`items`、`stores`、`logs`、`weights`、`logDays`（35）、`weightDays`（90）。Items、Stores、Config 全給（含已刪除，`deleted_at` 不是 `null` 的就是已刪除）；Logs 往回 35 天（含今天）；Weights 往回 90 天。更早的用 `history`。

`config` 是有型別的物件（見下方欄位對照），沒有設定過時回預設值（2000 kcal / 150 g / 60 g / 200 g）。

### `GET /summary?day=YYYY-MM-DD`

問「這天還剩多少」。`day` 省略就是台北時間的今天。

```bash
curl -sS "$BASE/summary?day=2026-10-10" -H "Authorization: Bearer $KEY"
```

```json
{
  "ok": true,
  "day": "2026-10-10",
  "count": 2,
  "totals": { "kcal": 300, "protein": 40.5, "fat": 10, "carb": 20 },
  "targets": { "kcal": 2000, "protein": 150, "fat": 60, "carb": 200 },
  "remaining": { "kcal": 1700, "protein": 109.5, "fat": 50, "carb": 180 }
}
```

和 App 用同一份計算，數字一致。`remaining = target - total`，可以是負數（表示超過）。加總用 Logs 上已經存好的數字，不要依份量重算。

### `GET /trends?weekStart=YYYY-MM-DD`

`weekStart` 必須是週一，否則 `bad_record`。

```bash
curl -sS "$BASE/trends?weekStart=2026-10-05" -H "Authorization: Bearer $KEY"
```

回 `ok`、`weekStart`、`weekEnd`、`avgKcal`、`avgDeficit`、`proteinHit`、`proteinDenom`、`incompleteDays`（形狀和 App 的 `weekSummary()` 相同；沒有完整日或沒設 `tdee` 時 `avgKcal`／`avgDeficit` 是 `null`）。

### `GET /history?table=logs|weights&before=YYYY-MM-DD&limit=`

往回翻 `read` 窗口以外的資料。回 `day < before` 的列，新的在前（含已刪除），最多 `limit` 筆（預設 35，最多 90）。`hasMore` 為 `true` 時，用這一頁最舊的 `day` 當下一次的 `before`。

```bash
curl -sS "$BASE/history?table=logs&before=2026-09-01&limit=90" -H "Authorization: Bearer $KEY"
```

```json
{ "ok": true, "table": "logs", "records": [ { "id": "…", "day": "2026-08-31", "…": "…" } ], "hasMore": true }
```

## 寫入：`POST /mutate`

```json
{ "name": "<動作>@1", "args": { … } }
```

`name` 必須帶版本（`@1`），而且只能是下面七個；其他（刪除或復原店家、品項的刪除與復原、體重的刪除與復原、設定、收藏）一律 `forbidden`。成功回 `{ "ok": true, "result": { … } }`。

| `name` | `args` | 重點 |
|---|---|---|
| `logs.add@1` | `{ log, item? }` | `log.source` 必須是 `"kyujin"`。`item_id` 空字串或 `null` 表示沒有品項的估算（`qty` 必須是 1、沒有 `grams`、`src` 是 `其他`、沒有店家）。`item` 是同時新建的自建品項（先寫），`log.item_id` 要等於 `item.id` |
| `logs.update@1` | `{ id, patch }` | 只能改 `source:"kyujin"` 的列。`patch` 白名單：`qty`、`grams`、`kcal`、`protein`、`fat`、`carb`、`ts`、`day`、`name`。改 `source` 是 `bad_record` |
| `logs.delete@1` / `logs.restore@1` | `{ id }` | 只能動 `source:"kyujin"` 的列（不存在或不是 kyujin 的都是 `forbidden`） |
| `items.upsert@1` | 品項（見下） | 店家品項（`store_id` 非空）可以改 App 建的；沒有店家的 `u:` 品項只能寫自己建的；`ov:`、`fm:`、`711:` 是 `forbidden` |
| `stores.upsert@1` | `{ id, name, ts? }` | 新建時 `created_by` 自動是 `kyujin`；改名保留原本的。重名回 `duplicate_name` |
| `weights.upsert@1` | `{ id, day, ts, kg }` | `kg` 30.0–250.0、最多一位小數；`day` 要等於 `ts` 的台北日期、不能晚於今天。同一天已有未刪除的列：覆寫 `kg` 和 `ts`、保留原本的 `id`，回 `{ rowId, overwritten: true, prevKg }` |

### `weights.upsert`

```bash
curl -sS -X POST "$BASE/mutate" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' --data '{
  "name": "weights.upsert@1",
  "args": { "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "day": "2026-10-10", "ts": "2026-10-10T08:00:00+08:00", "kg": 72.4 }
}'
```

```json
{ "ok": true, "result": { "rowId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "overwritten": false, "prevKg": null } }
```

### `stores.upsert`

```bash
curl -sS -X POST "$BASE/mutate" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' --data '{
  "name": "stores.upsert@1",
  "args": { "id": "s:11111111-1111-4111-8111-111111111111", "name": "阿財牛肉麵", "ts": "2026-10-10T12:00:00+08:00" }
}'
```

`id` 必須以 `s:` 開頭，店名 trim 後不可空。其他未刪除店家正規化後同名：

```json
{
  "ok": false,
  "error": "duplicate_name",
  "message": "已經有「阿財牛肉麵」",
  "details": { "existingId": "s:11111111-1111-4111-8111-111111111111", "existingName": "阿財牛肉麵" }
}
```

### `items.upsert`

自建品項（沒有店家）：`id` 以 `u:` 開頭、`kind` 是 `自建`、`base_id` 是 `null`。店家品項再加 `store_id`（未刪除的店），而且 `src` 必須是 `其他`。`created_by` 不用送，由 key 決定。

```bash
curl -sS -X POST "$BASE/mutate" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' --data '{
  "name": "items.upsert@1",
  "args": {
    "id": "u:22222222-2222-4222-8222-222222222222",
    "kind": "自建",
    "base_id": null,
    "src": "其他",
    "name": "牛肉麵",
    "serving": "1 份",
    "serving_g": null,
    "kcal": 520, "protein": 28, "fat": 18, "carb": 62,
    "store_id": "s:11111111-1111-4111-8111-111111111111",
    "ts": "2026-10-10T12:00:00+08:00"
  }
}'
```

熱量、蛋白質、脂肪、碳水都必須是 ≥ 0 的有限數字（`0` 可以）；`serving_g` 是 `null` 或大於 0。

### `logs.add`

```bash
curl -sS -X POST "$BASE/mutate" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' --data '{
  "name": "logs.add@1",
  "args": {
    "log": {
      "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "ts": "2026-10-10T12:00:00+08:00",
      "day": "2026-10-10",
      "item_id": "u:22222222-2222-4222-8222-222222222222",
      "name": "牛肉麵",
      "src": "其他",
      "qty": 1,
      "grams": null,
      "kcal": 520, "protein": 28, "fat": 18, "carb": 62,
      "source": "kyujin",
      "store_id": "s:11111111-1111-4111-8111-111111111111"
    }
  }
}'
```

成功回 `{ "ok": true, "result": { "rowId": "bbbbbbbb-…" } }`，之後 `summary` 的剩餘立刻含這一筆。不帶 `source` 或 `source` 不是 `kyujin`：`forbidden`。沒有品項的估算：`item_id` 給 `""`（或 `null`）、`name` 隨意、`qty:1`、`src:"其他"`、不帶 `store_id`。

### 不允許的例子（`forbidden`）

改 `source:"app"` 的 Log：

```bash
curl -sS -X POST "$BASE/mutate" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  --data '{ "name": "logs.update@1", "args": { "id": "an-app-log-id", "patch": { "kcal": 99 } } }'
```

```json
{ "ok": false, "error": "forbidden", "message": "Kyujin 只能寫入自建品項或體重" }
```

## 和 v1（`kyujin-api.md`）的對照

### 動作

| v1（Apps Script `/exec`，`POST`，`text/plain`） | v2（`/bot/v1`，JSON） |
|---|---|
| `{"secret":…,"client":"kyujin","action":"read"}` | `GET /read` |
| `action:"summary"`、`day` | `GET /summary?day=` |
| `action:"trends"`、`weekStart` | `GET /trends?weekStart=` |
| `action:"history"`、`table:"Logs"`／`"Weights"`、`before`、`limit` | `GET /history?table=logs`／`weights`（小寫）`&before=&limit=` |
| `append` `table:"Logs"`、`record` | `POST /mutate` `logs.add@1` `{ log }`（品項在同一個請求用 `item`，不再有 `groupId`） |
| `update` `table:"Logs"`、`id`、`patch` | `logs.update@1` `{ id, patch }` |
| `softDelete` `table:"Logs"` | `logs.delete@1` `{ id }` |
| `restore` `table:"Logs"` | `logs.restore@1` `{ id }` |
| `upsertItem`、`record` | `items.upsert@1` `{…品項…}`（`record` 的內容直接放 `args`） |
| `upsertStore`、`record` | `stores.upsert@1` `{ id, name, ts }` |
| `upsertWeight`、`record` | `weights.upsert@1` `{ id, day, ts, kg }` |
| `softDelete`／`restore` 店家、品項、體重；`setConfig` | 沒有（`forbidden`） |

### 請求與回應

| v1 | v2 |
|---|---|
| `"secret": "<SECRET>"`（共享密鑰） | `Authorization: Bearer <KEY>`（Kyujin 專用，可單獨撤銷） |
| `"client": "kyujin"`（自己報） | 拿掉；身分由 key 決定 |
| `record.created_by: "kyujin"` | 拿掉；新建時依 key 自動是 `kyujin`，之後不變 |
| 一律 HTTP 200，看 `ok` | 看 `ok` 也看 HTTP 狀態碼（401／403／400／404／409／503） |
| `{ "ok": true, "duplicate": true }` | `{ "ok": true, "result": { "duplicate": true } }` |
| `{ "ok": true }`（upsert、append） | `{ "ok": true, "result": { "rowId": "…" } }` |
| `duplicate_name`：`existingId`、`existingName` 在最上層 | 在 `details` 裡 |
| `read` 的 `version: 1` | 沒有 |
| `read_only`（搬家後的 `/exec`） | v2 不會回；`unauthorized` 代表 key 失效 |

### 欄位

| 表 | v1 | v2 |
|---|---|---|
| 全部 | `deleted: true／false` | `deleted_at`：`null` 是存在，字串是刪除時間（台北時間 ISO） |
| 全部 | `updated_at` | `updated_at`（不能自己送，由伺服器寫） |
| Items | `store`（店家 id，空字串表示沒有） | `store_id`（`null` 表示沒有） |
| Items | `base_id: ""` | `base_id: null` |
| Items | `fav`（是否收藏） | 沒有。收藏另外存（`favorites`），Kyujin 讀不到也不能改 |
| Items | `created_by`（送出） | `created_by`（只讀） |
| Items | — | 新增 `cascade_of`（只讀：因為店家被刪而連帶刪除時，記下店家 id） |
| Stores | — | 新增 `name_norm`（只讀）、`last_eaten_at`（只讀，由 `logs.add` 往後更新） |
| Logs | `store` | `store_id` |
| Logs | `item_id: ""` | `item_id: ""` 或 `null`（讀回來是 `null`） |
| Logs | `source`（沒帶就是 `app`） | `logs.add` 必須帶 `source:"kyujin"` |
| Config | `key/value` 字串 map（`target_kcal: "2000"`、`tdee: ""`、`remind_meal_times: "08:00,12:30"`、`fav_ids`） | 有型別的物件：`target_kcal`／`target_protein`／`target_fat`／`target_carb`（數字）、`tdee`（數字或 `null`）、`remind_meal_times`（字串陣列）、`remind_weight_time`（字串或 `null`）；沒有 `fav_ids` |
| `history` 的 `table` | `Logs`／`Weights` | `logs`／`weights` |
