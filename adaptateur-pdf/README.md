# Adaptateur PDF — police Luciole

Outil **autonome et hors ligne**, en un seul fichier HTML
(`adaptateur-pdf-luciole.html`), qui remet en page un document PDF (texte
natif ou scanné) en gros caractères — police **Luciole**, conçue pour la
basse vision — et permet d'exporter le résultat en PDF où le texte reste du
**vrai texte** : sélectionnable, copiable, lisible par une synthèse vocale.

Destiné à un parent ou un enseignant qui adapte un document (school ou
personnel) pour un enfant malvoyant.

## Usage

1. Double-cliquer sur `adaptateur-pdf-luciole.html` pour l'ouvrir dans un
   navigateur (testé avec Chrome/Chromium récent). **Aucune connexion
   internet requise**, aucune installation.
2. Déposer un PDF dans la zone prévue, ou cliquer sur « Choisir un fichier ».
3. Ajuster les réglages (taille, interligne, contraste, espacement,
   images, orientation, double page) dans le panneau latéral — l'aperçu se
   met à jour immédiatement.
4. Cliquer sur « Télécharger le PDF adapté », ou « Imprimer » en filet de
   sécurité.

**Confidentialité** : le fichier déposé ne quitte jamais votre ordinateur.
Le traitement (lecture, OCR, mise en page, export) est intégralement local,
dans l'onglet du navigateur. Aucune requête réseau n'est émise pendant
l'exécution (vérifié par interception de toutes les requêtes lors des
tests : voir `tests/`).

## Usage réservé — ce que l'outil ne doit pas devenir

Voir la mention affichée en pied de chaque page de l'outil. Ce logiciel est
un outil d'**adaptation personnelle**, pas de diffusion : il ne contient
aucune fonction de partage, d'envoi, de publication, de téléversement ou de
sauvegarde distante, et ne doit pas en recevoir. Voir « Cadre légal »
ci-dessous.

## Limites connues

- **OCR imparfait.** La reconnaissance de texte sur les pages scannées est
  automatique mais pas infaillible ; une relecture est recommandée (l'outil
  le rappelle explicitement à l'écran). Sur le document de test de
  référence (roman jeunesse scanné, double page, rotation, folios), le taux
  d'erreur caractère mesuré sur un échantillon transcrit à la main est de
  **1,52 %** (notes techniques locales, non publiées : elles citent le
  document de référence).
- **Détection d'italique non tentée sur le texte OCRisé.** Le moteur LSTM
  de tesseract.js ne fournit pas d'attribut de style fiable (`font_name`
  vide en pratique). Conformément à la consigne « mieux vaut du romain que
  du faux italique », aucune tentative n'est faite : le texte OCRisé sort
  toujours en romain, même si la source contient des passages en italique.
- **Aucun italique, nulle part (décision E9, v0.3).** Le texte natif garde
  le gras d'origine ; l'italique est lu (il reste dans le modèle du
  document) mais toujours rendu en romain, dans l'aperçu comme dans le PDF.
- **Pages très illustrées (couverture, page de dédicace, en-tête de
  section décorative).** Tesseract peut « halluciner » du texte à partir
  d'un graphisme. Un filtre de qualité (identique à celui qui écarte la
  couche texte parasite d'un scanner, voir plus bas) rejette la plupart de
  ces faux textes, mais un texte de chapitre mêlé à un ornement graphique
  sur la même ligne peut occasionnellement laisser passer un fragment de
  bruit. L'image de la page est conservée dans tous les cas.
- **Extraction d'image best-effort.** Sur un PDF texte natif, les images
  sont recadrées à partir d'un rendu de page complet et de la matrice de
  transformation PDF ; les images pivotées ou cisaillées ne sont pas prises
  en charge (rare en pratique). Sur les pages scannées, l'« illustration »
  est approximée par la zone significative sous le dernier mot reconnu.
- **PDF non balisé (pas de PDF/UA).** jsPDF ne produit pas de PDF balisé :
  le texte est sélectionnable et vocalisable par un lecteur qui lit le flux
  de texte, mais la structure sémantique (titres, paragraphes) n'est pas
  exposée aux technologies d'assistance qui s'appuient sur le balisage.
  Acceptable pour l'usage visé (lecture visuelle agrandie), à dire et non
  cacher.
- **Mise en page par blocs, empilés verticalement.** Tableaux, encadrés et
  images sont conservés et remis en page sur la largeur de la page A4
  (décision Z1) ; des conteneurs côte à côte dans la source sont empilés
  l'un sous l'autre. Les cartes mentales ne sont pas encore reconstruites
  en texte (décision E2, lot 7 du plan, non commencé).
