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
  **1,52 %** — voir `tests/spike-notes.md` section 9.
- **Détection d'italique non tentée sur le texte OCRisé.** Le moteur LSTM
  de tesseract.js ne fournit pas d'attribut de style fiable (`font_name`
  vide en pratique). Conformément à la consigne « mieux vaut du romain que
  du faux italique », aucune tentative n'est faite : le texte OCRisé sort
  toujours en romain, même si la source contient des passages en italique.
  Le texte **natif** (PDF texte, non scanné) conserve en revanche le gras et
  l'italique d'origine.
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
- **Mise en page d'origine non conservée, par choix.** *(Décision rouverte le
  19/09/2026, voir Addendum 6 du plan — en cours de refonte vers une
  reconstruction par blocs qui conserve tableaux/encadrés/colonnes/images.
  Cette limite ne décrit encore que le comportement actuel, pas la cible.)*
  L'outil refait un flux linéaire une colonne (Phase 2 du plan de
  conception), pas un fac-similé de la mise en page source.
- **Ordre de lecture multi-colonnes** : fonctionne sur les cas testés
  (deux colonnes franches, gouttière nette) via un histogramme des
  abscisses de début de ligne. Une mise en page à plus de deux colonnes ou
  sans gouttière nette n'est pas prise en charge et sera lue comme une
  colonne unique.
- **Double page** : la détection de gouttière centrale et l'ordonnancement
  par folio OCRisé fonctionnent sur le document de référence (voir
  `tests/spike-notes.md`). Sur un document sans folio lisible, l'outil se
  rabat sur l'ordre gauche-puis-droite et le signale explicitement.
- **Limite de taille de fichier PDF déposé** : 300 Mo (au-delà, message
  d'erreur explicite plutôt qu'un plantage silencieux).
- **Performance** : un document scanné long (dizaines de pages) avec double
  page et OSD peut prendre plusieurs minutes (OCR + détection d'orientation
  + folio, page par page). Une barre de progression informe de l'avancement.

## Ce qui a été vérifié / ce qui ne l'a pas été

Voir le rapport final transmis séparément pour le détail complet. En résumé :
vérifié sur un fichier réel représentatif (scan de livre jeunesse, double
page, rotation, folios, dialogues, italiques, césures) et sur six fixtures
synthétiques (hiérarchie de titres/gras/italique/listes, deux colonnes,
scan simple, en-tête/pied répétés, images, page dense), plus deux fixtures
d'erreur (mot de passe, fichier corrompu). Non vérifié à ce stade :
compatibilité Firefox/Safari (seul Chrome/Chromium a pu être testé dans cet
environnement), documents de plus de quelques dizaines de pages, mises en
page à plus de deux colonnes, PDF avec formulaires ou couches OCR
partiellement correctes (au lieu de totalement inexploitables ou
totalement fiables).

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
| **pdf.js** (`pdfjs-dist@3.11.174`, patché — voir `tests/spike-notes.md` §1) | Apache-2.0 | Mozilla |
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
    make_fixtures.py            # genere les fixtures de test
    fixtures/                   # PDF de test (generes + fichiers d'erreur)
    verify.sh                   # controles automatises sur un PDF produit
    spike-notes.md              # notes techniques du spike de faisabilite (Phase 0)
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

**Limite restante sur les listes** : les items sans puce textuelle sont
agglomérés en paragraphes continus au lieu de rester un par ligne. Une liste de
valise se lit donc comme un bloc de prose. Non corrigé.

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

| Fichier | État | Hors-vocabulaire |
|---|---|---|
| `adaptateur-pdf-luciole.html` (livré) | = addendum 4 | **5,32 %** |
| `docs/archive/html-anciens/adaptateur-pdf-luciole.v-addendum5.html` | tentative suivante, **moins bonne** | 6,88 % |
| — (non conservé) | première version | 5,07 % |

Trois sessions de correctifs successives n'ont pas amélioré les indicateurs
globaux : chaque heuristique corrigeant un symptôme en créait un autre. Le
livrable est donc revenu à l'état addendum 4.

**Mise à jour (périmé depuis Z6)** : la mise en garde ci-dessus datait d'un
état intermédiaire où `src/` contenait la tentative « addendum 5 » (moins
bonne). Ce n'est plus le cas : depuis Z6, `adaptateur-pdf-luciole.html` est
systématiquement **reconstruit depuis `src/` par `build.py`**, et `src/`
correspond bien au livrable (vérifié à chaque session : `python3 build.py`
puis `git diff` sur le HTML généré ne doit rien montrer). L'essai
« addendum 5 » n'a jamais été fusionné dans `src/` ; sa copie archivée reste
consultable dans `docs/archive/html-anciens/`, à titre historique
uniquement.

### Piste recommandée si le travail reprend

Rendre l'aperçu **modifiable** avant export, et générer le PDF depuis le texte
corrigé. Une vingtaine de corrections manuelles donnent 100 % de justesse, là où
aucune heuristique automatique n'a dépassé ~95 % sans casser autre chose. Cette
approche supprime aussi le besoin de correction automatique, dont le risque —
introduire du faux texte indétectable dans un document scolaire — reste le plus
sérieux du projet.
