# Décisions en vigueur

Une ligne par décision **encore appliquée** aujourd'hui. Ne reprend pas le
texte des fiches du corpus. Historique complet des essais et correctifs :
`docs/archive/PLAN-adaptateur-pdf-luciole.md` (addenda 1-6) et
`docs/archive/CADRAGE-Z12.md` (Z12). Ces documents, comme `docs/PLAN-v0.3.md`,
sont locaux et non publiés (ils citent les fiches du corpus).

| ID | Décision | Source (addendum/section) |
|---|---|---|
| Z1 | Sortie fidèle à la mise en page par **blocs** (tableaux/encadrés/colonnes/images conservés), pas un reflow linéaire 1-colonne | `docs/archive/PLAN-adaptateur-pdf-luciole.md` §Z1 |
| Z1 | PDF texte natif prioritaire ; **OCR gelé** (code conservé dans `02-ocr-pipeline.js`, non retravaillé) | `docs/archive/PLAN-adaptateur-pdf-luciole.md` §Z1 |
| Z9 | Sortie **paginée en A4** : un contenu plus haut qu'une page est scindé entre pages (boîtes et tableaux compris, cf. Z12 B1) | `docs/archive/PLAN-adaptateur-pdf-luciole.md` §Z9 ; `docs/archive/CADRAGE-Z12.md` Lot B |
| Z2 | Plancher de corps de police **20 pt** (jamais en dessous), plage exposée 20-24 pt, 24 pt par défaut | `docs/archive/PLAN-adaptateur-pdf-luciole.md` §Z2 |
| Z3 | Contenu secondaire (titres, en-têtes/pieds non essentiels, notes) **détecté et conservé en mémoire**, jamais supprimé silencieusement à l'extraction ; inclusion/exclusion = décision d'affichage (case à cocher), pas d'extraction | `docs/archive/PLAN-adaptateur-pdf-luciole.md` §Z3 |
| Z8 | Largeur de sortie **fixe** (format A4 du réglage d'orientation), indépendante de la taille de police ; seule la hauteur des blocs grandit pour absorber le texte reflowé | `docs/archive/PLAN-adaptateur-pdf-luciole.md` §Z8 |
| Z8 | Largeur minimale garantie par colonne/boîte = largeur du mot le plus long qu'elle contient (`widestTokenWidth`), jamais retirée à une autre colonne | `docs/archive/PLAN-adaptateur-pdf-luciole.md` §Z8 |
| A1 | Une boîte de contenu est remise en page sur la **largeur utile** de la page (comme les tableaux) ; elle garde son identité visuelle (cadre, fond, bordure, coins) mais sa géométrie est recalculée | `docs/archive/CADRAGE-Z12.md` §3, Lot A |
| — | Sortie = empilement vertical à une colonne ; le placement de conteneurs côte à côte n'est pas supporté | `docs/archive/PLAN-adaptateur-pdf-luciole.md` §Z4/Z6/Z10 ; `docs/archive/CADRAGE-Z12.md` §3 A1 |
| E1 | Exemplaires multiples à découper (fiches d'exercices) : **une seule version** conservée | `docs/PLAN-v0.3.md` §5 |
| E2 | Cartes mentales : **reconstruites en texte** dans la police Luciole agrandie, pas en image | `docs/PLAN-v0.3.md` §5 |
| E3 | L'élève **n'écrit pas** sur la feuille imprimée : pas d'espace d'écriture à dimensionner, les lignes d'écriture pointillées ne sont pas restituées | `docs/PLAN-v0.3.md` §5 |
| E4 | Tableaux de conjugaison larges : page A4 **paysage**, 3 verbes par page, corps **20 pt** ; chaque tableau doit tenir entier sur sa page | `docs/PLAN-v0.3.md` §5 |
| E9 | **Aucun italique**, nulle part (aperçu et PDF) ; l'italique reste capté à l'extraction mais n'est jamais rendu | `docs/PLAN-v0.3.md` §5 |
| E5 (défaut) | Mode N&B : marquer ce que la couleur signalait par du **gras** (+ souligné si déjà gras) | `docs/PLAN-v0.3.md` §5 |
| E6 (défaut) | Mascottes conservées en petite icône à côté de leur libellé | `docs/PLAN-v0.3.md` §5 |
| E7 (défaut) | Paysage page par page, réservé aux tableaux larges (E4) ; les cartes reconstruites restent en portrait | `docs/PLAN-v0.3.md` §5 |
| E8 (défaut) | En-têtes de collection et pastilles de numéro : une ligne discrète en haut (« Orthographe 7 ») | `docs/PLAN-v0.3.md` §5 |
