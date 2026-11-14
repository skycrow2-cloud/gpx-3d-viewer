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
const GPX_NAV = path.join(__dirname, 'demo-guidage.gpx');   // trace courte à virages francs, pour le guidage
/* OpenTopoMap renvoie des tuiles filigranées aux adresses de centre de données (politique
   d'usage) : les captures passent donc par CartoWeb.be, qui couvre la zone des traces. */
const CAPTURE_BASEMAP = process.env.CAPTURE_BASEMAP || 'cartoweb';
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

/* ------------------------------------------------- traces d'exemple : géométrie */
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
/* lit un GPX et en tire de quoi se déplacer le long de la trace (mètres depuis le départ) */
function readTrack(file){
  const pts = [...fs.readFileSync(file, 'utf8').matchAll(/<trkpt[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"/g)]
    .map(m => ({ lat: +m[1], lon: +m[2] }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + distM(pts[i - 1], pts[i]);
  const total = cum[cum.length - 1];
  const at = d => {
    d = Math.max(0, Math.min(total, d));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const seg = cum[i] - cum[i - 1];
    const t = seg > 0 ? (d - cum[i - 1]) / seg : 0;
    const a = pts[i - 1], b = pts[i];
    return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
  };
  /* changement de cap à `d` mètres : même fenêtre de 30 m que le guidage de l'outil */
  const turnAt = d => {
    const h1 = bearing(at(d - 30), at(d)), h2 = bearing(at(d), at(d + 30));
    return ((h2 - h1 + 540) % 360) - 180;
  };
  /* virage le plus marqué après `from` mètres, avec de la marge pour l'aborder */
  const findTurn = (from, minDeg) => {
    for (let d = from; d < total - 60; d += 5) if (Math.abs(turnAt(d)) >= minDeg) return d;
    return Math.min(from + 200, total - 100);
  };
  const headingAt = d => bearing(at(Math.max(0, d - 5)), at(Math.min(total, d + 5)));
  return { file, pts, cum, total, at, turnAt, findTurn, headingAt };
}
const DEMO = readTrack(GPX);
const NAV = readTrack(GPX_NAV);

/* ---------------------------------------------------------------- navigateur */
async function newContext(browser, opts = {}){
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, locale: 'fr-BE', ...opts });
  if (LOCAL_JS.maplibre) await ctx.route('**/maplibre-gl.min.js', r => r.fulfill({ path: LOCAL_JS.maplibre, contentType: 'text/javascript' }));
  if (LOCAL_JS.proj4) await ctx.route('**/proj4.js', r => r.fulfill({ path: LOCAL_JS.proj4, contentType: 'text/javascript' }));
  ctx.setDefaultTimeout(60000);
  return ctx;
}
async function open(ctx, base){
  const page = await ctx.newPage();
  page.on('pageerror', e => console.warn('  [erreur page]', e.message));
  await page.goto(base + '/index.html');
  await page.waitForFunction(() => window.__gpx3dMapReady === true, null, { timeout: 60000 }).catch(() => {});
  await setCheck(page, 'input[name="basemap"][value="' + CAPTURE_BASEMAP + '"]', true);
  await sleep(2500);
  return page;
}
async function loadDemo(page, file){
  for (let essai = 1; essai <= 2; essai++){
    await page.setInputFiles('#file-input', file || GPX);
    try { await page.waitForSelector('#stats-section:not([hidden])', { timeout: 60000 }); break; }
    catch (e) {
      if (essai === 2) throw e;
      console.warn('  … trace non chargée après 60 s, nouvel essai');
    }
  }
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
/* commandes passées directement au DOM : pendant une lecture animée (ou un chargement de
   tuiles sur un runner sans carte graphique), la page n'est jamais « stable » et les clics,
   cases et curseurs de Playwright finissent par expirer. */
async function jsClick(page, sel){
  await page.evaluate(s => { const e = document.querySelector(s); if (e) e.click(); }, sel);
  await sleep(300);
}
async function setCheck(page, sel, on){
  await page.evaluate(([s, v]) => {
    const c = document.querySelector(s);
    if (c && c.checked !== v){ c.checked = v; c.dispatchEvent(new Event('change', { bubbles: true })); }
  }, [sel, on]);
  await sleep(300);
}
async function setRange(page, sel, value){
  await page.evaluate(([s, v]) => {
    const r = document.querySelector(s);
    if (!r) return;
    r.value = String(v);
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
  }, [sel, value]);
  await sleep(300);
}
async function selectIndex(page, sel, index){
  await page.evaluate(([s, i]) => {
    const el = document.querySelector(s);
    if (!el || !el.options[i]) return;
    el.selectedIndex = i;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [sel, index]);
  await sleep(300);
}
/* capture d'une carte à un point donné du parcours : on y place le curseur de lecture
   au lieu de capturer pendant l'animation — une page qui se redessine en continu fait
   expirer la capture elle-même sur un runner sans carte graphique */
async function shotAt(page, name, frac){
  await setRange(page, '#seek', Math.round(frac * 1000));
  await mapIdle(page, 2500);
  await shot(page, name, { map: true, jpeg: true });
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
  const start = DEMO.pts[0];
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

  await selectIndex(page, '#mode-select', 2);
  await sleep(600);
  await shot(page, '04-profil', { sel: '#profile-section' });
  await shot(page, '05-lecture', { sel: '#playback-section' });
  await shot(page, '17-guidage-panneau', { sel: '#nav-section' });

  // repères de départ et d'arrivée : vue rapprochée sur le départ
  await page.evaluate(([lon, lat]) => window.__gpx3dMap.jumpTo({ center: [lon, lat], zoom: 16.5, pitch: 0, bearing: 0 }), [start.lon, start.lat]);
  await sleep(4000);
  await shot(page, '06-depart-arrivee', { map: true, jpeg: true });
  await jsClick(page, '#btn-stop');   // recadre la caméra sur l'ensemble de la trace
  await sleep(2500);

  // vue générale, position à mi-parcours
  await shotAt(page, '07-vue-generale', 0.45);
  await jsClick(page, '#btn-stop');
  await sleep(2000);

  // suivi rapproché + cap (la vue générale est cochée par défaut : on la décoche)
  await setCheck(page, '#overview-check', false);
  await setCheck(page, '#orient-check', true);
  await shotAt(page, '08-suivi', 0.45);
  await jsClick(page, '#btn-stop');
  await setCheck(page, '#orient-check', false);   // avant de recocher la vue générale, qui la grise
  await setCheck(page, '#overview-check', true);
  await sleep(2500);

  // menus de la carte
  await openMapMenu(page, 'menu-map');
  await shot(page, '09-fonds', { sel: '#menu-map .map-pop' });
  await closeMapMenu(page, 'menu-map');
  await openMapMenu(page, 'menu-legend');
  await shot(page, '10-legende', { sel: '#legend-pop' });
  await closeMapMenu(page, 'menu-legend');

  // options et thème clair
  await jsClick(page, '#btnTrackStyle');
  await sleep(600);
  await shot(page, '11-options', { sel: '#track-style-section' });
  await jsClick(page, '#theme-light');
  await sleep(3000);
  await shot(page, '12-theme-clair', { jpeg: true });
  await jsClick(page, '#theme-dark');
  await sleep(2000);
  await jsClick(page, '#btnTsClose');

  // barre météo (dépliée) et coordonnées
  await page.evaluate(() => {
    const b = document.getElementById('weather-bar');
    if (b && b.classList.contains('collapsed')) document.getElementById('weather-toggle').click();
  });
  await sleep(1500);
  await shot(page, '15-meteo', { sel: '#weather-bar' });
  await jsClick(page, '#coord-toggle');
  const box = await page.locator('#map').boundingBox();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await sleep(800);
  await shot(page, '14-coordonnees', { sel: '#coord-box' });

  // relief : inclinaison de la caméra
  await setRange(page, '#pitch-slider', 55);
  await sleep(3500);
  await shot(page, '16-assiette', { map: true, jpeg: true });
  await setRange(page, '#pitch-slider', 0);
  await sleep(2000);

  // points de la trace (menu du clic droit)
  const cx = box.x + box.width * 0.62, cy = box.y + box.height * 0.45;
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await sleep(600);
  await shot(page, '13-menu-clic-droit', { sel: '#map-ctx-menu' });
  await jsClick(page, '#ctx-show-points');
  await sleep(1800);
  await shot(page, '13-points', { map: true, jpeg: true });
  await jsClick(page, '#ctx-show-points');
  await page.keyboard.press('Escape');

  // panneaux : OpenStreetMap, aide rapide
  await jsClick(page, '#btnOsm');
  await sleep(900);
  await shot(page, '21-osm', { sel: '#osmPanel' });
  await jsClick(page, '#btnOsmClose');
  await sleep(500);
  await jsClick(page, '#btnInfo');
  await sleep(900);
  await shot(page, '22-aide-rapide', { sel: '.doc-modal' });
  await jsClick(page, '#btnDocClose');
  await ctx.close();
}

async function phoneImages(browser, base){
  console.log('Captures téléphone…');
  const start = DEMO.pts[0];
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
  await jsClick(ppage, '#btnTools');
  await sleep(700);
  await ppage.locator('#tools-menu').screenshot({ path: path.join(IMG, '24-outils.png') });
  console.log('  ✔ img/24-outils.png');
  await pctx.close();
}

/* attend que la carte ait fini de charger ce qu'elle affiche (tuiles comprises) */
async function mapIdle(page, extra){
  await page.waitForFunction(() => window.__gpx3dMap && window.__gpx3dMap.loaded(), null, { timeout: 30000 }).catch(() => {});
  await sleep(extra || 1500);
}

/* positions successives le long d'une trace, transmises comme des relevés GPS */
async function walk(ctx, trk, fromD, toD, opts = {}){
  const step = opts.step || 4, ms = opts.ms || 250, off = opts.offset || 0;
  for (let d = fromD; d <= toD; d += step){
    let p = trk.at(d);
    if (off) p = dest(p, trk.headingAt(d) + 90, off);
    await ctx.setGeolocation({ latitude: p.lat, longitude: p.lon, accuracy: opts.accuracy || 8 });
    await sleep(ms);
  }
}

async function guidanceImages(browser, base){
  console.log('Captures du guidage…');
  const far = dest(NAV.pts[0], 25, 3000);   // 3 km du départ : la fenêtre « départ éloigné » s'ouvre
  const ctx = await newContext(browser, {
    permissions: ['geolocation'],
    geolocation: { latitude: far.lat, longitude: far.lon, accuracy: 8 },
  });
  const page = await open(ctx, base);
  await loadDemo(page, GPX_NAV);
  await jsClick(page, '#btn-nav');
  await page.waitForSelector('#nav-far:not([hidden])', { timeout: 20000 }).catch(() => {});
  await sleep(900);
  await shot(page, '20-guidage-depart', { jpeg: true });
  await jsClick(page, '#nav-far-close');

  // sur la trace, à l'approche d'un virage franc
  const dTurn = NAV.findTurn(120, 60);
  await walk(ctx, NAV, dTurn - 140, dTurn - 60, { step: 8, ms: 160 });
  await mapIdle(page, 2500);
  await shotAround(page, '18-guidage-virage', '#track-title-badge', 90);
  await shot(page, '17-guidage-etat', { sel: '#nav-section' });

  // écart de 70 m : au-delà de deux fois la tolérance, la sortie est signalée tout de suite
  await walk(ctx, NAV, dTurn - 60, dTurn - 40, { step: 10, ms: 400, offset: 70 });
  await mapIdle(page, 2500);
  await shotAround(page, '19-guidage-hors-trace', '#track-title-badge', 90);
  await jsClick(page, '#btn-nav');
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
  const start = DEMO.pts[0];
  const geo = { permissions: ['geolocation'], geolocation: { latitude: start.lat, longitude: start.lon, accuracy: 8 } };

  await video(browser, base, '01-demarrer', {
    context: geo,
    prepare: async page => { await sleep(1200); },
    act: async page => {
      await loadDemo(page);
      await jsClick(page, '#btn-play');
      await sleep(11000);
      await jsClick(page, '#btn-stop');
      await sleep(1500);
    },
  });

  await video(browser, base, '02-suivi-cap', {
    context: geo,
    prepare: async page => { await loadDemo(page); },
    act: async page => {
      await setCheck(page, '#overview-check', false);
      await sleep(1200);
      await setCheck(page, '#orient-check', true);
      await sleep(1200);
      await jsClick(page, '#btn-play');
      await sleep(18000);
      await jsClick(page, '#btn-stop');
    },
  });

  await video(browser, base, '03-fonds', {
    context: geo,
    prepare: async page => { await loadDemo(page); },
    act: async page => {
      await openMapMenu(page, 'menu-map');
      await sleep(2000);
      await setRange(page, '#topo-opacity-range', 80);
      await sleep(2500);
      await setRange(page, '#topo-opacity-range', 30);
      await sleep(2000);
      await closeMapMenu(page, 'menu-map');
      await setRange(page, '#pitch-slider', 55);
      await sleep(3500);
      await setRange(page, '#pitch-slider', 0);
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

  // guidage GPS : marche simulée sur la trace à virages, sortie de trace puis retour
  const dTurn = NAV.findTurn(120, 60);
  const d0 = Math.max(40, dTurn - 120);
  await video(browser, base, '04-guidage', {
    context: {
      permissions: ['geolocation'],
      geolocation: { latitude: NAV.at(d0).lat, longitude: NAV.at(d0).lon, accuracy: 8 },
    },
    prepare: async (page, ctx) => {
      await loadDemo(page, GPX_NAV);
      await jsClick(page, '#btn-nav');
      await sleep(3000);
    },
    act: async (page, ctx) => {
      await walk(ctx, NAV, d0, dTurn + 120, { step: 3, ms: 220 });                      // approche et passage du virage
      await walk(ctx, NAV, dTurn + 120, dTurn + 170, { step: 5, ms: 260, offset: 70 }); // sortie de trace
      await sleep(3000);
      await walk(ctx, NAV, dTurn + 170, dTurn + 230, { step: 5, ms: 260 });             // retour sur la trace
      await sleep(2000);
    },
  });
}

/* ---------------------------------------------------------------- */
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  console.log('Traces d\'exemple : ' + DEMO.pts.length + ' points / ' + (DEMO.total / 1000).toFixed(2) + ' km'
    + ' · guidage ' + NAV.pts.length + ' points / ' + (NAV.total / 1000).toFixed(2) + ' km'
    + ' · fond ' + CAPTURE_BASEMAP);
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
