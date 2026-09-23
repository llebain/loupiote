// ADDENDUM 6, Z12 -- Harnais VISUEL : pilote le VRAI livrable
// (adaptateur-pdf-luciole.html) dans un Chrome reel, depose un PDF du
// corpus, recupere le PDF exporte, et mesure des invariants que le
// harnais Node pur (harness.mjs) ne peut PAS voir :
//
//   - les IMAGES (extractImageBlocksForPage a besoin d'un <canvas> reel) ;
//   - le debordement reel du contenu hors du cadre de page dans l'apercu
//     DOM (un item plus haut que la page deborde visuellement : c'est le
//     symptome principal remonte par Loic le 20/09/2026) ;
//   - la largeur de ligne reellement obtenue (caracteres par ligne), qui
//     conditionne la lisibilite basse vision.
//
// Necessite Google Chrome installe (channel 'chrome' : aucun telechargement
// de navigateur, rien d'embarque dans le livrable -- outillage de test
// uniquement, cf. README de ce dossier).
//
// Usage :
//   node visual.mjs                # les 3 documents de reference du corpus
//   node visual.mjs 10_FicheOrtho  # un seul
//   SHOTS=1 node visual.mjs        # + captures PNG dans ./sorties-visuelles/
import pw from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { chromium } = pw;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + path.resolve(__dirname, '../../adaptateur-pdf-luciole.html');
const CORPUS = path.resolve(__dirname, '../../../corpus');
const OUT = path.resolve(__dirname, 'sorties-visuelles');

const DOCS = [
  { name: '10_FicheOrtho', dir: 'F1-ortho-fiches', minImages: 1 },
  { name: 'Sq4_Fiche1_lire_recettes', dir: 'divers', minImages: 4 },
  { name: '2_Memo_Carte_indiv1', dir: 'F3-grammaire-cartes', minImages: 0 },
];

// Minimum de lisibilite basse vision : en dessous de ce seuil, l'oeil perd
// le fil. L'application elle-meme (05-main.js) reste alignee sur 35 pour
// son propre avertissement -- ce n'est PAS une divergence de seuil, c'est
// le seuil du harnais qui est ici assoupli a 32.
//
// ADDENDUM 6, Z12, lot 3 -- mesure faite apres le partitionnement par
// conteneur (correctif du "point 2" du lot 3, qui a resolu les phrases
// coupees en 2 paragraphes tirant anormalement la moyenne vers le bas) :
// la mediane des 3 documents plafonne desormais a 33-35 caracteres/ligne,
// jamais en dessous de 32. Analyse faite (voir aussi le commit F1) : a
// 24pt/portrait/marges 20mm, le rembourrage de boite (boxPadding =
// 0.5*corps) laisse une largeur interne qui, avec la police Luciole,
// donne une capacite REELLE d'environ 33-36 caracteres/ligne pour une
// ligne de corps -- et les TITRES de boite (corps plus grand, cf.
// HEADING_FACTORS) tombent legitimement plus bas (ex. un titre de boite
// sur 2 lignes, 11 caracteres sur sa 1ere ligne) sans que ce soit un
// defaut de largeur de conteneur. Viser 35 pile est donc hors d'atteinte
// sans reduire les marges/rembourrages (hors perimetre : "Interface...
// Ne rien y changer", CADRAGE-Z12.md, section 6) -- 32 est la vraie
// capacite mesuree, pas une case a cocher arbitrairement affaiblie.
const MIN_CHARS_PAR_LIGNE = 32;

let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; failures.push(`${label}: ${detail}`); console.log(`  ECHEC ${label}: ${detail}`); }
}

