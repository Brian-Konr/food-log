# Kyujin API

Kyujin 是外部客戶端，用和 App 同一個 Apps Script `/exec` 網址與共享密鑰。每個請求都要帶 `"client": "kyujin"`。

把下面的 `<GAS_EXEC_URL>` 換成結尾是 `/exec` 的網址，把 `<SECRET>` 換成共享密鑰。不要把真實密鑰或網址寫進這個檔。

前端一律 `POST`、`Content-Type: text/plain;charset=utf-8`，body 是 JSON。

Kyujin **可以**：`read`、`summary`、`trends`、`history`、`upsertStore`（新建必須 `created_by:kyujin`；可以改 App 建的店名，`created_by` 仍是 `app`）、店家品項 `upsertItem`（`store` 非空，即使原 `created_by` 是 `app`）、寫 `source:"kyujin"` 的 Logs（`item_id` 可空或指向品項）、改／軟刪／復原 `source:"kyujin"` 的 Logs、寫自己建的沒有店家的 `u:` 品項、`upsertWeight`。

Kyujin **不可以**：刪除或復原店家、寫不帶 `source` 或 `source` 為 `app`／`quick` 的 Logs、改／刪 `app` 或 `quick` 的 Logs、把 Log 的 `source` 改掉、改沒有店家的 App 自建品項、補填官方品項（`ov:`）、改官方 id（`fm:` / `711:`）、`setConfig`。這些會得到 `forbidden`（改 `source` 是 `bad_record`）。

`summary` 的 `remaining` 可以是負數，表示當天已經超過目標。App 會顯示「超過」，不會顯示負號。加總用 Logs 上已經存好的數字，不要依份量重算。

## read

```bash
curl -sS -X POST '<GAS_EXEC_URL>' \
  -H 'Content-Type: text/plain;charset=utf-8' \
  --data '{"secret":"<SECRET>","client":"kyujin","action":"read"}'
```

成功時 `ok` 為 true，`version` 為 1，並帶回 `serverTime`、`config`、`items`、`stores`、`logs`、`weights`。Items、Stores 與 Config 全給（含已刪除）。Logs 往回 35 天，Weights 往回 90 天，回應 `weightDays` 為 90。

## summary

問「這天還剩多少」。

```bash
curl -sS -X POST '<GAS_EXEC_URL>' \
  -H 'Content-Type: text/plain;charset=utf-8' \
  --data '{"secret":"<SECRET>","client":"kyujin","action":"summary","day":"2026-10-10"}'
```

成功範例：

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

`remaining = target - total`。若 `remaining.kcal` 是 `-150`，表示熱量超過 150，不是要顯示「−150」。

## trends

`weekStart` 必須是週一的 `YYYY-MM-DD`。

```bash
curl -sS -X POST '<GAS_EXEC_URL>' \
  -H 'Content-Type: text/plain;charset=utf-8' \
  --data '{"secret":"<SECRET>","client":"kyujin","action":"trends","weekStart":"2026-10-05"}'
```

回該週摘要，形狀與 App 的 `weekSummary()` 相同（平均熱量、赤字、蛋白質達標天數等）。不是週一會得到 `bad_record`。

## upsertItem（自建，成功）

`id` 必須以 `u:` 開頭，`kind` 為 `自建`，`created_by` 必須是 `kyujin`。同一 `id` 再送一次是更新該列，不會插第二列。

```bash
curl -sS -X POST '<GAS_EXEC_URL>' \
  -H 'Content-Type: text/plain;charset=utf-8' \
  --data '{
    "secret": "<SECRET>",
    "client": "kyujin",
    "action": "upsertItem",
    "record": {
      "id": "u:11111111-1111-4111-8111-111111111111",
      "ts": "2026-10-10T12:00:00+08:00",
      "deleted": false,
      "kind": "自建",
      "base_id": "",
      "src": "其他",
      "name": "雞胸沙拉",
      "serving": "1 份",
      "serving_g": 200,
      "kcal": 250,
      "protein": 40,
      "fat": 6,
      "carb": 8,
      "fav": false,
      "created_by": "kyujin"
    }
  }'
```

成功時 `{ "ok": true }`。熱量、蛋白質、脂肪、碳水都必須是 ≥ 0 的有限數字（`0` 可以）。

## upsertWeight（成功）

