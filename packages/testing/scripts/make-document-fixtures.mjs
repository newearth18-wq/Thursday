// Makes the PDF and PNG fixtures of the SET 10 document tests with headless
// Chromium (an independent PDF producer). Run from the repository root with a
// Chromium-family browser: node packages/testing/scripts/make-document-fixtures.mjs
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const here = join(import.meta.dirname, '..', 'fixtures', 'documents')
const executablePath = process.env.JUPITER_TEST_BROWSER_EXECUTABLE ?? '/opt/pw-browsers/chromium'
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setContent(`<!doctype html><html><head><title>Jupiter Quarterly Report</title></head>
<body style="font-family:sans-serif">
<h1>Jupiter Quarterly Report</h1>
<p>The Great Red Spot is a storm larger than Earth.</p>
<p>Second paragraph about the moons: Io, Europa, Ganymede and Callisto.</p>
<div style="page-break-before:always"><h2>Page two</h2><p>Revenue grew by 12 percent.</p></div>
</body></html>`)
await page.pdf({ path: join(here, 'report.pdf'), format: 'A4', tagged: true })
await page.setViewportSize({ width: 320, height: 200 })
await page.setContent(
  '<body style="margin:0;background:#1f3864"><div style="width:120px;height:120px;margin:40px 100px;background:#f5a623;border-radius:60px"></div></body>'
)
await page.screenshot({ path: join(here, 'chart.png') })
await browser.close()
console.log('ok')
