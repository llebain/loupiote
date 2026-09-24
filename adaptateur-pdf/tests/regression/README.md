# Suite de non-régression (ADDENDUM 6, Z9)

Vérifie automatiquement, sur les fixtures `tests/fixtures/` et 3 documents
de référence du `corpus/` (racine du dépôt), que le pipeline (extraction →
mise en page par blocs → export PDF) ne régresse pas sur des invariants
structurels :

- aucune exception pendant l'extraction ou l'export,
- le PDF exporté est réellement exploitable (pages, texte présent),
- la **largeur de page reste fixe (A4)** quelle que soit la taille de
  police réglée — c'est le test qui aurait détecté le bug remonté par Loïc
  le 20/09/2026 ("la taille de la police fait juste un zoom", Addendum 6
  Z8) avant qu'il n'ait à le signaler lui-même,
- **aucune page de sortie ne dépasse la hauteur A4** (pagination réelle,
  Addendum 6 Z9),
- la **marge de page n'est jamais nulle** (bug réel trouvé en implémentant
  la pagination : le premier item de chaque page collait au bord),
- les documents `10_FicheOrtho.pdf` / `Sq4_Fiche1_lire_recettes.pdf` /
  `2_Memo_Carte_indiv1.pdf` produisent bien des blocs de type boîte/tableau
  (pas un simple flux de texte qui aurait perdu toute mise en forme).

## Usage

```bash
cd tests
python3 make_fixtures.py   # fixtures regenerees (fpdf2 + Pillow), non versionnees
cd regression
npm install   # une seule fois
npm test      # run.mjs (invariants) puis v03.mjs (tests v0.3)
```

Sur un clone du depot public, les 3 fiches du corpus sont absentes : leurs
tests sont ignores, avec un message (`CORPUS_OBLIGATOIRE=1` en fait un echec).
Tous les scripts pilotant Chrome acceptent `CHROME_PATH=/chemin/chrome` a la
place du Chrome installe (`channel: 'chrome'`).

## Tests v0.3 (`v03.mjs`, `v03-navigateur.mjs`)

`tests/fixtures_v03.py` fabrique une fixture par defaut du diagnostic v0.3
(`docs/DIAGNOSTIC-v0.3.md`, local), en PDF « brut » (flux de contenu ecrit a
la main) pour reproduire exactement le MECANISME observe sur les fiches, sans
en reprendre le texte : couleur d'une case qui fuit sur le texte (R2), trous
et titres pales (C1), etoile/fleche/ciseaux absents de Luciole (R4),
exposants (R5), italique (E9), runs desynchronises du texte (R1, cause des
gels), mot en deux couleurs coupe en fin de ligne (W1), faux tableaux (S6),
exemplaires separes par des lignes de decoupe (E1), tableau de conjugaison
large (E4), liste sans puce, pastille de numero (E8), transformations
imbriquees. Chaque test de `v03.mjs` echouait avant son correctif (129 echecs
sur le code du 23/09/2026), chaque fixture est rejouee a 24 pt, 20 pt N&B et
32 pt jaune/bleu, avec des invariants communs (A4 portrait ou paysage, aucun
debordement, aucun italique, contraste >= 4,5:1, aucun glyphe absent, aucun
`[garde-fou]` declenche).

`v03-navigateur.mjs` rejoue une partie de ces fixtures dans le vrai livrable
sous Chrome (images et mascottes en icone, apercu paysage, erreurs JS,
requetes reseau, fichiers corrompu / protege par mot de passe). `SHOTS=1`
ajoute des captures dans `sorties-visuelles/`.

