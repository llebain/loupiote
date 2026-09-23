// Mesure UNE fiche du corpus : pilote le vrai livrable dans Chrome, exporte
// le PDF par le bouton, relit ce PDF (et la source) avec pdf.js DANS Chrome
// (window.pdfjsLib, deja charge et fonctionnel dans la page de l'outil --
// evite tout probleme de worker pdf.js sous file:// en Node), calcule les
// metriques du lot 0.2 et ecrit tout dans <sortieDir>/<famille>/<nom>/.
//
// Concu pour tourner comme PROCESSUS ISOLE, lance par corpus.mjs
// (child_process.spawn), un par fiche. N'est PAS concu pour etre importe.
//
// Usage :
//   node corpus-un-doc.mjs <cheminSourcePdf> <famille> <nom> <corpsPt> <sortieDir>
//
// Ecrit <sortieDir>/<famille>/<nom>/metrics.json (toujours, meme en cas
// d'echec) + adapte.pdf + source-pN.png + adapte-pN.png (miniatures basse
// resolution). N'imprime qu'UNE seule ligne JSON sur stdout en sortie
// (resume, repris par corpus.mjs) -- tout le detail est dans metrics.json.

import pw from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { lireCmap } from './corpus-lib/cmap.mjs';
import { normaliserMots, couverture, ordre, duplication, mediane } from './corpus-lib/texte.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + path.resolve(__dirname, '../../adaptateur-pdf-luciole.html');
const MARGIN_MM = 20;
const MM_TO_PT = 2.83464567;
const MARGIN_PT = MARGIN_MM * MM_TO_PT;
const SEUIL_CONTRASTE = 4.5;
const SEUIL_CORPS_PT = 20;

const [, , srcPdf, famille, nom, corpsArg, sortieDirArg] = process.argv;
const corps = Number(corpsArg) || 24;
const sortieDoc = path.resolve(sortieDirArg, famille, nom);
// Repart d'un dossier vide : sinon les pages d'une campagne precedente
// (ex. 501 pages avant le garde-fou 0.3) restent et faussent la galerie.
fs.rmSync(sortieDoc, { recursive: true, force: true });
fs.mkdirSync(sortieDoc, { recursive: true });

function ecrireResultat(r) {
  fs.writeFileSync(path.join(sortieDoc, 'metrics.json'), JSON.stringify(r, null, 2));
  console.log(JSON.stringify({ nom, famille, statut: r.statut, duree_s: r.duree_s }));
}

function b64FromFile(p) { return fs.readFileSync(p).toString('base64'); }
function bufFromDataUrl(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Buffer.from(b64, 'base64');
}

