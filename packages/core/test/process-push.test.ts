import { describe, expect, test } from 'vitest'
import { KYUJIN } from '../src/actor'
import { MutationError, TransientError } from '../src/errors'
import { BOT_MUTATION_NAMES } from '../src/registry'
import { MAX_PUSH_MUTATIONS, pushRequestSchema } from '../src/protocol/push'
import type { PushMutation } from '../src/protocol/push'
import { MUTATION_OUTCOME_RETENTION } from '../src/server/store'
import { processPush } from '../src/server/process-push'
import { itemArgs, logArgs, storeArgs, TEST_NOW, weightArgs } from '../src/testing'
import { newServer, row } from './helpers'

const m = (id: number, name: string, args: unknown): PushMutation => ({ id, name, args, clientTs: TEST_NOW })

describe('冪等（clientId + mutationId）', () => {
  test('同一批送兩次只生效一次，版本號不再增加，第二次回「已處理」', async () => {
    const s = newServer()
    const req = { clientId: 'c1', mutations: [m(1, 'weights.upsert@1', weightArgs({ id: 'w1', kg: 72 })), m(2, 'logs.add@1', { log: logArgs({ id: 'l1' }) })] }
    const first = await s.push(req)
    expect(first.results.map((r) => r.ok)).toEqual([true, true])
    expect(first.lastMutationId).toBe(2)
    const v = s.db.version
    const rows = JSON.stringify(s.snapshot())
    const second = await s.push(req)
    expect(second.lastMutationId).toBe(2)
    // 重送回傳當時的原始結果（成功結果存在 mutation_outcomes）。
    expect(second.results).toEqual(first.results)
    expect(second.results).toEqual([
      { id: 1, ok: true, result: { rowId: 'w1', overwritten: false, prevKg: null } },
      { id: 2, ok: true, result: { rowId: 'l1' } },
    ])
    expect(s.db.version).toBe(v)
    expect(JSON.stringify(s.snapshot())).toBe(rows)
  })

  test('逾時重送後面多帶新的一筆：舊的跳過，新的照常處理', async () => {
    const s = newServer()
    await s.push({ clientId: 'c1', mutations: [m(1, 'weights.upsert@1', weightArgs({ id: 'w1', kg: 72 }))] })
    const res = await s.push({
      clientId: 'c1',
      mutations: [m(1, 'weights.upsert@1', weightArgs({ id: 'w1', kg: 99 })), m(2, 'logs.add@1', { log: logArgs({ id: 'l1' }) })],
    })
    expect(res.lastMutationId).toBe(2)
    expect(row(s, 'weights', 'w1').kg).toBe(72) // 重送的 id=1 沒有再執行（即使內容不同）
    expect(row(s, 'logs', 'l1')).toBeDefined()
  })

  test('批次內 id 倒退（[2, 1]）：id=1 已經被前面推進的 lastMutationId 蓋過，當成已處理', async () => {
    const s = newServer()
    const res = await s.push({
      clientId: 'c1',
      mutations: [m(2, 'weights.upsert@1', weightArgs({ id: 'w2', day: '2026-10-09', ts: '2026-10-09T08:00:00+08:00' })), m(1, 'weights.upsert@1', weightArgs({ id: 'w1', day: '2026-10-10', ts: '2026-10-10T08:00:00+08:00' }))],
    })
    expect(res.results[1]).toEqual({ id: 1, ok: true, result: { replayed: true } })
    expect(s.db.tables.weights.has('w1')).toBe(false)
  })

  test('不同 clientId 各自計算 lastMutationId', async () => {
    const s = newServer()
    await s.push({ clientId: 'a', mutations: [m(1, 'weights.upsert@1', weightArgs({ id: 'wa' }))] })
    const b = await s.push({ clientId: 'b', mutations: [m(1, 'weights.upsert@1', weightArgs({ id: 'wb', kg: 70 }))] })
    expect(b.results[0]).toMatchObject({ ok: true, result: { overwritten: true } }) // b 的 id=1 不是 a 的重送
    expect(await s.getLastMutationId('a')).toBe(1)
    expect(await s.getLastMutationId('b')).toBe(1)
  })
})