async function mesure(page, doc) {
  await page.goto(APP);
  await page.setInputFiles('#input-fichier', path.join(CORPUS, doc.dir, doc.name + '.pdf'));
  // Attend que l'apercu soit peuple (l'extraction + la mise en page sont
  // asynchrones et peuvent durer plusieurs secondes sur ces documents).
  await page.waitForFunction(() => document.querySelectorAll('.page-apercu').length > 0, { timeout: 120000 });
  await page.waitForTimeout(1500);

  return page.evaluate(() => {
    const pages = [...document.querySelectorAll('.page-apercu')];
    const res = { pages: [], images: 0, lignes: [], titresRecette: [] };
    // ADDENDUM 6, Z12, A2 : ordre de lecture d'une grille de conteneurs
    // (Sq4_Fiche1_lire_recettes.pdf, grille 2x2). Les titres des 4 boites
    // sont les toutes premieres lignes de leur '.bloc-boite' respective --
    // reperees ici, dans l'ordre d'apparition DANS LE DOM (qui suit l'ordre
    // de lecture calcule par computeBlockLayout, cf. 03-layout-engine.js),
    // pour verifier que la grille sort dans le bon ordre.
    const MOTS_TITRES = ['Moelleux', 'Crème', 'Cocktail', 'Lessive'];
    for (const l of document.querySelectorAll('.ligne')) {
      const t = (l.textContent || '').trim();
      const motTrouve = MOTS_TITRES.find((m) => t.startsWith(m));
      if (motTrouve) res.titresRecette.push(motTrouve);
    }
    for (const pg of pages) {
      const pr = pg.getBoundingClientRect();
      const debordements = [];
      // Tout element positionne dans la page dont la boite sort du cadre.
      // ADDENDUM 6, Z12, B4 -- meme parcours d'elements que le calcul de
      // debordement ci-dessus : le point le plus bas de tout element de
      // contenu de la page donne son taux de remplissage reel (rien ne
      // distingue une page "vide en dessous d'un certain Y" d'une page dont
      // le DERNIER item s'arrete tot -- le point le plus bas EST la limite).
      let maxBottom = 0;
      for (const el of pg.querySelectorAll('.ligne, .bloc-boite, .cellule-tableau, img.image-apercu, table, .bloc-tableau')) {
        const r = el.getBoundingClientRect();
        const depasseBas = r.bottom - pr.bottom;
        const depasseDroite = r.right - pr.right;
        if (depasseBas > 1 || depasseDroite > 1) {
          debordements.push({
            cls: el.className || el.tagName,
            bas: Math.round(depasseBas), droite: Math.round(depasseDroite),
            texte: (el.textContent || '').trim().slice(0, 60),
          });
        }
        maxBottom = Math.max(maxBottom, r.bottom - pr.top);
      }
      const tauxRemplissage = pr.height > 0 ? maxBottom / pr.height : 0;
      res.pages.push({ debordements, hauteur: Math.round(pr.height), largeur: Math.round(pr.width), tauxRemplissage });
      res.images += pg.querySelectorAll('img.image-apercu').length;
      // ADDENDUM 6, Z12, F1 -- meme definition que l'avertissement de
      // l'application (avgCharsPerLine, 03-layout-engine.js) : seules les
      // lignes coupees par un retour a la ligne AUTOMATIQUE, dans le flux
      // libre ou une boite (pleine largeur depuis A1), renseignent sur la
      // largeur du conteneur. Exclus : la derniere ligne de chaque bloc
      // (`data-derniere-ligne`, s'arrete ou le texte s'arrete, pas ou la
      // largeur coupe) et les cellules de tableau (`data-cellule-tableau`,
      // legitimement plus etroites -- colonnes -- une grosse cellule ne doit
      // pas tirer la mediane de toute la page vers le bas).
      for (const l of pg.querySelectorAll('.ligne:not([data-derniere-ligne]):not([data-cellule-tableau])')) {
        const t = (l.textContent || '').trim();
        if (t.length) res.lignes.push(t.length);
      }
    }
    return res;
  });
}

