// Plan v0.3 -- tests cibles, un par defaut du diagnostic, sur les fixtures
// synthetiques de tests/fixtures_v03.py (generees par make_fixtures.py).
// Chaque fixture reproduit le MECANISME d'un defaut observe sur le corpus
// (sans en reprendre le texte) ; chaque test echouait avant son correctif.
//
// Complement, pas remplacement, de `npm run corpus -- --compare` : ces
// fixtures ne disent rien des 43 fiches reelles (plan v0.3, §0 et §9).
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { setup, runFullPipeline } from './harness.mjs';
import { lireCmap } from './corpus-lib/cmap.mjs';
import { ratioContraste } from './corpus-lib/couleurs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = (n) => path.resolve(__dirname, '../fixtures', n);
const A4 = { w: 210 * 2.83464567, h: 297 * 2.83464567 };
const TOL = 2;

const warns = [];
const origWarn = console.warn;
console.warn = (...a) => { warns.push(a.join(' ')); };
const origLog = console.log;
console.log = (...a) => { if (!String(a[0]).startsWith('[qualite-texte]')) origLog(...a); };

let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) pass++;
  else { fail++; failures.push(`${label}: ${detail}`); console.log(`  ✗ ${label}: ${detail}`); }
}

const cmap = lireCmap(fs.readFileSync(path.resolve(__dirname, '../../assets/fonts/Luciole-Regular.ttf')));

function lineText(l) { return l.segments.map((s) => s.text).join(''); }
function allLines(ctx, layout) {
  return layout.pages.flatMap((pg) => ctx.LayoutEngine.collectPageLines(pg));
}
function blockText(b) { return (b.runs || []).map((r) => r.text).join('').replace(/\s+/g, ' ').trim(); }
function visibleBlocks(r) { return r.blocks.filter((b) => !b.secondary && !b.duplicate && b.type !== 'image'); }

// Couleur de chaque segment telle que rendue, avec le fond reellement
// derriere lui (meme regle que 04-pdf-export.js / 05-main.js).
function renderedSegments(ctx, layout) {
  const LE = ctx.LayoutEngine;
  const theme = layout.theme, settings = layout.settings;
  const pageBg = LE.hexToRgbArr(theme.bg);
  const out = [];
  for (const pg of layout.pages) {
    for (const it of pg.items) {
      const push = (lines, bg) => { for (const l of lines) for (const s of l.segments) if (s.text.trim()) out.push({ s, l, bg, color: LE.resolveTextColor(s.color, settings, theme, bg) }); };
      if (it.kind === 'flow') push(it.lines, pageBg);
      else if (it.kind === 'box') push(it.lines, LE.resolveContainerColors(it.fill, it.stroke, settings, theme).fill);
      else if (it.kind === 'table') {
        for (const row of it.rows) for (const cell of row.cells) {
          push(cell.lines, cell.fill ? LE.resolveContainerColors(cell.fill, null, settings, theme).fill : pageBg);
        }
      }
    }
  }
  return out;
}

async function exportedText(ctx, pdfBuffer) {
  const doc = await ctx.pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer), disableFontFace: true, verbosity: 0 }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const vp = page.getViewport({ scale: 1 });
    pages.push({ width: vp.width, height: vp.height, text: tc.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ') });
  }
  return pages;
}