describe('版本號與結果', () => {
  test('只有成功寫入才 +1；一個 mutation 寫多列也只 +1，且列的 version 相同', async () => {
    const s = newServer()
    await s.mutate('stores.upsert@1', storeArgs({ id: 's:1' }))
    await s.mutate('items.upsert@1', itemArgs({ id: 'u:a', store_id: 's:1' }))
    await s.mutate('items.upsert@1', itemArgs({ id: 'u:b', store_id: 's:1' }))
    expect(s.db.version).toBe(3)
    await s.mutate('stores.delete@1', { id: 's:1' })
    expect(s.db.version).toBe(4)
    expect(row(s, 'stores', 's:1').version).toBe(4)
    expect(row(s, 'items', 'u:a').version).toBe(4)
    expect(row(s, 'items', 'u:b').version).toBe(4)
  })

  test('業務錯誤、ignored、duplicate 都不增加版本號，但 lastMutationId 照樣前進', async () => {
    const s = newServer()
    await s.mutate('logs.add@1', { log: logArgs({ id: 'l1' }) })
    await s.mutate('logs.delete@1', { id: 'l1' })
    const v = s.db.version
    const last = await s.getLastMutationId(s.clientIdOf(KYUJIN))
    const owner = s.clientIdOf({ kind: 'owner', name: 'app' })
    const before = await s.getLastMutationId(owner)
    await s.mutate('logs.update@1', { id: 'l1', patch: { qty: 2 } }) // ignored
    await s.mutate('logs.add@1', { log: logArgs({ id: 'l1' }) }) // duplicate
    await s.mutate('logs.restore@1', { id: 'nope' }) // not_found
    await s.mutateRaw('nope.nope@1', {}) // 未知名稱
    expect(s.db.version).toBe(v)
    expect(await s.getLastMutationId(owner)).toBe(before + 4)
    expect(await s.getLastMutationId(s.clientIdOf(KYUJIN))).toBe(last)
  })

  test('結果型別：ignored、duplicate、{rowId, overwritten, prevKg}', async () => {
    const s = newServer()
    expect(await s.mutate('weights.upsert@1', weightArgs({ id: 'w1' }))).toEqual({ id: 1, ok: true, result: { rowId: 'w1', overwritten: false, prevKg: null } })
    expect(await s.mutate('weights.upsert@1', weightArgs({ id: 'w1' }))).toMatchObject({ ok: true, result: { duplicate: true } })
    expect(await s.mutate('weights.upsert@1', weightArgs({ id: 'w2', kg: 73 }))).toMatchObject({ ok: true, result: { rowId: 'w1', overwritten: true, prevKg: 72 } })
    await s.mutate('weights.delete@1', { id: 'w1' })
    expect(await s.mutate('weights.delete@1', { id: 'w1' })).toMatchObject({ ok: true, result: { ignored: 'deleted' } })
  })
})

