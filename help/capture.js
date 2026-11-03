#!/usr/bin/env node
/* Génère les captures (help/img/*.png) et vidéos (help/video/*.mp4) de l'aide en ligne
   à partir de l'outil réel et de la trace d'exemple help/demo.gpx.

   Pré-requis (Internet nécessaire : tuiles de carte et MapLibre via CDN) :
     npm i playwright && npx playwright install chromium
     ffmpeg (facultatif : sans lui, les vidéos restent en .webm ; l'aide attend du .mp4)

   Usage, depuis la racine du dépôt :
     node help/capture.js            # tout
     node help/capture.js img        # captures seulement
     node help/capture.js video      # vidéos seulement
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const IMG = path.join(__dirname, 'img');
const VID = path.join(__dirname, 'video');
const GPX = path.join(__dirname, 'demo.gpx');
const W = 1440, H = 810;
const what = process.argv[2] || 'all';
const LOCAL_MAPLIBRE = process.env.MAPLIBRE_JS; // test hors ligne uniquement
fs.mkdirSync(IMG, { recursive: true });
fs.mkdirSync(VID, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.gpx': 'application/gpx+xml', '.png': 'image/png', '.mp4': 'video/mp4' };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function newContext(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, locale: 'fr-BE', ...opts });
  if (LOCAL_MAPLIBRE) {
    await ctx.route('**/maplibre-gl.min.js', r => r.fulfill({ path: LOCAL_MAPLIBRE, contentType: 'text/javascript' }));
  }
  return ctx;
}

async function open(ctx, base) {
  const page = await ctx.newPage();
  page.on('pageerror', e => console.warn('  [erreur page]', e.message));
  await page.goto(base + '/index.html');
  await page.waitForFunction(() => window.__gpx3dMap && window.__gpx3dMap.loaded && window.__gpx3dMap.loaded(), null, { timeout: 60000 }).catch(() => {});
  await sleep(1500);
  return page;
}

async function loadDemo(page) {
  await page.setInputFiles('#file-input', GPX);
  await page.waitForSelector('#stats-section:not([hidden])', { timeout: 30000 });
  await page.waitForSelector('#preload-overlay[hidden]', { state: 'attached', timeout: 90000 }).catch(() => {});
  await sleep(2500);
}

async function snap(page, name, target) {
  const file = path.join(IMG, name + '.png');
  if (target) await page.locator(target).first().screenshot({ path: file });
  else await page.screenshot({ path: file });
  console.log('  ✔ img/' + name + '.png');
}

async function images(browser, base) {
  console.log('Captures…');
  const ctx = await newContext(browser);
  const page = await open(ctx, base);

  await snap(page, '03-charger', '#dropzone');
  await loadDemo(page);
  await snap(page, '02-interface');
  await page.selectOption('#mode-select', { label: 'Altitude + Vitesse' }).catch(() => {});
  await sleep(500);
  await snap(page, '04-profil', '#panel');
  await snap(page, '05-lecture', '#playback-section');

  // vue générale en lecture
  await page.click('#btn-play');
  await sleep(4000);
  await snap(page, '06-vue-generale');
  await page.click('#btn-stop');

  // suivi + cap (la case « vue générale » est cochée par défaut : on la décoche pour la capture)
  await page.uncheck('#overview-check');
  await page.check('#orient-check');
  await page.click('#btn-play');
  await sleep(12000);
  await snap(page, '07-suivi');
  await page.click('#btn-stop');
  await page.uncheck('#orient-check'); // avant de recocher la vue générale (qui grise la case)
  await page.check('#overview-check');
  await sleep(1000);

  // menu des fonds
  await page.click('#menu-map .map-menu-btn');
  await sleep(600);
  await snap(page, '08-fonds');
  await page.keyboard.press('Escape');

  // options + thème clair
  await page.click('#btnTrackStyle');
  await sleep(400);
  await snap(page, '09-options');
  await page.click('#theme-light');
  await sleep(2500);
  await snap(page, '10-theme-clair');
  await page.click('#theme-dark');
  await sleep(1500);
  await page.click('#btnTrackStyle');

  // clic droit : menu des points
  const box = await page.locator('#map').boundingBox();
  const cx = box.x + box.width * 0.62, cy = box.y + box.height * 0.45;
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await sleep(400);
  await page.click('#ctx-show-points', { force: true }).catch(() => {});
  await sleep(1200);
  await snap(page, '11-points');
  await page.keyboard.press('Escape');

  // panneau OpenStreetMap
  await page.click('#btnOsm');
  await sleep(600);
  await snap(page, '12-osm');
  await ctx.close();
}

async function recordVideo(browser, base, name, scenario) {
  console.log('Vidéo ' + name + '…');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gpx3d-vid-'));
  const ctx = await newContext(browser, { recordVideo: { dir, size: { width: W, height: H } } });
  const page = await open(ctx, base);
  const video = page.video();
  await scenario(page);
  await ctx.close();
  const webm = await video.path();
  const mp4 = path.join(VID, name + '.mp4');
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-an', '-c:v', 'libx264', '-crf', '30',
      '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
    console.log('  ✔ video/' + name + '.mp4');
  } catch (e) {
    fs.copyFileSync(webm, path.join(VID, name + '.webm'));
    console.warn('  ffmpeg indisponible : ' + name + '.webm écrit à la place (l\'aide attend du .mp4)');
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

async function videos(browser, base) {
  await recordVideo(browser, base, '01-demarrer', async page => {
    await sleep(1500);
    await loadDemo(page);
    await page.click('#btn-play');
    await sleep(8000);
    await page.click('#btn-stop');
    await sleep(800);
  });
  await recordVideo(browser, base, '02-vue-generale', async page => {
    await loadDemo(page);
    await page.click('#btn-play');
    await sleep(14000);
    await page.click('#btn-stop');
  });
  await recordVideo(browser, base, '03-suivi-cap', async page => {
    await loadDemo(page);
    await page.uncheck('#overview-check');
    await sleep(800);
    await page.check('#orient-check');
    await sleep(800);
    await page.click('#btn-play');
    await sleep(18000);
    await page.click('#btn-stop');
  });
  await recordVideo(browser, base, '04-fonds', async page => {
    await loadDemo(page);
    await page.click('#menu-map .map-menu-btn');
    await sleep(1200);
    for (const v of ['cyclosm', 'opentopo']) {
      await page.check('input[name="basemap"][value="' + v + '"]');
      await sleep(2500);
    }
    await page.locator('#topo-opacity-range').fill('70').catch(() => {});
    await sleep(2000);
    await page.locator('#topo-opacity-range').fill('30').catch(() => {});
    await sleep(1500);
    await page.keyboard.press('Escape');
    await sleep(800);
  });
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  try {
    if (what === 'all' || what === 'img') await images(browser, base);
    if (what === 'all' || what === 'video') await videos(browser, base);
  } finally {
    await browser.close();
    server.close();
  }
  console.log('Terminé.');
})().catch(e => { console.error(e); process.exit(1); });
