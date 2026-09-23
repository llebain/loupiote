// Outil de corpus (plan v0.3, §0.2). Pilote UN PROCESSUS NODE ISOLE par
// fiche (corpus-un-doc.mjs), 4 en parallele par defaut, delai maximal 90 s
// par fiche -- a l'echeance, tue tout le GROUPE de processus (spawn
// detache + SIGKILL du groupe), jamais de Chrome orphelin. Remplace
// corpus-prototype.mjs / corpus-prototype-un-doc.sh (perl alarm, macOS
// n'a pas `timeout`).
//
// Usage :
//   node corpus.mjs                         # campagne complete (43 fiches)
//   node corpus.mjs --only 07_FicheOrtho,03_ExercicesAuto
//   node corpus.mjs --famille F2
//   node corpus.mjs --update-reference       # ecrit corpus/_reference/metrics.json
//   node corpus.mjs --compare                # code <> 0 si regression
//   node corpus.mjs --compare --cible 12_Tableau_indiv,F4   # exempte ces docs/familles
//   node corpus.mjs --jobs 6 --corps 20
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(__dirname, '../../../corpus');
const SORTIES = path.join(CORPUS, '_sorties');
const REFERENCE = path.join(CORPUS, '_reference', 'metrics.json');
const MANIFEST = path.join(CORPUS, 'manifest.json');
const UN_DOC = path.join(__dirname, 'corpus-un-doc.mjs');

const DELAI_MAX_MS = 90000;

function parseArgs(argv) {
  const a = { jobs: 4, corps: 24, only: null, famille: null, cible: [], compare: false, updateReference: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--only') a.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (t === '--famille') a.famille = argv[++i];
    else if (t === '--cible') a.cible = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (t === '--compare') a.compare = true;
    else if (t === '--update-reference') a.updateReference = true;
    else if (t === '--corps') a.corps = Number(argv[++i]);
    else if (t === '--jobs') a.jobs = Number(argv[++i]);
    else console.error(`Option inconnue ignoree : ${t}`);
  }
  return a;
}

function chargerManifest() {
  if (!fs.existsSync(MANIFEST)) {
    console.log('corpus/manifest.json absent : generation...');
    const r = spawnSync('node', [path.join(__dirname, 'corpus-manifeste.mjs')], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('Echec de generation du manifeste.');
  }
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

function sourcePdfPath(fiche) {
  return path.join(CORPUS, fiche.dossier, fiche.fichier);
}

/**
 * Lance UNE fiche dans un processus isole, detache (son propre groupe de
 * processus), avec un delai maximal. A l'echeance : SIGKILL du groupe
 * entier (process.kill(-pid, 'SIGKILL')) -- tue le node ET tout Chrome
 * qu'il a lance, meme si le rendu de la page est completement fige
 * (gel R1 : verifie qu'un simple timeout Playwright cote Node NE SUFFIT
 * PAS toujours quand le thread JS de la page est sature -- cf. note de
 * session : 13_Memo_Tableau_indiv a depasse son propre delai interne de
 * 80 s sans jamais rendre la main, la commande Playwright est restee
 * bloquee ; seul le SIGKILL du groupe de processus a termine le test).
 */
function lancerFiche(fiche, corps) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(
      'node',
      [UN_DOC, sourcePdfPath(fiche), fiche.famille, fiche.nom, String(corps), SORTIES],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let sortieLigne = '';
    let erreur = '';
    child.stdout.on('data', (d) => { sortieLigne += d.toString(); });
    child.stderr.on('data', (d) => { erreur += d.toString(); });

    let fini = false;
    const minuteur = setTimeout(() => {
      if (fini) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* deja mort */ }
      try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
    }, DELAI_MAX_MS);

    child.on('exit', (code, signal) => {
      if (fini) return;
      fini = true;
      clearTimeout(minuteur);
      const dureeS = (Date.now() - t0) / 1000;
      const chemin = path.join(SORTIES, fiche.famille, fiche.nom, 'metrics.json');
      let metrics = null;
      if (fs.existsSync(chemin)) {
        try { metrics = JSON.parse(fs.readFileSync(chemin, 'utf8')); } catch (e) { /* fichier tronque */ }
      }
      if (!metrics) {
        // Le processus enfant n'a jamais eu la main pour ecrire son
        // resultat (tue par le minuteur ci-dessus, ou plante avant coup) :
        // le parent synthetise un resultat minimal.
        const statut = signal === 'SIGKILL' && dureeS >= (DELAI_MAX_MS / 1000) - 2 ? 'delai-depasse' : 'plantage';
        metrics = {
          nom: fiche.nom, famille: fiche.famille, fichier: fiche.fichier,
          statut, duree_s: Number(dureeS.toFixed(1)),
          fatal: `processus enfant termine sans metrics.json (code=${code}, signal=${signal}) apres ${dureeS.toFixed(1)}s. stderr: ${erreur.slice(0, 300)}`,
        };
        fs.mkdirSync(path.dirname(chemin), { recursive: true });
        fs.writeFileSync(chemin, JSON.stringify(metrics, null, 2));
      }
      resolve(metrics);
    });
  });
}