describe('業務錯誤的紀錄與回報', () => {
  test('記錄 error、message、details；重送時原樣再回一次；pull 帶 errors', async () => {
    const s = newServer()
    await s.push({ clientId: 'c1', mutations: [m(1, 'stores.upsert@1', storeArgs({ id: 's:1', name: '阿財' }))] })
    const req = { clientId: 'c1', mutations: [m(2, 'stores.upsert@1', storeArgs({ id: 's:2', name: ' 阿・財 ' }))] }
    const first = await s.push(req)
    expect(first.results[0]).toMatchObject({ id: 2, ok: false, error: 'duplicate_name', details: { existingId: 's:1', existingName: '阿財' } })
    expect(first.lastMutationId).toBe(2)
    expect(s.db.errors).toHaveLength(1)
    expect(s.db.errors[0]).toMatchObject({ clientId: 'c1', mutationId: 2, name: 'stores.upsert@1', error: 'duplicate_name' })
    const again = await s.push(req)
    expect(again.results[0]).toEqual(first.results[0])
    expect(s.db.errors).toHaveLength(1) // 重送不重複記錄
    const p = await s.pull({ clientId: 'c1', afterMutationId: 1 })
    expect(p.errors).toHaveLength(1)
    expect(p.errors[0]).toMatchObject({ mutationId: 2, error: 'duplicate_name', details: { existingId: 's:1' } })
    expect((await s.pull({ clientId: 'c1', afterMutationId: 2 })).errors).toEqual([])
    expect((await s.pull({ clientId: 'other' })).errors).toEqual([]) // 只回本裝置的
  })

  test('壞掉的批次中間有錯誤：後面的 mutation 照常處理', async () => {
    const s = newServer()
    const res = await s.push({
      clientId: 'c1',
      mutations: [
        m(1, 'weights.upsert@1', weightArgs({ id: 'w1' })),
        m(2, 'weights.upsert@1', weightArgs({ id: 'w2', kg: 5 })),
        m(3, 'logs.add@1', { log: logArgs({ id: 'l1' }) }),
      ],
    })
    expect(res.results.map((r) => r.ok)).toEqual([true, false, true])
    expect(res.lastMutationId).toBe(3)
    expect(row(s, 'logs', 'l1')).toBeDefined()
  })

  test('zod 驗證失敗、未知名稱 → bad_record（不是例外）', async () => {
    const s = newServer()
    const res = await s.push({
      clientId: 'c1',
      mutations: [m(1, 'weights.upsert@1', { id: 'w1' }), m(2, 'weights.upsert@9', weightArgs()), m(3, 'nope', {}), m(4, 'weights.upsert@1', null)],
    })
    for (const r of res.results) expect(r).toMatchObject({ ok: false, error: 'bad_record' })
    expect(res.lastMutationId).toBe(4)
    expect(s.db.version).toBe(0)
  })

  test('allow 清單（/bot/v1/mutate 的 7 個名稱）：其餘名稱 forbidden，在 mutator 之前擋下', async () => {
    const s = newServer()
    const run = (name: string, args: unknown, id: number) => s.push({ clientId: 'bot', mutations: [m(id, name, args)] }, KYUJIN, { allow: BOT_MUTATION_NAMES })
    expect((await run('stores.delete@1', { id: 's:1' }, 1)).results[0]).toMatchObject({ ok: false, error: 'forbidden' })
    expect((await run('favorites.set@1', { item_id: 'x', fav: true }, 2)).results[0]).toMatchObject({ ok: false, error: 'forbidden' })
    expect((await run('weights.upsert@1', weightArgs(), 3)).results[0]).toMatchObject({ ok: true })
    expect(BOT_MUTATION_NAMES).toHaveLength(7)
  })
})

describe('並行與暫時性錯誤（CAS）', () => {
  test('提交前別人先寫：CAS 失敗後重讀重試，同一天體重仍只有一筆未刪除', async () => {
    const s = newServer()
    let injected = false
    s.beforeCommit = async () => {
      if (injected) return
      injected = true
      await s.mutate('weights.upsert@1', weightArgs({ id: 'wB', kg: 71 }), KYUJIN) // 另一個 client 搶先寫了同一天
    }
    const res = await s.mutate('weights.upsert@1', weightArgs({ id: 'wA', kg: 72.5 }))
    // 第一次嘗試讀到「當天沒有紀錄」，CAS 失敗；重試時讀到 wB，所以是覆寫
    expect(res).toMatchObject({ ok: true, result: { rowId: 'wB', overwritten: true, prevKg: 71 } })
    const live = s.db.all('weights').filter((w) => w.deleted_at === null)
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ id: 'wB', kg: 72.5 })
  })

  test('CAS 一直失敗：重試 5 次後丟 TransientError（整批中止），先前提交的保留，之後重送能接續', async () => {
    const s = newServer()
    let attempts = 0
    s.beforeCommit = async () => {
      attempts += 1
      s.db.version += 1 // 模擬一直有人搶先提交
    }
    const req = { clientId: 'c1', mutations: [m(1, 'logs.add@1', { log: logArgs({ id: 'l1' }) })] }
    await expect(s.push(req)).rejects.toBeInstanceOf(TransientError)
    expect(attempts).toBe(5)
    expect(s.db.tables.logs.size).toBe(0)
    expect(await s.getLastMutationId('c1')).toBe(0)
    s.beforeCommit = undefined
    const ok = await s.push(req)
    expect(ok.results[0]).toMatchObject({ ok: true })
  })

  test('非業務錯誤（儲存層丟例外）原樣丟出，不記成業務錯誤', async () => {
    const s = newServer()
    s.beforeCommit = () => {
      throw new Error('D1 掛了')
    }
    await expect(s.mutate('weights.upsert@1', weightArgs())).rejects.toThrow('D1 掛了')
    expect(s.db.errors).toHaveLength(0)
    expect(s.db.version).toBe(0)
  })

  test('同一台裝置同時送兩次相同的批次（雙送）：只生效一次', async () => {
    const s = newServer()
    const req = { clientId: 'c1', mutations: [m(1, 'logs.add@1', { log: logArgs({ id: 'l1' }) })] }
    const [a, b] = await Promise.all([s.push(req), s.push(req)])
    expect(s.db.tables.logs.size).toBe(1)
    expect(s.db.version).toBe(1)
    expect([a.results[0]!.ok, b.results[0]!.ok]).toEqual([true, true])
    expect(await s.getLastMutationId('c1')).toBe(1)
  })
})

