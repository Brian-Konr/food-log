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
  console.log('DBG dialogs', await pg.getByRole('dialog').count(), await pg.evaluate(() => document.activeElement?.outerHTML.slice(0,120)), await pg.evaluate(() => document.body.style.pointerEvents)); await pg.screenshot({ path: '/tmp/dbg-w.png' })
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
  await pg.screenshot({ path: '../qa-v1/e2e-landscape.png' })
} finally { await b.close() }
if (errors.length) { console.log('console errors:'); errors.forEach((e) => console.log('  ', e.slice(0, 200))); process.exit(1) }
console.log('OK：沒有 console error')
