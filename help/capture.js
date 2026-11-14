#!/usr/bin/env node
/* Génère les médias de l'aide illustrée — help/img/*.png|jpg et help/video/*.mp4 —
   en pilotant l'outil réel (index.html) avec la trace d'exemple help/demo.gpx.

   Internet est nécessaire : tuiles de carte, MapLibre/proj4 par CDN, Nominatim et Open-Meteo.
   En pratique, c'est l'action GitHub « Aide : captures et vidéos » qui exécute ce script
   et dépose les fichiers dans le dépôt (Actions → Run workflow).

   Pré-requis pour l'exécuter à la main, depuis la racine du dépôt :
     npm i playwright && npx playwright install --with-deps chromium
     ffmpeg (facultatif : sans lui les vidéos restent en .webm, l'aide accepte les deux)

     node help/capture.js            # tout
     node help/capture.js img        # captures seulement
     node help/capture.js video      # vidéos seulement

   Variables d'environnement (mise au point) :
     CHROME_PATH             Chrome/Chromium du système au lieu de celui de Playwright
     MAPLIBRE_JS, PROJ4_JS   copies locales des bibliothèques, servies à la place du CDN
*/
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { ({ chromium } = require('playwright-core')); }

const ROOT = path.resolve(__dirname, '..');
const IMG = path.join(__dirname, 'img');
const VID = path.join(__dirname, 'video');
const GPX = path.join(__dirname, 'demo.gpx');
const W = 1440, H = 810;          // captures (fenêtre d'ordinateur)
const VW = 1280, VH = 720;        // vidéos (plus légères)
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const what = process.argv[2] || 'all';
const CHROME_PATH = process.env.CHROME_PATH || null;
const LOCAL_JS = { maplibre: process.env.MAPLIBRE_JS, proj4: process.env.PROJ4_JS };

fs.mkdirSync(IMG, { recursive: true });
fs.mkdirSync(VID, { recursive: true });

/* ---------------------------------------------------------------- serveur local */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
  '.gpx': 'application/gpx+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.webmanifest': 'application/manifest+json',
};
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------- trace d'exemple : géométrie */
const PTS = [...fs.readFileSync(GPX, 'utf8').matchAll(/<trkpt[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"/g)]
  .map(m => ({ lat: +m[1], lon: +m[2] }));
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
function distM(a, b){
  const dphi = rad(b.lat - a.lat), dl = rad(b.lon - a.lon);
  const s = Math.sin(dphi / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dl / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(s)));
}
function bearing(a, b){
  const dl = rad(b.lon - a.lon);
  const y = Math.sin(dl) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dl);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
/* déplacement de d mètres selon un cap (approximation plane : quelques dizaines de mètres) */
function dest(p, brg, d){
  return {
    lat: p.lat + d * Math.cos(rad(brg)) / 110540,
    lon: p.lon + d * Math.sin(rad(brg)) / (111320 * Math.cos(rad(p.lat))),
  };
}
const CUM = [0];
for (let i = 1; i < PTS.length; i++) CUM[i] = CUM[i - 1] + distM(PTS[i - 1], PTS[i]);
const TOTAL = CUM[CUM.length - 1];
/* point situé à `d` mètres du départ, le long de la trace */
function at(d){
  d = Math.max(0, Math.min(TOTAL, d));
  let i = 1;
  while (i < CUM.length - 1 && CUM[i] < d) i++;
  const seg = CUM[i] - CUM[i - 1];
  const t = seg > 0 ? (d - CUM[i - 1]) / seg : 0;
  const a = PTS[i - 1], b = PTS[i];
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}
/* changement de cap à `d` mètres (même fenêtre de 30 m que le guidage de l'outil) */
function turnAt(d){
  const h1 = bearing(at(d - 30), at(d)), h2 = bearing(at(d), at(d + 30));
  return ((h2 - h1 + 540) % 360) - 180;
}
/* premier virage marqué après `from` mètres : la caméra a de la marge pour l'aborder */
function findTurn(from, minDeg){
  for (let d = from; d < TOTAL - 60; d += 5) if (Math.abs(turnAt(d)) >= minDeg) return d;
  return Math.min(from + 200, TOTAL - 100);
}
/* cap de la trace à `d` mètres (pour décaler la position perpendiculairement) */
function headingAt(d){ return bearing(at(Math.max(0, d - 5)), at(Math.min(TOTAL, d + 5))); }

/* ---------------------------------------------------------------- navigateur */
async function newContext(browser, opts = {}){
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, locale: 'fr-BE', ...opts });
  if (LOCAL_JS.maplibre) await ctx.route('**/maplibre-gl.min.js', r => r.fulfill({ path: LOCAL_JS.maplibre, contentType: 'text/javascript' }));
  if (LOCAL_JS.proj4) await ctx.route('**/proj4.js', r => r.fulfill({ path: LOCAL_JS.proj4, contentType: 'text/javascript' }));
  return ctx;
}
async function open(ctx, base){
  const page = await ctx.newPage();
  page.on('pageerror', e => console.warn('  [erreur page]', e.message));
  await page.goto(base + '/index.html');
  await page.waitForFunction(() => window.__gpx3dMapReady === true, null, { timeout: 60000 }).catch(() => {});
  await sleep(2000);
  return page;
}
async function loadDemo(page){
  await page.setInputFiles('#file-input', GPX);
  await page.waitForSelector('#stats-section:not([hidden])', { timeout: 30000 });
  await page.waitForSelector('#preload-overlay[hidden]', { state: 'attached', timeout: 120000 }).catch(() => {});
  await page.waitForFunction(() => window.__gpx3dMap.loaded(), null, { timeout: 30000 }).catch(() => {});
  await sleep(3000);
}
/* zone de carte réellement visible (à droite du panneau) : cadrage des captures de carte */
async function mapClip(page){
  const p = await page.locator('#panel').boundingBox();
  const left = Math.round((p ? p.x + p.width : 0) + 10);
  return { x: left, y: 10, width: W - left - 10, height: H - 20 };
}
const missing = [];
/* une étape qui échoue n'interrompt pas les suivantes : les autres médias sont quand même produits */
async function safe(label, fn){
  try { await fn(); }
  catch (e) { missing.push(label); console.warn('  ! ' + label + ' interrompu : ' + String(e.message || e).split('\n')[0]); }
}
/* une capture qui échoue (élément masqué, service injoignable) n'interrompt pas le reste :
   l'aide affiche un cadre pointillé tant qu'un média manque */
