import puppeteer from 'puppeteer-core';

const url = process.argv[2] || 'http://localhost:4173';
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

  // Dump all visible button texts at load (to find the start menu controls)
  const buttons = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map(b => ({
    t: (b.innerText || '').replace(/\s+/g,' ').trim().slice(0,40),
    title: (b.getAttribute('title')||'').slice(0,50)
  })));
  console.log('LOAD BUTTONS:', JSON.stringify(buttons));
} finally {
  await browser.close();
}
