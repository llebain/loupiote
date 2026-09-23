// ADDENDUM 6, Z9 -- Suite de non-regression.
// Usage : cd tests/regression && npm install && npm test
//
// Ne remplace pas la verification visuelle humaine (voir README de ce
// dossier) : ces checks portent sur des INVARIANTS structurels
// automatisables (dimensions de page, absence de plantage, presence de
// texte/tableaux/boites attendus) -- pas sur la qualite visuelle fine
// (chevauchements, espacements) qui a demande un oeil humain a plusieurs
// reprises cette session (PLAN, Addendum 6, sections Z7-Z8).
import path from 'path';
import { fileURLToPath } from 'url';
import { setup, runFullPipeline, extractPdf } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const p = (rel) => path.resolve(__dirname, rel);

// Format A4 portrait, cf. 03-layout-engine.js pageDimsPt(). Tolerance
// generreuse (2pt) pour les arrondis de conversion mm->pt.
const A4_WIDTH = 210 * 2.83464567;
const A4_HEIGHT = 297 * 2.83464567;
const TOL = 2;
// Marge de page (cf. 03-layout-engine.js, MARGIN_MM = 20mm). Un item texte
// dont le sommet colle au bord de page (marge quasi nulle) est le signe du
// bug reel corrige le 20/09/2026 (Addendum 6, Z9 : `y` de pagination
// demarrait a 0 au lieu de `margin`, un tableau touchait le bord haut de
// page). Tolerance large (10pt) : on ne verifie pas la marge exacte, on
// detecte l'absence de marge.
const MIN_TOP_MARGIN = 20 * 2.83464567 * 0.5; // moitie de la marge nominale

const FIXTURES = [
  { path: p('../fixtures/01-hierarchie-styles-listes.pdf'), minBlocks: 5, label: '01-hierarchie-styles-listes' },
  { path: p('../fixtures/02-deux-colonnes.pdf'), minBlocks: 2, label: '02-deux-colonnes',
    note: 'bug preexistant connu (detectColumns melange le texte de 2 colonnes, PLAN Addendum 6 Z6/Z7) -- non verifie ici, hors perimetre' },
  { path: p('../fixtures/04-entete-pied-repetes.pdf'), minBlocks: 2, label: '04-entete-pied-repetes' },
  { path: p('../fixtures/05-avec-images.pdf'), minBlocks: 2, label: '05-avec-images' },
  { path: p('../fixtures/06-page-unique-dense.pdf'), minBlocks: 1, label: '06-page-unique-dense' },
  { path: p('../../../corpus/F1-ortho-fiches/10_FicheOrtho.pdf'), minBlocks: 15, expectKinds: ['table', 'box'], label: '10_FicheOrtho' },
  { path: p('../../../corpus/divers/Sq4_Fiche1_lire_recettes.pdf'), minBlocks: 10, expectKinds: ['box'], label: 'Sq4_Fiche1_lire_recettes' },
  { path: p('../../../corpus/F3-grammaire-cartes/2_Memo_Carte_indiv1.pdf'), minBlocks: 5, expectKinds: ['box'], label: '2_Memo_Carte_indiv1' },
];

let pass = 0, fail = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push(`${label}: ${detail}`); console.log(`  ✗ ${label}: ${detail}`); }
}

function collectKinds(layout) {
  const kinds = new Set();
  for (const page of layout.pages) for (const item of page.items) kinds.add(item.kind);
  return kinds;
}

