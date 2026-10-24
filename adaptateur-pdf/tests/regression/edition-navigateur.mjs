// Retour de test du 05/10/2026 -- l'interface dans Chrome : taille par defaut
// 20 pt, case « Texte simplifie », case « Garder les en-tetes... », panneau
// « Modifier le texte » (deux modes), numerotation hors de la page.
// Pilote le VRAI livrable (adaptateur-pdf-luciole.html).
//
// Usage : node edition-navigateur.mjs            (Chrome installe : channel 'chrome')
//         CHROME_PATH=/chemin/chrome node edition-navigateur.mjs
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
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 1100 } });
  const page = await ctx.newPage();
  const errors = [], requests = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) requests.push(r.url()); });
  await page.goto(APP);
  await page.waitForFunction(() => !document.getElementById('progression').textContent, null, { timeout: 60000 });
  const etat = { ctx, page, errors, requests };
  if (fixture) await deposer(page, fixture);
  return etat;
}
async function deposer(page, fixture) {
  await page.setInputFiles('#input-fichier', path.join(FIX, fixture));
  await page.waitForFunction(() => document.querySelectorAll('.page-apercu').length > 0, null, { timeout: 60000 });
}
const textePages = (page) => page.evaluate(() => [...document.querySelectorAll('.page-apercu .ligne')].map((l) => l.textContent).join('\n'));
const nb = (page, sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
const attendreApercu = (page) => page.waitForTimeout(400);
// Editeur de texte : un <p> par paragraphe (alignement / puce en data-*).
const lireEditeur = (page) => page.evaluate(() => [...document.querySelectorAll('#editeur-texte p')].map((p) => p.textContent).filter((t) => t.trim()).join('\n\n'));
const ecrireEditeur = (page, texte) => page.evaluate((t) => {
  const ed = document.getElementById('editeur-texte');
  ed.textContent = '';
  for (const part of t.split(/\n\n/)) { const p = document.createElement('p'); p.dataset.align = 'left'; p.dataset.marker = 'none'; p.textContent = part; ed.appendChild(p); }
  ed.dispatchEvent(new Event('input', { bubbles: true }));
}, texte);
const selectionnerParagraphe = (page, k) => page.evaluate((i) => {
  const p = document.querySelectorAll('#editeur-texte p')[i];
  const r = document.createRange(); r.selectNodeContents(p);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  document.dispatchEvent(new Event('selectionchange'));
}, k);

async function main() {
  const launch = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' };
  const browser = await pw.chromium.launch({ ...launch, headless: true, args: ['--no-sandbox'] });

  // --- Reglages par defaut ------------------------------------------------------
  console.log('\n=== reglages par defaut ===');
  {
    const { ctx, page, errors, requests } = await ouvrir(browser);
    check('ui/taille-20', await page.inputValue('#reglage-taille') === '20', `curseur = ${await page.inputValue('#reglage-taille')}`);
    check('ui/taille-affichee-20', (await page.textContent('#valeur-taille')) === '20', 'texte du curseur');
    check('ui/simplifie-decoche', !(await page.isChecked('#reglage-simplifie')), 'simplifie coche par defaut');
    check('ui/entetes-decoche', !(await page.isChecked('#reglage-entetes-pieds')), 'en-tetes coches par defaut');
    check('ui/editeur-bouton-desactive', await page.isDisabled('#btn-modifier-texte'), 'bouton actif sans document');
    check('ui/editeur-ferme', await page.isHidden('#editeur'), 'editeur visible sans document');
    await ctx.close();
    check('ui/aucune-erreur-js', errors.length === 0, errors.join(' | '));
    check('ui/aucune-requete-reseau', requests.length === 0, requests.join(' '));
  }

  // --- Numerotation hors de la page ---------------------------------------------
  console.log('\n=== numerotation ===');
  {
    const { ctx, page, errors } = await ouvrir(browser, '08-numerotation.pdf');
    check('numero/hors-page', (await nb(page, '.page-apercu .numero-page')) === 0 && (await nb(page, '#apercu > .numero-page')) === 2, 'la legende « Page n / N » est sur la page');
    check('numero/pas-dans-le-texte', !/Page \d sur 2/.test(await textePages(page)), 'numerotation du document visible par defaut');
    const imprime = await page.evaluate(() => { const l = document.querySelector('.numero-page'); return l.matches('@media print') ; }).catch(() => null);
    await page.emulateMedia({ media: 'print' });
    check('numero/cachee-a-limpression', await page.evaluate(() => getComputedStyle(document.querySelector('.numero-page')).display === 'none'), 'legende imprimee');
    await page.emulateMedia({ media: 'screen' });
    await page.check('#reglage-entetes-pieds');
    await attendreApercu(page);
    check('numero/reaffichee-par-la-case', /Page 1 sur 2/.test(await textePages(page)), 'numerotation absente avec la case cochee');
    await page.uncheck('#reglage-entetes-pieds');
    await attendreApercu(page);
    check('numero/masquee-de-nouveau', !/Page 1 sur 2/.test(await textePages(page)), 'numerotation encore la case decochee');
    await ctx.close();
    check('numero/aucune-erreur-js', errors.length === 0, errors.join(' | '));
  }

  // --- Texte simplifie ----------------------------------------------------------
  console.log('\n=== texte simplifie ===');
  {
    const { ctx, page, errors } = await ouvrir(browser, 'v3-titre-et-colonnes.pdf');
    const cadres = await nb(page, '.bloc-boite');
    const pagesAvant = await nb(page, '.page-apercu');
    check('simplifie/cadres-presents-avant', cadres > 0, `${cadres} cadre(s)`);
    const texteAvant = (await textePages(page)).replace(/\s+/g, ' ');
    await page.check('#reglage-simplifie');
    await attendreApercu(page);
    check('simplifie/plus-de-cadre', (await nb(page, '.bloc-boite')) === 0, `${await nb(page, '.bloc-boite')} cadre(s) restant(s)`);
    check('simplifie/images-masquees', (await page.inputValue('#reglage-images')) === 'masquer', `images = ${await page.inputValue('#reglage-images')}`);
    check('simplifie/meme-texte', (await textePages(page)).replace(/\s+/g, ' ') === texteAvant, 'le texte differe');
    check('simplifie/pas-plus-de-pages', (await nb(page, '.page-apercu')) <= pagesAvant, `${await nb(page, '.page-apercu')} > ${pagesAvant}`);
    const couleurs = await page.evaluate(() => [...document.querySelectorAll('.page-apercu span')].map((s) => getComputedStyle(s).color)
      .filter((c) => c !== 'rgb(0, 0, 0)').length);
    check('simplifie/texte-noir', couleurs === 0, `${couleurs} span(s) non noir(s)`);
    check('simplifie/tableau-garde', (await nb(page, '.cellule-tableau')) > 0, 'les tableaux ont disparu');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-telecharger')]);
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(fs.readFileSync(await dl.path())), disableFontFace: true, verbosity: 0 }).promise;
    check('simplifie/export-pages', doc.numPages === await nb(page, '.page-apercu'), `export ${doc.numPages} page(s)`);
    await page.uncheck('#reglage-simplifie');
    await attendreApercu(page);
    check('simplifie/retour', (await nb(page, '.bloc-boite')) === cadres && (await page.inputValue('#reglage-images')) === 'conserver', 'le mode normal ne revient pas');
    await ctx.close();
    check('simplifie/aucune-erreur-js', errors.length === 0, errors.join(' | '));
  }

  // --- Relecture du texte -------------------------------------------------------
  console.log('\n=== relecture du texte ===');
  {
    const { ctx, page, errors, requests } = await ouvrir(browser, '01-hierarchie-styles-listes.pdf');
    check('editeur/bouton-actif', !(await page.isDisabled('#btn-modifier-texte')), 'bouton inactif avec un document');
    const avant = await textePages(page);
    await page.click('#btn-modifier-texte');
    check('editeur/ouvert', await page.isVisible('#editeur') && (await page.getAttribute('#btn-modifier-texte', 'aria-expanded')) === 'true', 'panneau ferme');
    const aCote = await page.evaluate(() => {
      const e = document.getElementById('editeur').getBoundingClientRect(), a = document.getElementById('apercu').getBoundingClientRect();
      return a.left >= e.right - 1;
    });
    check('editeur/a-cote-de-l-apercu', aCote, 'le panneau n\'est pas a cote de l\'apercu');
    const texte = await lireEditeur(page);
    const paragraphes = texte.split(/\n\n/);
    check('editeur/texte-extrait', paragraphes.length > 4 && paragraphes.every((p) => p.trim()), `${paragraphes.length} paragraphe(s)`);
    check('editeur/meme-texte-que-l-apercu', paragraphes.every((p) => avant.replace(/\s+/g, ' ').includes(p.slice(0, 20))), 'le panneau montre un texte different de l\'apercu');

    // Suppression d'une phrase en trop.
    const cible = paragraphes[2];
    await ecrireEditeur(page, paragraphes.filter((_, i) => i !== 2).join('\n\n'));
    await page.click('#btn-appliquer-texte');
    await attendreApercu(page);
    let apres = (await textePages(page)).replace(/\s+/g, ' ');
    check('editeur/suppression', !apres.includes(cible.slice(0, 30)), 'paragraphe supprime toujours affiche');
    check('editeur/reste-affiche', paragraphes.filter((_, i) => i !== 2).every((p) => apres.includes(p.slice(0, 20))), 'un autre paragraphe a disparu');
    check('editeur/etat-modifie', /modifié/.test(await page.textContent('#editeur-etat')) || /appliqu/i.test(await page.textContent('#editeur-etat')), `etat : ${await page.textContent('#editeur-etat')}`);

    // Correction d'un mot, puis changement de reglage SANS appliquer : la
    // saisie n'est pas perdue.
    const t2 = await lireEditeur(page);
    await ecrireEditeur(page, t2.replace(/^(\S+)/, 'CORRIGE'));
    await page.selectOption('#reglage-interligne', '1.75');
    await attendreApercu(page);
    check('editeur/saisie-conservee-au-changement-de-reglage', /CORRIGE/.test(await textePages(page)), 'la correction non appliquee est perdue');
    check('editeur/panneau-reste-ouvert', await page.isVisible('#editeur'), 'panneau ferme par un changement de reglage');
    await page.selectOption('#reglage-interligne', '1.5');
    await attendreApercu(page);

    // Mode « texte simple ».
    await page.check('#editeur-mode-brut');
    await page.click('#btn-appliquer-texte');
    await attendreApercu(page);
    const gras = await page.evaluate(() => [...document.querySelectorAll('.page-apercu .ligne')].filter((l) => l.style.fontWeight === 'bold').length);
    check('editeur/brut-plus-de-titre', gras === 0, `${gras} ligne(s) en gras`);
    check('editeur/brut-texte-conserve', /CORRIGE/.test(await textePages(page)), 'texte perdu en mode texte simple');
    check('editeur/brut-pas-de-cadre', (await nb(page, '.bloc-boite, .cellule-tableau, img.image-apercu')) === 0, 'cadre ou tableau en mode texte simple');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-telecharger')]);
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(fs.readFileSync(await dl.path())), disableFontFace: true, verbosity: 0 }).promise;
    const tc = await (await doc.getPage(1)).getTextContent();
    check('editeur/brut-export-vrai-texte', tc.items.some((i) => /CORRIGE/.test(i.str)), 'le texte corrige n\'est pas du vrai texte dans le PDF');

    // Retour a la mise en forme.
    await page.check('#editeur-mode-blocs');
    await page.click('#btn-appliquer-texte');
    await attendreApercu(page);
    const gras2 = await page.evaluate(() => [...document.querySelectorAll('.page-apercu .ligne')].filter((l) => l.style.fontWeight === 'bold').length);
    check('editeur/retour-mise-en-forme', gras2 > 0, 'les titres ne reviennent pas');

    // Revenir au texte d'origine.
    await page.click('#btn-restaurer-texte');
    await attendreApercu(page);
    check('editeur/restaurer', (await textePages(page)) === avant, 'le texte d\'origine n\'est pas restaure');
    check('editeur/restaurer-panneau', (await lireEditeur(page)) === texte, 'le panneau n\'est pas restaure');

    // Fermer.
    await page.click('#btn-modifier-texte');
    check('editeur/ferme', await page.isHidden('#editeur'), 'panneau toujours visible');

    // Nouveau document : le panneau repart de zero.
    await page.click('#btn-modifier-texte');
    await ecrireEditeur(page, 'Autre texte.');
    await page.click('#btn-appliquer-texte');
    await attendreApercu(page);
    await deposer(page, '04-entete-pied-repetes.pdf');
    await attendreApercu(page);
    check('editeur/nouveau-document-ferme', await page.isHidden('#editeur'), 'panneau reste ouvert sur un nouveau document');
    check('editeur/nouveau-document-texte', /Article 1/.test(await textePages(page)) && !/Autre texte/.test(await textePages(page)), 'texte du document precedent');
    await ctx.close();
    check('editeur/aucune-erreur-js', errors.length === 0, errors.join(' | '));
    check('editeur/aucune-requete-reseau', requests.length === 0, requests.join(' '));
  }

  // --- Retour de la prof : ordre, interligne, alignement, puces ---------------------
  console.log('\n=== editeur : ordre, interligne, mise en forme ===');
  for (const fixture of ['01-hierarchie-styles-listes.pdf', '02-deux-colonnes.pdf', 'v3-decoupe-verticale.pdf', '07-mascottes.pdf']) {
    const { ctx, page, errors } = await ouvrir(browser, fixture);
    await page.click('#btn-modifier-texte');
    const paras = (await lireEditeur(page)).split(/\n\n/).filter(Boolean);
    const apercu = (await textePages(page)).replace(/\s+/g, ' ');
    // Ordre : chaque paragraphe du panneau se retrouve dans l'apercu, dans le meme ordre.
    let from = 0, desordre = null;
    for (const para of paras) {
      const cle = para.replace(/\s+/g, ' ').slice(0, 12);
      const at = apercu.indexOf(cle, from);
      if (at < 0) { desordre = cle; break; }
      from = at + 1;
    }
    check(`ordre/${fixture}`, paras.length > 0 && desordre === null, `paragraphe hors ordre de l'apercu : "${desordre}"`);
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await ouvrir(browser, '01-hierarchie-styles-listes.pdf');
    await page.click('#btn-modifier-texte');
    const ratio = () => page.evaluate(() => {
      const p = document.querySelector('#editeur-texte p'); const cs = getComputedStyle(p);
      return parseFloat(cs.lineHeight) / parseFloat(cs.fontSize);
    });
    check('interligne/editeur-1-5', Math.abs((await ratio()) - 1.5) < 0.01, `interligne de l'editeur = ${await ratio()}`);
    await page.selectOption('#reglage-interligne', '1.75');
    await attendreApercu(page);
    check('interligne/editeur-suit-le-reglage', Math.abs((await ratio()) - 1.75) < 0.01, `interligne de l'editeur = ${await ratio()}`);
    await page.selectOption('#reglage-interligne', '1.5');
    await attendreApercu(page);
    // Apres modification du texte, l'apercu garde l'interligne 1,5.
    const paras = (await lireEditeur(page)).split(/\n\n/);
    await ecrireEditeur(page, paras.map((t, i) => (i === 1 ? t + ' ajout' : t)).join('\n\n'));
    await page.click('#btn-appliquer-texte');
    await attendreApercu(page);
    const pas = await page.evaluate(() => {
      const tops = [...document.querySelectorAll('.page-apercu .ligne')].filter((l) => l.style.fontWeight !== 'bold')
        .map((l) => ({ top: parseFloat(l.style.top), size: parseFloat(l.style.fontSize) }));
      const gaps = [];
      for (let i = 1; i < tops.length; i++) { const d = tops[i].top - tops[i - 1].top; if (d > 0 && d < tops[i].size * 2.2) gaps.push(d / tops[i].size); }
      return Math.min(...gaps);
    });
    check('interligne/apercu-apres-modif', pas >= 1.45, `plus petit pas de ligne = ${pas} x corps`);

    // Alignement et puces.
    const nbParas = paras.length;
    await selectionnerParagraphe(page, 1);
    await page.click('#editeur-barre button[data-align="center"]');
    await selectionnerParagraphe(page, 2);
    await page.click('#editeur-barre button[data-marker="number"]');
    await selectionnerParagraphe(page, 3);
    await page.click('#editeur-barre button[data-marker="number"]');
    await selectionnerParagraphe(page, 4);
    await page.click('#editeur-barre button[data-marker="dash"]');
    await selectionnerParagraphe(page, 5);
    await page.click('#editeur-barre button[data-align="justify"]');
    const etat = await page.evaluate(() => [...document.querySelectorAll('#editeur-texte p')].map((p) => [p.dataset.align, p.dataset.marker, p.dataset.label || '']));
    check('mise-en-forme/panneau-centre', etat[1][0] === 'center', JSON.stringify(etat[1]));
    check('mise-en-forme/panneau-numeros', etat[2][2] === '1.' && etat[3][2] === '2.', JSON.stringify([etat[2], etat[3]]));
    check('mise-en-forme/panneau-tiret', etat[4][2] === '–', JSON.stringify(etat[4]));
    await page.click('#btn-appliquer-texte');
    await attendreApercu(page);
    const rendu = await page.evaluate(() => [...document.querySelectorAll('.page-apercu .ligne')].map((l) => ({ t: l.textContent, left: parseFloat(l.style.left) })));
    check('mise-en-forme/numero-affiche', rendu.some((l) => /^1\.\s/.test(l.t)) && rendu.some((l) => /^2\.\s/.test(l.t)), 'numeros absents de l\'apercu');
    check('mise-en-forme/tiret-affiche', rendu.some((l) => /^–\s/.test(l.t)), 'tiret absent de l\'apercu');
    const cle = paras[1].slice(0, 10);
    const centre = rendu.find((l) => l.t.startsWith(cle));
    const gauche = rendu.find((l) => l.t.startsWith(paras[0].slice(0, 10)));
    check('mise-en-forme/centre-decale', centre && gauche && centre.left > gauche.left + 5, `centre ${centre && centre.left} vs gauche ${gauche && gauche.left}`);
    // Ordre conserve apres application.
    const apres = (await lireEditeur(page)).split(/\n\n/);
    check('mise-en-forme/ordre-conserve', apres.length === nbParas && apres.every((t, i) => t.slice(0, 15) === (i === 1 ? paras[i] + ' ajout' : paras[i]).slice(0, 15)), 'ordre ou nombre de paragraphes change');
    // Export : texte toujours du vrai texte.
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-telecharger')]);
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(fs.readFileSync(await dl.path())), disableFontFace: true, verbosity: 0 }).promise;
    const tc = await (await doc.getPage(1)).getTextContent();
    check('mise-en-forme/export-numero', tc.items.some((i) => /^1\./.test(i.str.trim())), 'numero absent du PDF');
    // Retirer une puce en re-cliquant sur le meme bouton.
    await selectionnerParagraphe(page, 4);
    await page.click('#editeur-barre button[data-marker="dash"]');
    check('mise-en-forme/retrait-puce', (await page.evaluate(() => document.querySelectorAll('#editeur-texte p')[4].dataset.marker)) === 'none', 'la puce n\'est pas retiree');
    await ctx.close();
    check('mise-en-forme/aucune-erreur-js', errors.length === 0, errors.join(' | '));
  }

  await browser.close();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${pass} test(s) edition navigateur reussis, ${fail} echec(s)`);
  if (fail) { console.log('\nEchecs :'); for (const f of failures) console.log('  - ' + f); process.exitCode = 1; }
}

main().catch((e) => { console.error('ERREUR FATALE:', e); process.exitCode = 1; });
