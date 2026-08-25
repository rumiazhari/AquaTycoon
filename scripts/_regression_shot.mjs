import puppeteer from 'puppeteer-core';
const url = process.argv[2] || 'http://localhost:4173';
const out = process.argv[3] || 'C:/Users/Yoshida Labo/AppData/Local/Temp/river.png';
const night = process.argv[4] === 'night';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,720'],
  defaultViewport: { width: 1280, height: 720 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('PAGE ERROR:', e.message));
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 4000));
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find(x => /know everything/i.test(x.textContent));
    if (b) b.click();
  });
  await new Promise(r => setTimeout(r, 1500));
  await page.mouse.move(640, 360);
  for (let i = 0; i < 3; i++) { await page.mouse.wheel({ deltaY: 400 }); await new Promise(r => setTimeout(r, 300)); }
  await page.mouse.move(1000, 380);
  await page.mouse.down();
  for (let s = 1; s <= 12; s++) { await page.mouse.move(1000 - s * 55, 380, { steps: 2 }); await new Promise(r => setTimeout(r, 40)); }
  await page.mouse.up();
  if (night) {
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const b = btns.find(x => x.textContent.trim() === '5x');
      if (b) b.click();
    });
    const deadline = Date.now() + 240000;
    let clock = '';
    while (Date.now() < deadline) {
      clock = await page.evaluate(() => document.body.innerText.match(/\d{2}:\d{2}/)?.[0] ?? '');
      if (clock >= '19:30') break;
      await new Promise(r => setTimeout(r, 2000));
    }
    console.log('night clock:', clock);
  }
  await new Promise(r => setTimeout(r, 2500));
  await page.screenshot({ path: out });
  console.log('SCREENSHOT SAVED:', out);
} finally { await browser.close(); }
