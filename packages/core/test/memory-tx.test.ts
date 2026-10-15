import { describe, expect, test } from 'vitest'
import { OWNER } from '../src/actor'
import { executeMutation, lookupMutation, MUTATION_NAMES, mutations, BOT_MUTATION_NAMES } from '../src/registry'
import { CLIENT_VERSION, isClientTooOld, parseClientVersionHeader } from '../src/protocol/version'
import { MemoryDb, MemoryTx, ownerCtx, weightArgs, weightRow } from '../src/testing'
import { isMutationError } from '../src/errors'

describe('MemoryTx：先讀後寫', () => {
  test('put 之後再讀任何東西都丟錯（D1 的緩衝寫入讀不到）', async () => {
    const db = new MemoryDb()
    const tx = new MemoryTx(db)
    await tx.get('weights', 'w1') // 寫之前可以讀
    tx.put('weights', weightRow())
    await expect(tx.get('weights', 'w1')).rejects.toThrow('先寫後讀')
    await expect(tx.liveWeightOnDay('2026-10-11')).rejects.toThrow('先寫後讀')
    await expect(tx.liveStoreByNorm('x')).rejects.toThrow('先寫後讀')
    await expect(tx.itemsOfStore('s:1')).rejects.toThrow('先寫後讀')
    await expect(tx.getConfig()).rejects.toThrow('先寫後讀')
  })

  test('put 只進緩衝區，commit 才套用並蓋上 user_id 與 version', async () => {
    const db = new MemoryDb('user-x')
    const tx = new MemoryTx(db)
    tx.put('weights', weightRow({ id: 'w9' }))
    expect(db.tables.weights.size).toBe(0)
    expect(tx.commit()).toBe(1)
    expect(db.tables.weights.get('w9')).toMatchObject({ user_id: 'user-x', version: 1, id: 'w9' })
  })

  test('沒有寫入的 commit 不增加版本號', () => {
    const db = new MemoryDb()
    expect(new MemoryTx(db).commit()).toBe(0)
  })

  test('每個 mutation 都遵守先讀後寫：以各種狀態跑一遍都不會觸發 MemoryTx 的檢查', async () => {
    // MemoryServer 的所有 mutate 都走 MemoryTx；這裡把每個名稱各用合法參數和壞參數跑過，沒有任何一個丟出非業務錯誤。
    const { MemoryServer, itemArgs, logArgs, storeArgs } = await import('../src/testing')
    const s = new MemoryServer()
    const calls: [string, unknown][] = [
      ['stores.upsert@1', storeArgs()],
      ['items.upsert@1', itemArgs({ store_id: 's:1' })],
      ['logs.add@1', { log: logArgs({ item_id: 'u:item-1', src: '其他', store_id: 's:1' }), item: itemArgs({ store_id: 's:1' }) }],
      ['logs.update@1', { id: 'log-1', patch: { kcal: 1 } }],
      ['logs.delete@1', { id: 'log-1' }],
      ['logs.restore@1', { id: 'log-1' }],
      ['weights.upsert@1', weightArgs()],
      ['weights.upsert@1', weightArgs({ id: 'w2', kg: 73 })],
      ['weights.delete@1', { id: 'w1' }],
      ['weights.restore@1', { id: 'w1' }],
      ['favorites.set@1', { item_id: 'u:item-1', fav: true }],
      ['favorites.set@1', { item_id: 'u:item-1', fav: false }],
      ['config.set@1', { key: 'tdee', value: '2000' }],
      ['items.delete@1', { id: 'u:item-1' }],
      ['items.restore@1', { id: 'u:item-1' }],
      ['stores.delete@1', { id: 's:1' }],
      ['stores.restore@1', { id: 's:1' }],
    ]
    for (const [name, args] of calls) {
      for (const actor of [OWNER, { kind: 'bot', name: 'kyujin' } as const]) {
        const res = await s.mutateRaw(name, args, actor)
        // 只會是成功或業務錯誤；MemoryTx 的「先寫後讀」錯誤或其他例外會讓 mutateRaw reject
        expect(typeof res.ok).toBe('boolean')
      }
    }
  })
})

describe('registry', () => {
  test('計畫 §3.2 的所有 mutation 都以 @1 登錄', () => {
    expect([...MUTATION_NAMES].sort()).toEqual([
      'config.set@1', 'favorites.set@1', 'items.delete@1', 'items.restore@1', 'items.upsert@1',
      'logs.add@1', 'logs.delete@1', 'logs.restore@1', 'logs.update@1',
      'stores.delete@1', 'stores.restore@1', 'stores.upsert@1',
      'weights.delete@1', 'weights.restore@1', 'weights.upsert@1',
    ])
    expect(Object.keys(mutations)).toHaveLength(15)
  })

  test('lookupMutation：未知名稱、沒有版本、原型鏈上的名稱都找不到', () => {
    expect(lookupMutation('logs.add@1')).toBeDefined()
    expect(lookupMutation('logs.add')).toBeUndefined()
    expect(lookupMutation('logs.add@2')).toBeUndefined()
    expect(lookupMutation('constructor')).toBeUndefined()
    expect(lookupMutation('__proto__')).toBeUndefined()
  })

  test('Bot 可用的名稱是 7 個，且都在 registry 裡', () => {
    expect(BOT_MUTATION_NAMES).toHaveLength(7)
    for (const n of BOT_MUTATION_NAMES) expect(lookupMutation(n)).toBeDefined()
    for (const n of ['stores.delete@1', 'config.set@1', 'favorites.set@1', 'weights.delete@1', 'items.delete@1']) {
      expect(BOT_MUTATION_NAMES as readonly string[]).not.toContain(n)
    }
  })

  test('executeMutation：壞參數丟 MutationError(bad_record)，不是 ZodError', async () => {
    const db = new MemoryDb()
    const err = await executeMutation(new MemoryTx(db), ownerCtx(), 'weights.upsert@1', { id: 1 }).catch((e: unknown) => e)
    expect(isMutationError(err)).toBe(true)
    expect(err).toMatchObject({ code: 'bad_record' })
    const unknown = await executeMutation(new MemoryTx(db), ownerCtx(), 'zzz@1', {}).catch((e: unknown) => e)
    expect(unknown).toMatchObject({ code: 'bad_record' })
  })
})

describe('client version', () => {
  test('CLIENT_VERSION 是整數；太舊或沒帶標頭都算太舊', () => {
    expect(Number.isInteger(CLIENT_VERSION)).toBe(true)
    expect(isClientTooOld(CLIENT_VERSION, CLIENT_VERSION)).toBe(false)
    expect(isClientTooOld(CLIENT_VERSION - 1, CLIENT_VERSION)).toBe(true)
    expect(isClientTooOld(null, 1)).toBe(true)
    expect(isClientTooOld(undefined, 1)).toBe(true)
    expect(isClientTooOld(1.5, 1)).toBe(true)
  })
  test('parseClientVersionHeader', () => {
    expect(parseClientVersionHeader('3')).toBe(3)
    expect(parseClientVersionHeader(' 12 ')).toBe(12)
    for (const bad of ['', 'x', '-1', '1.5', null, undefined]) expect(parseClientVersionHeader(bad)).toBeNull()
  })
})