`dump.mjs` : outil de diagnostic (blocs, tableaux, regions, lignes de sortie
d'un PDF), a ne pas utiliser pour produire quoi que ce soit de publie a
partir d'une fiche du corpus.

**Limite** : ces fixtures ne remplacent pas `npm run corpus -- --compare` sur
les 43 fiches (plan v0.3, §0 et §9) -- elles prouvent qu'un mecanisme est
corrige, pas qu'aucune fiche ne regresse.

## Ce que cette suite NE remplace PAS

Ces vérifications portent sur des **invariants structurels automatisables**
(dimensions, présence de contenu, absence de plantage) -- **pas** sur la
qualité visuelle fine. Plusieurs bugs réels de cette session (chevauchement
de texte dans une cellule trop étroite, élément mal placé dans l'ordre de
lecture, table "pas propre") n'étaient visibles qu'à l'œil humain sur un
rendu réel. Avant de livrer un changement touchant `01-extract-native.js`
ou `03-layout-engine.js`, reconstruire le fichier (`python3 build.py`) et
vérifier visuellement au moins `10_FicheOrtho.pdf` dans un navigateur --
cette suite est un filet de sécurité, pas un remplacement de cette
vérification.

## Pourquoi des dépendances npm ici, alors que l'outil livré n'en a aucune

`adaptateur-pdf-luciole.html` reste un fichier unique, hors ligne, sans
dépendance réseau à l'exécution (voir README du projet) -- ça ne change
pas. `pdfjs-dist` et `jspdf` ici ne servent qu'à FAIRE TOURNER LES TESTS en
local ; ils ne sont jamais embarqués dans le fichier livré (`build.py` lit
les vraies bibliothèques vendues dans `assets/vendor/`, pas celles-ci).

## Limite du harnais (`harness.mjs`)

Tourne en Node pur, sans navigateur : `extractImageBlocksForPage()`
s'appuie sur `document.createElement('canvas')` / `page.render()`, absents
ici -- elle échoue silencieusement (comportement déjà "best-effort" du code
source), donc aucun bloc `image` n'est produit sous ce harnais. Sans impact
sur les invariants vérifiés ici, mais une vérification visuelle des images
nécessite un vrai navigateur.

## Outil de corpus (`npm run corpus`, PLAN-v0.3.md §0.2)

Pilote le **vrai livrable** dans Chrome sur les 43 fiches de `corpus/`,
exporte le PDF par le bouton « Télécharger », relit ce PDF (et la source)
avec pdf.js **dans Chrome** (contraste, débordement, glyphes absents de
Luciole, couverture/duplication de mots, corps minimal...), et produit une
galerie locale `corpus/_sorties/index.html` (source | adapté, métriques,
différentiel vs référence).

```bash
node corpus-manifeste.mjs        # regénère corpus/manifest.json (gitignore)
node corpus.mjs                  # campagne complète (43 fiches, ~4 min)
node corpus.mjs --only 07_FicheOrtho,03_ExercicesAuto
node corpus.mjs --famille F2
node corpus.mjs --update-reference   # écrit corpus/_reference/metrics.json (versionné)
node corpus.mjs --compare            # code ≠ 0 si régression (hors --cible)
node corpus.mjs --compare --cible 12_Tableau_indiv,F4
node corpus.mjs --jobs 6 --corps 20
```

Un **processus Node isolé par fiche** (`corpus-un-doc.mjs`), 4 en
parallèle par défaut (`--jobs`), délai maximal 90 s : à l'échéance, le
parent (`corpus.mjs`) tue tout le **groupe** de processus
(`process.kill(-pid, 'SIGKILL')`, le child étant lancé `detached: true`)
pour ne laisser aucun Chrome orphelin même si le thread JS de la page est
totalement figé (gel R1 -- vérifié : un timeout Playwright côté Node seul
ne suffit pas toujours dans ce cas, la commande reste bloquée en attente
du renderer).

`corpus/_reference/metrics.json` est **versionné** (seule exception au
`.gitignore` de `corpus/`) : uniquement des nombres, statuts, noms de
fichiers et messages d'avertissement de l'application (génériques,
jamais de contenu de fiche). Tout le reste de `corpus/` (manifeste, PDF,
sorties, PNG) reste local et gitignoré.