/**
 * Filet de securite final : meme apres un SIGKILL du groupe de processus
 * (process.kill(-pid,...)), certains processus auxiliaires de Chrome
 * (chrome_crashpad_handler, GPU, network/storage utility) peuvent survivre
 * -- observe empiriquement sur les fiches "delai-depasse"/"plantage" du
 * corpus (renderer completement fige, cf. R1) : Chrome ne place pas
 * toujours tous ses processus auxiliaires dans le MEME groupe que le
 * processus Node qui l'a lance, donc `kill(-pgid)` ne les atteint pas
 * systematiquement. Balayage inconditionnel en fin de campagne, cible
 * uniquement les processus dont la ligne de commande contient le prefixe
 * de repertoire temporaire propre a Playwright (aucun usage legitime hors
 * de cet outil de test ne porte ce nom).
 */
function balayageFinalChromeOrphelins() {
  try {
    const avant = spawnSync('pgrep', ['-f', 'playwright_chromiumdev_profile']).stdout.toString().trim();
    const pids = avant ? avant.split('\n').filter(Boolean) : [];
    if (pids.length) {
      console.log(`  (nettoyage : ${pids.length} processus Chrome de test residuels, SIGKILL)`);
      spawnSync('pkill', ['-9', '-f', 'playwright_chromiumdev_profile']);
    }
  } catch (e) { /* pgrep/pkill absents (hors macOS/Linux) : rien a faire */ }
}

async function executerFileAttente(fiches, jobs, corps) {
  const resultats = [];
  let idx = 0;
  let actifs = 0;
  return new Promise((resolveAll) => {
    function lancerSuivant() {
      if (idx >= fiches.length && actifs === 0) { resolveAll(resultats); return; }
      while (actifs < jobs && idx < fiches.length) {
        const fiche = fiches[idx++];
        actifs++;
        const t0 = Date.now();
        process.stdout.write(`  -> ${fiche.famille}/${fiche.nom}...\n`);
        lancerFiche(fiche, corps).then((r) => {
          actifs--;
          const t = ((Date.now() - t0) / 1000).toFixed(1);
          process.stdout.write(`  <- ${fiche.famille}/${fiche.nom} : ${r.statut} (${t}s)\n`);
          resultats.push(r);
          lancerSuivant();
        });
      }
    }
    lancerSuivant();
  });
}

// ---------------------------------------------------------------------
// Comparaison / reference
// ---------------------------------------------------------------------

// Champs conserves dans la reference VERSIONNEE : uniquement des nombres,
// statuts, noms de fichiers, et messages d'avertissement/erreur de
// l'APPLICATION (jamais de contenu de fiche -- verifie : ces messages ne
// citent que des labels generiques "tableau/boite/image/bloc de texte" et
// des tailles en pt, cf. 03-layout-engine.js). `glyphes_absents` (les
// caracteres eux-memes) est volontairement EXCLU de la reference par
// prudence -- seul le compte `n_glyphes_absents` y figure.
const CHAMPS_REFERENCE = [
  'nom', 'famille', 'fichier', 'statut', 'duree_s', 'corps',
  'pages', 'pagesApercu', 'pagesSource', 'remplissage',
  'couverture', 'ordre', 'duplication',
  'debordement_cadre', 'debordement_zone_utile', 'debordement_dom_over',
  'contraste_min', 'n_sous_contraste', 'n_lignes_contraste_mesurees',
  'n_glyphes_absents',
  'corps_min', 'n_sous_20pt', 'med_car_ligne',
  'n_erreurs_js', 'erreurs_js',
  'n_avertissements', 'avertissements_5premiers', 'n_avert_dernier_recours',
];

function versReference(metrics) {
  const out = {};
  for (const c of CHAMPS_REFERENCE) if (c in metrics) out[c] = metrics[c];
  return out;
}