// -----------------------------------------------------------------------
// Fonction executee DANS la page (window.pdfjsLib deja pret). Reçoit les
// octets base64 de la source et de l'export, rend chaque page (miniature +
// canvas d'analyse), extrait items texte / images, groupe en "lignes" et
// mesure le contraste ligne par ligne.
// -----------------------------------------------------------------------
async function analyserDansLaPage(b64Source, b64Adapte, seuilContraste) {
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function contraste(rgb1, rgb2) {
    const lum = ([r, g, b]) => {
      const f = (c) => { const cs = c / 255; return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const L1 = lum(rgb1), L2 = lum(rgb2);
    const [hi, lo] = L1 >= L2 ? [L1, L2] : [L2, L1];
    return (hi + 0.05) / (lo + 0.05);
  }

  // Rend une page pdf.js sur un canvas hors-DOM, a l'echelle donnee.
  async function renderPage(page, scale) {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    await page.render({ canvasContext: ctx, viewport }).promise;
    return { canvas, ctx, viewport };
  }

  // Teste si un rectangle (pt, coordonnees PDF) chevauche au moins un des
  // rectangles d'image donnes (memes coordonnees). Utilise pour EXCLURE les
  // pixels d'image du calcul de contraste d'une ligne de texte (une ligne
  // dont la boite recouvre une illustration ne doit pas faire mesurer le
  // "fond" ou l'"encre" sur les pixels de la photo).
  function chevaucheImage(boxPdf, images) {
    for (const im of images) {
      if (boxPdf.x0 < im.x1 && boxPdf.x1 > im.x0 && boxPdf.y0 < im.y1 && boxPdf.y1 > im.y0) return true;
    }
    return false;
  }

  // Parcourt l'operator list pour recuperer les boites des images peintes,
  // en suivant la matrice de transformation courante (save/restore/transform).
  async function imagesDeLaPage(page, OPS) {
    const opList = await page.getOperatorList();
    const stack = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const mul = (m1, m2) => [
      m1[0] * m2[0] + m1[1] * m2[2], m1[0] * m2[1] + m1[1] * m2[3],
      m1[2] * m2[0] + m1[3] * m2[2], m1[2] * m2[1] + m1[3] * m2[3],
      m1[4] * m2[0] + m1[5] * m2[2] + m2[4], m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
    ];
    const out = [];
    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i];
      const args = opList.argsArray[i];
      if (fn === OPS.save) { stack.push(ctm); }
      else if (fn === OPS.restore) { ctm = stack.pop() || [1, 0, 0, 1, 0, 0]; }
      else if (fn === OPS.transform) { ctm = mul(args, ctm); }
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
        // Unite [0,1]x[0,1] mappee par ctm : coins.
        const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [
          ctm[0] * x + ctm[2] * y + ctm[4],
          ctm[1] * x + ctm[3] * y + ctm[5],
        ]);
        const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
        out.push({ x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
      }
    }
    return out;
  }

  async function analyserDocument(bytes, { avecContraste, echelleMiniature, echelleComplete }) {
    const doc = await window.pdfjsLib.getDocument({ data: bytes }).promise;
    const OPS = window.pdfjsLib.OPS;
    const pages = [];
    const items = [];
    const images = [];
    const contrasteLignes = [];
    const morceauxTexte = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const view = page.view; // [x0,y0,x1,y1] en pt
      const w = view[2] - view[0], h = view[3] - view[1];
      pages.push({ w, h });

      const tc = await page.getTextContent();
      const lignesIdx = []; // regroupement simple par proximite de baseline Y
      for (const it of tc.items) {
        // Exclut aussi les items "espace(s) seul(s)" : des cellules de
        // tableau vides (frequentes sur les tableaux casses, F4) peuvent
        // contenir un item texte reduit a un espace, positionne au milieu
        // de la cellule -- s'il est garde, il sert de pont artificiel entre
        // deux vraies cellules de texte eloignees lors du regroupement en
        // ligne/segment (le trou reel entre elles redevient une suite de
        // petits trous sous le seuil), ce qui recree l'artefact que
        // segmenterParX ci-dessous est cense eliminer.
        if (!it.str || !it.str.trim()) continue;
        const [a, b, , d, e, f] = it.transform;
        const fontSize = Math.hypot(a, b) || Math.abs(d) || 1;
        const x0 = e, y0 = f - fontSize * 0.25; // marge basse approx (descendants)
        const wdt = it.width || fontSize * it.str.length * 0.5;
        const hgt = it.height || fontSize * 1.15;
        const rec = { page: p, str: it.str, x0, y0, x1: x0 + wdt, y1: y0 + hgt, fontSize };
        items.push(rec);
        morceauxTexte.push(it.str);
        // Groupe en ligne : meme page, baseline Y a moins de 2pt.
        let ligne = lignesIdx.find((L) => Math.abs(L.y - f) < 2);
        if (!ligne) { ligne = { y: f, items: [] }; lignesIdx.push(ligne); }
        ligne.items.push(rec);
      }

      const imgs = await imagesDeLaPage(page, OPS);
      for (const im of imgs) images.push({ page: p, ...im });

      // Miniature basse resolution (galerie) + rendu "complet" ~110dpi
      // (echelleComplete, cf. §0.2 point 3 : la miniature 0,35x/209px est
      // illisible pour relire un PDF -- lien clic-pour-agrandir depuis la
      // galerie). Le rendu complet des pages ADAPTEES est aussi reutilise
      // ci-dessous pour la mesure de contraste (pas de rendu en double).
      const { canvas: miniCanvas } = await renderPage(page, echelleMiniature);
      pages[pages.length - 1].png = miniCanvas.toDataURL('image/png');
      const { canvas: completCanvas, ctx: completCtx, viewport: completViewport } = await renderPage(page, echelleComplete);
      pages[pages.length - 1].pngComplet = completCanvas.toDataURL('image/png');

      // Un cluster "meme baseline Y" peut contenir des items de PLUSIEURS
      // COLONNES d'un tableau large (T1, F4 conjugaison) : meme Y, grand
      // ecart X. Preuve trouvee sur 18_Memo_Tableau_indiv (contraste_min
      // signale a 1,05 avant ce correctif) : la "ligne" mesuree melangeait
      // du texte de cellules DIFFERENTES ("les verbeschangerles", mots de
      // colonnes voisines concatenes sans espace) et donc leurs fonds de
      // cellule differents -- pas un vrai texte continu sur un fond uni.
      // Sous-segmente donc chaque cluster Y par ecart en X avant de
      // mesurer le contraste : une vraie ligne de texte n'a jamais un trou
      // de plus de ~1,8x son corps entre deux mots consecutifs.
      function segmenterParX(ligne) {
        const items = ligne.items.slice().sort((a, b) => a.x0 - b.x0);
        const segments = [];
        let cur = [];
        let prevX1 = null;
        for (const it of items) {
          const seuil = Math.max(15, it.fontSize * 1.8);
          if (prevX1 !== null && it.x0 - prevX1 > seuil) {
            if (cur.length) segments.push(cur);
            cur = [];
          }
          cur.push(it);
          prevX1 = prevX1 === null ? it.x1 : Math.max(prevX1, it.x1);
        }
        if (cur.length) segments.push(cur);
        return segments;
      }

      if (avecContraste) {
        const ctx = completCtx, viewport = completViewport;
        for (const ligne of lignesIdx) for (const seg of segmenterParX(ligne)) {
          const xs = seg.map((r) => r.x0).concat(seg.map((r) => r.x1));
          const y0s = seg.map((r) => r.y0), y1s = seg.map((r) => r.y1);
          const boxPdf = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...y0s), y1: Math.max(...y1s) };
          // Exclut les lignes dont la boite recouvre une image detectee sur
          // cette page (§0.2 point 2 : une ligne a cheval sur une
          // illustration ne doit pas faire mesurer le contraste sur des
          // pixels de photo -- ce n'est pas du texte sur fond uni).
          if (chevaucheImage(boxPdf, imgs)) continue;
          // Conversion pt -> pixels canvas (viewport applique l'echelle et
          // l'inversion d'axe Y standard de pdf.js).
          const p0 = window.pdfjsLib.Util.applyTransform([boxPdf.x0, boxPdf.y1], viewport.transform);
          const p1 = window.pdfjsLib.Util.applyTransform([boxPdf.x1, boxPdf.y0], viewport.transform);
          const px0 = Math.max(0, Math.floor(Math.min(p0[0], p1[0])));
          const px1 = Math.min(ctx.canvas.width, Math.ceil(Math.max(p0[0], p1[0])));
          const py0 = Math.max(0, Math.floor(Math.min(p0[1], p1[1])));
          const py1 = Math.min(ctx.canvas.height, Math.ceil(Math.max(p0[1], p1[1])));
          if (px1 - px0 < 2 || py1 - py0 < 2) continue;
          let data;
          try { data = ctx.getImageData(px0, py0, px1 - px0, py1 - py0).data; } catch (e) { continue; }
          // Histogramme de couleurs quantifiees (pas de 16) pour trouver le
          // fond dominant, puis "encre" = moyenne des pixels les plus
          // eloignes du fond (percentile robuste, comme demande §0.2).
          const compte = new Map();
          const pixels = [];
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], bl = data[i + 2], al = data[i + 3];
            if (al < 128) continue;
            pixels.push([r, g, bl]);
            const key = (r >> 4) + ',' + (g >> 4) + ',' + (bl >> 4);
            compte.set(key, (compte.get(key) || 0) + 1);
          }
          if (pixels.length < 4) continue;
          let fondKey = null, fondN = -1;
          for (const [k, n] of compte) if (n > fondN) { fondN = n; fondKey = k; }
          const [fr, fg, fb] = fondKey.split(',').map((v) => Number(v) * 16 + 8);
          const distances = pixels.map(([r, g, bl]) => Math.hypot(r - fr, g - fg, bl - fb));
          const idxTri = distances.map((d, i) => [d, i]).sort((a, b) => b[0] - a[0]);
          const nEncre = Math.max(1, Math.round(pixels.length * 0.15));
          let sr = 0, sg = 0, sb = 0;
          for (let i = 0; i < nEncre; i++) { const [r, g, bl] = pixels[idxTri[i][1]]; sr += r; sg += g; sb += bl; }
          const encre = [Math.round(sr / nEncre), Math.round(sg / nEncre), Math.round(sb / nEncre)];
          const fond = [Math.round(fr), Math.round(fg), Math.round(fb)];
          const ratio = contraste(encre, fond);
          // N'a de sens que si l'"encre" est reellement distincte du fond
          // (une ligne monochrome n'a pas de texte a sa taille, contraste
          // non pertinent) : garde tout, filtre au besoin cote Node.
          const distMax = distances[idxTri[0][1]];
          contrasteLignes.push({
            page: p, ratio, distMax,
            x0: boxPdf.x0, y0: boxPdf.y0, x1: boxPdf.x1, y1: boxPdf.y1,
            encre, fond,
            texte: seg.map((r) => r.str).join('').slice(0, 40),
          });
        }
      }
    }
    await doc.destroy();
    return { pages, items, images, contrasteLignes, texte: morceauxTexte.join(' ') };
  }

  const source = await analyserDocument(b64ToBytes(b64Source), { avecContraste: false, echelleMiniature: 0.35, echelleComplete: 1.528 });
  const adapte = await analyserDocument(b64ToBytes(b64Adapte), { avecContraste: true, echelleMiniature: 0.35, echelleComplete: 1.528 });
  return { source, adapte };
}