- **Ordre de lecture multi-colonnes** : fonctionne sur les cas testés
  (deux colonnes franches, gouttière nette) via un histogramme des
  abscisses de début de ligne. Une mise en page à plus de deux colonnes ou
  sans gouttière nette n'est pas prise en charge et sera lue comme une
  colonne unique.
- **Double page** : la détection de gouttière centrale et l'ordonnancement
  par folio OCRisé fonctionnent sur le document de référence (voir
  notes techniques locales). Sur un document sans folio lisible, l'outil se
  rabat sur l'ordre gauche-puis-droite et le signale explicitement.
- **Limite de taille de fichier PDF déposé** : 300 Mo (au-delà, message
  d'erreur explicite plutôt qu'un plantage silencieux).
- **Performance** : un document scanné long (dizaines de pages) avec double
  page et OSD peut prendre plusieurs minutes (OCR + détection d'orientation
  + folio, page par page). Une barre de progression informe de l'avancement.

## Ce qui a été vérifié / ce qui ne l'a pas été

Vérifié sur un fichier réel représentatif (scan de livre jeunesse, double
page, rotation, folios, dialogues, italiques, césures), sur les 43 fiches du
corpus v0.3 (outil `npm run corpus`, local), et sur des fixtures synthétiques
régénérables : hiérarchie de titres/gras/italique/listes, deux colonnes, scan
simple, en-tête/pied répétés, images, page dense, mascottes dans un tableau,
PDF protégé par mot de passe, fichier corrompu, et une fixture par défaut du
diagnostic v0.3 (`tests/fixtures_v03.py`).

**Compatibilité navigateurs.** Seul Chrome/Chromium est testé (automatiquement
et à l'œil). Firefox et Safari n'ont **pas** été essayés. Relecture du code :
la partie de l'outil n'utilise rien au-delà d'ES2019 (`flat`/`flatMap`,
expressions régulières Unicode `\p{…}`), disponible depuis Firefox 78 et
Safari 12. Les bibliothèques embarquées fixent le vrai plancher : pdf.js 3.11
demande un navigateur récent (Firefox ≥ 102, Safari ≥ 15 environ), l'OCR
(tesseract, WebAssembly SIMD) Safari ≥ 16.4. Le point le plus incertain est
Safari en `file://` : l'outil crée ses workers à partir d'URL `blob:`, ce que
Safari restreint parfois pour une page ouverte depuis le disque. À essayer
avant de le conseiller sur Mac/iPad.

Non vérifié : documents de plus de quelques dizaines de pages, mises en page à
plus de deux colonnes, PDF avec formulaires ou couches OCR partiellement
correctes. **Impression** (bouton « Imprimer ») : un document qui contient une
page paysage (tableau large, E4) s'imprime avec l'orientation du réglage
général ; le PDF téléchargé, lui, a bien ses pages paysage.

## Décisions v0.3 appliquées dans le rendu

| Décision | Ce que fait l'outil |
|---|---|
| E1 | Exemplaires identiques séparés par des lignes de découpe : un seul gardé (les autres restent dans le modèle, marqués en double) ; rien n'est fusionné à travers une ligne de découpe. |
| E3 | Lignes d'écriture pointillées : jamais restituées, jamais prises pour un tableau. |
| E4 / E7 | Tableau trop large pour la page portrait : page A4 **paysage**, corps 20 pt, 3 colonnes de données au plus par page, en-tête répété, colonne des pronoms retirée quand chaque forme la répète, titre repris avec « (1/3) ». Le reste du document reste en portrait. |
| E5 | Mode Noir & Blanc : un mot que la couleur distinguait dans sa phrase passe en gras (souligné s'il l'était déjà). |
| E6 | Petites images (mascottes) dans un tableau ou un encadré : icône à ~1,5 × le corps, à gauche de son libellé (au-dessus si la colonne est trop étroite). |
| E8 | Pastille de numéro : rattachée à l'en-tête de collection (« Orthographe 7 »). |
| E9 | Aucun italique. |
| C1 | Contraste : toute couleur de texte est gardée si elle atteint 4,5:1 sur le fond réellement derrière elle (page, encadré, cellule), sinon assombrie (ou éclaircie) en gardant sa teinte. |
| R4 | Caractères absents de Luciole remplacés à l'extraction (étoile → `*`, flèches → `→`, coches → `☑`), ciseaux retirés. |

**Mesure sur les 43 fiches (24/09/2026, `npm run corpus -- --compare`, 24 pt),
avant → après ces correctifs :**

