// 在 node:vm 裡載入 gas/*.gs，並提供最小的 Apps Script 假物件（只為本機測試）
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

type Cell = unknown
let VmDate: DateConstructor = Date
class FakeSheet {
  data: Cell[][] = []
  frozen = 0
  maxRows = 1000
  textCells = new Set<string>()
  formats = new Map<string, string>()
  constructor(public name: string) {}
  getName() { return this.name }
  getMaxRows() { return this.maxRows }
  getLastRow() { return this.data.length }
  getLastColumn() { return this.data.reduce((m, r) => Math.max(m, r.length), 0) }
  getDataRange() { return { getValues: () => this.data.map((r) => { const w = this.getLastColumn(); return Array.from({ length: w }, (_, i) => r[i] ?? '') }) } }
  getRange(row: number, col: number, nr = 1, nc = 1) {
    const sh = this
    let text = false
    const range = {
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => sh.data[row - 1 + i]?.[col - 1 + j] ?? '')),
      setValues: (vals: Cell[][]) => { vals.forEach((r, i) => r.forEach((v, j) => sh.set(row + i, col + j, v))); return range },
      setValue: (v: Cell) => { sh.set(row, col, v, text); return range },
      setNumberFormat: (f: string) => {
        text = f === '@'
        for (let i = 0; i < nr; i++) {
          for (let j = 0; j < nc; j++) {
            const key = `${row + i}:${col + j}`
            sh.formats.set(key, f)
            if (f === '@') sh.textCells.add(key)
            else sh.textCells.delete(key)
          }
        }
        return range
      },
    }
    return range
  }
  set(row: number, col: number, v: Cell, text = false) {
    while (this.data.length < row) this.data.push([])
    const r = this.data[row - 1]
    while (r.length < col) r.push('')
    r[col - 1] = text || this.textCells.has(`${row}:${col}`) ? v : sheetCoerce(v)
  }
  appendRow(row: Cell[]) { this.data.push(row.map(sheetCoerce)) }
  setFrozenRows(n: number) { this.frozen = n }
}
function sheetCoerce(v: Cell): Cell {
  if (typeof v === 'string' && v === '7-11') {
    const taipeiYear = new Date(Date.now() + 8 * 3600 * 1000).getUTCFullYear()
    return new VmDate(Date.UTC(taipeiYear, 6, 11))
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new VmDate(v + 'T00:00:00Z')
  if (v === 'TRUE') return true
  if (v === 'FALSE') return false
  if (typeof v === 'string' && v !== '' && !isNaN(Number(v))) return Number(v)
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v)) return new VmDate(v)
  // 真的試算表會把「12:30」轉成 1899-12-30 的時間
  if (typeof v === 'string' && /^\d\d:\d\d$/.test(v)) return new VmDate(`1899-12-30T${v}:00+08:00`)
  return v
}

export function loadGas(opts: { lockBusy?: boolean } = {}) {
  const sheets = new Map<string, FakeSheet>()
  sheets.set('工作表1', new FakeSheet('工作表1'))
  const props = new Map<string, string>()
  const files: { id: string; name: string; mime: string; bytes: number[]; folder: string }[] = []
  const folders: string[] = []
  const logs: string[] = []
  const shares: string[] = []
  let uuid = 0
  let lockHeld = false
  const ss = {
    getSheetByName: (n: string) => sheets.get(n) ?? null,
    insertSheet: (n: string) => { const s = new FakeSheet(n); sheets.set(n, s); return s },
    getSheets: () => [...sheets.values()],
    deleteSheet: (s: FakeSheet) => sheets.delete(s.name),
    addEditor: (e: string) => shares.push('sheet-editor:' + e),
  }
  const ctx: Record<string, unknown> = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush: () => {} },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => {
          if (opts.lockBusy) return false
          if (lockHeld) return false
          lockHeld = true
          return true
        },
        releaseLock: () => { lockHeld = false },
      }),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k: string) => props.get(k) ?? null, setProperty: (k: string, v: string) => props.set(k, v) }) },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: (s: string) => ({ body: s, setMimeType() { return this } }) },
    DriveApp: {
      createFolder: (name: string) => { folders.push(name); return { getId: () => 'folder-' + folders.length } },
      getFolderById: (id: string) => ({
        addViewer: (e: string) => shares.push(id + '-viewer:' + e),
        createFile: (blob: { bytes: number[]; mime: string; name: string }) => {
          const f = { id: 'file-' + (files.length + 1), name: blob.name, mime: blob.mime, bytes: blob.bytes, folder: id }
          files.push(f)
          return { getId: () => f.id, getUrl: () => 'https://drive.google.com/file/d/' + f.id + '/view' }
        },
      }),
      getFileById: (id: string) => {
        const f = files.find((x) => x.id === id)
        if (!f) throw new Error('File not found: ' + id)
        let parentTaken = false
        return {
          getId: () => f.id,
          getParents: () => ({
            hasNext: () => !parentTaken,
            next: () => { parentTaken = true; return { getId: () => f.folder } },
          }),
          getBlob: () => ({ getContentType: () => f.mime, getBytes: () => f.bytes }),
        }
      },
    },
    Utilities: {
      base64Decode: (s: string) => [...Buffer.from(s, 'base64')],
      base64Encode: (bytes: number[] | Uint8Array) => Buffer.from(bytes).toString('base64'),
      newBlob: (bytes: number[], mime: string, name: string) => ({ bytes, mime, name }),
      getUuid: () => '00000000-0000-4000-8000-' + String(++uuid).padStart(12, '0'),
      formatDate: (d: Date, _tz?: string, fmt?: string) => {
        if (fmt === 'HH:mm') return new Date(d.getTime() + 8 * 3600e3).toISOString().slice(11, 16)
        const t = new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 19)
        return t + '+08:00'
      },
    },
    Logger: { log: (s: string) => logs.push(s) },
  }
  vm.createContext(ctx)
  VmDate = vm.runInContext('Date', ctx)
  ;(ctx as { Date: DateConstructor }).Date = VmDate
  for (const f of ['Schema.gs', 'Setup.gs', 'Code.gs', 'Trends.gs']) {
    vm.runInContext(readFileSync(resolve(import.meta.dirname, '../gas', f), 'utf8'), ctx, { filename: f })
  }
  // ISO timestamps are second-precision; bump nowIso_ so sequential API calls
  // get distinct updated_at (restore cascade matches that value).
  vm.runInContext(`
    (function () {
      var t = Date.now();
      nowIso_ = function () {
        t += 1000;
        return taipeiIso_(t);
      };
    })();
  `, ctx)
  const g = ctx as any
  const post = (body: unknown) => JSON.parse(g.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).body)
  const get = (parameter: Record<string, string>) => JSON.parse(g.doGet({ parameter }).body)
  return { g, sheets, props, files, folders, logs, shares, post, get }
}

export function readyGas(opts: { lockBusy?: boolean } = {}) {
  const env = loadGas(opts)
  env.g.setupFoodLog()
  const secret = env.props.get('SHARED_SECRET') as string
  const call = (body: Record<string, unknown>) => env.post({ secret, ...body })
  return { ...env, secret, call }
}
