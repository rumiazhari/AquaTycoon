/**
 * Builds a single self-contained launcher file (AquaTycoon_Launcher.html)
 * from the Vite production build in dist/. The launcher inlines all JS and
 * CSS so the game runs directly in any browser — double-click, GitHub Pages,
 * or shared as a single file. No server or downloads required.
 *
 * Usage: npm run build && node scripts/make-launcher.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

function findAsset(ext) {
  const files = readdirSync(join(dist, 'assets')).filter(f => f.endsWith(ext));
  if (files.length === 0) throw new Error(`No .${ext} asset found in dist/assets`);
  return join(dist, 'assets', files[0]);
}

let html = readFileSync(join(dist, 'index.html'), 'utf8');
const jsPath = findAsset('.js');
const cssPath = findAsset('.css');
const js = readFileSync(jsPath, 'utf8');
const css = readFileSync(cssPath, 'utf8');

// Inline CSS
html = html.replace(
  /<link rel="stylesheet"[^>]*href="[^"]*\.css"[^>]*>/,
  () => `<style>\n${css}\n</style>`
);

// Escape `</script>` sequences inside JS so the inline script tag survives
const safeJs = js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

// Inline JS module
html = html.replace(
  /<script type="module"[^>]*src="[^"]*\.js"[^>]*><\/script>/,
  () => `<script type="module">\n${safeJs}\n</script>`
);

const banner = `<!-- AquaTycoon 3D — single-file browser launcher.
     Everything (JS/CSS) is inlined; open directly in any modern browser. -->\n`;
writeFileSync(join(dist, 'launcher.html'), banner + html, 'utf8');
writeFileSync('AquaTycoon_Launcher.html', banner + html, 'utf8');
console.log('Launcher written: AquaTycoon_Launcher.html (' + Math.round((banner.length + html.length) / 1024) + ' KB)');
