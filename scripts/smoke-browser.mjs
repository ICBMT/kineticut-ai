/**
 * Browser checks: runs the real app in a headless Chromium and drives it the
 * way a user would. Not part of `npm run smoke` (it needs a browser).
 *
 *   npm run dev:web                       # app on :5173, API on :4890
 *   KC_CHROME=/path/to/chrome npm run smoke:browser
 *
 * KC_CHROME is any Chromium or Chrome binary. KC_URL overrides the app address.
 */
import { chromium } from 'playwright-core'

const URL = process.env.KC_URL || 'http://localhost:5173/'
const CHROME = process.env.KC_CHROME
if (!CHROME) {
  console.log('SKIP: set KC_CHROME to a Chromium or Chrome binary to run the browser checks.')
  process.exit(0)
}

const results = []
const check = (name, ok) => {
  results.push([name, ok])
  console.log(`${ok ? '✓' : '✗'} ${name}`)
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'], headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text())
  })

  // 1. Empty launch: no folder, no editor tabs, the welcome screen is shown.
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(1200)
  check('launch: no folder is open', (await page.textContent('body')).includes('no folder open'))
  check('launch: the explorer offers Open Folder', await page.getByText('No folder opened').isVisible())

  // Seed staged changes (the review store persists in localStorage).
  const mk = (p, o, s) => ({ path: p, original: o, staged: s, decisions: [true], sessionId: 's', messageId: 'm', stagedAt: Date.now() })
  await page.evaluate((pending) => {
    localStorage.setItem('kineticut.review.v1', JSON.stringify({ state: { pending }, version: 0 }))
  }, { '/w/a.ts': mk('/w/a.ts', 'x\n', 'y\n'), '/w/b.md': mk('/w/b.md', null, 'hi\n') })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.click('[aria-label="AI Chat"]')
  await page.waitForTimeout(400)

  // 2. Changes bar: counts, then per-file reject.
  const toggle = page.locator('.changes-bar-toggle')
  check('changes bar: shows 2 files changed', ((await toggle.textContent()) || '').includes('2 files changed'))
  await page.click('[aria-label="Reject changes to b.md"]')
  await page.waitForTimeout(250)
  check('changes bar: rejecting one file leaves one', ((await toggle.textContent()) || '').includes('1 file changed'))
  await page.click('[aria-label="Reject changes to a.ts"]')
  await page.waitForTimeout(250)
  check('changes bar: rejecting the last file hides the bar', (await page.locator('.changes-bar').count()) === 0)

  // 3. Composer chips: a mention becomes a chip; removing it leaves the rest of the text.
  const input = page.locator('textarea[aria-label="Message the AI"]')
  await input.fill('explain @src/app.ts and @codebase please')
  await page.waitForTimeout(200)
  const chips = await page.locator('.composer-chip').allTextContents()
  check('composer: mentions show as chips', chips.includes('src/app.ts') && chips.includes('Codebase'))
  await page.click('[aria-label="Remove src/app.ts from context"]')
  await page.waitForTimeout(150)
  check('composer: removing a chip removes only its token', (await input.inputValue()) === 'explain and @codebase please')

  // 4. Keyboard focus is visible on a button.
  await page.keyboard.press('Tab')
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement).boxShadow)
  check('focus: keyboard focus shows a ring', ring !== 'none' && ring !== '')

  // 4b. Manual mode: the footer says only attachments are sent, and the mode persists.
  await page.getByRole('button', { name: 'Manual', exact: true }).click()
  await page.waitForTimeout(150)
  check('manual mode: footer explains that only attachments are sent', (await page.textContent('body')).includes('Only what you attach is sent'))

  // 5. Settings pages switch.
  await page.click('[aria-label="Settings"]')
  await page.waitForTimeout(300)
  await page.click('.settings-nav-item:has-text("Editor")')
  await page.waitForTimeout(150)
  check('settings: Editor page shows Font size', (await page.getByText('Font size', { exact: true }).count()) === 1)
  check('settings: the Models page is hidden on Editor', (await page.getByText('Default chat model').count()) === 0)
  await page.click('.settings-nav-item:has-text("Rules & index")')
  await page.waitForTimeout(150)
  check('settings: Rules & index page has the workspace mode', (await page.locator('[aria-label="Workspace mode"]').count()) === 1)
  check('settings: the embedding model moved to Rules & index', (await page.locator('[aria-label="Embedding model"]').count()) === 1)

  check('no runtime errors in the console', errors.length === 0)
  if (errors.length) console.log(errors.slice(0, 5))
} finally {
  await browser.close()
}

const failed = results.filter(([, ok]) => !ok)
console.log(failed.length ? `\nBROWSER SMOKE FAILED (${failed.length})` : '\nBROWSER SMOKE PASSED')
process.exit(failed.length ? 1 : 0)
