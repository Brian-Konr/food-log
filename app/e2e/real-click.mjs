// 真實點擊冒煙測試（WebKit iPhone 13，本機試用模式）。
// 用法：npm run e2e
// PLAYWRIGHT_DIR 預設 /workspace/photo-repro/node_modules/playwright，不下載瀏覽器。
// 沒有人先開 dev server 時會自己起 vite。一律 locator.click；console error 即失敗。
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const PLAYWRIGHT_DIR = process.env.PLAYWRIGHT_DIR || '/workspace/photo-repro/node_modules/playwright'
process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD ??= '1'
const { webkit, devices } = require(PLAYWRIGHT_DIR)
const BASE = process.argv[2] || 'http://127.0.0.1:5191/'
const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const SHOTS = fileURLToPath(new URL('./shots/', import.meta.url))
mkdirSync(SHOTS, { recursive: true })
const SIZES = [[390, 844], [844, 390]]
// Playwright 的 iPhone 13 預設 viewport 是 390×664（扣掉 Safari chrome），screen 才是 844。
// 先用 844 建 context，tab bar 才會貼齊 390×844 截圖底部；之後再 setViewportSize(844) 會讓 visual viewport 卡在 664。
const IPHONE = {
  ...devices['iPhone 13'],
  viewport: { width: 390, height: 844 },
  screen: { width: 390, height: 844 },
  locale: 'zh-TW',
  timezoneId: 'Asia/Taipei',
}
const errors = []
const step = (s) => console.log('·', s)
const wait = (pg, ms) => pg.waitForTimeout(ms)
const fail = (m) => { throw new Error(m) }

async function serverUp(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) })
    return r.status < 500
  } catch {
    return false
  }
}

