// Outil de diagnostic (developpement) : pour chaque PDF passe en argument,
// affiche les blocs extraits, les tableaux / lignes de decoupe / regions
// detectes, et les lignes de sortie page par page (texte, style, couleur
// source), puis les avertissements de la console.
//   node dump.mjs ../fixtures/v3-decoupe.pdf ...
// Ne pas l'utiliser sur une fiche du corpus pour produire une sortie
// destinee a etre publiee (le texte des fiches y apparait).
import { setup, runFullPipeline } from './harness.mjs';
const warns = [];
const ow = console.warn; console.warn = (...a) => { warns.push(a.join(' ')); };
console.log = ((ol) => (...a) => { if (!String(a[0]).startsWith('[qualite-texte]')) ol(...a); })(console.log);
const ctx = await setup();
for (const f of process.argv.slice(2)) {
  warns.length = 0;
  const r = await runFullPipeline(ctx, f, { fontSize: 24 });
  console.log('\n######', f.split('/').pop(), 'pages', r.layout.pages.length);
  for (const b of r.blocks) console.log(' bloc', b.type, JSON.stringify((b.runs||[]).map(x=>x.text).join('|')).slice(0,120), b.secondary?'(sec)':'');
  r.extraction.pageShapes.forEach((s,i)=>console.log(' tables p'+(i+1), (s.tables||[]).length));
  r.layout.pages.forEach((pg,i)=>{
    console.log(' -- page', i+1, pg.pageDims.width.toFixed(0)+'x'+pg.pageDims.height.toFixed(0), pg.items.map(it=>it.kind+(it.rows?'['+it.rows.length+'x'+it.rows[0].cells.length+']':'')).join(','));
    for (const l of ctx.LayoutEngine.collectPageLines(pg)) console.log('    ', JSON.stringify(l.segments.map(s=>s.text+(s.style!=='normal'?'{'+s.style+'}':'')+(s.color?'#'+s.color.map(Math.round).join('.'):'')).join('')));
  });
  for (const w of warns) console.log(' WARN', w.slice(0,200));
}