async function main() {
  const t0 = Date.now();
  const browser = await pw.chromium.launch({ channel: 'chrome', headless: true });
  const consoleWarns = [];
  const pageErrors = [];
  let crashed = false;
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, acceptDownloads: true });
    page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));
    page.on('console', (m) => { if (m.type() === 'warning') consoleWarns.push(m.text()); });
    page.on('crash', () => { crashed = true; });

    await page.goto(APP);
    await page.setInputFiles('#input-fichier', srcPdf);

    // Regle le corps AVANT que l'apercu ne se calcule si possible ; sinon
    // reglee apres, ce qui redeclenche recomputeLayoutAndRender (voir
    // wireSettingsEvents dans 05-main.js).
    try {
      await page.waitForSelector('#reglage-taille', { timeout: 5000 });
      await page.evaluate((c) => {
        const el = document.getElementById('reglage-taille');
        if (el) { el.value = String(c); el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }
      }, corps);
    } catch (e) { /* reglage non trouve avant apercu : tant pis, defaut applique */ }

    await page.waitForFunction(() => document.querySelectorAll('.page-apercu').length > 0, { timeout: 80000 });
    await page.waitForTimeout(1200);

    const domInfo = await page.evaluate(() => {
      const pages = [...document.querySelectorAll('.page-apercu')];
      let over = 0;
      for (const pg of pages) {
        const pr = pg.getBoundingClientRect();
        for (const el of pg.querySelectorAll('.ligne, .bloc-boite, .cellule-tableau, img.image-apercu, table, .bloc-tableau')) {
          const q = el.getBoundingClientRect();
          if (q.bottom - pr.bottom > 1 || q.right - pr.right > 1) over++;
        }
      }
      const blocks = window.__DEBUG_BLOCKS__ || [];
      const texteSource = blocks
        .filter((b) => !b.secondary && !b.frontMatter && b.type !== 'needs-ocr')
        .map((b) => (b.runs || []).map((r) => r.text || '').join(''))
        .join(' ');
      return { pagesApercu: pages.length, over, texteSource, blocksDisponibles: !!window.__DEBUG_BLOCKS__ };
    });

    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      page.click('#btn-telecharger'),
    ]);
    const adaptePath = path.join(sortieDoc, 'adapte.pdf');
    await dl.saveAs(adaptePath);

    if (crashed) throw new Error('Target crashed (page crash Chromium)');

    const b64Source = b64FromFile(srcPdf);
    const b64Adapte = b64FromFile(adaptePath);
    await page.addScriptTag({ content: `window.__analyserCorpus__ = ${analyserDansLaPage.toString()};` });
    const resultatAnalyse = await page.evaluate(
      ([bs, ba, seuil]) => window.__analyserCorpus__(bs, ba, seuil),
      [b64Source, b64Adapte, SEUIL_CONTRASTE]
    );

    const { source, adapte } = resultatAnalyse;

    // --- Ecriture des miniatures PNG + rendus complets (~110dpi, point 3) ---
    source.pages.forEach((p, i) => {
      if (p.png) fs.writeFileSync(path.join(sortieDoc, `source-p${i + 1}.png`), bufFromDataUrl(p.png));
      if (p.pngComplet) fs.writeFileSync(path.join(sortieDoc, `source-p${i + 1}-complet.png`), bufFromDataUrl(p.pngComplet));
    });
    adapte.pages.forEach((p, i) => {
      if (p.png) fs.writeFileSync(path.join(sortieDoc, `adapte-p${i + 1}.png`), bufFromDataUrl(p.png));
      if (p.pngComplet) fs.writeFileSync(path.join(sortieDoc, `adapte-p${i + 1}-complet.png`), bufFromDataUrl(p.pngComplet));
    });

    // --- Metriques texte (couverture / duplication) ---
    const motsSource = normaliserMots(domInfo.texteSource);
    const motsSortie = normaliserMots(adapte.texte);
    const couvertureVal = couverture(motsSource, motsSortie);
    const ordreVal = ordre(motsSource, motsSortie);
    const duplicationVal = duplication(motsSource, motsSortie);

    // --- Debordement (texte + images), cadre de page ET zone utile ---
    let debCadre = 0, debZoneUtile = 0;
    const eps = 0.5;
    function dimsPage(p) { return adapte.pages[p - 1] || { w: 0, h: 0 }; }
    for (const it of adapte.items) {
      const { w, h } = dimsPage(it.page);
      if (it.x0 < -eps || it.y0 < -eps || it.x1 > w + eps || it.y1 > h + eps) debCadre++;
      if (it.x0 < MARGIN_PT - eps || it.y0 < MARGIN_PT - eps || it.x1 > w - MARGIN_PT + eps || it.y1 > h - MARGIN_PT + eps) debZoneUtile++;
    }
    for (const im of adapte.images) {
      const { w, h } = dimsPage(im.page);
      if (im.x0 < -eps || im.y0 < -eps || im.x1 > w + eps || im.y1 > h + eps) debCadre++;
      if (im.x0 < MARGIN_PT - eps || im.y0 < MARGIN_PT - eps || im.x1 > w - MARGIN_PT + eps || im.y1 > h - MARGIN_PT + eps) debZoneUtile++;
    }

    // --- Remplissage par page ---
    const remplissage = adapte.pages.map((pdims, idx) => {
      const p = idx + 1;
      const usableTop = pdims.h - MARGIN_PT, usableBottom = MARGIN_PT;
      const usableHeight = Math.max(1, usableTop - usableBottom);
      let minY0 = pdims.h;
      for (const it of adapte.items) if (it.page === p) minY0 = Math.min(minY0, it.y0);
      for (const im of adapte.images) if (im.page === p) minY0 = Math.min(minY0, im.y0);
      const couvert = usableTop - Math.max(minY0, usableBottom);
      return Math.max(0, Math.min(1, couvert / usableHeight));
    });

    // --- Corps / lignes ---
    const taillesTexte = adapte.items.filter((it) => it.str.trim()).map((it) => it.fontSize);
    const corpsMin = taillesTexte.length ? Math.min(...taillesTexte) : null;
    const nSousXXpt = taillesTexte.filter((s) => s < SEUIL_CORPS_PT).length;
    // Regroupement en lignes (page + baseline proche) pour la mediane car./ligne.
    const lignesMap = new Map();
    for (const it of adapte.items) {
      const key = it.page + ':' + Math.round(it.y0 / 2);
      lignesMap.set(key, (lignesMap.get(key) || '') + it.str);
    }
    const longueursLignes = [...lignesMap.values()].map((s) => s.trim().length).filter((n) => n > 0);
    const medCarLigne = mediane(longueursLignes);

    // --- Contraste ---
    const lignesContrasteValides = adapte.contrasteLignes.filter((l) => l.distMax > 20 && l.texte.trim().length > 0);
    const ratios = lignesContrasteValides.map((l) => l.ratio);
    const contrasteMin = ratios.length ? Math.min(...ratios) : null;
    const nSousContraste = ratios.filter((r) => r < SEUIL_CONTRASTE).length;
    // Detail auditable des lignes sous le seuil -- LOCAL UNIQUEMENT (ce
    // fichier metrics.json par document, jamais corpus/_reference/) : pas
    // de contenu de fiche dans les champs numeriques (page/position/couleurs),
    // le texte va dans un champ separe `texte_debut` (<=30 car.) pour rester
    // isolable si jamais ce detail devait un jour remonter plus loin.
    const lignesSousContraste = lignesContrasteValides
      .filter((l) => l.ratio < SEUIL_CONTRASTE)
      .map((l) => ({
        page: l.page,
        x_pt: Number(l.x0.toFixed(1)),
        y_pt: Number(l.y0.toFixed(1)),
        ratio: Number(l.ratio.toFixed(2)),
        encre_rgb: l.encre,
        fond_rgb: l.fond,
        texte_debut: l.texte.slice(0, 30),
      }))
      .sort((a, b) => a.ratio - b.ratio);

    // --- Glyphes absents (Luciole) ---
    const cmapPath = path.resolve(__dirname, '../../assets/fonts/Luciole-Regular.ttf');
    const cmap = lireCmap(fs.readFileSync(cmapPath));
    const carsVus = new Set();
    for (const ch of adapte.texte) carsVus.add(ch);
    for (const ch of domInfo.texteSource) carsVus.add(ch);
    const glyphesAbsents = [...carsVus].filter((ch) => {
      const cp = ch.codePointAt(0);
      if (cp <= 0x20) return false; // espaces/controles hors-sujet
      return !cmap.has(cp);
    });

    const dureeS = (Date.now() - t0) / 1000;
    const avertDernierRecours = consoleWarns.filter((w) => w.includes('debordement de dernier recours') || w.includes('débordement de dernier recours'));

    const resultat = {
      nom, famille, fichier: path.basename(srcPdf),
      statut: pageErrors.length ? 'erreur-js' : 'ok',
      duree_s: Number(dureeS.toFixed(1)),
      corps,
      pages: adapte.pages.length,
      pagesApercu: domInfo.pagesApercu,
      pagesSource: source.pages.length,
      remplissage,
      couverture: Number(couvertureVal.toFixed(4)),
      ordre: Number(ordreVal.toFixed(4)),
      duplication: Number(duplicationVal.toFixed(4)),
      debordement_cadre: debCadre,
      debordement_zone_utile: debZoneUtile,
      debordement_dom_over: domInfo.over,
      contraste_min: contrasteMin === null ? null : Number(contrasteMin.toFixed(2)),
      n_sous_contraste: nSousContraste,
      n_lignes_contraste_mesurees: ratios.length,
      lignes_sous_contraste: lignesSousContraste,
      glyphes_absents: glyphesAbsents,
      n_glyphes_absents: glyphesAbsents.length,
      corps_min: corpsMin === null ? null : Number(corpsMin.toFixed(2)),
      n_sous_20pt: nSousXXpt,
      med_car_ligne: Number(medCarLigne.toFixed(1)),
      n_erreurs_js: pageErrors.length,
      erreurs_js: pageErrors.slice(0, 5),
      n_avertissements: consoleWarns.length,
      avertissements_5premiers: consoleWarns.slice(0, 5),
      n_avert_dernier_recours: avertDernierRecours.length,
      blocksDisponibles: domInfo.blocksDisponibles,
      nMotsSource: motsSource.length,
      nMotsSortie: motsSortie.length,
    };
    ecrireResultat(resultat);
  } catch (e) {
    const dureeS = (Date.now() - t0) / 1000;
    const messageErr = String((e && e.stack) || e);
    const estPlantage = crashed || /Target crashed|Target closed|crash/i.test(messageErr);
    const estDelai = /Timeout|timeout/i.test(messageErr) && dureeS > 30;
    const statut = estPlantage ? 'plantage' : (estDelai ? 'delai-depasse' : (pageErrors.length ? 'erreur-js' : 'sans-sortie'));
    ecrireResultat({
      nom, famille, fichier: path.basename(srcPdf),
      statut, duree_s: Number(dureeS.toFixed(1)), corps,
      n_erreurs_js: pageErrors.length, erreurs_js: pageErrors.slice(0, 5),
      n_avertissements: consoleWarns.length, avertissements_5premiers: consoleWarns.slice(0, 5),
      fatal: messageErr.slice(0, 400),
    });
  } finally {
    try { await browser.close(); } catch (e) { /* ignore */ }
  }
}

main().catch((e) => {
  ecrireResultat({ nom, famille, fichier: path.basename(srcPdf), statut: 'sans-sortie', duree_s: null, fatal: String(e).slice(0, 400) });
  process.exit(1);
});
