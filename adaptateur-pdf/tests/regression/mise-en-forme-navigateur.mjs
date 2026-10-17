// Edition « traitement de texte » (retour de test d'Estelle) -- l'editeur
// riche dans Chrome : gras, souligne, retour a la ligne (Maj + Entree),
// alignement / justification, interligne, espaces, retrait, style de
// paragraphe, coller sans mise en forme, pas d'italique, export PDF.
// Pilote le VRAI livrable (adaptateur-pdf-luciole.html), clics et frappes reels.
//
// Usage : node mise-en-forme-navigateur.mjs   (Chrome installe, ou CHROME_PATH)
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

let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) pass++;
  else { fail++; failures.push(`${label}: ${detail}`); console.log(`  ✗ ${label}: ${detail}`); }
}

async function ouvrir(browser, fixture) {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1700, height: 1100 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const page = await ctx.newPage();
  const errors = [], requests = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) requests.push(r.url()); });
  await page.goto(APP);
  await page.waitForFunction(() => !document.getElementById('progression').textContent, null, { timeout: 60000 });
  await page.setInputFiles('#input-fichier', path.join(FIX, fixture));
  await page.waitForFunction(() => document.querySelectorAll('.page-apercu').length > 0, null, { timeout: 60000 });
  await page.click('#btn-modifier-texte');
  return { ctx, page, errors, requests };
}
// L'apercu se met a jour seul, peu apres la derniere action.
const attendre = (page) => page.waitForTimeout(1300);
const lignes = (page, n = 1e9) => page.evaluate((max) => [...document.querySelectorAll('.page-apercu')[0].querySelectorAll('.ligne')].slice(0, max).map((l) => {
  const r = l.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, text: l.textContent, bold: l.style.fontWeight === 'bold' || [...l.children].some((s) => s.style.fontWeight === 'bold'), under: [...l.children].some((s) => /underline/.test(s.style.textDecoration)) };
}), n);
// Ordonnee (document) de la premiere ligne d'apercu qui commence par `debut`.
const topDe = (page, debut) => page.evaluate((d) => {
  const l = [...document.querySelectorAll('.page-apercu .ligne')].find((x) => x.textContent.replace(/^•\s+/, '').startsWith(d));
  return l ? l.getBoundingClientRect().top + window.scrollY : null;
}, debut);
const pageBox = (page) => page.evaluate(() => { const r = document.querySelector('.page-apercu').getBoundingClientRect(); return { left: r.left, right: r.right }; });
const para = (page, i = 0) => page.locator('#editeur-texte p').nth(i);
async function selectionnerParagraphe(page, i = 0) {
  await page.evaluate((k) => {
    const p = document.querySelectorAll('#editeur-texte p')[k];
    p.parentElement.focus();
    const r = document.createRange(); r.selectNodeContents(p);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }, i);
}