| Famille | Pages | Texte retrouvé (couverture) | Lignes sous 4,5:1 | Remarque |
|---|---|---|---|---|
| F1 fiches d'orthographe | 3-5 → 3-4 | 0,94-1 (inchangé) | 5-8 → **0** | |
| F2 exercices | 6-9 → **2-3** | 0,82-0,96 → **0,89-1** | jusqu'à 63 → 0 (5 sur 2 fiches, trous) | glyphes absents 2 → 0, débordements divisés par 2 |
| F3 mémos carte | 2-6 → 2-6 | légère hausse | jusqu'à 39 → **0** | 4_Memo_Carte : 3 → 6 pages (cartes, lot 7) |
| F4 mémos tableau | 2-5 → 3-10 | 0,15-0,58 → **0,67-0,99** | jusqu'à 30 → 0-7 | pages paysage (E4) ; **duplication encore élevée sur 16, 17, 19** (≈ 0,5-0,6) |
| Sq4 | 11 → 12 | 1 | 8 → 0 | |

**Défauts connus restants** :
- F4 à plusieurs blocs de verbes (16, 17, 19) : sur les fiches réelles,
  une partie du tableau est encore dupliquée ou mal rangée (la réplique
  synthétique `v3-conjugaison-deux-blocs` passe, la géométrie réelle
  diffère) ;
- F4 pivotées (14, 15, 18) : contenu retrouvé mais mise en page médiocre,
  10 pages (lot 3, orientation, non commencé) ;
- F2 03 et 08 : ordre de lecture en légère baisse, lignes de trous encore
  pâles sur 2 fiches.

Non commencé : cartes mentales reconstruites (E2, lot 7), orientation des
contenus pivotés (lot 3), trous/cases/soulignés des exercices (lot 4), mots
encadrés et cerclés (lot 6), profils de collection (lot 8).

## Cadre légal — à lire avant usage au-delà du cercle familial

**Ceci n'est pas un avis juridique.**

L'adaptation d'une œuvre protégée au bénéfice d'une personne handicapée est
susceptible de relever de deux fondements différents selon qui l'effectue :

- **Article L.122-5, 7° du Code de la propriété intellectuelle** : dans sa
  lettre, ce texte vise la reproduction et la représentation réalisées par
  des **personnes morales et établissements ouverts au public**
  (bibliothèques, centres de documentation, associations et organismes
  inscrits sur la liste prévue par le texte), en vue d'une consultation
  strictement personnelle par des personnes handicapées.
- **Usage privé et familial** : l'adaptation faite **par un particulier
  pour un proche** (par exemple un parent pour son enfant) ne relève pas
  littéralement de l'exception ci-dessus ; elle s'appuie en pratique sur la
  tolérance de l'usage privé et familial.

Dans les deux cas, l'œuvre adaptée demeure protégée par le droit d'auteur
de ses ayants droit : l'outil ne doit servir qu'à un usage personnel, jamais
à la diffusion, au partage ou à la mise à disposition de tiers — c'est
pourquoi il ne comporte volontairement aucune fonction d'envoi ou de
publication. Si l'outil devait être utilisé au-delà d'un cadre familial
(établissement scolaire, association, mise en ligne), le libellé et le
fondement juridique mériteraient une validation par un professionnel du
droit.

## Crédits et licences

| Composant | Licence | Source |
|---|---|---|
| Police **Luciole** | CC BY 4.0 | Laurent Bourcellier & Jonathan Perez, projet porté par le CTRDV — [luciole-vision.com](https://www.luciole-vision.com/) |
| **pdf.js** (`pdfjs-dist@3.11.174`, patché pour charger son worker hors ligne — voir `src/00-lib-loader.js`) | Apache-2.0 | Mozilla |
| **jsPDF** (`jspdf@4.2.1`) | MIT | jsPDF contributors |
| **tesseract.js** (`7.0.0`) + **tesseract.js-core** (`7.0.0`, build `simd`, combiné legacy+LSTM) | Apache-2.0 | Tesseract.js / Tesseract OCR (Google, puis communauté) |
| **fra.traineddata**, **osd.traineddata** (`tessdata_fast`) | Apache-2.0 | tesseract-ocr/tessdata_fast |
| Liste de fréquence du français (`fr-2000.txt`, filtrée ≥ 3 caractères) | MIT | hermitdave/FrequencyWords (corpus OpenSubtitles) |

Mention de crédit Luciole reprise telle qu'affichée dans l'outil :
« Police Luciole © Laurent Bourcellier & Jonathan Perez, projet porté par le
CTRDV — Licence Creative Commons Attribution 4.0 International (CC BY 4.0). »

## Structure du projet

```
adaptateur-pdf/
  adaptateur-pdf-luciole.html   # LE LIVRABLE : fichier autonome
  build.py                      # assemble le HTML final depuis src/ + assets/
  src/                          # code source (JS, CSS, gabarit HTML)
  assets/                       # bibliotheques tierces et donnees (non livrees seules)
  tests/
    make_fixtures.py            # genere les fixtures de test (fpdf2 + Pillow)
    fixtures_v03.py             # fixtures v0.3 : une par defaut du diagnostic (PDF brut)
    fixtures/                   # PDF generes (non versionnes, cf. .gitignore)
    verify.sh                   # controles automatises sur un PDF produit
    regression/                 # suites de tests Node et Chrome, outil de corpus
```

Pour reconstruire le fichier après une modification de `src/` ou `assets/` :
`python3 build.py`.

---

## Limites connues sur les documents scannés (état au 19/09/2026)

L'outil suit deux chemins très différents selon l'entrée.

### PDF à texte natif — fiable depuis le correctif du 19/09/2026

Document exporté depuis un traitement de texte, manuel numérique, PDF généré.
Le texte est lu directement, **sans OCR**, donc sans erreur de reconnaissance.

**Bug corrigé le 19/09/2026 — perte silencieuse de contenu.** Le test de
qualité de la couche texte exigeait 35 % de mots reconnus dans une liste de
fréquence de 2000 mots. Ce seuil avait été calibré sur de la prose. Un document
fait de noms concrets — liste de courses, liste de valise, inventaire — score
16 à 30 %, était déclaré « inexploitable », basculé en OCR, et son contenu
perdu. Cas réel mesuré : 6 pages sur 9 rejetées, **69 % du texte disparu**, 6
pages blanches dans le PDF produit.

Le ratio de vocabulaire ne peut plus rejeter seul. Le rejet exige désormais
soit une longueur moyenne de token inférieure à 2,5, soit la conjonction d'un
fort taux de symboles et d'un vocabulaire très pauvre — c'est-à-dire la
signature mesurée d'une couche texte parasite de scanner (longueur 1,38,
22-30 % de symboles), et elle seule.