async function shot(page, name, opts = {}){
  const jpeg = !!opts.jpeg;
  const file = path.join(IMG, name + (jpeg ? '.jpg' : '.png'));
  const o = jpeg ? { path: file, type: 'jpeg', quality: 82 } : { path: file };
  try {
    if (opts.sel) await page.locator(opts.sel).first().screenshot({ ...o, timeout: 15000 });
    else if (opts.clip) await page.screenshot({ ...o, clip: opts.clip });
    else if (opts.map) await page.screenshot({ ...o, clip: await mapClip(page) });
    else await page.screenshot(o);
    console.log('  ✔ img/' + path.basename(file));
  } catch (e) {
    missing.push(path.basename(file));
    console.warn('  ! ' + path.basename(file) + ' : ' + e.message.split('\n')[0]);
  }
}
/* ouvre un menu de la carte par le code : un contrôle voisin peut recouvrir le bouton
   quand la mise en page flottante a bougé, ce qui ferait échouer un vrai clic */
async function openMapMenu(page, id){
  await page.evaluate(sel => document.querySelector(sel).click(), '#' + id + ' .map-menu-btn');
  await page.waitForSelector('#' + id + '.open', { timeout: 5000 }).catch(() => {});
  await sleep(700);
}
async function closeMapMenu(page, id){
  await page.evaluate(sel => { const m = document.querySelector(sel); if (m && m.classList.contains('open')) m.querySelector('.map-menu-btn').click(); }, '#' + id);
  await sleep(400);
}

/* capture d'un élément avec sa marge de carte autour (pastille de guidage, etc.) */
async function shotAround(page, name, sel, pad = 70){
  const b = await page.locator(sel).first().boundingBox().catch(() => null);
  if (!b){ missing.push(name); return console.warn('  ! élément introuvable : ' + sel); }
  const clip = {
    x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad),
    width: Math.min(W, b.width + 2 * pad), height: Math.min(H, b.height + 2 * pad),
  };
  await shot(page, name, { clip, jpeg: true });
}

