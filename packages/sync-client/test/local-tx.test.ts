import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MutationError, mutations } from '@food-log/core'
import type { Tx } from '@food-log/core'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalTx } from '../src/local-tx'
import { newServer, openDevice, storeArgs, viewOf, weightArgs } from './helpers'

// 測試用的壞 mutator，直接掛進 core 的 registry（物件沒有凍結；測完拿掉）。
type Reg = Record<string, { args: { safeParse(v: unknown): unknown }; run: (tx: Tx, ctx: unknown, a: unknown) => Promise<unknown> }>
const registry = mutations as unknown as Reg
const added: string[] = []
function register(name: string, run: (tx: Tx) => Promise<unknown>) {
  registry[name] = { args: { safeParse: (data) => ({ success: true, data }) }, run: (tx) => run(tx) }
  added.push(name)
}
afterEach(() => {
  for (const n of added.splice(0)) delete registry[n]
})

describe('LocalTx', () => {
  it('寫入只進緩衝區：mutator 丟 MutationError 時畫面表完全沒變（不靠交易回滾）', async () => {
    const d = await openDevice({ server: newServer() })
    register('test.writeThenFail@1', async (tx) => {
      tx.put('weights', { id: 'w1', day: '2026-10-11', ts: '2026-10-11T08:00:00+08:00', kg: 70, deleted_at: null, updated_at: '' })
      throw new MutationError('bad_record', 'boom')
    })
    await expect(d.client.mutate('test.writeThenFail@1' as never, {} as never)).rejects.toMatchObject({ code: 'bad_record' })
    expect(await viewOf(d, 'weights')).toEqual([])
    expect(await d.client.db.pending.count()).toBe(0)
  })

  it('先寫後讀會丟錯（和 MemoryTx 一樣）：D1 的寫入是緩衝的，寫後讀不到', async () => {
    const d = await openDevice({ server: newServer() })
    const tx = new LocalTx(d.client.db, 'user-1')
    tx.put('weights', { id: 'w1', day: '2026-10-11', ts: '2026-10-11T08:00:00+08:00', kg: 70, deleted_at: null, updated_at: '' })
    await expect(tx.get('weights', 'w1')).rejects.toThrow(/先寫後讀/)
    await expect(tx.liveWeightOnDay('2026-10-11')).rejects.toThrow(/先寫後讀/)
    await expect(tx.liveStoreByNorm('x')).rejects.toThrow(/先寫後讀/)
    await expect(tx.itemsOfStore('s:1')).rejects.toThrow(/先寫後讀/)
    await expect(tx.getConfig()).rejects.toThrow(/先寫後讀/)
  })

  it('讀取：get／liveWeightOnDay／liveStoreByNorm／itemsOfStore／getConfig 都看畫面表', async () => {
    const d = await openDevice({ server: newServer() })
    await d.client.mutate('stores.upsert@1', storeArgs({ id: 's:1', name: '阿財牛肉麵' }))
    await d.client.mutate('weights.upsert@1', weightArgs({ id: 'w1' }))
    const tx = new LocalTx(d.client.db, 'user-1')
    await d.client.db.transaction('r', d.client.db.allTables, async () => {
      expect((await tx.get('stores', 's:1'))?.name).toBe('阿財牛肉麵')
      expect((await tx.liveWeightOnDay('2026-10-11'))?.id).toBe('w1')
      expect((await tx.liveStoreByNorm('阿財牛肉麵'))?.id).toBe('s:1')
      expect(await tx.liveStoreByNorm('阿財牛肉麵', 's:1')).toBeUndefined()
      expect(await tx.itemsOfStore('s:1')).toEqual([])
      expect((await tx.getConfig()).target_kcal).toBe(2000)
    })
  })
})

describe('Dexie 交易的自動提交規則：mutator 不能 await 外來的 promise', () => {
  it('mutator await 了 setTimeout：交易已經自動提交，後續的 Dexie 操作失敗，mutate 不會悄悄成功', async () => {
    const d = await openDevice({ server: newServer() })
    register('test.foreignAwait@1', async (tx) => {
      await tx.getConfig() // Dexie 操作：沒問題
      await new Promise((r) => setTimeout(r, 10)) // 外來的 promise：交易在這裡死掉
      await tx.getConfig() // 交易已提交 → 失敗
      return 'unreachable'
    })
    await expect(d.client.mutate('test.foreignAwait@1' as never, {} as never)).rejects.toThrow(/Transaction has already completed/)
    expect(await d.client.db.pending.count()).toBe(0)
    expect(await d.client.db.getMeta('nextMutationId', 0)).toBe(1)
  })

  it('mutator 只 await Dexie 的操作（含 Promise.all）就沒事', async () => {
    const d = await openDevice({ server: newServer() })
    register('test.dexieOnly@1', async (tx) => {
      await Promise.all([tx.getConfig(), tx.liveWeightOnDay('2026-10-11')])
      await tx.getConfig()
      return 'ok'
    })
    await expect(d.client.mutate('test.dexieOnly@1' as never, {} as never)).resolves.toBe('ok')
  })

  it('靜態防線：core 的 mutator 原始碼不得出現會產生外來 promise 的東西', () => {
    const dir = fileURLToPath(new URL('../../core/src/mutators/', import.meta.url))
    const forbidden = [/\bsetTimeout\b/, /\bsetInterval\b/, /\bfetch\s*\(/, /new Promise\b/, /\bcrypto\.subtle\b/, /\bindexedDB\b/, /\bXMLHttpRequest\b/, /\bnavigator\./, /\bPromise\.(race|any)\b/]
    const offenders: string[] = []
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(dir + f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      for (const re of forbidden) if (re.test(src)) offenders.push(`${f}: ${re}`)
    }
    expect(offenders).toEqual([])
  })
})
