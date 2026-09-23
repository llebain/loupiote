# Loupiote

Adaptateur de PDF pédagogiques pour élève basse vision (police Luciole,
corps et couleurs réglables). Détails produit et limites connues :
`adaptateur-pdf/README.md`. Plan en cours : `docs/PLAN-v0.3.md` (document de travail local, non publié :
il cite les fiches du corpus).

## Où est quoi

```
Loupiote/
  README.md                    # ce fichier
  .gitignore
  docs/
    PLAN-v0.3.md                # plan en cours (phases, lots) — local, non publié
    DECISIONS.md                 # décisions encore en vigueur, une ligne par décision
    archive/
      PLAN-adaptateur-pdf-luciole.md   # mémoire historique (addenda 1-6)
      CADRAGE-Z12.md                    # cadrage Z12 (clos)
      sorties-v0.1/                     # anciennes sorties de test (test/v0.1)
      html-anciens/                     # anciennes copies de l'outil (tentatives abandonnées)
  corpus/                       # NON VERSIONNÉ (sauf corpus/_reference/, cf. .gitignore) :
    manifest.json                # famille, pages, capacités requises (généré, gitignore)
    F1-ortho-fiches/            # 11 fiches d'orthographe
    F2-ortho-exercices/         # 10 fiches d'exercices autonomes
    F3-grammaire-cartes/        # 12 mémos "carte" (grammaire)
    F4-grammaire-tableaux/      # 9 mémos "tableau" (conjugaison)
    divers/                     # 1 fiche isolée (Sq4)
    scans-v0.1/                 # 2 scans sources historiques (v0.1)
    _reference/metrics.json      # VERSIONNÉ : métriques de référence (nombres/statuts seulement)
    _sorties/                    # généré par `npm run corpus` (PDF exportés, galerie, gitignore)
  adaptateur-pdf/               # l'outil : code source, build, tests
    adaptateur-pdf-luciole.html # LE LIVRABLE (fichier HTML autonome)
    build.py                    # reconstruit le livrable depuis src/
    src/                        # code source (JS, CSS, gabarit HTML)
    assets/                     # polices, bibliothèques tierces, données OCR
    tests/                      # fixtures, verify.sh, harnais de non-régression
```

Les 43 fiches du corpus (éditions Retz, un roman jeunesse scanné) sont des
œuvres protégées : elles restent sur le Mac, ne sont jamais poussées ni
publiées (règle détaillée dans `docs/PLAN-v0.3.md` §0, local).

## Lancer l'outil

Ouvrir `adaptateur-pdf/adaptateur-pdf-luciole.html` dans un navigateur
(Chrome/Chromium recommandé). Fichier autonome, aucune connexion réseau
requise à l'exécution.

Après une modification de `adaptateur-pdf/src/` ou `adaptateur-pdf/assets/` :

```bash
cd adaptateur-pdf && python3 build.py
```

## Lancer les tests

```bash
cd adaptateur-pdf/tests/regression
npm install          # une seule fois
npm test              # invariants structurels (harnais Node pur)
npm run test:visuel   # pilote le vrai livrable dans Chrome, invariants visuels
npm run corpus         # campagne complète sur les 43 fiches (galerie + métriques + régression)
```

Voir `adaptateur-pdf/tests/regression/README.md` pour le détail et les
limites de chaque suite.