async function main() {
  const launch = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' };
  const browser = await pw.chromium.launch({ ...launch, headless: true, args: ['--no-sandbox'] });

  // --- Barre d'outils ------------------------------------------------------------
  console.log('\n=== barre d\'outils ===');
  {
    const { ctx, page, errors, requests } = await ouvrir(browser, '06-page-unique-dense.pdf');
    check('barre/visible', await page.isVisible('#editeur-barre'), 'barre absente');
    check('barre/editeur-editable', (await page.getAttribute('#editeur-texte', 'contenteditable')) === 'true', 'zone non editable');
    for (const sel of ['#outil-gras', '#outil-souligne', '#outil-saut', '[data-align=left]', '[data-align=center]', '[data-align=right]', '[data-align=justify]', '#outil-type', '#outil-interligne', '#outil-avant', '#outil-apres', '#outil-retrait-plus', '#outil-retrait-moins']) {
      check(`barre/${sel}`, await page.isVisible(sel), 'controle absent');
    }
    check('barre/pas-d-italique', (await page.locator('#editeur-barre', { hasText: /italique/i }).count()) === 0, 'bouton italique present');
    const roles = await page.evaluate(() => ({ gras: document.getElementById('outil-gras').getAttribute('aria-pressed'), tb: document.getElementById('editeur-barre').getAttribute('role') }));
    check('barre/accessible', roles.gras === 'false' && roles.tb === 'toolbar', JSON.stringify(roles));
    await ctx.close();
    check('barre/aucune-erreur-js', errors.length === 0, errors.join(' | '));
    check('barre/aucune-requete-reseau', requests.length === 0, requests.join(' '));
  }

  // --- Alignement et justification ----------------------------------------------
  console.log('\n=== alignement ===');
  {
    const { ctx, page, errors } = await ouvrir(browser, '06-page-unique-dense.pdf');
    const avant = await lignes(page, 8);
    const pb = await pageBox(page);
    check('align/depart-a-gauche', avant.every((l) => Math.abs(l.left - avant[0].left) < 1), 'lignes decalees au depart');

    await para(page).click();
    await page.click('[data-align=center]');
    await attendre(page);
    check('align/bouton-presse', (await page.getAttribute('[data-align=center]', 'aria-pressed')) === 'true' && (await page.getAttribute('[data-align=left]', 'aria-pressed')) === 'false', 'etat du bouton');
    let l = await lignes(page, 8);
    const milieu = (pb.left + pb.right) / 2;
    check('align/centre', l.every((x) => Math.abs((x.left + x.right) / 2 - milieu) < 3), `centres : ${l.map((x) => Math.round((x.left + x.right) / 2))} (page ${Math.round(milieu)})`);

    await page.click('[data-align=right]');
    await attendre(page);
    l = await lignes(page, 8);
    check('align/droite', l.every((x) => Math.abs(x.right - l[0].right) < 1) && l[0].right > avant[0].right - 1, `droites : ${l.map((x) => Math.round(x.right))}`);

    await page.click('[data-align=justify]');
    await attendre(page);
    l = await lignes(page, 8);
    check('justifie/bords-droits-alignes', l.every((x) => Math.abs(x.right - l[0].right) < 1.5), `droites : ${l.map((x) => x.right.toFixed(1))}`);
    check('justifie/bords-gauches-alignes', l.every((x) => Math.abs(x.left - l[0].left) < 1), 'bord gauche decale');
    // Derniere ligne du paragraphe (donc du document) : jamais etiree.
    const derniere = await page.evaluate(() => { const ls = document.querySelectorAll('.page-apercu .ligne'); const r = ls[ls.length - 1].getBoundingClientRect(); return { left: r.left, right: r.right }; });
    check('justifie/derniere-ligne-non-etiree', derniere.right < l[0].right - 5, `derniere ligne : ${derniere.right.toFixed(1)} contre ${l[0].right.toFixed(1)}`);
    check('justifie/meme-texte', (await page.evaluate(() => [...document.querySelectorAll('.page-apercu .ligne')].map((x) => x.textContent).join(' ').replace(/\s+/g, ' '))).includes('Il etait une fois'), 'texte perdu');

    // Export : le texte justifie reste du vrai texte.
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-telecharger')]);
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(fs.readFileSync(await dl.path())), disableFontFace: true, verbosity: 0 }).promise;
    const tc = await (await doc.getPage(1)).getTextContent();
    const texte = tc.items.map((i) => i.str).join(' ');
    check('justifie/export-vrai-texte', /Il\s+etait\s+une\s+fois/.test(texte), `texte exporte : ${texte.slice(0, 80)}`);

    await page.click('[data-align=left]');
    await attendre(page);
    l = await lignes(page, 8);
    check('align/retour-a-gauche', l.every((x) => Math.abs(x.left - l[0].left) < 1) && Math.abs(l[0].left - avant[0].left) < 1, 'retour a gauche');
    await ctx.close();
    check('align/aucune-erreur-js', errors.length === 0, errors.join(' | '));
  }

  // --- Gras, souligne, retour a la ligne -----------------------------------------
  console.log('\n=== gras, souligne, retour a la ligne ===');
  {
    const { ctx, page, errors } = await ouvrir(browser, '06-page-unique-dense.pdf');
    const nbLignes = (await lignes(page)).length;
    await selectionnerParagraphe(page);
    await page.click('#outil-gras');
    await attendre(page);
    check('gras/dans-l-editeur', (await page.locator('#editeur-texte b').count()) > 0, 'pas de <b>');
    check('gras/bouton-presse', (await page.getAttribute('#outil-gras', 'aria-pressed')) === 'true', 'bouton non presse');
    let l = await lignes(page, 5);
    check('gras/dans-l-apercu', l.every((x) => x.bold), 'lignes non grasses dans l\'apercu');
    await page.click('#outil-gras');
    await attendre(page);
    l = await lignes(page, 5);
    check('gras/retire', l.every((x) => !x.bold), 'gras toujours present');

    await selectionnerParagraphe(page);
    await page.click('#outil-souligne');
    await attendre(page);
    l = await lignes(page, 5);
    check('souligne/dans-l-apercu', l.every((x) => x.under), 'lignes non soulignees');
    await page.click('#outil-souligne');
    await attendre(page);

    // Gras sur quelques mots au clavier (Ctrl+B).
    await para(page).click();
    await page.keyboard.press('Control+Home');
    for (let i = 0; i < 2; i++) await page.keyboard.press('Control+Shift+ArrowRight');
    await page.keyboard.press('Control+b');
    await attendre(page);
    const mots = await page.evaluate(() => [...document.querySelectorAll('#editeur-texte b')].map((b) => b.textContent));
    check('gras/clavier-quelques-mots', mots.length === 1 && mots[0].trim().split(/\s+/).length === 2, JSON.stringify(mots));
    const partiel = await page.evaluate(() => { const sp = [...document.querySelector('.page-apercu .ligne').children]; return [sp.some((s) => s.style.fontWeight === 'bold'), sp.some((s) => s.style.fontWeight !== 'bold')]; });
    check('gras/apercu-partiel', partiel[0] && partiel[1], `gras partiel absent de l'apercu : ${partiel}`);

    // Retour a la ligne dans le meme paragraphe.
    await page.keyboard.press('Control+Home');
    for (let i = 0; i < 2; i++) await page.keyboard.press('Control+ArrowRight');
    await page.keyboard.press('Shift+Enter');
    await attendre(page);
    check('retour/br-dans-l-editeur', (await page.locator('#editeur-texte p').count()) === 1 && (await page.locator('#editeur-texte p br').count()) === 1, 'br absent ou paragraphe scinde');
    l = await lignes(page, 2);
    check('retour/premiere-ligne-courte', l[0].right - l[0].left < 120 && /^Il etait/.test(l[0].text) && !/village/.test(l[0].text), `ligne 1 : "${l[0].text}"`);
    check('retour/suite-sur-la-ligne-suivante', l[1].top > l[0].top && l[1].left - l[0].left < 1, 'suite pas sous la premiere ligne');

    // Bouton « Aller a la ligne ».
    await page.keyboard.press('End');
    await page.click('#outil-saut');
    await attendre(page);
    check('retour/bouton', (await page.locator('#editeur-texte p br').count()) === 2, `${await page.locator('#editeur-texte p br').count()} br`);

    // Entree : nouveau paragraphe, qui garde l'alignement du precedent.
    await para(page).click();
    await page.click('[data-align=center]');
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Une nouvelle phrase ajoutee.');
    await attendre(page);
    check('entree/nouveau-paragraphe', (await page.locator('#editeur-texte p').count()) === 2, `${await page.locator('#editeur-texte p').count()} paragraphe(s)`);
    check('entree/garde-l-alignement', (await para(page, 1).evaluate((p) => JSON.parse(p.dataset.fmt || '{}').align)) === 'center', 'alignement perdu');
    check('entree/dans-l-apercu', /Une nouvelle phrase ajoutee\./.test(await page.evaluate(() => [...document.querySelectorAll('.page-apercu .ligne')].map((x) => x.textContent).join(' '))), 'phrase absente de l\'apercu');

    // Pas d'italique : Ctrl+I est sans effet.
    await para(page).click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+i');
    await attendre(page);
    check('italique/ctrl-i-sans-effet', (await page.locator('#editeur-texte i, #editeur-texte em, #editeur-texte [style*="italic"]').count()) === 0, 'italique insere');
    check('italique/jamais-dans-l-apercu', (await page.locator('.page-apercu [style*="italic"]').count()) === 0, 'italique dans l\'apercu');
    await ctx.close();
    check('gras/aucune-erreur-js', errors.length === 0, errors.join(' | '));
  }

  // --- Interligne, espaces, retrait, style ----------------------------------------
  console.log('\n=== interligne, espaces, retrait, style ===');
  {
    const { ctx, page, errors } = await ouvrir(browser, '01-hierarchie-styles-listes.pdf');
    const n = await page.locator('#editeur-texte p').count();
    check('style/plusieurs-paragraphes', n > 4, `${n} paragraphe(s)`);
    const ecart = async () => { const l = await lignes(page, 40); const out = []; for (let i = 1; i < l.length; i++) out.push(l[i].top - l[i - 1].top); return out; };

    // Interligne d'un seul paragraphe : les lignes de CE paragraphe s'ecartent.
    const textes = await page.evaluate(() => [...document.querySelectorAll('#editeur-texte p')].map((p) => p.textContent));
    const iLong = textes.findIndex((t) => t.startsWith('Il etait une fois'));
    const debutLong = textes[iLong].slice(0, 12);
    const deuxiemeLigne = async () => page.evaluate(() => {
      const ls = [...document.querySelectorAll('.page-apercu .ligne')];
      const k = ls.findIndex((x) => x.textContent.startsWith('Il etait une fois'));
      return ls[k + 1].getBoundingClientRect().top - ls[k].getBoundingClientRect().top;
    });
    const gap0 = await deuxiemeLigne();
    await para(page, iLong).click();
    await page.selectOption('#outil-interligne', '3');
    await attendre(page);
    const gap3 = await deuxiemeLigne();
    check('interligne/ecarte-les-lignes', gap3 > gap0 * 1.5, `ecart ${gap0.toFixed(1)} -> ${gap3.toFixed(1)}`);
    check('interligne/liste-reflete-le-paragraphe', (await page.inputValue('#outil-interligne')) === '3', 'liste non synchronisee');
    const ailleurs = await page.evaluate((k) => [...document.querySelectorAll('#editeur-texte p')].filter((_, i) => i !== k).map((p) => JSON.parse(p.dataset.fmt || '{}').lineHeight).filter((v) => v !== undefined), iLong);
    check('interligne/autres-paragraphes-inchanges', ailleurs.length === 0, `interligne applique ailleurs : ${ailleurs}`);
    await page.selectOption('#outil-interligne', '');
    await attendre(page);
    check('interligne/retour-au-reglage-general', Math.abs((await deuxiemeLigne()) - gap0) < 0.5, 'interligne non restaure');

    // Espace apres : l'ecart avec le paragraphe suivant grandit.
    const suivant = textes[iLong + 1].slice(0, 12);
    const ecartSuite = async () => (await topDe(page, suivant)) - (await topDe(page, debutLong));
    const e0 = await ecartSuite();
    await para(page, iLong).click();
    await page.selectOption('#outil-apres', '2');
    await attendre(page);
    const e2 = await ecartSuite();
    check('espace/apres-agrandit', e2 > e0 + 10, `ecart ${e0.toFixed(1)} -> ${e2.toFixed(1)}`);
    await page.selectOption('#outil-apres', '0');
    await attendre(page);
    const eb = await ecartSuite();
    check('espace/apres-retire', Math.abs(eb - e0) < 0.5, `ecart ${eb.toFixed(1)} contre ${e0.toFixed(1)}`);
    // Espace avant le paragraphe suivant : meme effet.
    await para(page, iLong + 1).click();
    await page.selectOption('#outil-avant', '2');
    await attendre(page);
    check('espace/avant-agrandit', (await ecartSuite()) > e0 + 10, 'espace avant sans effet');
    await page.selectOption('#outil-avant', '0');
    await attendre(page);

    // Retrait.
    const l0 = (await lignes(page, 1))[0].left;
    await para(page, 0).click(); // titre : le retrait s'applique a lui comme a n'importe quel paragraphe
    await page.click('#outil-retrait-plus');
    await attendre(page);
    check('retrait/decale', (await lignes(page, 1))[0].left > l0 + 2, 'ligne non decalee');
    await page.click('#outil-retrait-moins');
    await attendre(page);
    check('retrait/retire', Math.abs((await lignes(page, 1))[0].left - l0) < 1, 'retrait non retire');
    await page.click('#outil-retrait-moins');
    check('retrait/jamais-negatif', (await para(page, 0).evaluate((p) => JSON.parse(p.dataset.fmt || '{}').indent)) === undefined, 'retrait negatif');

    // Style : paragraphe -> Titre 2 (gras, plus grand).
    const cible = n - 1;
    const tailleAvant = await page.evaluate((k) => { const t = document.querySelectorAll('#editeur-texte p')[k].textContent.slice(0, 15); const l = [...document.querySelectorAll('.page-apercu .ligne')].find((x) => x.textContent.startsWith(t)); return l ? parseFloat(l.style.fontSize) : 0; }, cible);
    await para(page, cible).click();
    await page.selectOption('#outil-type', 'h2');
    await attendre(page);
    const tailleApres = await page.evaluate((k) => { const t = document.querySelectorAll('#editeur-texte p')[k].textContent.slice(0, 15); const l = [...document.querySelectorAll('.page-apercu .ligne')].find((x) => x.textContent.startsWith(t)); return l ? [parseFloat(l.style.fontSize), l.style.fontWeight] : [0, '']; }, cible);
    check('style/titre-plus-grand-et-gras', tailleApres[0] > tailleAvant && tailleApres[1] === 'bold', `taille ${tailleAvant} -> ${tailleApres}`);
    await page.selectOption('#outil-type', 'li');
    await attendre(page);
    check('style/liste-puce', /•/.test(await page.evaluate(() => [...document.querySelectorAll('.page-apercu .ligne')].map((x) => x.textContent).join('\n'))), 'pas de puce');

    // Annuler.
    await para(page, cible).click();
    await page.keyboard.type('XYZ');
    await page.click('#outil-annuler');
    check('annuler/efface-la-frappe', !/XYZ/.test(await page.evaluate(() => document.getElementById('editeur-texte').textContent)), 'Annuler sans effet');
    await ctx.close();
    check('style/aucune-erreur-js', errors.length === 0, errors.join(' | '));
  }

  // --- Mise en forme + reglages generaux ------------------------------------------
  console.log('\n=== mise en forme et reglages generaux ===');
  {
    const { ctx, page, errors } = await ouvrir(browser, '06-page-unique-dense.pdf');
    await para(page).click();
    await page.click('[data-align=justify]');
    await attendre(page);
    await page.fill('#reglage-taille', '30');
    await page.waitForTimeout(500);
    const l = await lignes(page, 6);
    check('reglages/justifie-apres-changement-de-taille', l.every((x) => Math.abs(x.right - l[0].right) < 1.5), `droites : ${l.map((x) => x.right.toFixed(1))}`);
    check('reglages/editeur-conserve-sa-mise-en-forme', (await para(page).evaluate((p) => JSON.parse(p.dataset.fmt).align)) === 'justify', 'mise en forme perdue au rechargement de l\'editeur');
    check('reglages/barre-synchronisee', (await page.getAttribute('[data-align=justify]', 'aria-pressed')) !== 'x', 'barre');

    // Interligne general et interligne de paragraphe : le plus specifique gagne.
    await page.selectOption('#reglage-interligne', '2');
    await page.waitForTimeout(500);
    check('reglages/justification-gardee', (await para(page).evaluate((p) => JSON.parse(p.dataset.fmt).align)) === 'justify', 'mise en forme perdue');

    // Texte seulement : la mise en forme est gardee.
    await page.evaluate(() => { document.getElementById('editeur-options').open = true; });
    await page.check('#editeur-mode-brut');
    await page.click('#btn-appliquer-texte');
    await attendre(page);
    const lb = await lignes(page, 6);
    check('texte-seul/justifie-garde', lb.every((x) => Math.abs(x.right - lb[0].right) < 1.5), `droites : ${lb.map((x) => x.right.toFixed(1))}`);

    // Revenir a l'origine efface la mise en forme.
    await page.check('#editeur-mode-blocs');
    await page.click('#btn-restaurer-texte');
    await attendre(page);
    check('restaurer/efface-la-mise-en-forme', (await para(page).evaluate((p) => JSON.parse(p.dataset.fmt || '{}').align)) === undefined, 'justification restee apres Revenir au texte d\'origine');
    const lr = await lignes(page, 6);
    check('restaurer/apercu-a-gauche', lr.every((x) => Math.abs(x.left - lr[0].left) < 1) && lr.some((x) => Math.abs(x.right - lr[0].right) > 1), 'apercu encore justifie');
    await ctx.close();
    check('reglages/aucune-erreur-js', errors.length === 0, errors.join(' | '));
  }

  // --- Coller ----------------------------------------------------------------------
  console.log('\n=== coller ===');
  {
    const { ctx, page, errors } = await ouvrir(browser, '06-page-unique-dense.pdf');
    await para(page).click();
    await page.keyboard.press('Control+End');
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'Texte colle.');
      dt.setData('text/html', '<p style="color:red;font-family:Arial"><i>Texte</i> <b>colle</b>.</p>');
      document.getElementById('editeur-texte').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await attendre(page);
    const html = await page.evaluate(() => document.getElementById('editeur-texte').innerHTML);
    check('coller/texte-brut', /Texte colle\./.test(html) && !/<i>|<em>|color:|Arial/.test(html), html.slice(-120));
    await ctx.close();
    check('coller/aucune-erreur-js', errors.length === 0, errors.join(' | '));
  }

  await browser.close();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${pass} test(s) mise en forme navigateur reussis, ${fail} echec(s)`);
  if (fail) { console.log('\nEchecs :'); for (const f of failures) console.log('  - ' + f); process.exitCode = 1; }
}

main().catch((e) => { console.error('ERREUR FATALE:', e); process.exitCode = 1; });