// Invariants communs a toutes les fixtures v0.3.
async function common(ctx, name, r, settingsLabel) {
  const L = `${name}${settingsLabel ? '/' + settingsLabel : ''}`;
  for (const pg of r.layout.pages) {
    const land = pg.pageDims.width > pg.pageDims.height;
    const w = land ? A4.h : A4.w, h = land ? A4.w : A4.h;
    check(`${L}/format-A4`, Math.abs(pg.pageDims.width - w) < TOL && Math.abs(pg.pageDims.height - h) < TOL,
      `page ${pg.pageDims.width.toFixed(0)}x${pg.pageDims.height.toFixed(0)}`);
    for (const it of pg.items) {
      check(`${L}/pas-de-debordement`, it.x + it.width <= pg.pageDims.width - pg.margin + TOL && it.y + it.height <= pg.pageDims.height - pg.margin + TOL,
        `${it.kind} deborde (${(it.x + it.width).toFixed(0)}, ${(it.y + it.height).toFixed(0)}) sur page ${pg.pageDims.width.toFixed(0)}x${pg.pageDims.height.toFixed(0)}`);
    }
    // R3 : aucune ligne de texte plus large que son conteneur.
    for (const it of pg.items) {
      const lines = it.kind === 'table' ? it.rows.flatMap((row) => row.cells.map((c) => ({ c, row }))) : [];
      for (const { c } of lines) {
        for (const l of c.lines) {
          const wl = l.segments.reduce((a, s) => a + s.width, 0);
          check(`${L}/texte-dans-cellule`, l.x + wl <= it.x + c.x + c.width + TOL, `"${lineText(l)}" deborde de sa cellule`);
        }
      }
    }
  }
  // E9 : aucun italique rendu.
  const ital = renderedSegments(ctx, r.layout).filter((x) => /italic/.test(x.s.style));
  check(`${L}/E9-aucun-italique`, ital.length === 0, `${ital.length} segment(s) en italique`);
  // jsPDF declare toujours ses 14 polices standard (Times-Italic...), jamais
  // utilisees : seule une Luciole italique embarquee compte.
  check(`${L}/E9-aucune-police-italique`, !/\/BaseFont\s*\/[^\s\/]*Luciole[^\s\/]*Italic/i.test(r.pdfBuffer.toString('latin1')), 'Luciole italique embarquee dans le PDF exporte');
  // C1 : contraste >= 4,5:1 partout.
  const faibles = renderedSegments(ctx, r.layout).filter((x) => ratioContraste(x.color, x.bg) < 4.5);
  check(`${L}/C1-contraste`, faibles.length === 0,
    `${faibles.length} segment(s) sous 4,5:1, ex. "${faibles[0] && faibles[0].s.text}" ${faibles[0] && ratioContraste(faibles[0].color, faibles[0].bg).toFixed(2)}:1`);
  // R4 : aucun glyphe absent de Luciole, ni dans le modele ni dans la sortie.
  const chars = new Set();
  for (const b of visibleBlocks(r)) for (const ch of blockText(b)) chars.add(ch);
  for (const l of allLines(ctx, r.layout)) for (const ch of lineText(l)) chars.add(ch);
  const absents = [...chars].filter((ch) => ch.codePointAt(0) > 0x20 && !cmap.has(ch.codePointAt(0)));
  check(`${L}/R4-glyphes`, absents.length === 0, `glyphes absents de Luciole : ${absents.join(' ')}`);
}