/* ---------------------------------------------------------------- captures */
async function images(browser, base){
  console.log('Captures…');
  const start = PTS[0];
  const ctx = await newContext(browser, {
    permissions: ['geolocation'],
    geolocation: { latitude: start.lat, longitude: start.lon, accuracy: 8 },
  });
  const page = await open(ctx, base);

  await shot(page, '00-accueil', { jpeg: true });
  await shot(page, '02-charger', { sel: '#dropzone' });

  await loadDemo(page);
  await shot(page, '01-interface', { jpeg: true });
  await shot(page, '03-stats', { sel: '#stats-section' });

  await page.selectOption('#mode-select', { index: 2 }).catch(() => {});
  await sleep(600);
  await shot(page, '04-profil', { sel: '#profile-section' });
  await shot(page, '05-lecture', { sel: '#playback-section' });
  await shot(page, '17-guidage-panneau', { sel: '#nav-section' });

  // repères de départ et d'arrivée : vue rapprochée sur le départ
  await page.evaluate(([lon, lat]) => window.__gpx3dMap.jumpTo({ center: [lon, lat], zoom: 16.5, pitch: 0, bearing: 0 }), [start.lon, start.lat]);
  await sleep(4000);
  await shot(page, '06-depart-arrivee', { map: true, jpeg: true });
  await page.click('#btn-stop');   // recadre la caméra sur l'ensemble de la trace
  await sleep(2500);

  // lecture en vue générale
  await page.click('#btn-play');
  await sleep(6000);
  await shot(page, '07-vue-generale', { map: true, jpeg: true });
  await page.click('#btn-stop');
  await sleep(2000);

  // suivi rapproché + cap (la vue générale est cochée par défaut : on la décoche)
  await page.uncheck('#overview-check');
  await page.check('#orient-check');
  await page.click('#btn-play');
  await sleep(14000);
  await shot(page, '08-suivi', { map: true, jpeg: true });
  await page.click('#btn-stop');
  await page.uncheck('#orient-check');   // avant de recocher la vue générale, qui la grise
  await page.check('#overview-check');
  await sleep(2500);

  // menus de la carte
  await openMapMenu(page, 'menu-map');
  await shot(page, '09-fonds', { sel: '#menu-map .map-pop' });
  await closeMapMenu(page, 'menu-map');
  await openMapMenu(page, 'menu-legend');
  await shot(page, '10-legende', { sel: '#legend-pop' });
  await closeMapMenu(page, 'menu-legend');

  // options et thème clair
  await page.click('#btnTrackStyle');
  await sleep(600);
  await shot(page, '11-options', { sel: '#track-style-section' });
  await page.click('#theme-light');
  await sleep(3000);
  await shot(page, '12-theme-clair', { jpeg: true });
  await page.click('#theme-dark');
  await sleep(2000);
  await page.click('#btnTsClose').catch(() => {});

  // barre météo (dépliée) et coordonnées
  await page.evaluate(() => {
    const b = document.getElementById('weather-bar');
    if (b && b.classList.contains('collapsed')) document.getElementById('weather-toggle').click();
  });
  await sleep(1500);
  await shot(page, '15-meteo', { sel: '#weather-bar' });
  await page.click('#coord-toggle', { force: true });
  const box = await page.locator('#map').boundingBox();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await sleep(800);
  await shot(page, '14-coordonnees', { sel: '#coord-box' });

  // relief : inclinaison de la caméra
  await page.locator('#pitch-slider').fill('55');
  await sleep(3500);
  await shot(page, '16-assiette', { map: true, jpeg: true });
  await page.locator('#pitch-slider').fill('0');
  await sleep(2000);

  // points de la trace (menu du clic droit)
  const cx = box.x + box.width * 0.62, cy = box.y + box.height * 0.45;
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await sleep(600);
  await shot(page, '13-menu-clic-droit', { sel: '#map-ctx-menu' });
  await page.click('#ctx-show-points', { force: true }).catch(() => {});
  await sleep(1800);
  await shot(page, '13-points', { map: true, jpeg: true });
  await page.click('#ctx-show-points', { force: true }).catch(() => {});
  await page.keyboard.press('Escape');

  // panneaux : OpenStreetMap, aide rapide
  await page.click('#btnOsm');
  await sleep(900);
  await shot(page, '21-osm', { sel: '#osmPanel' });
  await page.click('#btnOsmClose').catch(() => page.keyboard.press('Escape'));
  await sleep(500);
  await page.click('#btnInfo');
  await sleep(900);
  await shot(page, '22-aide-rapide', { sel: '.doc-modal' });
  await page.click('#btnDocClose').catch(() => page.keyboard.press('Escape'));
  await ctx.close();
}