async function run() {
  const ctx = await setup();

  for (const fx of FIXTURES) {
    console.log(`\n=== ${fx.label} ===`);

    // 1. Extraction seule : ne doit jamais lever.
    let extraction;
    try {
      extraction = await extractPdf(ctx, fx.path);
    } catch (e) {
      check(`${fx.label}/extraction`, false, `a leve : ${e.message}`);
      continue;
    }
    const blocks = extraction.blocks.filter((b) => b.type !== 'pagebreak' && b.type !== 'needs-ocr');
    check(`${fx.label}/blocs`, blocks.length >= fx.minBlocks,
      `${blocks.length} bloc(s) utile(s), attendu >= ${fx.minBlocks}`);

    // 2. Pipeline complet a 24pt (preset conforme par defaut).
    let r24;
    try {
      r24 = await runFullPipeline(ctx, fx.path, { fontSize: 24 });
    } catch (e) {
      check(`${fx.label}/pipeline-24pt`, false, `a leve : ${e.message}\n${e.stack}`);
      continue;
    }
    check(`${fx.label}/pdf-valide-24pt`, r24.reparsed.pageCount >= 1, 'aucune page dans le PDF exporte');
    check(`${fx.label}/texte-present-24pt`,
      r24.reparsed.pages.some((pg) => pg.textItemCount > 0), 'aucun texte dans le PDF exporte (page blanche)');
    const p1 = r24.reparsed.pages[0];
    check(`${fx.label}/marge-haute-24pt`,
      p1.topItemY === null || p1.height - p1.topItemY >= MIN_TOP_MARGIN,
      `le texte le plus haut est a ${(p1.height - p1.topItemY).toFixed(1)}pt du bord de page, attendu >= ${MIN_TOP_MARGIN.toFixed(1)}pt`);

    // 3. Largeur de page FIXE (format A4), quelle que soit la taille de
    // police -- regression trouvee et corrigee le 20/09/2026 (Addendum 6,
    // Z8 : "la taille de la police fait juste un zoom"). C'est le check le
    // plus important de cette suite : c'est celui qui aurait detecte le bug
    // avant que Loic n'ait a le remonter lui-meme.
    let r40;
    try {
      r40 = await runFullPipeline(ctx, fx.path, { fontSize: 40 });
    } catch (e) {
      check(`${fx.label}/pipeline-40pt`, false, `a leve : ${e.message}`);
      continue;
    }
    const w24 = r24.reparsed.pages[0].width, w40 = r40.reparsed.pages[0].width;
    check(`${fx.label}/largeur-fixe`, Math.abs(w24 - w40) < TOL,
      `largeur de page 24pt=${w24.toFixed(1)}pt vs 40pt=${w40.toFixed(1)}pt -- devrait etre identique (page fixe, pas de zoom)`);
    check(`${fx.label}/largeur-A4`, Math.abs(w24 - A4_WIDTH) < TOL,
      `largeur de page ${w24.toFixed(1)}pt, attendu ${A4_WIDTH.toFixed(1)}pt (A4 portrait)`);

    // 4. Pagination : aucune page de sortie ne doit depasser la hauteur A4
    // (ADDENDUM 6, Z9 -- ecrit AVANT l'implementation de la pagination
    // reelle, pour verifier le correctif une fois fait ; peut echouer tant
    // que la pagination n'est pas en place, cf. PLAN section Z9).
    const tallPages24 = r24.reparsed.pages.filter((pg) => pg.height > A4_HEIGHT + TOL);
    check(`${fx.label}/pagination-24pt`, tallPages24.length === 0,
      `${tallPages24.length} page(s) depassent la hauteur A4 (${A4_HEIGHT.toFixed(0)}pt) : ${tallPages24.map((pg) => pg.height.toFixed(0)).join(', ')}pt`);
    const tallPages40 = r40.reparsed.pages.filter((pg) => pg.height > A4_HEIGHT + TOL);
    check(`${fx.label}/pagination-40pt`, tallPages40.length === 0,
      `${tallPages40.length} page(s) depassent la hauteur A4 a 40pt : ${tallPages40.map((pg) => pg.height.toFixed(0)).join(', ')}pt`);

    // 5. Structure attendue (boites/tableaux) pour les documents cibles.
    if (fx.expectKinds) {
      const kinds = collectKinds(r24.layout);
      for (const k of fx.expectKinds) {
        check(`${fx.label}/contient-${k}`, kinds.has(k), `aucun item de type "${k}" dans la mise en page`);
      }
    }

    // 6. Aucun item (boite/tableau/flux/image) ne deborde a droite de la
    // page -- bug reel trouve le 20/09/2026 (Addendum 6, Z10) : elargir une
    // colonne de tableau trop etroite pour son mot le plus long (Z8) sans
    // revegetifier que le total tenait encore dans la largeur de page
    // faisait deborder le tableau au-dela de la marge droite (remonte par
    // Loic sur une capture d'ecran reelle).
    const overflowing = [];
    for (const pg of r24.layout.pages) {
      for (const item of pg.items) {
        if (item.x + item.width > pg.pageDims.width - pg.margin + TOL) {
          overflowing.push(`${item.kind}@x=${item.x.toFixed(0)}+w=${item.width.toFixed(0)}=${(item.x + item.width).toFixed(0)} (page ${pg.pageDims.width.toFixed(0)}pt, marge ${pg.margin.toFixed(0)}pt)`);
        }
      }
    }
    check(`${fx.label}/pas-de-debordement-droite`, overflowing.length === 0,
      `${overflowing.length} item(s) depassent la marge droite : ${overflowing.join(' ; ')}`);

    // 7. Aucune boite/tableau ne doit avoir un fond noir plein alors
    // qu'aucune couleur de fond n'a ete reellement tracee dans le PDF
    // source (bug reel Addendum 6, Z10 : une forme tracee au contour seul
    // heritait de la derniere couleur de REMPLISSAGE active dans l'etat
    // graphique du PDF, souvent sans rapport -- ex. les 4 cartes de
    // Sq4_Fiche1_lire_recettes.pdf, fond transparent dans le PDF source,
    // se retrouvaient avec un fond NOIR plein page). Heuristique : un fond
    // parfaitement noir [0,0,0] sur une grande boite/tableau est presque
    // toujours ce bug plutot qu'une vraie intention de design (aucun des 3
    // documents cibles n'a de fond noir intentionnel).
    const blackFills = [];
    for (const pg of r24.layout.pages) {
      for (const item of pg.items) {
        if (item.kind === 'box' && item.fill && item.fill[0] === 0 && item.fill[1] === 0 && item.fill[2] === 0) {
          blackFills.push(`box@(${item.x.toFixed(0)},${item.y.toFixed(0)})`);
        }
      }
    }
    check(`${fx.label}/pas-de-fond-noir-suspect`, blackFills.length === 0,
      `${blackFills.length} boite(s) a fond noir suspect : ${blackFills.join(', ')}`);

    // 8. Deux boites/tableaux/images ne doivent jamais se chevaucher
    // visuellement sur la meme page -- bug reel trouve le 20/09/2026 sur
    // 2_Memo_Carte_indiv1.pdf : la fusion d'une boite-enveloppe (Z10bis)
    // appliquee a tort a un conteneur englobant PLUSIEURS boites (les 3
    // cases d'un diagramme en arbre) faisait reclamer le meme grand
    // conteneur par chacun de ses enfants independamment, produisant des
    // rectangles superposes. Test AABB simple, tolerance 1pt.
    const rectOf = (it) => ({ x0: it.x, y0: it.y, x1: it.x + it.width, y1: it.y + it.height });
    const overlaps = (a, b) => a.x0 < b.x1 - 1 && a.x1 > b.x0 + 1 && a.y0 < b.y1 - 1 && a.y1 > b.y0 + 1;
    const overlapPairs = [];
    for (const pg of r24.layout.pages) {
      const boxy = pg.items.filter((it) => it.kind === 'box' || it.kind === 'table' || it.kind === 'image');
      for (let i = 0; i < boxy.length; i++) {
        for (let j = i + 1; j < boxy.length; j++) {
          if (overlaps(rectOf(boxy[i]), rectOf(boxy[j]))) {
            overlapPairs.push(`${boxy[i].kind}@(${boxy[i].x.toFixed(0)},${boxy[i].y.toFixed(0)}) / ${boxy[j].kind}@(${boxy[j].x.toFixed(0)},${boxy[j].y.toFixed(0)})`);
          }
        }
      }
    }
    check(`${fx.label}/pas-de-chevauchement`, overlapPairs.length === 0,
      `${overlapPairs.length} paire(s) d'items qui se chevauchent : ${overlapPairs.join(' ; ')}`);

    if (fx.note) console.log(`  (note : ${fx.note})`);
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