async function run() {
  const ctx = await setup();
  const load = async (n, s) => { warns.length = 0; const r = await runFullPipeline(ctx, FIX(n), s || { fontSize: 24 }); r.warns = warns.slice(); return r; };
  const names = ['v3-couleurs.pdf', 'v3-glyphes.pdf', 'v3-exposants.pdf', 'v3-italique.pdf', 'v3-runs.pdf', 'v3-mot-coupe.pdf',
    'v3-faux-tableaux.pdf', 'v3-decoupe.pdf', 'v3-tableau-large.pdf', 'v3-liste-sans-puce.pdf', 'v3-pastille.pdf', 'v3-matrices.pdf',
    'v3-decoupe-verticale.pdf', 'v3-cellule-deux-lignes.pdf'];
  const res = {};
  for (const n of names) {
    console.log(`\n=== ${n} ===`);
    for (const s of [{ fontSize: 24 }, { fontSize: 20, colorMode: 'nb' }, { fontSize: 32, contrast: 'jaune-bleu' }]) {
      const label = `${s.fontSize}pt${s.colorMode ? '-' + s.colorMode : ''}${s.contrast ? '-' + s.contrast : ''}`;
      let r;
      try { r = await load(n, s); } catch (e) { check(`${n}/${label}/pipeline`, false, `a leve : ${e.stack}`); continue; }
      if (s.fontSize === 24) res[n] = r;
      // R1 : plus aucun garde-fou declenche (cause racine corrigee).
      const gf = r.warns.filter((w) => w.includes('[garde-fou]') || w.includes('dernier recours'));
      check(`${n}/${label}/R1-aucun-garde-fou`, gf.length === 0, gf.join(' | ').slice(0, 300));
      await common(ctx, n, r, label);
    }
  }

  const T = (n) => res[n];
  const texts = (n) => visibleBlocks(T(n)).map(blockText);
  const outLines = (n) => allLines(ctx, T(n).layout).map(lineText);

  // R2 : la couleur d'une case remplie dans un q...Q ne fuit pas sur le texte.
  {
    const r = T('v3-couleurs.pdf');
    const fuite = r.blocks.flatMap((b) => b.runs || []).filter((x) => x.color && x.color[0] > 200 && x.color[2] > 230 && x.color[1] > 220);
    check('R2-pas-de-fuite-de-couleur', fuite.length === 0, `${fuite.length} run(s) dans le bleu de la case : "${fuite[0] && fuite[0].text}"`);
    const orange = r.blocks.flatMap((b) => b.runs || []).filter((x) => x.text.trim() === 'ons');
    check('couleur-de-terminaison-conservee', orange.length === 1 && orange[0].color && orange[0].color[0] > 200 && orange[0].color[2] < 120,
      `run "ons" : ${JSON.stringify(orange.map((o) => o.color))}`);
    // X1 : une ligne de trous pale est rendue dans la couleur du theme.
    const trous = renderedSegments(ctx, r.layout).filter((x) => /^…+$/.test(x.s.text.trim()));
    check('X1-trous-pales-en-noir', trous.length >= 1 && trous.every((x) => x.color.every((v) => v < 30)),
      JSON.stringify(trous.map((x) => x.color)));
    // E5 : en N&B, la terminaison coloree (deja grasse) est soulignee.
    const nb = await load('v3-couleurs.pdf', { fontSize: 24, colorMode: 'nb' });
    const segs = renderedSegments(ctx, nb.layout).filter((x) => x.s.text.includes('ons'));
    check('E5-nb-souligne', segs.some((x) => x.s.underline), `segments "ons" en N&B : ${JSON.stringify(segs.map((x) => [x.s.text, x.s.style, !!x.s.underline]))}`);
    const titre = renderedSegments(ctx, nb.layout).filter((x) => x.s.text.includes('couleurs'));
    check('E5-titre-colore-non-souligne', titre.every((x) => !x.s.underline), 'un titre entierement colore ne doit pas etre marque');
  }
  // R4 : substitutions.
  {
    const t = texts('v3-glyphes.pdf').join(' / ');
    check('R4-etoile', t.includes('Niveau 1 (*') && t.includes('(**'), t);
    check('R4-fleche', t.includes('→'), t);
    check('R4-ciseaux-retires', !/[✂✄]/.test(t) && !texts('v3-glyphes.pdf').some((x) => x === '"' || x === ''), t);
  }
  // R5 : exposants rattaches a leur mot.
  {
    const t = texts('v3-exposants.pdf');
    check('R5-pas-de-ligne-exposant', !t.some((x) => /^(re|e)( e)?$/.test(x)), JSON.stringify(t));
    check('R5-1re-personne', t.some((x) => x.includes('1re personne') && x.includes('2e personne')), JSON.stringify(t));
  }
  // W2 / R1 / D3.
  {
    const t = texts('v3-runs.pdf');
    check('W2-espaces-du-titre', t.some((x) => x === 'Conjuguer etre, avoir, aller'), JSON.stringify(t));
    check('D3-mini-colonnes', t.includes('Farine : 200 g') && t.includes('Sucre : 100 g'), JSON.stringify(t));
  }
  // W1 : un mot en deux runs n'est jamais coupe.
  {
    const l = outLines('v3-mot-coupe.pdf');
    const coupe = l.filter((x) => /^xemple/.test(x) || /(^|\s)E$/.test(x));
    check('W1-mot-jamais-coupe', coupe.length === 0, `${coupe.length} ligne(s) : ${coupe.slice(0, 2).join(' | ')}`);
  }
  // S6 : seul le vrai tableau est un tableau a plusieurs colonnes.
  {
    const r = T('v3-faux-tableaux.pdf');
    const tabs = r.extraction.pageShapes[0].tables || [];
    const multi = tabs.filter((t) => t.colBounds.length > 2);
    check('S6-un-seul-vrai-tableau', multi.length === 1 && multi[0].rowBounds.length === 4 && multi[0].colBounds.length === 4,
      JSON.stringify(tabs.map((t) => [t.rowBounds.length - 1, t.colBounds.length - 1])));
    const lignesEcriture = tabs.filter((t) => t.y1 < 690 && t.y0 > 590);
    check('S6-lignes-ecriture-pas-un-tableau', lignesEcriture.length === 0, 'les lignes d\'ecriture forment un tableau');
    check('S6-pagination-raisonnable', r.layout.pages.length <= 2, `${r.layout.pages.length} pages`);
  }
  // E1 : exemplaires dedoublonnes, rien a travers une ligne de decoupe.
  {
    const r = T('v3-decoupe.pdf');
    const pages = await exportedText(ctx, r.pdfBuffer);
    const all = pages.map((p) => p.text).join(' ');
    const nA = all.split('Exercice A.').length - 1, nB = all.split('Exercice B.').length - 1;
    check('E1-un-seul-exemplaire', nA === 1 && nB === 1, `Exercice A x${nA}, Exercice B x${nB}`);
    check('E1-dedoublonne-pas-supprime', r.blocks.filter((b) => b.duplicate).length >= 3, 'les exemplaires ecartes doivent rester dans le modele (marques duplicate)');
    check('S1-lignes-de-decoupe', (r.extraction.pageShapes[0].cutLines || []).length === 4, `${(r.extraction.pageShapes[0].cutLines || []).length} ligne(s) de decoupe`);
  }
  // E4 : tableau large en paysage, 3 verbes par page, 20 pt, pronoms retires.
  {
    const r = T('v3-tableau-large.pdf');
    const tabPages = r.layout.pages.filter((pg) => pg.items.some((it) => it.kind === 'table'));
    check('E4-paysage', tabPages.length === 2 && tabPages.every((pg) => pg.pageDims.width > pg.pageDims.height),
      tabPages.map((pg) => `${pg.pageDims.width.toFixed(0)}x${pg.pageDims.height.toFixed(0)}`).join(', '));
    const tabs = tabPages.flatMap((pg) => pg.items.filter((it) => it.kind === 'table'));
    check('E4-3-verbes-max', tabs.every((t) => t.rows[0].cells.length <= 3), tabs.map((t) => t.rows[0].cells.length).join(','));
    check('E4-tableau-entier-sur-sa-page', tabs.length === 2 && tabs.every((t) => t.rows.length === 7), tabs.map((t) => t.rows.length).join(','));
    const corps = new Set(tabs.flatMap((t) => t.rows.flatMap((rw) => rw.cells.flatMap((c) => c.lines.map((l) => l.isHeading ? 20 : l.sizePt)))));
    check('E4-corps-20', corps.size === 1 && corps.has(20), [...corps].join(','));
    const cellules = tabs.flatMap((t) => t.rows.flatMap((rw) => rw.cells.map((c) => c.lines.map(lineText).join(' '))));
    check('E4-pronoms-retires', !cellules.includes('tu') && !cellules.includes('il / elle / on'), 'colonne des pronoms encore presente');
    for (const f of ['je chanterai', 'nous finirons', "j'irai", 'ils feront']) {
      check(`E4-forme-${f}`, cellules.filter((c) => c === f).length === 1, `"${f}" : ${cellules.filter((c) => c === f).length} fois`);
    }
    const titres = outLines('v3-tableau-large.pdf').filter((x) => x.startsWith("Le futur de l'indicatif"));
    check('E4-titre-repete', titres.length === 2 && titres[0].endsWith('(1/2)') && titres[1].endsWith('(2/2)'), JSON.stringify(titres));
    const pages = await exportedText(ctx, r.pdfBuffer);
    check('E4-export-paysage', pages[0].width > pages[0].height && pages[pages.length - 1].width < pages[pages.length - 1].height,
      pages.map((p) => `${p.width.toFixed(0)}x${p.height.toFixed(0)}`).join(', '));
  }
  // Liste sans puce (README) : un item par bloc, la prose reste un bloc.
  {
    const t = texts('v3-liste-sans-puce.pdf');
    for (const it of ['brosse a dents', 'Pyjama', 'deux pulls chauds', 'lampe de poche', 'Livre de contes', 'maillot de bain']) {
      check(`liste-sans-puce/${it}`, t.includes(it), JSON.stringify(t));
    }
    check('liste-sans-puce/prose-intacte', t.filter((x) => x.startsWith('Chaque matin')).every((x) => x.endsWith('voitures rouges.')), JSON.stringify(t));
  }
  // E8 : pastille rattachee a l'en-tete.
  {
    const t = texts('v3-pastille.pdf');
    check('E8-en-tete-et-numero', t.includes('Orthographe 7'), JSON.stringify(t));
  }
  // S1 : exercices cote a cote -- ni fusion de lignes, ni entrelacement.
  {
    const l = outLines('v3-decoupe-verticale.pdf').join(' / ');
    const iC = l.indexOf('Exercice C'), iD = l.indexOf('Exercice D');
    const finC = l.indexOf('des gateaux sucres'), debD = l.indexOf('pomme poire chaise');
    check('S1-regions-cote-a-cote', iC >= 0 && iD > finC && finC > iC && debD > iD, l.slice(0, 300));
    check('S1-pas-de-fusion-a-travers-la-decoupe', !/sucres\s+bleu|rouge\s+pomme|intrus\.?\s+le velo/.test(l), l.slice(0, 300));
  }
  // Retour force : jamais dans une cellule dont le texte est simplement coupe.
  {
    const t = texts('v3-cellule-deux-lignes.pdf');
    check('cellule-sur-deux-lignes-un-paragraphe', t.includes('Le chat noir dort sur le canape du salon pendant que la pluie tombe.'), JSON.stringify(t));
  }
  // Matrices imbriquees.
  {
    const boxes = T('v3-matrices.pdf').extraction.pageShapes[0].boxes;
    const ok = boxes.some((b) => Math.abs(b.x0 - 100) < 1 && Math.abs(b.x1 - 300) < 1 && Math.abs(b.y0 - 100) < 1 && Math.abs(b.y1 - 200) < 1);
    check('matrices-cm-imbriques', ok, JSON.stringify(boxes.map((b) => [b.x0, b.y0, b.x1, b.y1].map(Math.round))));
    const t = texts('v3-matrices.pdf');
    const box = T('v3-matrices.pdf').layout.pages[0].items.filter((it) => it.kind === 'box');
    check('matrices-texte-dans-la-boite', box.length === 1 && box[0].lines.map(lineText).join(' ').includes('transformations successives'), JSON.stringify(t));
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${pass} test(s) v0.3 reussis, ${fail} echec(s)`);
  if (fail > 0) {
    console.log('\nEchecs :');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  }
}

run().catch((e) => { console.error('ERREUR FATALE:', e); process.exitCode = 1; });
