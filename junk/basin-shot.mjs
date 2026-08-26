import puppeteer from 'puppeteer-core';
const url = process.argv[2] || 'http://localhost:4173';
const out = process.argv[3] || 'C:\\Users\\rumia\\AppData\\Local\\Temp\\basin_check.png';
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,720'],
  defaultViewport: { width: 1280, height: 720 },
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('PAGE ERROR:', e.message));
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(5000);
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /no thanks|i know everything/i.test(x.innerText||'')); if (b) b.click(); });
  await sleep(2000);
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find(x => (x.getAttribute('title')||'').includes('Draw a custom basin')); if (b) b.click(); });
  await sleep(600);
  await page.mouse.move(640, 360);
  for (let i = 0; i < 5; i++) { await page.mouse.wheel({ deltaY: 500 }); await sleep(250); }
  await sleep(800);
  const getToast = () => page.evaluate(() => document.body.innerText.replace(/\n/g,' ').slice(0,160));
  await page.mouse.click(600, 330);
  await sleep(700);
  await page.mouse.click(624, 354);
  await sleep(1500);
  console.log('RESULT:', (await getToast()).slice(0,110));
  await page.screenshot({ path: out });
  console.log('SCREENSHOT SAVED:', out);
} finally { await browser.close(); }