async function phoneImages(browser, base){
  console.log('Captures téléphone…');
  const start = PTS[0];
  // téléphone : mise en page empilée et menu Outils
  const pctx = await newContext(browser, {
    viewport: { width: PHONE.width, height: PHONE.height },
    deviceScaleFactor: PHONE.deviceScaleFactor, isMobile: true, hasTouch: true,
    permissions: ['geolocation'], geolocation: { latitude: start.lat, longitude: start.lon, accuracy: 8 },
  });
  const ppage = await open(pctx, base);
  await loadDemo(ppage);
  await ppage.screenshot({ path: path.join(IMG, '23-telephone.jpg'), type: 'jpeg', quality: 82 });
  console.log('  ✔ img/23-telephone.jpg');
  await ppage.click('#btnTools');
  await sleep(700);
  await ppage.locator('#tools-menu').screenshot({ path: path.join(IMG, '24-outils.png') });
  console.log('  ✔ img/24-outils.png');
  await pctx.close();
}

/* positions successives le long de la trace, transmises comme des relevés GPS */
async function walk(ctx, fromD, toD, opts = {}){
  const step = opts.step || 4, ms = opts.ms || 250, off = opts.offset || 0;
  for (let d = fromD; d <= toD; d += step){
    let p = at(d);
    if (off) p = dest(p, headingAt(d) + 90, off);
    await ctx.setGeolocation({ latitude: p.lat, longitude: p.lon, accuracy: opts.accuracy || 8 });
    await sleep(ms);
  }
}

async function guidanceImages(browser, base){
  console.log('Captures du guidage…');
  const far = dest(PTS[0], 25, 3000);   // 3 km du départ : la fenêtre « départ éloigné » s'ouvre
  const ctx = await newContext(browser, {
    permissions: ['geolocation'],
    geolocation: { latitude: far.lat, longitude: far.lon, accuracy: 8 },
  });
  const page = await open(ctx, base);
  await loadDemo(page);
  await page.click('#btn-nav');
  await page.waitForSelector('#nav-far:not([hidden])', { timeout: 20000 }).catch(() => {});
  await sleep(900);
  await shot(page, '20-guidage-depart', { jpeg: true });
  await page.click('#nav-far-close');
  await sleep(500);

  // sur la trace, à l'approche d'un virage marqué
  const dTurn = findTurn(250, 60);
  await walk(ctx, dTurn - 140, dTurn - 60, { step: 8, ms: 160 });
  await sleep(2000);
  await shotAround(page, '18-guidage-virage', '#track-title-badge', 80);
  await shot(page, '17-guidage-etat', { sel: '#nav-section' });

  // écart de 70 m : au-delà de deux fois la tolérance, la sortie est signalée tout de suite
  await walk(ctx, dTurn - 60, dTurn - 40, { step: 10, ms: 400, offset: 70 });
  await sleep(2500);
  await shotAround(page, '19-guidage-hors-trace', '#track-title-badge', 80);
  await page.click('#btn-nav');
  await ctx.close();
}