describe('成功結果的保存（mutation_outcomes）', () => {
  test('遺失回應後重送 weights.upsert 的覆寫：回傳原本的 {overwritten:true, prevKg}，不是 {replayed:true}，也不再寫入', async () => {
    const s = newServer()
    await s.push({ clientId: 'c1', mutations: [m(1, 'weights.upsert@1', weightArgs({ id: 'w1', kg: 72 }))] })
    const req = { clientId: 'c1', mutations: [m(2, 'weights.upsert@1', weightArgs({ id: 'w2', kg: 73.4 }))] }
    const first = await s.push(req) // 假裝這個回應在路上掉了
    expect(first.results[0]).toEqual({ id: 2, ok: true, result: { rowId: 'w1', overwritten: true, prevKg: 72 } })
    const v = s.db.version
    const replay = await s.push(req)
    expect(replay.results[0]).toEqual({ id: 2, ok: true, result: { rowId: 'w1', overwritten: true, prevKg: 72 } })
    expect(replay.lastMutationId).toBe(2)
    expect(s.db.version).toBe(v)
    expect(row(s, 'weights', 'w1').kg).toBe(73.4)
  })

  test('重送 ignored／duplicate 的結果也原樣回傳；業務錯誤照舊', async () => {
    const s = newServer()
    const reqs = [
      m(1, 'logs.add@1', { log: logArgs({ id: 'l1' }) }),
      m(2, 'logs.add@1', { log: logArgs({ id: 'l1' }) }), // duplicate
      m(3, 'logs.delete@1', { id: 'nope' }), // ignored:missing
      m(4, 'logs.restore@1', { id: 'nope' }), // not_found
    ]
    const first = await s.push({ clientId: 'c1', mutations: reqs })
    expect(first.results.map((r) => r.ok)).toEqual([true, true, true, false])
    const replay = await s.push({ clientId: 'c1', mutations: reqs })
    expect(replay.results).toEqual(first.results)
    expect(replay.results[1]).toMatchObject({ result: { duplicate: true } })
    expect(replay.results[2]).toMatchObject({ result: { ignored: 'missing' } })
  })

  test('結果只保留最近 MUTATION_OUTCOME_RETENTION 筆：更舊的重送退回 {replayed:true}', async () => {
    const s = newServer()
    const total = MUTATION_OUTCOME_RETENTION + 5
    for (let id = 1; id <= total; id++) {
      await s.push({ clientId: 'c1', mutations: [m(id, 'logs.delete@1', { id: `x${id}` })] })
    }
    expect(s.db.outcomes.size).toBe(MUTATION_OUTCOME_RETENTION)
    const old = await s.push({ clientId: 'c1', mutations: [m(1, 'logs.delete@1', { id: 'x1' })] })
    expect(old.results[0]).toEqual({ id: 1, ok: true, result: { replayed: true } })
    const recent = await s.push({ clientId: 'c1', mutations: [m(total, 'logs.delete@1', { id: `x${total}` })] })
    expect(recent.results[0]).toEqual({ id: total, ok: true, result: { ignored: 'missing' } })
  })
})

