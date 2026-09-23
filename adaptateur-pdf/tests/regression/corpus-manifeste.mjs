// Genere corpus/manifest.json (non versionne, gitignore) a partir des PDF
// presents dans corpus/{F1..F4,divers}. Reproductible : relance = meme
// resultat (pagesSource relu a chaque fois avec pdfjs, capacites recalculees
// depuis les regles ci-dessous qui recopient le tableau §4 du plan).
//
// Usage : node corpus-manifeste.mjs   (depuis tests/regression/)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(__dirname, '../../../corpus');
const require = createRequire(import.meta.url);
const { getDocument } = require('pdfjs-dist/legacy/build/pdf.js');

const FAMILLES = [
  { dossier: 'F1-ortho-fiches', famille: 'F1' },
  { dossier: 'F2-ortho-exercices', famille: 'F2' },
  { dossier: 'F3-grammaire-cartes', famille: 'F3' },
  { dossier: 'F4-grammaire-tableaux', famille: 'F4' },
  { dossier: 'divers', famille: 'divers' },
];

// Capacites de base par famille (colonne "Familles" du tableau §4 du plan :
// une capacite est incluse pour une famille si cette famille apparait dans
// sa colonne). R1 (gel/plantage), S3 (rotation) et X4 (tableau a remplir)
// ne s'appliquent qu'a des documents precis (colonne "Docs" = decompte
// restreint) : traites a part ci-dessous, PAS ici.
const CAPACITES_PAR_FAMILLE = {
  F1: ['R3', 'R6', 'S4', 'M4', 'M5', 'L1', 'L2'],
  F2: ['R2', 'R3', 'R4', 'S1', 'S2', 'S4', 'X1', 'X2', 'X3', 'M1', 'L1', 'L2'],
  F3: ['R3', 'R4', 'R5', 'S1', 'S5', 'M1', 'M2', 'M3', 'M4', 'M5', 'L1', 'L2', 'D1'],
  F4: ['R4', 'R5', 'S1', 'S5', 'T1', 'T2', 'M5', 'L1', 'L2'],
  divers: ['L1'],
};

// Regles document-precises (§3/§4 du plan) qui ajoutent une capacite non
// deductible de la seule famille.
const CAPACITES_PAR_DOC = {
  // R1 -- les 9 fiches "sans sortie" du constat de depart (§3).
  '4_Memo_Carte_indiv': ['R1'],
  '9_Memo_Carte_indiv': ['R1'],
  '13_Memo_Tableau_indiv': ['R1'],
  '14_Memo_Tableau_indiv': ['R1'],
  '15_Memo_Tableau_indiv': ['R1'],
  '16_Memo_Tableau_indiv': ['R1'],
  '17_Memo_Tableau_indiv': ['R1'],
  '19_Memo_Tableau_indiv': ['R1'],
  '20_Memo_Tableau_indiv': ['R1'],
  // S3 -- contenu pivote a 90 deg (§2, §4).
  '14_Memo_Tableau_indiv_S3': null, // place-holder retire plus bas (evite doublon de cle)
  // X4 -- tableaux a remplir.
  '12_Tableau_indiv': ['S2', 'X4'],
  // D1 -- carte de 02_FicheOrtho (schema annote, F1), en plus des 12 de F3.
  '02_FicheOrtho': ['D1'],
};
// S3 ajoute separement (evite l'ecrasement de la cle '12_Tableau_indiv'
// au-dessus) :
for (const nom of ['14_Memo_Tableau_indiv', '15_Memo_Tableau_indiv', '18_Memo_Tableau_indiv']) {
  CAPACITES_PAR_DOC[nom] = [...(CAPACITES_PAR_DOC[nom] || []), 'S3'];
}
delete CAPACITES_PAR_DOC['14_Memo_Tableau_indiv_S3'];

async function pagesSourceDe(fichier) {
  const data = new Uint8Array(fs.readFileSync(fichier));
  const doc = await getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const n = doc.numPages;
  await doc.destroy();
  return n;
}

async function main() {
  const fiches = [];
  for (const { dossier, famille } of FAMILLES) {
    const dir = path.join(CORPUS, dossier);
    if (!fs.existsSync(dir)) continue;
    const pdfs = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
    for (const fichier of pdfs) {
      const nom = fichier.replace(/\.pdf$/i, '');
      const pagesSource = await pagesSourceDe(path.join(dir, fichier));
      const capacites = new Set(CAPACITES_PAR_FAMILLE[famille] || []);
      for (const c of CAPACITES_PAR_DOC[nom] || []) capacites.add(c);
      fiches.push({
        fichier,
        nom,
        dossier,
        famille,
        pagesSource,
        capacites: [...capacites].sort(),
        attendu: null,
      });
      process.stdout.write(`  ${famille}/${fichier} : ${pagesSource} page(s) source, capacites [${[...capacites].sort().join(', ')}]\n`);
    }
  }
  const manifest = { genere: new Date().toISOString(), nb: fiches.length, fiches };
  fs.writeFileSync(path.join(CORPUS, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nEcrit corpus/manifest.json (${fiches.length} fiches).`);
}

main().catch((e) => { console.error('ERREUR', e); process.exitCode = 1; });
