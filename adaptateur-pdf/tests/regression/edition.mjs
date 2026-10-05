// Retour de test du 05/10/2026 (reunion de test de l'outil) -- tests cibles :
//  - taille par defaut 20 pt ;
//  - en-tetes, pieds de page et numeros de page : masques par defaut,
//    reaffichables, jamais perdus du modele ;
//  - mode « Texte simplifie » (sans cadres, couleurs, rembourrage) ;
//  - relecture du texte (04b-text-edit.js) : suppression / correction d'un
//    paragraphe, style conserve, mode « texte simple ».
// Meme principe que v03.mjs : modules reels charges sous Node, sur les
// fixtures synthetiques de tests/fixtures/ (aucune fiche du corpus).
import path from 'path';
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { setup, runFullPipeline, makeMeasurer } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = (n) => path.resolve(__dirname, '../fixtures', n);

const origLog = console.log;
console.warn = () => {};
console.log = (...a) => { if (!String(a[0]).startsWith('[qualite-texte]')) origLog(...a); };

let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) pass++;
  else { fail++; failures.push(`${label}: ${detail}`); origLog(`  ✗ ${label}: ${detail}`); }
}

const lineText = (l) => l.segments.map((s) => s.text).join('');
const allLines = (ctx, layout) => layout.pages.flatMap((pg) => ctx.LayoutEngine.collectPageLines(pg));
const layoutText = (ctx, layout) => allLines(ctx, layout).map(lineText).join('\n');