// Sens de regression (§0.2 du plan). Retourne une liste de textes courts.
function regressions(ref, cur) {
  const pb = [];
  const num = (x) => (typeof x === 'number' ? x : null);
  if (num(ref.couverture) !== null && num(cur.couverture) !== null && cur.couverture < ref.couverture - 1e-9)
    pb.push(`couverture ${ref.couverture} -> ${cur.couverture} (baisse)`);
  if (num(ref.ordre) !== null && num(cur.ordre) !== null && cur.ordre < ref.ordre - 0.02)
    pb.push(`ordre ${ref.ordre} -> ${cur.ordre} (baisse > 0,02)`);
  if (num(ref.duplication) !== null && num(cur.duplication) !== null && cur.duplication > ref.duplication + 1e-9)
    pb.push(`duplication ${ref.duplication} -> ${cur.duplication} (hausse)`);
  const debRef = (ref.debordement_cadre || 0) + (ref.debordement_zone_utile || 0);
  const debCur = (cur.debordement_cadre || 0) + (cur.debordement_zone_utile || 0);
  if (debCur > debRef) pb.push(`debordement ${debRef} -> ${debCur} (hausse)`);
  if ((cur.n_sous_contraste || 0) > (ref.n_sous_contraste || 0))
    pb.push(`n_sous_contraste ${ref.n_sous_contraste} -> ${cur.n_sous_contraste} (hausse)`);
  if ((cur.n_glyphes_absents || 0) > (ref.n_glyphes_absents || 0))
    pb.push(`glyphes_absents ${ref.n_glyphes_absents} -> ${cur.n_glyphes_absents} (hausse)`);
  if ((cur.n_sous_20pt || 0) > (ref.n_sous_20pt || 0))
    pb.push(`n_sous_20pt ${ref.n_sous_20pt} -> ${cur.n_sous_20pt} (hausse)`);
  if (ref.statut === 'ok' && cur.statut !== 'ok')
    pb.push(`statut ok -> ${cur.statut} (regression)`);
  if (typeof ref.pages === 'number' && typeof cur.pages === 'number' && cur.pages > ref.pages + 1)
    pb.push(`pages ${ref.pages} -> ${cur.pages} (+${cur.pages - ref.pages}, > 1)`);
  return pb;
}

function estCible(fiche, cibleList) {
  if (!cibleList.length) return false;
  return cibleList.includes(fiche.nom) || cibleList.includes(fiche.famille);
}

// ---------------------------------------------------------------------
// Galerie (corpus/_sorties/index.html)
// ---------------------------------------------------------------------
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function fmtVal(v) { return Array.isArray(v) ? v.length : (v === null || v === undefined ? '-' : (typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(3)) : v)); }

