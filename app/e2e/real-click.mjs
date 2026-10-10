// 真實點擊冒煙測試（WebKit iPhone 13，本機試用模式）。
// 用法：先 `npm run dev -- --port 5191`，再
//   PLAYWRIGHT_DIR=/workspace/photo-repro/node_modules/playwright node e2e/real-click.mjs [base_url]
// 一律用 locator.click（真的滑鼠點擊）／鍵盤（會移動焦點），不要用 element.click()。console 有任何 error 就失敗。
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { webkit, devices } = require(process.env.PLAYWRIGHT_DIR || 'playwright')
const BASE = process.argv[2] || 'http://127.0.0.1:5191/'
const errors = []
const step = (s) => console.log('·', s)
const wait = (pg, ms) => pg.waitForTimeout(ms)
const fail = (m) => { throw new Error(m) }

const b = await webkit.launch()
try {
  const ctx = await b.newContext({ ...devices['iPhone 13'], locale: 'zh-TW', timezoneId: 'Asia/Taipei' })
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
  await pg.getByText(/^搜尋 7-11/).first().click(); await wait(pg, 500)
  await pg.keyboard.type('雞胸'); await wait(pg, 700)
  await pg.getByText('法式香草嫩雞胸').first().click(); await wait(pg, 600)
  const q15 = pg.getByRole('button', { name: /^1\.5/ }).first()
  await q15.click(); await wait(pg, 500)
  if ((await q15.getAttribute('aria-pressed')) !== 'true') fail('1.5 份沒有保持選取')
  await pg.getByRole('button', { name: /^記錄/ }).last().click(); await wait(pg, 800)

  step('要補營養素的品項 → 打數字 → 記錄')
  await pg.getByText(/^搜尋 7-11/).first().click(); await wait(pg, 500)
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
} finally { await b.close() }
if (errors.length) { console.log('console errors:'); errors.forEach((e) => console.log('  ', e.slice(0, 200))); process.exit(1) }
console.log('OK：沒有 console error')