describe('批次大小', () => {
  test('MAX_PUSH_MUTATIONS 是 10（D1 免費方案每次呼叫 50 個查詢，每筆 mutation 約 4 個）；超過 10 筆的請求不合法', () => {
    expect(MAX_PUSH_MUTATIONS).toBe(10)
    const mk = (n: number) => ({ clientId: 'c', mutations: Array.from({ length: n }, (_, i) => m(i + 1, 'logs.delete@1', { id: 'x' })) })
    expect(pushRequestSchema.safeParse(mk(10)).success).toBe(true)
    expect(pushRequestSchema.safeParse(mk(11)).success).toBe(false)
  })
})

describe('commit 的唯一索引違反（guard 通過之後）= 業務錯誤 bad_record，不是暫時性衝突', () => {
  test('MemoryTx 模擬部分唯一索引：同一天寫兩筆未刪除的體重 → commit 丟 bad_record，什麼都沒寫', async () => {
    const s = newServer()
    const stx = await s.store.begin('c1')
    const base = { ts: '2026-10-11T08:00:00+08:00', kg: 72, deleted_at: null, updated_at: '2026-10-12T12:00:00+08:00' }
    stx.tx.put('weights', { id: 'a', day: '2026-10-11', ...base })
    stx.tx.put('weights', { id: 'b', day: '2026-10-11', ...base })
    await expect(stx.commit({ ok: true, mutationId: 1, result: {} })).rejects.toMatchObject({ code: 'bad_record' })
    expect(s.db.tables.weights.size).toBe(0)
    expect(s.db.version).toBe(0)
    expect(await s.getLastMutationId('c1')).toBe(0)
  })

  test('processPush 接住 commit 丟的 bad_record：記錄業務錯誤、cursor 前進、版本號不變，不重試', async () => {
    const s = newServer()
    const real = s.store
    let commits = 0
    // 包一層：第一次 ok 的 commit 丟 bad_record（模擬 D1 的 UNIQUE 違反），其餘照常。
    const wrapped = {
      ...real,
      userId: real.userId,
      begin: async (clientId: string) => {
        const stx = await real.begin(clientId)
        return {
          tx: stx.tx,
          version: stx.version,
          lastMutationId: stx.lastMutationId,
          hasWrites: () => stx.hasWrites(),
          commit: async (input: Parameters<typeof stx.commit>[0]) => {
            commits += 1
            if (input.ok && commits === 1) throw new MutationError('bad_record', '這天已經有一筆體重（唯一索引）')
            return stx.commit(input)
          },
        }
      },
      readMeta: () => real.readMeta(),
      rowsAfter: (a: number, l: number) => real.rowsAfter(a, l),
      rowsAtVersion: (v: number) => real.rowsAtVersion(v),
      getLastMutationId: (c: string) => real.getLastMutationId(c),
      getMutationOutcome: (c: string, id: number) => real.getMutationOutcome(c, id),
      listErrors: (c: string, a: number) => real.listErrors(c, a),
    }
    const res = await processPush(wrapped, s.ctx(), { clientId: 'c1', mutations: [m(1, 'weights.upsert@1', weightArgs({ id: 'w1' }))] })
    expect(res.results[0]).toMatchObject({ id: 1, ok: false, error: 'bad_record' })
    expect(commits).toBe(2) // 一次 ok（丟錯）、一次業務錯誤；沒有第三次
    expect(res.lastMutationId).toBe(1)
    expect(s.db.version).toBe(0)
    expect(s.db.tables.weights.size).toBe(0)
    expect(s.db.errors).toHaveLength(1)
  })

  test('commit 的兩個 guard：版本號被別人推進，或同一台裝置的 cursor 被別的請求推進，都回 false', async () => {
    const s = newServer()
    const a = await s.store.begin('c1')
    await s.mutate('weights.upsert@1', weightArgs({ id: 'w9' }), KYUJIN) // 另一台裝置推進了全域版本號
    expect(await a.commit({ ok: true, mutationId: 1, result: {} })).toBe(false)
    const b = await s.store.begin('c1')
    const c = await s.store.begin('c1')
    expect(await b.commit({ ok: true, mutationId: 1, result: {} })).toBe(true) // 沒有寫入：版本號不動，只有 cursor 推進
    expect(await c.commit({ ok: true, mutationId: 1, result: {} })).toBe(false) // cursor guard：版本號沒變，但 cursor 變了
  })
})