function construireGalerie(resultats, referenceParDoc) {
  const parFamille = {};
  for (const r of resultats) { (parFamille[r.famille] = parFamille[r.famille] || []).push(r); }
  const familles = Object.keys(parFamille).sort();

  const regDocs = resultats
    .map((r) => ({ r, pb: referenceParDoc[r.nom] ? regressions(referenceParDoc[r.nom], r) : [] }))
    .filter((x) => x.pb.length > 0);

  const champsAffiches = ['statut', 'duree_s', 'pages', 'couverture', 'ordre', 'duplication', 'debordement_cadre', 'debordement_zone_utile', 'contraste_min', 'n_sous_contraste', 'n_glyphes_absents', 'corps_min', 'n_sous_20pt', 'med_car_ligne', 'n_avert_dernier_recours'];

  function ligneMetriques(r) {
    const ref = referenceParDoc[r.nom];
    return champsAffiches.map((c) => {
      const cur = fmtVal(r[c]);
      if (!ref) return `<td>${esc(cur)}</td>`;
      const rv = fmtVal(ref[c]);
      const pb = regressions(ref, r).some((t) => t.startsWith(c) || (c === 'debordement_cadre' && t.startsWith('debordement')) || (c === 'n_glyphes_absents' && t.startsWith('glyphes_absents')));
      const diff = String(rv) !== String(cur) ? ` <span class="ref">(${esc(rv)} -> )</span>` : '';
      return `<td class="${pb ? 'regression' : ''}">${esc(cur)}${diff}</td>`;
    }).join('');
  }

  // Vignette cliquable -> rendu complet (~110dpi) dans un nouvel onglet.
  function vignette(dossierRel, base, alt) {
    const mini = `${dossierRel}/${base}.png`;
    const complet = `${dossierRel}/${base}-complet.png`;
    return `<a href="${complet}" target="_blank" rel="noopener"><img loading="lazy" src="${mini}" alt="${esc(alt)}" title="cliquer pour la taille lisible (~110dpi)"></a>`;
  }

  function tableauContraste(r) {
    const lignes = r.lignes_sous_contraste;
    if (!lignes || !lignes.length) return '';
    const rows = lignes.map((l) => `<tr><td>${l.page}</td><td>${l.x_pt}</td><td>${l.y_pt}</td><td>${l.ratio}</td>` +
      `<td style="background:rgb(${l.encre_rgb.join(',')})">&nbsp;</td><td>${l.encre_rgb.join(',')}</td>` +
      `<td style="background:rgb(${l.fond_rgb.join(',')})">&nbsp;</td><td>${l.fond_rgb.join(',')}</td>` +
      `<td>${esc(l.texte_debut)}</td></tr>`).join('');
    return `<details class="contraste-detail"><summary>${lignes.length} ligne(s) sous le seuil de contraste (4,5:1) -- detail</summary>
    <table class="metriques"><tr><th>page</th><th>x_pt</th><th>y_pt</th><th>ratio</th><th>encre</th><th>rgb</th><th>fond</th><th>rgb</th><th>debut du texte</th></tr>${rows}</table>
    </details>`;
  }

  function blocDoc(r) {
    const dir = path.join(SORTIES, r.famille, r.nom);
    const dossierRel = `${r.famille}/${r.nom}`;
    const srcPng = fs.existsSync(path.join(dir, 'source-p1.png')) ? vignette(dossierRel, 'source-p1', 'source') : null;
    const nAdaptPages = r.pages || 0;
    const adaptImgs = [];
    for (let i = 1; i <= Math.min(nAdaptPages, 12); i++) {
      const f = path.join(dir, `adapte-p${i}.png`);
      if (fs.existsSync(f)) adaptImgs.push(vignette(dossierRel, `adapte-p${i}`, 'page adaptee'));
    }
    return `
<section class="doc" id="doc-${esc(r.nom)}">
  <h3>${esc(r.famille)} / ${esc(r.nom)} <span class="statut statut-${esc(r.statut)}">${esc(r.statut)}</span></h3>
  <div class="colonnes">
    <div class="miniatures src">
      <p>Source (clic = taille lisible)</p>
      ${srcPng || '<p class="manque">(aucune image)</p>'}
    </div>
    <div class="miniatures adapte">
      <p>Adapte (${nAdaptPages} page(s), clic = taille lisible)</p>
      ${adaptImgs.join('') || '<p class="manque">(aucune sortie)</p>'}
    </div>
    <table class="metriques">
      <tr>${champsAffiches.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>
      <tr>${ligneMetriques(r)}</tr>
    </table>
  </div>
  ${tableauContraste(r)}
  ${r.fatal ? `<p class="fatal">${esc(r.fatal)}</p>` : ''}
</section>`;
  }

  const sectionsRegression = regDocs.length
    ? `<section class="regressions"><h2>Regressions (${regDocs.length})</h2><ul>${regDocs.map(({ r, pb }) => `<li><a href="#doc-${esc(r.nom)}">${esc(r.famille)}/${esc(r.nom)}</a> : ${pb.map(esc).join(' ; ')}</li>`).join('')}</ul></section>`
    : `<section class="regressions"><h2>Regressions</h2><p>Aucune regression detectee.</p></section>`;

  const sectionsFamille = familles.map((f) => `
<section class="famille">
  <h2>${esc(f)} (${parFamille[f].length} fiche(s))</h2>
  ${parFamille[f].map(blocDoc).join('\n')}
</section>`).join('\n');

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<title>Galerie corpus -- adaptateur-pdf-luciole</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;padding:1rem 2rem;background:#f7f7f7;color:#111}
h1{margin-top:0}
nav a{margin-right:1rem}
section.famille{margin-bottom:2rem}
section.doc{background:#fff;border:1px solid #ddd;border-radius:6px;padding:1rem;margin:1rem 0}
.statut{padding:.1rem .5rem;border-radius:4px;font-size:.8rem;margin-left:.5rem}
.statut-ok{background:#d4f4dd}
.statut-erreur-js,.statut-plantage,.statut-delai-depasse,.statut-sans-sortie{background:#f8d0d0}
.colonnes{display:flex;gap:1rem;flex-wrap:wrap;align-items:flex-start}
.miniatures{max-width:220px}
.miniatures img{max-width:200px;border:1px solid #ccc;display:block;margin-bottom:.3rem}
.metriques{border-collapse:collapse;font-size:.78rem;flex:1;min-width:400px}
.metriques th,.metriques td{border:1px solid #ddd;padding:.2rem .4rem;text-align:right}
.metriques th{background:#eee}
.regression{background:#ffd7d7;font-weight:bold}
.ref{color:#888;font-weight:normal}
.regressions{background:#fff3f3;border:1px solid #e8b4b4;border-radius:6px;padding:1rem}
.fatal{color:#a00;font-size:.85rem;white-space:pre-wrap}
.manque{color:#999;font-style:italic}
.contraste-detail{margin-top:.6rem;font-size:.78rem}
.contraste-detail table td,.contraste-detail table th{padding:.15rem .35rem}
</style></head>
<body>
<h1>Galerie corpus -- adaptateur-pdf-luciole (${resultats.length} fiches)</h1>
<p>Generee le ${esc(new Date().toISOString())}. Local uniquement, non versionnee.</p>
${sectionsRegression}
${sectionsFamille}
</body></html>`;
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = chargerManifest();
  let fiches = manifest.fiches;
  if (args.only) fiches = fiches.filter((f) => args.only.includes(f.nom));
  if (args.famille) fiches = fiches.filter((f) => f.famille === args.famille);
  if (!fiches.length) { console.error('Aucune fiche selectionnee.'); process.exitCode = 1; return; }

  fs.mkdirSync(SORTIES, { recursive: true });
  console.log(`Campagne corpus : ${fiches.length} fiche(s), ${args.jobs} job(s) en parallele, corps ${args.corps}pt, delai max ${DELAI_MAX_MS / 1000}s/fiche.`);
  const t0 = Date.now();
  const resultats = await executerFileAttente(fiches, args.jobs, args.corps);
  const dureeTotale = (Date.now() - t0) / 1000;
  console.log(`\nCampagne terminee en ${dureeTotale.toFixed(1)}s.`);
  balayageFinalChromeOrphelins();

  resultats.sort((a, b) => (a.famille + a.nom).localeCompare(b.famille + b.nom));
  const parStatut = {};
  for (const r of resultats) parStatut[r.statut] = (parStatut[r.statut] || 0) + 1;
  console.log('Statuts :', JSON.stringify(parStatut));

  const campagne = { genere: new Date().toISOString(), duree_totale_s: Number(dureeTotale.toFixed(1)), jobs: args.jobs, corps: args.corps, nb: resultats.length, parStatut, fiches: resultats };
  fs.writeFileSync(path.join(SORTIES, 'metrics.json'), JSON.stringify(campagne, null, 2));

  // Reference existante (pour la galerie ET --compare).
  let reference = { fiches: [] };
  if (fs.existsSync(REFERENCE)) {
    try { reference = JSON.parse(fs.readFileSync(REFERENCE, 'utf8')); } catch (e) { console.error('Reference illisible :', e.message); }
  }
  const referenceParDoc = Object.fromEntries((reference.fiches || []).map((f) => [f.nom, f]));

  // Galerie (toujours regeneree, meme lot partiel).
  const html = construireGalerie(resultats, referenceParDoc);
  fs.writeFileSync(path.join(SORTIES, 'index.html'), html);
  console.log(`Galerie : ${path.join(SORTIES, 'index.html')}`);

  if (args.updateReference) {
    const nouvelleRef = { genere: new Date().toISOString(), fiches: resultats.map(versReference) };
    fs.mkdirSync(path.dirname(REFERENCE), { recursive: true });
    fs.writeFileSync(REFERENCE, JSON.stringify(nouvelleRef, null, 2));
    console.log(`Reference ecrite : ${REFERENCE} (${nouvelleRef.fiches.length} fiches)`);
  }

  if (args.compare) {
    if (!reference.fiches || !reference.fiches.length) {
      console.error('Aucune reference a comparer (corpus/_reference/metrics.json absent ou vide).');
      process.exitCode = 1;
      return;
    }
    const cassees = [];
    for (const r of resultats) {
      const ref = referenceParDoc[r.nom];
      if (!ref) continue; // nouvelle fiche, rien a comparer
      const pb = regressions(ref, r);
      if (pb.length && !estCible({ nom: r.nom, famille: r.famille }, args.cible)) {
        cassees.push({ nom: r.nom, famille: r.famille, pb });
      }
    }
    if (cassees.length) {
      console.error(`\nREGRESSIONS detectees sur ${cassees.length} fiche(s) (hors --cible) :`);
      for (const c of cassees) console.error(`  - ${c.famille}/${c.nom} : ${c.pb.join(' ; ')}`);
      process.exitCode = 1;
    } else {
      console.log('\nAucune regression (hors --cible). --compare OK.');
    }
  }
}

main().catch((e) => { console.error('ERREUR FATALE', e); process.exitCode = 1; });