async function run() {
  const ctx = await setup();
  // 04b-text-edit.js n'est pas dans la liste du harnais : on le charge ici.
  vm.runInThisContext(fs.readFileSync(path.resolve(__dirname, '../../src/04b-text-edit.js'), 'utf8'), { filename: '04b-text-edit.js' });
  const TE = global.window.TextEdit;
  const LE = ctx.LayoutEngine;
  const { measurer } = makeMeasurer(ctx);
  const relayout = (extraction, blocks, settings) => LE.computeBlockLayoutForDocument(extraction, blocks, LE.clampSettings(settings), measurer);

  // --- Taille par defaut -----------------------------------------------------
  console.log('\n=== reglages ===');
  check('defaut/20pt', LE.DEFAULTS.fontSize === 20, `DEFAULTS.fontSize = ${LE.DEFAULTS.fontSize}`);
  check('defaut/clamp-vide', LE.clampSettings({}).fontSize === 20, `${LE.clampSettings({}).fontSize}`);
  check('defaut/plancher', LE.clampSettings({ fontSize: 12 }).fontSize === 20, `${LE.clampSettings({ fontSize: 12 }).fontSize}`);
  check('defaut/simplifie-off', LE.clampSettings({}).simplified === false, 'simplified devrait valoir false');
  check('defaut/entetes-masques', LE.clampSettings({}).showHeaderFooter === false, 'showHeaderFooter devrait valoir false');
  check('simplifie/noir-et-blanc-effectif', LE.effectiveSettings({ simplified: true, colorMode: 'couleur' }).colorMode === 'nb', 'le mode simplifie doit rendre en N&B');
  check('defaut/texte-seul-off', LE.clampSettings({}).textOnly === false, 'textOnly devrait valoir false');
  check('texte-seul/implique-simplifie', LE.effectiveSettings({ textOnly: true }).simplified === true, 'le texte seul doit etre sans cadre');
  check('simplifie/reglage-couleur-intact', LE.clampSettings({ simplified: true, colorMode: 'couleur' }).colorMode === 'couleur', 'clampSettings ne doit pas ecraser colorMode');

  // --- En-tetes / pieds / numeros --------------------------------------------
  console.log('\n=== en-tetes, pieds de page, numeros ===');
  {
    const r = await runFullPipeline(ctx, FIX('04-entete-pied-repetes.pdf'), { fontSize: 20 });
    const hf = r.extraction.blocks.filter((b) => b.headerFooter);
    check('entetes/blocs-gardes-dans-le-modele', hf.length === 3, `${hf.length} bloc(s) en-tete/pied dans le modele (attendu 3)`);
    check('entetes/masques-par-defaut', !/Bulletin municipal/.test(layoutText(ctx, r.layout)), 'l\'en-tete repete apparait dans la sortie par defaut');
    check('entetes/texte-courant-conserve', /Article 1/.test(layoutText(ctx, r.layout)) && /Article 3/.test(layoutText(ctx, r.layout)), 'le texte courant a disparu');
    const shown = await runFullPipeline(ctx, FIX('04-entete-pied-repetes.pdf'), { fontSize: 20, showHeaderFooter: true });
    const n = (layoutText(ctx, shown.layout).match(/Bulletin municipal/g) || []).length;
    check('entetes/reaffichables', n === 3, `${n} en-tete(s) affiche(s) avec la case cochee (attendu 3)`);
    check('entetes/pdf-valide', shown.reparsed.pageCount >= 1, 'export invalide');
  }
  {
    const r = await runFullPipeline(ctx, FIX('08-numerotation.pdf'), { fontSize: 20 });
    const hf = r.extraction.blocks.filter((b) => b.headerFooter).map((b) => TE.blockText(b));
    check('numeros/page-x-sur-y-detecte', hf.length === 2 && hf.every((t) => /^Page \d sur 2$/.test(t)), `blocs en-tete/pied : ${JSON.stringify(hf)}`);
    check('numeros/masques-par-defaut', !/Page \d sur 2/.test(layoutText(ctx, r.layout)), 'la numerotation de page apparait dans la sortie');
    const shown = await runFullPipeline(ctx, FIX('08-numerotation.pdf'), { fontSize: 20, showHeaderFooter: true });
    check('numeros/reaffichables', /Page 1 sur 2/.test(layoutText(ctx, shown.layout)), 'numerotation absente avec la case cochee');
  }

  // --- Mode « Texte simplifie » ----------------------------------------------
  console.log('\n=== texte simplifie ===');
  for (const n of ['v3-matrices.pdf', 'v3-titre-et-colonnes.pdf', '07-mascottes.pdf']) {
    const normal = await runFullPipeline(ctx, FIX(n), { fontSize: 20 });
    const simple = await runFullPipeline(ctx, FIX(n), { fontSize: 20, simplified: true, showImages: false });
    check(`${n}/simplifie-actif`, simple.layout.settings.simplified === true, 'layout.settings.simplified faux');
    check(`${n}/simplifie-meme-texte`, layoutText(ctx, normal.layout).replace(/\s+/g, ' ') === layoutText(ctx, simple.layout).replace(/\s+/g, ' '),
      'le mode simplifie ne doit retirer aucun texte');
    const hauteur = (r) => r.layout.pages.reduce((a, pg) => a + pg.items.reduce((b, it) => b + (it.height || 0), 0), 0);
    check(`${n}/simplifie-pas-plus-haut`, hauteur(simple) <= hauteur(normal) + 0.5, `hauteur ${hauteur(simple).toFixed(0)} > ${hauteur(normal).toFixed(0)}`);
    check(`${n}/simplifie-pages`, simple.layout.pages.length <= normal.layout.pages.length, `${simple.layout.pages.length} page(s) > ${normal.layout.pages.length}`);
    for (const pg of simple.layout.pages) {
      for (const it of pg.items) {
        if (it.kind !== 'box') continue;
        const xs = it.lines.map((l) => l.x);
        // Sans cadre, le texte retrouve la marge de page (aucun rembourrage).
        check(`${n}/simplifie-sans-rembourrage`, Math.min(...xs) <= it.x + 0.5, `texte decale de ${(Math.min(...xs) - it.x).toFixed(1)}pt dans une boite`);
        check(`${n}/simplifie-boite-ajustee`, it.height <= it.lines[it.lines.length - 1].y + 0.5 * 20 + 1, 'boite etiree jusqu\'a la hauteur de sa source');
      }
    }
    check(`${n}/simplifie-pdf-valide`, simple.reparsed.pageCount === simple.layout.pages.length, 'export incoherent');
    // Aucun segment colore : tout suit la couleur du theme.
    const theme = LE.hexToRgbArr(simple.layout.theme.fg);
    const colores = [];
    for (const l of allLines(ctx, simple.layout)) for (const s of l.segments) {
      if (!s.text.trim()) continue;
      const c = LE.resolveTextColor(s.color, simple.layout.settings, simple.layout.theme, LE.hexToRgbArr(simple.layout.theme.bg));
      if (c.some((v, i) => v !== theme[i])) colores.push(s.text);
    }
    check(`${n}/simplifie-sans-couleur`, colores.length === 0, `${colores.length} segment(s) colore(s), ex. "${colores[0]}"`);
  }

  // --- Relecture du texte : modele ---------------------------------------------
  console.log('\n=== relecture du texte (modele) ===');
  {
    const S = LE.clampSettings({});
    const r = await runFullPipeline(ctx, FIX('01-hierarchie-styles-listes.pdf'), { fontSize: 20 });
    const all = r.extraction.blocks;
    const visible = TE.visibleBlocks(all, S);
    const paragraphs = visible.map(TE.blockText);
    check('edition/visibles', visible.length > 4 && visible.every((b) => b.type !== 'image' && b.type !== 'pagebreak'), `${visible.length} bloc(s) visibles`);
    check('edition/aller-retour', JSON.stringify(TE.parseParagraphs(TE.joinParagraphs(paragraphs))) === JSON.stringify(paragraphs), 'joindre puis decouper ne redonne pas les paragraphes');

    // Aucune modification : memes blocs, memes objets.
    const same = TE.applyEdit(all, paragraphs, S);
    check('edition/sans-changement', same.length === all.length && same.every((b, i) => b === all[i]), 'un texte inchange modifie le modele');

    // Suppression d'un paragraphe (une phrase en trop).
    const k = Math.min(3, paragraphs.length - 1);
    const sansK = paragraphs.filter((_, i) => i !== k);
    const del = TE.applyEdit(all, sansK, S);
    check('edition/suppression-bloc', del.length === all.length - 1 && !del.includes(visible[k]), 'le bloc supprime est toujours la');
    check('edition/suppression-reste-intact', visible.filter((_, i) => i !== k).every((b) => del.includes(b)), 'un autre bloc a ete touche');
    const layDel = relayout(r.extraction, del.filter((b) => b.type !== 'pagebreak' && b.type !== 'needs-ocr'), {});
    check('edition/suppression-dans-la-sortie', !layoutText(ctx, layDel).includes(paragraphs[k].slice(0, 25)), 'le paragraphe supprime apparait encore dans la mise en page');

    // Correction d'un mot dans un paragraphe : style des runs conserve.
    const styled = visible.findIndex((b) => b.runs.length > 1 || b.runs.some((x) => x.bold));
    const ti = styled >= 0 ? styled : 1;
    const orig = paragraphs[ti];
    const word = orig.split(' ').find((w) => w.length > 3) || orig;
    const edited = paragraphs.slice(); edited[ti] = orig.replace(word, 'XXXXXX');
    const ed = TE.applyEdit(all, edited, S);
    const nb = ed.find((b) => b.edited);
    check('edition/correction-bloc-modifie', !!nb && TE.blockText(nb) === edited[ti], `texte du bloc : "${nb && TE.blockText(nb)}"`);
    check('edition/correction-meme-place', !!nb && nb.type === visible[ti].type && nb.bbox === visible[ti].bbox && ed.indexOf(nb) === all.indexOf(visible[ti]), 'type, position ou rang du bloc change');
    check('edition/original-intact', TE.blockText(visible[ti]) === orig, 'le bloc d\'origine a ete modifie sur place');
    if (visible[ti].runs.some((x) => x.bold) && visible[ti].runs.some((x) => !x.bold)) {
      const origBold = visible[ti].runs.filter((x) => x.bold).map((x) => x.text).join('');
      const newBold = nb.runs.filter((x) => x.bold).map((x) => x.text).join('');
      check('edition/gras-conserve', !word || !origBold.includes(word) ? newBold === origBold : true, `gras avant "${origBold}" apres "${newBold}"`);
    }

    // Paragraphe ajoute : prend la place du precedent, en texte courant.
    const ajout = paragraphs.slice(); ajout.splice(2, 0, 'Une phrase ajoutee a la main.');
    const add = TE.applyEdit(all, ajout, S);
    const added = add.find((b) => b.added);
    check('edition/ajout', !!added && add.indexOf(added) === all.indexOf(visible[1]) + 1 && TE.blockText(added) === 'Une phrase ajoutee a la main.', 'paragraphe ajoute mal place');

    // Plusieurs suppressions + une correction dans le meme intervalle : la
    // correction retrouve son bloc par ressemblance (pas par position).
    const melange = paragraphs.slice(); melange.splice(1, 2); melange[1] = melange[1] + ' (relu)';
    const mel = TE.applyEdit(all, melange, S);
    const edB = mel.find((b) => b.edited);
    check('edition/correction-apres-suppression', !!edB && edB === mel.find((b) => TE.blockText(b) === melange[1]) && edB.type === visible[3].type, `bloc corrige : ${edB && TE.blockText(edB).slice(0, 30)}`);

    // En-tetes : non editables tant qu'ils sont masques.
    const hfDoc = await runFullPipeline(ctx, FIX('04-entete-pied-repetes.pdf'), { fontSize: 20 });
    check('edition/entetes-hors-panneau', TE.visibleBlocks(hfDoc.extraction.blocks, S).every((b) => !b.headerFooter), 'un en-tete est editable alors qu\'il est masque');
    check('edition/entetes-dans-panneau-si-affiches', TE.visibleBlocks(hfDoc.extraction.blocks, { ...S, showHeaderFooter: true }).some((b) => b.headerFooter), 'en-tete absent du panneau alors qu\'il est affiche');
    const hfVis = TE.visibleBlocks(hfDoc.extraction.blocks, { ...S, showHeaderFooter: true });
    const hfEd = TE.applyEdit(hfDoc.extraction.blocks, hfVis.map(TE.blockText).filter((t) => !/Bulletin/.test(t)), { ...S, showHeaderFooter: true });
    check('edition/entete-supprimable', hfEd.filter((b) => b.headerFooter).length === 0, 'en-tete non supprime');
  }
  {
    // Runs : le texte insere prend le style de l'endroit, le reste garde le sien.
    const runs = [{ text: 'Il faut ', bold: false }, { text: 'accorder', bold: true }, { text: ' le verbe.', bold: false }];
    const out = TE.applyTextToRuns(runs, 'Il faut bien accorder le verbe.');
    check('runs/gras-conserve', out.find((r) => r.bold).text === 'accorder', JSON.stringify(out));
    check('runs/texte', out.map((r) => r.text).join('') === 'Il faut bien accorder le verbe.', JSON.stringify(out));
    const out2 = TE.applyTextToRuns(runs, 'Il faut accorder');
    check('runs/suppression-fin', out2.map((r) => r.text).join('') === 'Il faut accorder' && out2.find((r) => r.bold).text === 'accorder', JSON.stringify(out2));
    check('runs/couleur-conservee', TE.applyTextToRuns([{ text: 'a ', color: [1, 2, 3] }, { text: 'b', color: [9, 9, 9] }], 'a bc')[1].color[0] === 9, 'couleur du run perdue');
  }
  {
    const ops = TE.alignParagraphs(['a', 'b', 'c', 'd'], ['a', 'c', 'd']);
    check('alignement/suppression', ops.filter((o) => o.op === 'del').length === 1 && ops.find((o) => o.op === 'del').i === 1, JSON.stringify(ops));
    const ops2 = TE.alignParagraphs(['premier', 'second paragraphe', 'troisieme'], ['premier', 'second paragraphe corrige', 'troisieme']);
    check('alignement/correction', ops2.some((o) => o.op === 'edit' && o.i === 1 && o.j === 1), JSON.stringify(ops2));
    check('alignement/vide', TE.alignParagraphs([], []).length === 0 && TE.alignParagraphs(['x'], []).length === 1, 'cas vide');
  }

  // --- Mode « texte simple » -----------------------------------------------------
  console.log('\n=== texte simple ===');
  {
    const texte = 'Premier paragraphe du texte.\n\nSecond paragraphe\nsur deux lignes.\n\n\n   \nTroisième paragraphe.';
    check('brut/decoupage', JSON.stringify(TE.parseParagraphs(texte)) === JSON.stringify(['Premier paragraphe du texte.', 'Second paragraphe sur deux lignes.', 'Troisième paragraphe.']), JSON.stringify(TE.parseParagraphs(texte)));
    const doc = TE.plainDocument(texte);
    const lay = relayout(doc.extraction, doc.blocks, { fontSize: 20 });
    check('brut/mise-en-page', lay.pages.length === 1 && lay.pages[0].items.length === 3 && lay.pages[0].items.every((it) => it.kind === 'flow'), `${lay.pages.length} page(s), items : ${lay.pages[0].items.map((i) => i.kind)}`);
    const ordre = layoutText(ctx, lay);
    check('brut/ordre', ordre.indexOf('Premier') < ordre.indexOf('Second') && ordre.indexOf('Second') < ordre.indexOf('Troisième'), ordre);
    check('brut/corps-20', allLines(ctx, lay).every((l) => l.sizePt === 20), 'corps different de 20 pt');
    // Long texte : se pagine en A4.
    const long = Array.from({ length: 60 }, (_, i) => `Paragraphe numéro ${i + 1} : ${'des mots pour remplir la ligne '.repeat(6)}`).join('\n\n');
    const dl = TE.plainDocument(long);
    const ll = relayout(dl.extraction, dl.blocks, { fontSize: 20 });
    const A4h = 297 * 2.83464567;
    check('brut/pagination', ll.pages.length > 3 && ll.pages.every((pg) => Math.abs(pg.pageDims.height - A4h) < 2), `${ll.pages.length} page(s)`);
    check('brut/tout-le-texte', (layoutText(ctx, ll).match(/Paragraphe numéro/g) || []).length === 60, 'paragraphe(s) perdu(s) a la pagination');
    check('brut/paysage', relayout(doc.extraction, doc.blocks, { fontSize: 20, orientation: 'paysage' }).pages[0].pageDims.width > A4h - 2, 'orientation paysage ignoree');
    const ex = ctx.PdfExport.createExportDoc(ctx.jsPDF, ll.pages[0].pageDims);
    ctx.PdfExport.renderLayoutToPdf(ex, ll, 'brut.pdf');
    check('brut/export', ex.output('arraybuffer').byteLength > 1000, 'export vide');
    const vide = TE.plainDocument('   \n\n  ');
    check('brut/vide', vide.blocks.length === 0, 'un texte vide doit donner un document vide');
  }

  // --- Mode « Texte seul » -------------------------------------------------------
  console.log('\n=== texte seul (document) ===');
  for (const n of ['v3-titre-et-colonnes.pdf', 'v3-matrices.pdf', '07-mascottes.pdf', '01-hierarchie-styles-listes.pdf']) {
    const S = LE.clampSettings({ textOnly: true });
    const r = await runFullPipeline(ctx, FIX(n), { fontSize: 20 });
    const doc = TE.textOnlyDocument(r.extraction.blocks, S);
    const lay = relayout(doc.extraction, doc.blocks, { fontSize: 20, textOnly: true });
    check(`${n}/texte-seul-que-du-flux`, lay.pages.every((pg) => pg.items.every((it) => it.kind === 'flow')), 'element autre que du texte courant');
    const lignes = allLines(ctx, lay);
    check(`${n}/texte-seul-ni-gras-ni-titre`, lignes.every((l) => !l.isHeading && l.segments.every((s) => s.style !== 'bold' && !s.underline)), 'gras ou titre en texte seul');
    check(`${n}/texte-seul-une-taille`, new Set(lignes.map((l) => l.sizePt)).size === 1, 'plusieurs tailles de police');
    const mots = (t) => t.replace(/\s+/g, ' ').split(' ').filter(Boolean).sort().join(' ');
    const attendu = TE.visibleBlocks(r.extraction.blocks, S).map(TE.blockText).join(' ');
    check(`${n}/texte-seul-tout-le-texte`, mots(layoutText(ctx, lay)) === mots(attendu), 'des mots perdus ou ajoutes');
    const ex = ctx.PdfExport.createExportDoc(ctx.jsPDF, lay.pages[0].pageDims);
    ctx.PdfExport.renderLayoutToPdf(ex, lay, 'texte.pdf');
    check(`${n}/texte-seul-export`, ex.output('arraybuffer').byteLength > 1000, 'export vide');
  }

  origLog(`\n${'='.repeat(60)}`);
  origLog(`${pass} test(s) edition reussis, ${fail} echec(s)`);
  if (fail) { origLog('\nEchecs :'); for (const f of failures) origLog('  - ' + f); process.exitCode = 1; }
}

run().catch((e) => { console.error('ERREUR FATALE:', e); process.exitCode = 1; });