/* ---------------------------------------------------------------- vidéos */
async function recordVideo(browser, base, name, scenario){
  console.log('Vidéo ' + name + '…');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpx3d-vid-'));
  const ctx = await newContext(browser, {
    viewport: { width: VW, height: VH },
    recordVideo: { dir, size: { width: VW, height: VH } },
    ...(scenario.context || {}),
  });
  const t0 = Date.now();
  const page = await open(ctx, base);
  const video = page.video();
  if (scenario.prepare) await scenario.prepare(page, ctx);
  const skip = Math.min(90, Math.max(0, (Date.now() - t0) / 1000 - 0.8));   // on coupe le chargement au montage
  await scenario.act(page, ctx);
  await sleep(600);
  await ctx.close();
  if (!video){   // enregistrement indisponible (ffmpeg de Playwright absent)
    missing.push('video ' + name);
    console.warn('  ! video/' + name + " : l'enregistrement vidéo n'est pas disponible");
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  const webm = await video.path();
  const mp4 = path.join(VID, name + '.mp4');
  const encode = from => execFileSync('ffmpeg', ['-y', '-loglevel', 'error']
    .concat(from > 0 ? ['-ss', from.toFixed(1)] : [])
    .concat(['-i', webm, '-an', '-c:v', 'libx264', '-crf', '30', '-preset', 'veryfast',
             '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]));
  try {
    encode(skip);
    // garde-fou : si la coupe du chargement a tout emporté, on réencode la vidéo entière
    if (fs.statSync(mp4).size < 20000) encode(0);
    console.log('  ✔ video/' + name + '.mp4 (' + Math.round(fs.statSync(mp4).size / 1024) + ' Ko)');
  } catch (e) {
    fs.copyFileSync(webm, path.join(VID, name + '.webm'));
    console.warn('  ffmpeg indisponible : video/' + name + '.webm écrit à la place');
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

async function video(browser, base, name, scenario){ return safe('video ' + name, () => recordVideo(browser, base, name, scenario)); }

async function videos(browser, base){
  const start = PTS[0];
  const geo = { permissions: ['geolocation'], geolocation: { latitude: start.lat, longitude: start.lon, accuracy: 8 } };

  await video(browser, base, '01-demarrer', {
    context: geo,
    prepare: async page => { await sleep(1200); },
    act: async page => {
      await loadDemo(page);
      await page.click('#btn-play');
      await sleep(11000);
      await page.click('#btn-stop');
      await sleep(1500);
    },
  });

  await video(browser, base, '02-suivi-cap', {
    context: geo,
    prepare: async page => { await loadDemo(page); },
    act: async page => {
      await page.uncheck('#overview-check');
      await sleep(1200);
      await page.check('#orient-check');
      await sleep(1200);
      await page.click('#btn-play');
      await sleep(18000);
      await page.click('#btn-stop');
    },
  });

  await video(browser, base, '03-fonds', {
    context: geo,
    prepare: async page => { await loadDemo(page); },
    act: async page => {
      await openMapMenu(page, 'menu-map');
      await sleep(800);
      await page.check('input[name="basemap"][value="cyclosm"]');
      await sleep(3000);
      await page.check('input[name="basemap"][value="opentopo"]');
      await sleep(2500);
      await page.locator('#topo-opacity-range').fill('80');
      await sleep(2500);
      await page.locator('#topo-opacity-range').fill('30');
      await sleep(2000);
      await closeMapMenu(page, 'menu-map');
      await page.locator('#pitch-slider').fill('55');
      await sleep(3500);
      await page.locator('#pitch-slider').fill('0');
      await sleep(1500);
    },
  });

  await video(browser, base, '05-profil', {
    context: geo,
    prepare: async page => { await loadDemo(page); },
    act: async page => {
      const b = await page.locator('#chart').boundingBox();
      const y = b.y + b.height / 2;
      await page.mouse.move(b.x + 6, y);
      await page.mouse.down();
      for (let i = 1; i <= 24; i++){
        await page.mouse.move(b.x + (b.width - 12) * (i / 24), y);
        await sleep(260);
      }
      await page.mouse.up();
      await sleep(1200);
    },
  });

  // guidage GPS : marche simulée, sortie de trace puis retour
  const dTurn = findTurn(250, 60);
  const d0 = Math.max(40, dTurn - 180);
  await video(browser, base, '04-guidage', {
    context: {
      permissions: ['geolocation'],
      geolocation: { latitude: at(d0).lat, longitude: at(d0).lon, accuracy: 8 },
    },
    prepare: async (page, ctx) => {
      await loadDemo(page);
      await page.click('#btn-nav');
      await sleep(2500);
    },
    act: async (page, ctx) => {
      await walk(ctx, d0, dTurn + 60, { step: 3, ms: 220 });            // approche et passage du virage
      await walk(ctx, dTurn + 60, dTurn + 110, { step: 5, ms: 260, offset: 70 });  // sortie de trace
      await sleep(2500);
      await walk(ctx, dTurn + 110, dTurn + 150, { step: 5, ms: 260 });  // retour sur la trace
      await sleep(2000);
    },
  });
}

/* ---------------------------------------------------------------- */
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  console.log('Trace d\'exemple : ' + PTS.length + ' points, ' + (TOTAL / 1000).toFixed(2) + ' km');
  const browser = await chromium.launch({
    executablePath: CHROME_PATH || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  try {
    if (what === 'all' || what === 'img'){
      await safe('captures', () => images(browser, base));
      await safe('captures du guidage', () => guidanceImages(browser, base));
      await safe('captures téléphone', () => phoneImages(browser, base));
    }
    if (what === 'all' || what === 'video') await videos(browser, base);
  } finally {
    await browser.close();
    server.close();
  }
  if (missing.length) console.warn('Médias manquants (' + missing.length + ') : ' + missing.join(', '));
  console.log('Terminé.');
})().catch(e => { console.error(e); process.exit(1); });