**Listes sans puce** (corrigé en v0.3) : une ligne qui s'arrête nettement avant
le bord droit du texte alors que le mot suivant y aurait tenu est un retour à la
ligne voulu : l'item suivant reste sur sa propre ligne au lieu d'être aggloméré
en prose. Un titre sur deux lignes n'est pas concerné.

### PDF scannés — dégradé, relecture indispensable

Mesure sur le fichier de référence (scan d'un roman
jeunesse illustré, double page, rotation 90°) :

| Indicateur | Valeur |
|---|---|
| Mots hors-vocabulaire sur 13 pages | **~5,3 %** (2 à 4 % attendus sur un texte propre) |
| CER, demi-page la plus nette | ~1,3 % |
| CER, demi-page dégradée | ~5 % |

Concrètement : une vingtaine de mots faux sur l'ensemble du livre, plus quelques
lignes de charabia. **Une relecture est nécessaire avant de remettre le document
à son destinataire.**

Défauts identifiés et non résolus :

1. **Charabia d'illustration.** Tesseract cherche du texte dans les dessins au
   trait et produit des lignes ineptes insérées dans le corps. Trois approches de
   filtrage ont été tentées ; toutes supprimaient aussi du texte réel. Le
   masquage des illustrations avant OCR (composantes connexes) est implémenté
   mais **désactivé** : il peignait en blanc des lignes de texte dont les
   ascendantes se touchent. Piste non essayée : la segmentation de page native
   de Tesseract.
2. **Confusions de lettres de forme voisine** (`J/l`, `t/i`, `b/h`, `c/r`) :
   `Jacquot→licquot`, `bien→hicn`, `télé→iclé`. Cause : hauteur de caractères
   trop faible, la page du livre de poche n'occupant qu'une fraction de la
   feuille A4 scannée.
3. **Troncature de première lettre** en bord de recadrage : `JACQUOT→ACQUOT`.
4. **Diacritiques hallucinés** : `Mais→Maïs`, `gobait→gobaït`.
5. **Titres de chapitre illustrés** non détectés comme titres.
6. **Jonction des demi-pages** : recollement de phrase partiel (2 cas sur 4).

### Historique des versions

Le livrable `adaptateur-pdf-luciole.html` est **toujours reconstruit depuis
`src/`** par `build.py` (depuis Z6) ; l'intégration continue vérifie qu'une
reconstruction ne change rien au fichier commité. L'OCR est gelé depuis
l'addendum 6 (Z1) : le code est conservé dans `02-ocr-pipeline.js` sans être
retravaillé, les mesures ci-dessus datent de cet état.

### Piste recommandée si le travail reprend

Rendre l'aperçu **modifiable** avant export, et générer le PDF depuis le texte
corrigé. Une vingtaine de corrections manuelles donnent 100 % de justesse, là où
aucune heuristique automatique n'a dépassé ~95 % sans casser autre chose. Cette
approche supprime aussi le besoin de correction automatique, dont le risque —
introduire du faux texte indétectable dans un document scolaire — reste le plus
sérieux du projet.
