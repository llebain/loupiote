// Plan v0.3 -- meme principe que visual.mjs, sur les fixtures synthetiques
// (tests/fixtures/, aucune fiche du corpus) : pilote le VRAI livrable dans
// Chrome, depose chaque fixture, telecharge le PDF par le bouton, et
// verifie ce que le harnais Node ne voit pas -- images (mascottes en
// icone, E6), apercu DOM (debordement, pages paysage E4), erreurs JS,
// avertissements [garde-fou] de la page.
//
// Usage : node v03-navigateur.mjs            (Chrome installe : channel 'chrome')
//         CHROME_PATH=/chemin/chrome node v03-navigateur.mjs
//         SHOTS=1 node v03-navigateur.mjs    (+ captures dans ./sorties-visuelles/)
import pw from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + path.resolve(__dirname, '../../adaptateur-pdf-luciole.html');
const FIX = path.resolve(__dirname, '../fixtures');
const OUT = path.resolve(__dirname, 'sorties-visuelles');

const FIXTURES = [
  { f: '07-mascottes.pdf', minIcons: 3 },
  { f: 'v3-tableau-large.pdf', landscapePages: 2 },
  { f: 'v3-decoupe.pdf', maxPages: 1 },
  { f: 'v3-couleurs.pdf' },
  { f: 'v3-glyphes.pdf' },
  { f: 'v3-faux-tableaux.pdf', maxPages: 2 },
  { f: 'v3-pastille.pdf' },
  { f: '05-avec-images.pdf', minImages: 1 },
  { f: 'erreur-corrompu.pdf', erreur: /PDF valide|ouvrir ce PDF/ },
  { f: 'erreur-mot-de-passe.pdf', erreur: /mot de passe/ },
];

let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) pass++;
  else { fail++; failures.push(`${label}: ${detail}`); console.log(`  ✗ ${label}: ${detail}`); }
}

async function main() {
  const launch = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' };
  const browser = await pw.chromium.launch({ ...launch, headless: true });
  if (process.env.SHOTS) fs.mkdirSync(OUT, { recursive: true });
  for (const fx of FIXTURES) {
    console.log(`\n=== ${fx.f} (navigateur) ===`);
    const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 1000 }, deviceScaleFactor: process.env.SHOTS ? 2.5 : 1 });
    const page = await ctx.newPage();
    const warns = [], errors = [], requests = [];
    page.on('console', (m) => { if (m.type() === 'warning') warns.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) requests.push(r.url()); });
    await page.goto(APP);
    await page.waitForFunction(() => !document.getElementById('progression').textContent, null, { timeout: 60000 });
    if (fx.erreur && !fs.existsSync(path.join(FIX, fx.f))) { console.log('  (fixture absente, ignoree)'); await ctx.close(); continue; }
    await page.setInputFiles('#input-fichier', path.join(FIX, fx.f));
    if (fx.erreur) {
      // Fichier invalide : message d'erreur explicite, aucune page, aucune
      // erreur JS non rattrapee.
      await page.waitForSelector('#messages .erreur', { timeout: 30000 }).catch(() => {});
      const msg = await page.evaluate(() => [...document.querySelectorAll('#messages .erreur')].map((e) => e.textContent).join(' '));
      check(`${fx.f}/message-erreur`, fx.erreur.test(msg), `message : "${msg}"`);
      check(`${fx.f}/erreurs-js`, errors.length === 0, errors.join(' | '));
      await ctx.close();
      continue;
    }
    await page.waitForFunction(() => document.querySelectorAll('.page-apercu').length > 0, null, { timeout: 60000 });
    await page.waitForTimeout(500);
    const dom = await page.evaluate(() => {
      const pages = [...document.querySelectorAll('.page-apercu')];
      let over = 0;
      for (const pg of pages) {
        const pr = pg.getBoundingClientRect();
        for (const el of pg.querySelectorAll('.ligne, .bloc-boite, .cellule-tableau, img.image-apercu')) {
          const q = el.getBoundingClientRect();
          if (q.bottom - pr.bottom > 1 || q.right - pr.right > 1) over++;
        }
      }
      const imgs = [...document.querySelectorAll('img.image-apercu')].map((i) => i.getBoundingClientRect().height);
      const land = pages.filter((p) => p.getBoundingClientRect().width > p.getBoundingClientRect().height).length;
      const italic = [...document.querySelectorAll('.page-apercu span')].filter((s) => getComputedStyle(s).fontStyle === 'italic').length;
      return { pages: pages.length, over, imgs, land, italic };
    });
    check(`${fx.f}/erreurs-js`, errors.length === 0, errors.join(' | '));
    const gf = warns.filter((w) => w.includes('[garde-fou]') || w.includes('dernier recours'));
    check(`${fx.f}/aucun-garde-fou`, gf.length === 0, gf.join(' | ').slice(0, 300));
    check(`${fx.f}/apercu-sans-debordement`, dom.over === 0, `${dom.over} element(s) hors page`);
    check(`${fx.f}/apercu-sans-italique`, dom.italic === 0, `${dom.italic} span(s) en italique`);
    check(`${fx.f}/aucune-requete-reseau`, requests.length === 0, requests.join(' '));
    if (fx.minIcons) {
      // Icone = hauteur ~1,5 x corps (24 pt) a l'echelle d'apercu 0,42.
      const icons = dom.imgs.filter((h) => h > 5 && h < 1.5 * 24 * 0.42 + 3);
      check(`${fx.f}/E6-mascottes-en-icone`, icons.length >= fx.minIcons, `hauteurs d'image : ${dom.imgs.map((h) => h.toFixed(1)).join(', ')}`);
    }
    if (fx.minImages) check(`${fx.f}/images`, dom.imgs.length >= fx.minImages, `${dom.imgs.length} image(s)`);
    if (fx.landscapePages) check(`${fx.f}/E4-apercu-paysage`, dom.land === fx.landscapePages, `${dom.land} page(s) paysage`);
    if (fx.maxPages) check(`${fx.f}/pages`, dom.pages <= fx.maxPages, `${dom.pages} pages`);

    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-telecharger')]);
    const buf = fs.readFileSync(await dl.path());
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf), disableFontFace: true, verbosity: 0 }).promise;
    check(`${fx.f}/export-pages`, doc.numPages === dom.pages, `export ${doc.numPages} page(s), apercu ${dom.pages}`);
    let land = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      const vp = (await doc.getPage(p)).getViewport({ scale: 1 });
      if (vp.width > vp.height) land++;
    }
    if (fx.landscapePages) check(`${fx.f}/E4-export-paysage`, land === fx.landscapePages, `${land} page(s) paysage exportee(s)`);
    if (process.env.SHOTS) {
      const els = await page.$$('.page-apercu');
      for (let i = 0; i < els.length; i++) await els[i].screenshot({ path: path.join(OUT, `${fx.f.replace('.pdf', '')}-p${i + 1}.png`) });
    }
    await ctx.close();
  }
  await browser.close();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${pass} test(s) navigateur reussis, ${fail} echec(s)`);
  if (fail) { console.log('\nEchecs :'); for (const f of failures) console.log('  - ' + f); process.exitCode = 1; }
}

main().catch((e) => { console.error('ERREUR FATALE:', e); process.exitCode = 1; });