```bash
curl -sS -X POST '<GAS_EXEC_URL>' \
  -H 'Content-Type: text/plain;charset=utf-8' \
  --data '{
    "secret": "<SECRET>",
    "client": "kyujin",
    "action": "upsertWeight",
    "record": {
      "day": "2026-10-10",
      "kg": 72.4,
      "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "ts": "2026-10-10T08:00:00+08:00"
    }
  }'
```

`kg` 範圍 30.0–250.0，最多一位小數。`day` 必須等於 `ts` 的台北日期，且不能晚於台北今天。同一天再用新的 `id` 送一次會覆寫公斤數，列的 `id` 仍是第一筆。重送同一個 `id` 會得到 `{ "ok": true, "duplicate": true }`，不會改儲存格。

## upsertStore（成功）

```bash
curl -sS -X POST '<GAS_EXEC_URL>' \
  -H 'Content-Type: text/plain;charset=utf-8' \
  --data '{
    "secret": "<SECRET>",
    "client": "kyujin",
    "action": "upsertStore",
    "record": {
      "id": "s:11111111-1111-4111-8111-111111111111",
      "ts": "2026-10-10T12:00:00+08:00",
      "name": "阿財牛肉麵",
      "created_by": "kyujin"
    }
  }'
```

成功時 `{ "ok": true }`。同一 `id` 再送是改名。店名 trim 後不可空。其他未刪除店家正規化後同名會得到：

```json
{
  "ok": false,
  "error": "duplicate_name",
  "message": "已經有「阿財牛肉麵」",
  "existingId": "s:11111111-1111-4111-8111-111111111111",
  "existingName": "阿財牛肉麵"
}
```

新建時 `created_by` 必須是 `kyujin`，否則 `forbidden`。

## upsertItem（店家品項）

`store` 為未刪除的 `Stores.id`，`kind` 為 `自建`，`src` 為 `其他`，`id` 以 `u:` 開頭。Kyujin 可以改 App 建的店家品項。

```bash
curl -sS -X POST '<GAS_EXEC_URL>' \
  -H 'Content-Type: text/plain;charset=utf-8' \
  --data '{
    "secret": "<SECRET>",
    "client": "kyujin",
    "action": "upsertItem",
    "record": {
      "id": "u:22222222-2222-4222-8222-222222222222",
      "ts": "2026-10-10T12:00:00+08:00",
      "deleted": false,
      "kind": "自建",
      "base_id": "",
      "src": "其他",
      "name": "牛肉麵",
      "serving": "1 份",
      "serving_g": null,
      "kcal": 520,
      "protein": 28,
      "fat": 18,
      "carb": 62,
      "fav": false,
      "created_by": "kyujin",
      "store": "s:11111111-1111-4111-8111-111111111111"
    }
  }'
```

## append Logs（source:kyujin，成功）

```bash
curl -sS -X POST '<GAS_EXEC_URL>' \
  -H 'Content-Type: text/plain;charset=utf-8' \
  --data '{
    "secret": "<SECRET>",
    "client": "kyujin",
    "action": "append",
    "table": "Logs",
    "record": {
      "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "ts": "2026-10-10T12:00:00+08:00",
      "day": "2026-10-10",
      "item_id": "u:22222222-2222-4222-8222-222222222222",
      "name": "牛肉麵",
      "src": "其他",
      "qty": 1,
      "kcal": 520,
      "protein": 28,
      "fat": 18,
      "carb": 62,
      "source": "kyujin",
      "store": "s:11111111-1111-4111-8111-111111111111"
    }
  }'
```

成功時 `{ "ok": true }`。之後 App 的 `summary` 剩餘立刻含這一筆。不帶 `source` 或 `source` 為 `app`／`quick` 會得到 `forbidden`。

## update／softDelete Logs（source:kyujin）

目標列的 `source` 必須是 `kyujin`。改 `source` 會得到 `bad_record`。改 `source:"app"` 的 Log：

```bash
curl -sS -X POST '<GAS_EXEC_URL>' \
  -H 'Content-Type: text/plain;charset=utf-8' \
  --data '{
    "secret": "<SECRET>",
    "client": "kyujin",
    "action": "update",
    "table": "Logs",
    "id": "an-app-log-id",
    "patch": { "kcal": 99 }
  }'
```

回應：

```json
{
  "ok": false,
  "error": "forbidden",
  "message": "Kyujin 只能寫入自建品項或體重"
}
```