let child = null
if (!(await serverUp(BASE))) {
  const port = new URL(BASE).port || '5173'
  step(`啟動 dev server :${port}`)
  child = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
    cwd: APP_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
    detached: true,
  })
  child.stdout.on('data', (d) => process.stdout.write(d))
  child.stderr.on('data', (d) => process.stderr.write(d))
  const t0 = Date.now()
  while (!(await serverUp(BASE))) {
    if (Date.now() - t0 > 40000) {
      child.kill('SIGTERM')
      throw new Error('dev server 沒起來：' + BASE)
    }
    await new Promise((r) => setTimeout(r, 400))
  }
}
const stopServer = () => {
  if (!child?.pid) { child = null; return }
  const pid = child.pid
  try { process.kill(-pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch {} }
  child = null
}
process.on('exit', stopServer)

async function shot(page, name, opts = {}) {
  const prev = page.viewportSize() || { width: 390, height: 844 }
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h })
    await wait(page, 250)
    if (opts.intoView) await opts.intoView.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${SHOTS}/${name}-${w}x${h}.png` })
  }
  await page.setViewportSize(prev)
  await wait(page, 150)
}

async function waitToastGone(page) {
  const toast = page.locator('[role=status]').filter({ hasText: '已記錄' })
  if (await toast.count()) await toast.first().waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {})
}

const b = await webkit.launch()
try {
  const ctx = await b.newContext(IPHONE)
  const pg = await ctx.newPage()
  pg.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  pg.on('pageerror', (e) => errors.push(String(e)))
  await pg.goto(BASE); await wait(pg, 1500)
  const trial = pg.getByText('先在這支手機試用')
  if (await trial.count()) { await trial.click(); await wait(pg, 1200) }

  step('分頁')
  for (const t of ['趨勢', '品項', '設定', '今天']) {
    await pg.getByRole('navigation', { name: '分頁' }).getByText(t, { exact: true }).click(); await wait(pg, 400)
  }
  step('體重')
  await pg.getByRole('button', { name: '記體重' }).click(); await wait(pg, 600)
  await pg.getByText('＋', { exact: true }).click(); await wait(pg, 300)
  await pg.keyboard.press('Escape'); await wait(pg, 400)

  step('搜尋 → 雞胸 → 1.5 份 → 記錄')
  await pg.getByText(/^搜尋店家/).first().click(); await wait(pg, 500)
  await pg.keyboard.type('雞胸'); await wait(pg, 700)
  await pg.getByText('法式香草嫩雞胸').first().click(); await wait(pg, 600)
  const q15 = pg.getByRole('button', { name: /^1\.5/ }).first()
  await q15.click(); await wait(pg, 500)
  if ((await q15.getAttribute('aria-pressed')) !== 'true') fail('1.5 份沒有保持選取')
  await pg.getByRole('button', { name: /^記錄/ }).last().click(); await wait(pg, 800)

  step('要補營養素的品項 → 打數字 → 記錄')
  await pg.getByText(/^搜尋店家/).first().click(); await wait(pg, 500)
  await pg.keyboard.type('義大利麵'); await wait(pg, 700)
  await pg.getByText('晶英-麻辣奶油鮮蝦義大利麵').first().click(); await wait(pg, 600)
  const ins = pg.getByPlaceholder('必填，可以填 0')
  const want = ['20', '70', '25']
  for (let i = 0; i < 3; i++) { await ins.nth(i).click(); await pg.keyboard.type(want[i]); await wait(pg, 200) }
  const got = await Promise.all([0, 1, 2].map((i) => ins.nth(i).inputValue()))
  if (got.join() !== want.join()) fail(`補營養素的數字被清掉：${got}`)
  await pg.getByRole('button', { name: /^下一步/ }).first().click(); await wait(pg, 600)
  await pg.getByRole('button', { name: /^記錄/ }).last().click(); await wait(pg, 800)
  const body = await pg.locator('body').innerText()
  if (!body.includes('法式香草嫩雞胸') || !body.includes('義大利麵')) fail('今天的紀錄沒有出現兩筆')
  step('常吃膠囊 → 份量 Sheet 帶上次 1.5 份')
  await pg.getByRole('button', { name: /法式香草嫩雞胸/ }).last().click(); await wait(pg, 600)
  if ((await pg.getByRole('button', { name: /^1\.5/ }).first().getAttribute('aria-pressed')) !== 'true') fail('常吃膠囊沒有帶上次的 1.5 份')
  await pg.keyboard.press('Escape'); await wait(pg, 400)
  step('體重：點一下數字就 focus；非今天不寫「今天」')
  await pg.setViewportSize({ width: 390, height: 844 })
  await pg.getByRole('button', { name: /今天/ }).last().click(); await wait(pg, 300)
  await pg.getByRole('button', { name: /體重/ }).first().click(); await wait(pg, 500)
  await pg.getByLabel('體重（kg）').click()
  if (!(await pg.evaluate(() => document.activeElement?.getAttribute('aria-label') === '體重（kg）'))) fail('點一下沒有 focus 體重輸入框')
  await pg.getByRole('button', { name: /^今天 / }).click(); await wait(pg, 300)
  await pg.locator('input[type=date]').fill('2026-09-16'); await wait(pg, 300)
  if (await pg.getByRole('button', { name: /^今天 / }).count()) fail('補記別天還寫「今天」')
  await pg.goto(new URL('#today', pg.url()).href.replace(/#.*#/, '#')); await pg.reload(); await wait(pg, 1200)
  step('設定：每日消耗 900 要擋下')
  await pg.getByRole('button', { name: /設定/ }).last().click(); await wait(pg, 400)
  await pg.getByLabel('每日消耗（kcal）').click(); await pg.keyboard.type('900')
  await pg.getByRole('heading', { name: '設定' }).click(); await wait(pg, 400)
  if (!(await pg.getByText('請輸入 1,200 到 5,000 之間的數字').isVisible())) fail('每日消耗 900 沒有被擋下')
  step('設定：提醒時間選好就存，重新整理後還在')
  await pg.getByLabel('午餐').fill('12:30'); await wait(pg, 400)
  await pg.getByLabel('量體重').fill('07:15'); await wait(pg, 400)
  await pg.reload(); await wait(pg, 1500)
  await pg.getByRole('button', { name: /設定/ }).last().click(); await wait(pg, 500)
  if ((await pg.getByLabel('午餐').inputValue()) !== '12:30') fail('重新整理後午餐提醒不見了')
  if ((await pg.getByLabel('量體重').inputValue()) !== '07:15') fail('重新整理後量體重提醒不見了')
  step('設定：後端連線設定可以取消，不會清掉設定')
  await pg.getByRole('button', { name: '後端連線設定' }).click(); await wait(pg, 400)
  await pg.getByRole('button', { name: '取消' }).click(); await wait(pg, 400)
  if (!(await pg.getByRole('heading', { name: '設定' }).isVisible())) fail('取消後沒有回到設定頁')
  await pg.getByRole('button', { name: '後端連線設定' }).click(); await wait(pg, 400)
  await pg.getByRole('button', { name: '儲存' }).click(); await wait(pg, 800)
  if (!(await pg.getByRole('alert').isVisible())) fail('空白值沒有被擋下')
  await pg.getByRole('button', { name: '取消' }).click(); await wait(pg, 400)
  await pg.reload(); await wait(pg, 1500)
  if (await pg.getByText('先在這支手機試用').count()) fail('按過連線設定後 app 掉回設定畫面')
  step('橫向 844×390：搜尋區不蓋住摘要')
  await pg.getByRole('button', { name: /今天/ }).last().click(); await pg.setViewportSize({ width: 844, height: 390 }); await wait(pg, 500)
  const dockH = await pg.evaluate(() => document.querySelector('.fixed.inset-x-0')?.getBoundingClientRect().height ?? 0)
  if (dockH > 100) fail(`橫向搜尋區太高：${dockH}px`)
  await pg.screenshot({ path: fileURLToPath(new URL('../../qa-v1/e2e-landscape.png', import.meta.url)) })

  await pg.setViewportSize({ width: 390, height: 844 })
  await pg.getByRole('button', { name: /今天/ }).last().click(); await wait(pg, 400)

  step('建店 → 新品項 → 記錄；reload 後 dock 有店家膠囊')
  await pg.getByText(/^搜尋店家/).first().click(); await wait(pg, 400)
  await pg.getByRole('button', { name: '＋ 新增店家' }).click(); await wait(pg, 400)
  await pg.getByLabel('店名').fill('e2e麵店'); await wait(pg, 200)
  await pg.getByRole('button', { name: '建立' }).click(); await wait(pg, 600)
  await pg.getByRole('button', { name: '＋ 新增品項' }).click(); await wait(pg, 400)
  const backBtn = pg.getByRole('button', { name: '返回' })
  const backBox = await backBtn.boundingBox()
  if (!backBox) fail('返回按鈕沒有出現')
  if (backBox.height > 48) fail(`返回被折行：高 ${backBox.height}px`)
  await shot(pg, '新增品項表單')
  await pg.getByLabel('品名').fill('陽春麵')
  const nut = pg.getByPlaceholder('必填，可以填 0')
  for (const [i, v] of ['400', '12', '70', '8'].entries()) { await nut.nth(i).click(); await pg.keyboard.type(v); await wait(pg, 100) }
  await pg.getByRole('button', { name: /^記錄/ }).last().click(); await wait(pg, 500)
  await pg.getByRole('button', { name: /^記錄/ }).last().click(); await wait(pg, 800)
  await pg.reload(); await wait(pg, 1500)
  if (!(await pg.getByRole('button', { name: '店家 e2e麵店' }).count())) fail('reload 後 dock 沒有店家膠囊')

  step('從店家記錄最多 3 下；店家 Sheet 列出剛記錄的品項')
  await pg.setViewportSize({ width: 390, height: 844 })
  let storeClicks = 0
  await pg.getByRole('button', { name: '店家 e2e麵店' }).click(); storeClicks += 1; await wait(pg, 400)
  const storeDlg = pg.getByRole('dialog')
  if (!(await storeDlg.getByText('陽春麵').count())) fail('店家 Sheet 沒有剛記錄的陽春麵')
  if (await storeDlg.getByText('還沒吃過').count()) fail('e2e麵店已經有陽春麵，不能顯示還沒吃過')
  if (await storeDlg.getByText('這家店還沒有品項').count()) fail('店家 Sheet 不該顯示還沒有品項')
  await shot(pg, '店家Sheet')
  await storeDlg.getByRole('button', { name: /陽春麵/ }).click(); storeClicks += 1; await wait(pg, 400)
  await pg.getByRole('button', { name: /^記錄/ }).last().click(); storeClicks += 1; await wait(pg, 800)
  if (storeClicks > 3) fail(`從店家記錄點了 ${storeClicks} 下`)

  step('不指定店家快速記錄')
  await pg.getByText(/^搜尋店家/).first().click(); await wait(pg, 400)
  if (!(await pg.getByText('常吃店家').count()) || !(await pg.getByRole('button', { name: '不指定店家' }).count())) {
    fail('搜尋 Sheet 沒打字時要看得到常吃店家和不指定店家')
  }
  const searchOrder = await pg.evaluate(() => {
    const quick = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') === '不指定店家') || (b.textContent || '').trim() === '不指定店家')
    const heading = [...document.querySelectorAll('div')].find((el) => (el.textContent || '').trim() === '常吃店家')
    if (!quick || !heading) return 'missing'
    return (quick.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING) ? 'ok' : 'wrong-order'
  })
  if (searchOrder !== 'ok') fail(`不指定店家要在常吃店家上面：${searchOrder}`)
  await shot(pg, '搜尋Sheet')
  await pg.getByRole('button', { name: '不指定店家' }).click(); await wait(pg, 400)
  const qn = pg.getByPlaceholder('必填，可以填 0')
  for (const [i, v] of ['300', '20', '30', '10'].entries()) { await qn.nth(i).click(); await pg.keyboard.type(v); await wait(pg, 100) }
  await pg.getByRole('button', { name: /^記錄/ }).last().click(); await wait(pg, 800)
  if (!(await pg.getByText('快速記錄').count())) fail('列表沒有快速記錄')

  step('同步中與骨架沒有 2,000')
  await pg.evaluate(() => localStorage.setItem('foodlog.mockDelayMs', '2500'))
  await pg.reload()
  await pg.getByText('同步中', { exact: true }).waitFor({ timeout: 2500 })
  await shot(pg, '首頁同步中')
  await pg.getByText('同步中', { exact: true }).waitFor({ state: 'hidden', timeout: 6000 })
  const ctxSkel = await b.newContext(IPHONE)
  const pgSkel = await ctxSkel.newPage()
  await pgSkel.addInitScript(() => {
    localStorage.setItem('foodlog.mock', '1')
    localStorage.setItem('foodlog.mockDelayMs', '5000')
  })
  await pgSkel.goto(BASE)
  await wait(pgSkel, 400)
  const skel = await pgSkel.locator('body').innerText()
  if (skel.includes('2,000')) fail('骨架期間出現 2,000')
  const expectH = pgSkel.viewportSize()?.height ?? 844
  const tabFlush = await pgSkel.evaluate((expectH) => {
    const nav = document.querySelector('nav[aria-label="分頁"]')
    if (!nav) return { ok: false, reason: 'no-tabbar' }
    const r = nav.getBoundingClientRect()
    const inner = window.innerHeight
    const client = document.documentElement.clientHeight
    const vv = window.visualViewport?.height ?? inner
    if (Math.abs(r.bottom - expectH) > 2) {
      return { ok: false, reason: `bottom=${r.bottom} expect=${expectH} inner=${inner} client=${client} vv=${vv}` }
    }
    return { ok: true, reason: '' }
  }, expectH)
  if (!tabFlush.ok) fail(`骨架頁 tab bar 沒貼齊底部：${tabFlush.reason}`)
  const skelBox = await pgSkel.locator('[data-remain-card]').boundingBox()
  await shot(pgSkel, '首頁骨架')
  await pgSkel.locator('[data-remain-card][aria-busy="true"]').waitFor({ state: 'detached', timeout: 8000 })
  const liveBox = await pgSkel.locator('[data-remain-card]').boundingBox()
  if (!skelBox || !liveBox) fail('剩餘卡 bounding box 缺失')
  if (Math.abs(skelBox.height - liveBox.height) > 12 || Math.abs(skelBox.width - liveBox.width) > 12 || Math.abs(skelBox.y - liveBox.y) > 12) {
    fail(`骨架換成資料時版面跳動 skel=${JSON.stringify(skelBox)} live=${JSON.stringify(liveBox)}`)
  }
  const liveHero = await pgSkel.locator('[data-remain-card] .text-hero').count()
  const livePro = await pgSkel.locator('[data-remain-card] .text-2xl').count()
  if (!liveHero || !livePro) fail('真資料剩餘卡沒有 text-hero / text-2xl')
  await ctxSkel.close()
  await pg.evaluate(() => localStorage.removeItem('foodlog.mockDelayMs'))

  step('讀取失敗有重試')
  await pg.evaluate(() => { localStorage.setItem('foodlog.mockFailReads', '1'); localStorage.removeItem('foodlog.mockDelayMs') })
  const ctxFail = await b.newContext(IPHONE)
  const pgFail = await ctxFail.newPage()
  await pgFail.addInitScript(() => {
    localStorage.setItem('foodlog.mock', '1')
    localStorage.setItem('foodlog.mockFailReads', '1')
  })
  await pgFail.goto(BASE); await wait(pgFail, 800)
  if (!(await pgFail.getByText('讀不到今天的資料').count())) fail('失敗空畫面沒出現')
  await pgFail.getByRole('button', { name: '重試' }).click(); await wait(pgFail, 1200)
  await ctxFail.close()

  step('寫入失敗列')
  await pg.bringToFront()
  await pg.setViewportSize({ width: 390, height: 844 })
  await pg.getByRole('button', { name: /今天/ }).last().click(); await wait(pg, 300)
  await pg.evaluate(() => localStorage.setItem('foodlog.mockFailWrites', '1'))
  await pg.getByText(/^搜尋店家/).first().click(); await wait(pg, 400)
  await pg.getByRole('button', { name: '不指定店家' }).click(); await wait(pg, 400)
  const fn = pg.getByPlaceholder('必填，可以填 0')
  for (const [i, v] of ['50', '1', '1', '1'].entries()) { await fn.nth(i).click(); await pg.keyboard.type(v); await wait(pg, 80) }
  await pg.getByRole('button', { name: /^記錄/ }).last().click(); await wait(pg, 800)
  const failRow = pg.getByText('沒有存到 · 重試')
  if (!(await failRow.count())) fail('寫入失敗列沒出現')
  await waitToastGone(pg)
  await shot(pg, '寫入失敗', { intoView: failRow.first() })
  await failRow.first().click(); await wait(pg, 400)
  if (!(await pg.getByRole('button', { name: '重試' }).count())) fail('寫入失敗 Sheet 沒有重試')
  if (!(await pg.getByRole('button', { name: '捨棄' }).count())) fail('寫入失敗 Sheet 沒有捨棄')
  await pg.getByRole('button', { name: '捨棄' }).click(); await wait(pg, 500)

  step('Kyujin 建的紀錄同步後出現並標 Kyujin 建檔')
  await pg.evaluate(() => {
    localStorage.removeItem('foodlog.mockFailReads')
    localStorage.removeItem('foodlog.mockFailWrites')
    localStorage.removeItem('foodlog.mockDelayMs')
    const db = JSON.parse(localStorage.getItem('foodlog.mockdb') || '{}')
    const store = (db.stores || []).find((s) => s.name === 'e2e麵店')
    const storeId = store ? store.id : ''
    const off = new Date(Date.now() + 8 * 3600 * 1000)
    const day = off.toISOString().slice(0, 10)
    const ts = `${day}T12:30:00+08:00`
    db.items = db.items || []
    db.logs = db.logs || []
    db.items.push({
      id: 'u:kyujin-e2e', ts, deleted: false, updated_at: ts, kind: '自建', base_id: '',
      src: '其他', name: 'Kyujin麵', serving: '1 份', serving_g: null,
      kcal: 480, protein: 22, fat: 8, carb: 70, fav: false, created_by: 'kyujin', store: storeId,
    })
    db.logs.push({
      id: 'l:kyujin-e2e', ts, deleted: false, updated_at: ts, day,
      item_id: 'u:kyujin-e2e', name: 'Kyujin麵', src: '其他', qty: 1, grams: null,
      kcal: 480, protein: 22, fat: 8, carb: 70, source: 'kyujin', store: storeId,
    })
    localStorage.setItem('foodlog.mockdb', JSON.stringify(db))
  })
  await pg.reload()
  await pg.getByText('Kyujin麵').first().waitFor({ timeout: 5000 })
  await pg.getByRole('button', { name: '店家 e2e麵店' }).click(); await wait(pg, 400)
  if (!(await pg.getByText('Kyujin 建檔').count())) fail('Kyujin 建的品項沒有標 Kyujin 建檔')
  await pg.keyboard.press('Escape'); await wait(pg, 300)

  step('重要按鈕都有 aria-label')
  const ariaMissing = []
  for (const name of ['記體重', '搜尋店家、7-11、全家、我的品項', '今天', '趨勢', '品項', '設定']) {
    if (!(await pg.getByRole('button', { name }).count()) && !(await pg.getByRole('navigation', { name: '分頁' }).getByRole('button', { name }).count())) {
      ariaMissing.push(name)
    }
  }
  if (!(await pg.getByRole('navigation', { name: '分頁' }).count())) ariaMissing.push('分頁')
  await pg.getByRole('button', { name: '店家 e2e麵店' }).click(); await wait(pg, 300)
  if (!(await pg.getByRole('button', { name: '店家選項' }).count())) ariaMissing.push('店家選項')
  await pg.getByRole('button', { name: '＋ 新增品項' }).click(); await wait(pg, 300)
  if (!(await pg.getByRole('button', { name: '返回' }).count())) ariaMissing.push('返回')
  if (!(await pg.getByRole('button', { name: '記錄' }).count())) ariaMissing.push('記錄')
  await pg.getByRole('button', { name: '返回' }).click(); await wait(pg, 200)
  await pg.keyboard.press('Escape'); await wait(pg, 300)
  if (ariaMissing.length) fail('重要按鈕缺少 accessible name：' + ariaMissing.join('、'))

  step('離線待上傳')
  await pg.addInitScript(() => {
    if (localStorage.getItem('foodlog.forceOffline') === '1') {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    }
  })
  await pg.evaluate(() => {
    localStorage.setItem('foodlog.forceOffline', '1')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    window.dispatchEvent(new Event('offline'))
  })
  await pg.getByText(/^搜尋店家/).first().click(); await wait(pg, 400)
  await pg.getByRole('button', { name: '不指定店家' }).click(); await wait(pg, 400)
  const on = pg.getByPlaceholder('必填，可以填 0')
  for (const [i, v] of ['100', '1', '1', '1'].entries()) { await on.nth(i).click(); await pg.keyboard.type(v); await wait(pg, 80) }
  await pg.getByRole('button', { name: /^記錄/ }).last().click(); await wait(pg, 3200)
  if (!(await pg.getByText('待上傳').count())) fail('離線 3 秒後沒有待上傳')
  const pendingRow = pg.getByRole('button', { name: /待上傳/ }).first()
  await pendingRow.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  const covered = await pg.evaluate(() => {
    const row = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('待上傳'))
    const dock = document.querySelector('.fixed.inset-x-0.z-30')
    const toast = [...document.querySelectorAll('[role=status]')].find((el) => (el.textContent || '').includes('已記錄'))
    if (!row) return 'no-row'
    const rb = row.getBoundingClientRect()
    if (dock) {
      const db = dock.getBoundingClientRect()
      if (rb.bottom > db.top + 1 && rb.top < db.bottom) return 'dock'
    }
    if (toast) {
      const tb = toast.getBoundingClientRect()
      if (rb.bottom > tb.top + 1 && rb.top < tb.bottom) return 'toast'
    }
    return ''
  })
  if (covered) fail(`待上傳列被 ${covered} 蓋住`)
  const offlineBadge = pg.getByText(/離線 ·/)
  if (!(await offlineBadge.count())) fail('離線徽章沒出現')
  await shot(pg, '離線徽章', { intoView: pendingRow })
  await pg.reload()
  await pg.getByText('待上傳').first().waitFor({ timeout: 5000 })
  await pg.evaluate(() => {
    localStorage.removeItem('foodlog.forceOffline')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
    window.dispatchEvent(new Event('online'))
  })
  await wait(pg, 2000)
} finally {
  await b.close()
  stopServer()
}
stopServer()
if (errors.length) { console.log('console errors:'); errors.forEach((e) => console.log('  ', e.slice(0, 200))); process.exit(1) }
console.log('OK：沒有 console error')
process.exit(0)