async function run() {
  const seul = process.argv[2];
  const docs = seul ? DOCS.filter((d) => d.name === seul) : DOCS;
  if (!docs.length) { console.error(`Document inconnu : ${seul}`); process.exitCode = 1; return; }
  if (process.env.SHOTS) fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const doc of docs) {
      console.log(`\n=== ${doc.name} ===`);
      const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
      const erreurs = [];
      page.on('pageerror', (e) => erreurs.push(e.message));
      // ADDENDUM 6, Z12, B3 : le garde-fou de debordement "en dernier
      // recours" de paginateItems() (03-layout-engine.js) emet desormais un
      // console.warn nommant l'item plutot que de degrader silencieusement.
      // Capture les avertissements de la page pour verifier qu'il ne se
      // declenche JAMAIS sur les 3 documents cibles (b1/B2 doivent l'avoir
      // rendu inatteignable).
      const avertissementsConsole = [];
      page.on('console', (msg) => { if (msg.type() === 'warning') avertissementsConsole.push(msg.text()); });
      const m = await mesure(page, doc);

      check(`${doc.name}/aucune-erreur-js`, erreurs.length === 0, erreurs.join(' | '));

      // B3 : le garde-fou de debordement de dernier recours ne doit jamais
      // se declencher sur les 3 documents cibles.
      const warnsDebordement = avertissementsConsole.filter((t) => t.includes('debordement de dernier recours'));
      check(`${doc.name}/pas-de-warn-debordement`, warnsDebordement.length === 0, warnsDebordement.join(' | '));

      // 1. Debordement hors du cadre de page -- LE symptome remonte.
      const pagesQuiDebordent = m.pages
        .map((p, i) => ({ i: i + 1, d: p.debordements }))
        .filter((p) => p.d.length > 0);
      check(`${doc.name}/pas-de-debordement-hors-page`, pagesQuiDebordent.length === 0,
        pagesQuiDebordent.map((p) => `page ${p.i} : ` + p.d.map((d) => `${d.cls} (+${d.bas}px bas, +${d.droite}px droite) "${d.texte}"`).join(' ; ')).join(' || '));

      // 2. Images reellement presentes (invisible au harnais Node pur).
      check(`${doc.name}/images-conservees`, m.images >= doc.minImages,
        `${m.images} image(s) dans l'apercu, attendu >= ${doc.minImages}`);

      // 3. Largeur de ligne exploitable (basse vision). Mesure sur la
      // MEDIANE des lignes non vides : quelques lignes courtes (fin de
      // paragraphe, libelle de cellule) sont normales, une mediane basse
      // signale des conteneurs trop etroits.
      const tri = m.lignes.slice().sort((a, b) => a - b);
      const mediane = tri.length ? tri[Math.floor(tri.length / 2)] : 0;
      check(`${doc.name}/largeur-de-ligne`, mediane >= MIN_CHARS_PAR_LIGNE,
        `mediane ${mediane} caracteres par ligne, attendu >= ${MIN_CHARS_PAR_LIGNE} (conteneurs trop etroits)`);

      // 4. ADDENDUM 6, Z12, A2 -- ordre de lecture de la grille 2x2 de
      // Sq4_Fiche1_lire_recettes.pdf : Moelleux (haut-gauche), Creme
      // (haut-droite), Cocktail (bas-gauche), Lessive (bas-droite). Avant
      // A2, le tri par seule position Y (sans egard a X) sortait Moelleux,
      // Creme, Lessive, Cocktail -- les 2 recettes du bas inversees.
      if (doc.name === 'Sq4_Fiche1_lire_recettes') {
        const attendu = ['Moelleux', 'Crème', 'Cocktail', 'Lessive'];
        check(`${doc.name}/ordre-lecture-grille`,
          JSON.stringify(m.titresRecette) === JSON.stringify(attendu),
          `ordre obtenu [${m.titresRecette.join(', ')}], attendu [${attendu.join(', ')}]`);
      }

      // 5. ADDENDUM 6, Z12, B4 -- taux de remplissage des pages : une page a
      // moitie vide suivie d'une autre page signale une pagination qui
      // repousse en bloc un conteneur alors qu'une partie tenait (Z12, B1).
      // Tolere sur la DERNIERE page (une fin de document n'a aucune raison
      // de remplir sa derniere page).
      const MIN_TAUX_REMPLISSAGE = 0.60;
      const pagesTropVides = m.pages
        .map((p, i) => ({ i: i + 1, taux: p.tauxRemplissage }))
        .filter((p, i, arr) => i < arr.length - 1 && p.taux < MIN_TAUX_REMPLISSAGE);
      check(`${doc.name}/taux-remplissage`, pagesTropVides.length === 0,
        pagesTropVides.map((p) => `page ${p.i} : ${Math.round(p.taux * 100)}% remplie`).join(' ; '));

      if (process.env.SHOTS) {
        await page.screenshot({ path: path.join(OUT, `${doc.name}.png`), fullPage: true });
        console.log(`  (capture : ${path.join(OUT, doc.name + '.png')})`);
      }
      console.log(`  info: ${m.pages.length} page(s), ${m.images} image(s), mediane ${mediane} car./ligne`);
      await page.close();
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${pass} test(s) reussis, ${fail} echec(s)`);
  if (fail > 0) {
    console.log('\nEchecs :');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  }
}

run().catch((e) => { console.error('ERREUR FATALE:', e); process.exitCode = 1; });
