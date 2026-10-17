// Edition « traitement de texte » (retour de test d'Estelle) -- tests du
// modele et du moteur de mise en page : alignement / justification,
// retours a la ligne forces, interligne, espaces avant / apres, retrait,
// report de la mise en forme de l'editeur sur les blocs (04b-text-edit.js).
// Modules reels charges sous Node, sans fixture ni corpus.
import path from 'path';
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { setup, makeMeasurer } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const origLog = console.log;
console.warn = () => {};

let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) pass++;
  else { fail++; failures.push(`${label}: ${detail}`); origLog(`  ✗ ${label}: ${detail}`); }
}

const lineText = (l) => l.segments.map((s) => s.text).join('');

async function run() {
  const ctx = await setup();
  vm.runInThisContext(fs.readFileSync(path.resolve(__dirname, '../../src/04b-text-edit.js'), 'utf8'), { filename: '04b-text-edit.js' });
  const TE = global.window.TextEdit;
  const LE = ctx.LayoutEngine;
  const { measurer } = makeMeasurer(ctx);
  const S = { fontSize: 20 };
  const BR = TE.BREAK;
  const margin = LE.MARGIN_MM * LE.MM_TO_PT;
  const lorem = 'Le petit chat dort sur le canapé du salon pendant que la pluie tombe doucement sur le toit de la maison. '.repeat(3).trim();

  const layoutOf = (paras, settings = S) => {
    const doc = TE.plainDocumentFromRich(paras);
    const lay = LE.computeBlockLayoutForDocument(doc.extraction, doc.blocks, LE.clampSettings(settings), measurer);
    const lines = lay.pages.flatMap((pg) => LE.collectPageLines(pg));
    return { lay, lines, doc };
  };
  const para = (text, fmt = {}, extra = {}) => ({ type: 'p', fmt, runs: [{ text, bold: false, underline: false }], ...extra });
  const right = (l) => l.x + l.segments.reduce((a, s) => a + s.width, 0);
  const usable = (lay) => lay.pages[0].pageDims.width - 2 * margin;

  // --- Alignement ----------------------------------------------------------------
  console.log('\n=== alignement ===');
  {
    const left = layoutOf([para(lorem)]);
    check('align/gauche-x', left.lines.every((l) => Math.abs(l.x - margin) < 0.5), 'lignes decalees sans alignement');
    check('align/plusieurs-lignes', left.lines.length >= 3, `${left.lines.length} ligne(s)`);

    const centre = layoutOf([para(lorem, { align: 'center' })]);
    const ok = centre.lines.every((l) => Math.abs((l.x + right(l)) / 2 - (margin + usable(centre.lay) / 2)) < 1);
    check('align/centre', ok, 'lignes non centrees');
    check('align/centre-meme-texte', centre.lines.map(lineText).join(' ') === left.lines.map(lineText).join(' '), 'le texte differe');

    const droite = layoutOf([para(lorem, { align: 'right' })]);
    check('align/droite', droite.lines.every((l) => Math.abs(right(l) - (margin + usable(droite.lay))) < 1), 'lignes non collees a droite');

    const just = layoutOf([para(lorem, { align: 'justify' })]);
    const jl = just.lines;
    const U = usable(just.lay);
    check('justifie/lignes-pleines', jl.slice(0, -1).every((l) => Math.abs(right(l) - (margin + U)) < 1), `droites : ${jl.map((l) => right(l).toFixed(1))} (cible ${(margin + U).toFixed(1)})`);
    check('justifie/derniere-a-gauche', Math.abs(jl[jl.length - 1].x - margin) < 0.5 && right(jl[jl.length - 1]) < margin + U - 5, 'derniere ligne etiree');
    check('justifie/bord-gauche', jl.every((l) => Math.abs(l.x - margin) < 0.5), 'bord gauche decale');
    check('justifie/meme-texte', jl.map(lineText).join(' ') === left.lines.map(lineText).join(' '), 'le texte differe');
    check('justifie/blancs-elargis', jl[0].segments.some((s) => s.gap) && jl[0].segments.filter((s) => s.gap).every((s) => s.text.trim() === '' && s.width > measurer.widthOf(' ', 20, 'normal')), 'blancs non elargis');
  }

  // --- Retours a la ligne ----------------------------------------------------------
  console.log('\n=== retours a la ligne ===');
  {
    const r = layoutOf([para(`Premiere ligne${BR}Deuxieme ligne${BR}${BR}Apres une ligne vide${BR}`)]);
    const t = r.lines.map(lineText);
    check('retour/lignes', JSON.stringify(t) === JSON.stringify(['Premiere ligne', 'Deuxieme ligne', '', 'Apres une ligne vide']), JSON.stringify(t));
    const ys = r.lines.map((l) => l.y);
    check('retour/pas-de-trou', ys.slice(1).every((y, i) => Math.abs(y - ys[i] - 30) < 0.01), JSON.stringify(ys));
    const j = layoutOf([para(`${lorem}${BR}${lorem}`, { align: 'justify' })]);
    const forces = j.lines.filter((l) => !/ maison\.$/.test(lineText(l)) === false);
    check('retour/justifie-ligne-forcee-a-gauche', j.lines.some((l) => /maison\.$/.test(lineText(l)) && right(l) < margin + usable(j.lay) - 1), 'ligne avant retour etiree');
    const noText = layoutOf([para(`mot${BR}autre`)]);
    check('retour/texte-normalise', TE.richText(para(`mot${BR}autre`)) === 'mot autre', 'richText');
  }

  // --- Interligne, espaces, retrait ------------------------------------------------
  console.log('\n=== interligne, espaces, retrait ===');
  {
    const gap = (r) => { const ys = r.lines.map((l) => l.y); return ys[1] - ys[0]; };
    check('interligne/defaut', Math.abs(gap(layoutOf([para(lorem)])) - 30) < 0.01, 'interligne par defaut');
    check('interligne/2', Math.abs(gap(layoutOf([para(lorem, { lineHeight: 2 })])) - 40) < 0.01, `ecart ${gap(layoutOf([para(lorem, { lineHeight: 2 })]))}`);
    check('interligne/3', Math.abs(gap(layoutOf([para(lorem, { lineHeight: 3 })])) - 60) < 0.01, 'interligne 3');
    check('interligne/plancher', Math.abs(gap(layoutOf([para(lorem, { lineHeight: 1 })])) - 30) < 0.01, 'sous 1,5 : plancher');
    check('interligne/reglage-general-respecte', Math.abs(gap(layoutOf([para(lorem)], { fontSize: 20, lineHeight: 2 })) - 40) < 0.01, 'reglage general ignore');
    // Interligne d'un bloc seul, l'autre garde le reglage general.
    const deux = layoutOf([para('Un mot ' + lorem, { lineHeight: 2 }), para('Autre ' + lorem)]);
    const ys = deux.lines.map((l) => l.y);
    check('interligne/par-paragraphe', Math.abs((ys[1] - ys[0]) - 40) < 0.01 && ys.some((y, i) => i > 0 && Math.abs(y - ys[i - 1] - 30) < 0.01), JSON.stringify(ys));

    const base = layoutOf([para('A'), para('B')]).lines;
    const apres = layoutOf([para('A', { after: 1 }), para('B')]).lines;
    check('espace/apres', Math.abs((apres[1].y - apres[0].y) - (base[1].y - base[0].y) - 30) < 0.01, `ecart ${(apres[1].y - apres[0].y).toFixed(1)} contre ${(base[1].y - base[0].y).toFixed(1)}`);
    const avant = layoutOf([para('A'), para('B', { before: 2 })]).lines;
    check('espace/avant', Math.abs((avant[1].y - avant[0].y) - (base[1].y - base[0].y) - 60) < 0.01, `ecart ${(avant[1].y - avant[0].y).toFixed(1)}`);
    check('espace/jamais-negatif', Math.abs(layoutOf([para('A', { after: -5 }), para('B')]).lines[1].y - base[1].y) < 0.01, 'espace negatif accepte');

    const ret = layoutOf([para(lorem, { indent: 1 })]).lines;
    check('retrait/decale', ret.every((l) => Math.abs(l.x - (margin + 30)) < 0.5), `x : ${ret.map((l) => l.x.toFixed(1))}`);
    check('retrait/ligne-plus-courte', ret.length >= layoutOf([para(lorem)]).lines.length, 'retrait sans effet sur la largeur');
    // Pagination : un long texte tres espace reste entier et tient sur plusieurs pages.
    const long = layoutOf(Array.from({ length: 40 }, (_, i) => para(`Paragraphe ${i + 1} ${lorem}`, { lineHeight: 2, after: 1, align: 'justify' })));
    check('pagination/plusieurs-pages', long.lay.pages.length > 4, `${long.lay.pages.length} page(s)`);
    check('pagination/rien-ne-deborde', long.lay.pages.every((pg) => LE.collectPageLines(pg).every((l) => l.y < pg.pageDims.height - margin + 1)), 'ligne hors de la page');
    check('pagination/tout-le-texte', (long.lines.map(lineText).join(' ').match(/Paragraphe \d+/g) || []).length === 40, 'paragraphe perdu');
  }

  // --- Export PDF ----------------------------------------------------------------
  console.log('\n=== export ===');
  {
    const r = layoutOf([
      { type: 'h1', fmt: { align: 'center' }, runs: [{ text: 'Titre centre', bold: true, underline: false }] },
      para(lorem, { align: 'justify', lineHeight: 2 }),
      para(`Une ligne${BR}puis une autre`, { align: 'right', indent: 1 }),
    ]);
    const ex = ctx.PdfExport.createExportDoc(ctx.jsPDF, r.lay.pages[0].pageDims);
    ctx.PdfExport.renderLayoutToPdf(ex, r.lay, 'forme.pdf');
    check('export/valide', ex.output('arraybuffer').byteLength > 1000, 'export vide');
    check('export/titre-centre', Math.abs(((r.lines[0].x + right(r.lines[0])) / 2) - (margin + usable(r.lay) / 2)) < 1, 'titre non centre');
  }

  // --- Report de la mise en forme sur les blocs -----------------------------------
  console.log('\n=== report sur les blocs ===');
  {
    const mk = (type, runs) => ({ type, srcPage: 1, runs, bbox: { x0: 0, x1: 500, y0: 0, y1: 20 } });
    const blocks = [
      mk('h1', [{ text: 'Mon titre', bold: true }]),
      mk('p', [{ text: 'Il faut ', color: [200, 0, 0] }, { text: 'accorder', bold: true, color: [200, 0, 0] }, { text: ' le verbe.' }]),
      mk('p', [{ text: 'Dernier paragraphe.' }]),
    ];
    const rich = TE.toRichParagraphs(blocks, S);
    check('rich/trois-paragraphes', rich.length === 3 && rich[0].type === 'h1' && rich[1].runs.some((r) => r.bold && r.text === 'accorder'), JSON.stringify(rich));

    const same = TE.applyRichEdit(blocks, rich, S);
    check('rich/inchange', same.length === 3 && same.every((b, i) => b === blocks[i]), 'un texte inchange modifie le modele');

    // Mise en forme seule : centrer le titre, justifier le 2e paragraphe.
    const fmt = JSON.parse(JSON.stringify(rich));
    fmt[0].fmt = { align: 'center' };
    fmt[1].fmt = { align: 'justify', lineHeight: 2, after: 1 };
    const f = TE.applyRichEdit(blocks, fmt, S);
    check('rich/format-seul-titre', f[0] !== blocks[0] && f[0].fmt.align === 'center' && f[0].type === 'h1' && f[0].bbox === blocks[0].bbox, JSON.stringify(f[0].fmt));
    check('rich/format-seul-paragraphe', f[1].fmt.align === 'justify' && f[1].fmt.lineHeight === 2 && f[1].fmt.after === 1, JSON.stringify(f[1].fmt));
    check('rich/format-seul-autre-intact', f[2] === blocks[2], 'un paragraphe non touche a ete recree');
    check('rich/original-intact', blocks[0].fmt === undefined && blocks[1].fmt === undefined, 'le bloc d\'origine a ete modifie sur place');
    check('rich/format-seul-texte-identique', f.map(TE.blockText).join('|') === blocks.map(TE.blockText).join('|'), 'le texte a change');
    check('rich/couleur-conservee', f[1].runs.every((r, i, a) => i === a.length - 1 || (r.color && r.color[0] === 200)), JSON.stringify(f[1].runs));

    // Gras retire sur "accorder", souligne ajoute sur "verbe".
    const st = JSON.parse(JSON.stringify(rich));
    st[1].runs = [
      { text: 'Il faut accorder le ', bold: false, underline: false },
      { text: 'verbe', bold: false, underline: true },
      { text: '.', bold: false, underline: false },
    ];
    const s = TE.applyRichEdit(blocks, st, S);
    check('rich/gras-retire', !s[1].runs.some((r) => r.bold), JSON.stringify(s[1].runs));
    check('rich/souligne-ajoute', s[1].runs.some((r) => r.underline && r.text === 'verbe'), JSON.stringify(s[1].runs));
    check('rich/couleur-gardee-apres-style', s[1].runs[0].color && s[1].runs[0].color[0] === 200, JSON.stringify(s[1].runs[0]));
    check('rich/jamais-d-italique', s.every((b) => b.runs.every((r) => !r.italic)), 'italique present');

    // Type : paragraphe -> titre 2, puis liste.
    const ty = JSON.parse(JSON.stringify(rich));
    ty[2].type = 'h2';
    check('rich/type-titre', TE.applyRichEdit(blocks, ty, S)[2].type === 'h2', 'type non reporte');
    ty[2].type = 'li';
    check('rich/type-liste', TE.applyRichEdit(blocks, ty, S)[2].type === 'li', 'type non reporte');

    // Retour a la ligne force + texte corrige.
    const br = JSON.parse(JSON.stringify(rich));
    br[2].runs = [{ text: `Dernier${BR}paragraphe corrige.`, bold: false, underline: false }];
    const b = TE.applyRichEdit(blocks, br, S);
    check('rich/retour-ligne-dans-le-bloc', b.length === 3 && b[2].runs.map((r) => r.text).join('') === `Dernier${BR}paragraphe corrige.`, JSON.stringify(b[2].runs));

    // Ajout d'un paragraphe (centre) entre les deux derniers + suppression du titre.
    const aj = JSON.parse(JSON.stringify(rich));
    aj.splice(2, 0, { type: 'p', fmt: { align: 'center' }, runs: [{ text: 'Ajout au milieu.', bold: true, underline: false }] });
    aj.shift();
    const a = TE.applyRichEdit(blocks, aj, S);
    check('rich/ajout-et-suppression', a.length === 3 && !a.includes(blocks[0]) && a[1].added && a[1].fmt.align === 'center' && a[1].runs[0].bold && a[2] === blocks[2], a.map(TE.blockText).join('|'));
    check('rich/ajout-meme-place', a[1].bbox === blocks[1].bbox && a[1].srcPage === 1, 'paragraphe ajoute sans position');

    // Mise en page de bout en bout.
    const ex = { blocks: f, pageShapes: [{ boxes: [], lines: [], decorative: [] }], pageSizes: [{ width: 595.28, height: 841.89, modalSize: 12 }] };
    const lay = LE.computeBlockLayoutForDocument(ex, f, LE.clampSettings(S), measurer);
    const lines = lay.pages.flatMap((pg) => LE.collectPageLines(pg));
    check('rich/mise-en-page-titre-centre', lines[0].x > margin + 20, `x = ${lines[0].x}`);

    // Mode texte seulement : types et mise en forme gardes.
    const plain = TE.plainDocumentFromRich(fmt);
    check('rich/texte-seulement', plain.blocks.length === 3 && plain.blocks[0].type === 'h1' && plain.blocks[0].fmt.align === 'center' && plain.blocks[1].fmt.lineHeight === 2, JSON.stringify(plain.blocks.map((x) => [x.type, x.fmt])));
    check('rich/vide', TE.plainDocumentFromRich([{ type: 'p', runs: [{ text: '   ' }] }]).blocks.length === 0, 'paragraphe vide conserve');
  }

  // --- Normalisation des blancs ---------------------------------------------------
  console.log('\n=== blancs ===');
  {
    const n = TE.normalizeRich([{ type: 'zzz', fmt: { align: 'bizarre', lineHeight: 0.5, before: -1, indent: 'x' }, runs: [{ text: `  a   b ${BR}  ${BR} c  ` }] }]);
    check('blancs/normalises', n.length === 1 && n[0].runs.map((r) => r.text).join('') === `a b${BR}${BR}c`, JSON.stringify(n));
    check('blancs/type-invalide', n[0].type === 'p', n[0].type);
    check('blancs/fmt-nettoye', JSON.stringify(n[0].fmt) === '{"lineHeight":1.5}', JSON.stringify(n[0].fmt));
  }

  origLog(`\n${'='.repeat(60)}`);
  origLog(`${pass} test(s) mise en forme reussis, ${fail} echec(s)`);
  if (fail) { origLog('\nEchecs :'); for (const f of failures) origLog('  - ' + f); process.exitCode = 1; }
}

run().catch((e) => { console.error('ERREUR FATALE:', e); process.exitCode = 1; });
