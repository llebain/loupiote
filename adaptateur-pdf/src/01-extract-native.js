/* ============================================================================
 * 01-extract-native.js
 * Extraction du texte natif d'un PDF (pdf.js) vers la Representation
 * Intermediaire (RI) : tableau de blocs { type, runs, srcPage }.
 * ==========================================================================*/

(function () {
  'use strict';

  const FR_WORDLIST = new Set(); // rempli au premier appel depuis ASSETS

  function ensureWordlist() {
    if (FR_WORDLIST.size) return FR_WORDLIST;
    const text = window.LibLoader.b64ToText(window.ASSETS.frWordlist);
    text.split('\n').forEach((w) => {
      w = w.trim().toLowerCase();
      if (w) FR_WORDLIST.add(w);
    });
    return FR_WORDLIST;
  }

  // --- Evaluation de la qualite d'une couche de texte PDF (ADDENDUM 3,
  // sections M-O -- remplace le seuil initial de la section B, insuffisant :
  // sur le fichier de reference, 92% des tokens de charabia scanner font
  // 1-2 caracteres, et une liste francaise en contient beaucoup (a, le, de,
  // il, on...), d'ou ~10% de reconnaissance ACCIDENTELLE du charabia avec le
  // seuil initial -- marge nulle. Regle corrigee : ne compter que les tokens
  // de 3 caracteres ou plus, des deux cotes du calcul.
  //   exploitable SI  longueur_moyenne_token           >= 3.0
  //               ET  ratio_reconnu (tokens >= 3 car.) >= 35%
  //               ET  ratio_symboles                   <= 15%
  // Mesure sur le fichier de reference : charabia 0-2% / vrai texte 70-75%.
  function assessTextQuality(text) {
    ensureWordlist();
    const allTokens = (text.match(/[A-Za-zÀ-ÖØ-öø-ÿ'-]+/g) || []);
    const nonAlnum = (text.match(/[^\p{L}\p{N}\s]/gu) || []).length;
    const totalChars = text.length || 1;
    const symbolRatio = nonAlnum / totalChars;

    if (allTokens.length === 0) {
      return { usable: false, frenchWordRatio: 0, symbolRatio, avgTokenLen: 0, tokenCount: 0 };
    }
    let lenSum = 0;
    for (const t of allTokens) lenSum += t.length;
    const avgTokenLen = lenSum / allTokens.length;

    const longTokens = allTokens.filter((t) => t.length >= 3);
    let frenchHits = 0;
    for (const t of longTokens) {
      if (FR_WORDLIST.has(t.toLowerCase())) frenchHits += 1;
    }
    const frenchWordRatio = longTokens.length ? frenchHits / longTokens.length : 0;

    // CORRECTIF (19/09/2026) : le ratio de vocabulaire ne peut plus rejeter
    // seul. Il depend de la nature du texte : une liste de courses ou de
    // valise est faite de noms concrets ("gigoteuse", "poussette", "rallonge")
    // absents d'une liste de frequence de 2000 mots dominee par les mots
    // outils. Mesure sur un cas reel (liste de vacances, texte natif propre) :
    // 6 pages sur 9 scoraient 16 a 30 % et etaient declarees inexploitables,
    // puis basculees en OCR -> 69 % du contenu perdu.
    //
    // Le but de ce test est de reconnaitre la couche texte parasite d'un
    // scanner, dont la signature mesuree est : longueur moyenne 1,38 et
    // 22-30 % de symboles. Ces deux indicateurs-la separent le cas sans
    // ambiguite (texte legitime : longueur 4,1 en prose, 5,5-7,4 en liste ;
    // symboles 2-5 %). Le vocabulaire n'est plus qu'un signal d'appoint.
    const usable = !(
      avgTokenLen < 2.5 ||
      (symbolRatio > 0.20 && frenchWordRatio < 0.15)
    );

    // Journalisation des trois indicateurs (diagnostic faux positif/negatif
    // sur un autre document, cf. ADDENDUM 3 section O).
    console.log(
      '[qualite-texte] longueur_moyenne=' + avgTokenLen.toFixed(2) +
      ' ratio_reconnu(>=3car)=' + (frenchWordRatio * 100).toFixed(1) + '%' +
      ' ratio_symboles=' + (symbolRatio * 100).toFixed(1) + '%' +
      ' -> ' + (usable ? 'EXPLOITABLE' : 'INEXPLOITABLE (OCR)')
    );

    return { usable, frenchWordRatio, symbolRatio, avgTokenLen, tokenCount: allTokens.length };
  }

  function isBoldFontName(name) {
    return /bold|black|heavy|semibold|extrabold/i.test(name || '');
  }
  function isItalicFontName(name) {
    return /italic|oblique/i.test(name || '');
  }

  // Determine gras/italique a partir du nom de police (item.fontName est un
  // identifiant interne pdf.js, ex. "g_d0_f1" -- NON exploitable directement).
  // On tente `page.commonObjs.get` en mode SYNCHRONE (sans callback) pour
  // recuperer le vrai nom PostScript quand l'objet est deja resolu ; sinon on
  // se rabat silencieusement sur l'identifiant brut. On evite deliberement
  // la forme asynchrone `commonObjs.get(id, callback)` : verifie a l'usage,
  // elle peut ne JAMAIS rappeler le callback pour un PDF dont on ne fait que
  // `getTextContent()` sans `render()`, bloquant l'extraction indefiniment.
  function resolveFontStyle(page, item) {
    let name = item.fontName || '';
    try {
      const obj = page.commonObjs.get(item.fontName);
      if (obj) name = obj.name || obj.fallbackName || name;
    } catch (e) { /* objet non resolu de maniere synchrone : repli sur le nom brut */ }
    const bold = isBoldFontName(name);
    const italic = isItalicFontName(name);
    return { bold, italic, fontName: name };
  }

  const colorsEqual = (a, b) => !!a && !!b &&
    Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) < 0.5 && Math.abs(a[2] - b[2]) < 0.5;

  // --- v0.3, lot 1 (R4) : glyphes absents de Luciole ----------------------
  // Mesure du diagnostic : 31 fiches sur 43 contiennent des caracteres que
  // Luciole ne dessine pas (etoile de niveau, fleche, ciseaux) ; rendus en
  // PDF, ils sortent en case vide ou disparaissent en laissant
  // « Niveau 1 ( ) ». Substitution APPLIQUEE A L'EXTRACTION (le texte du
  // modele est deja celui qui sera rendu, et l'outil de corpus mesure les
  // glyphes absents sur ce texte-la aussi).
  //
  // Couverture lue dans la table cmap de Luciole elle-meme (police embarquee
  // dans window.ASSETS), pas dans une liste figee : un caractere couvert par
  // Luciole n'est jamais touche.
  let lucioleCoverage = null;
  function readCmapCoverage(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (o) => dv.getUint16(o), u32 = (o) => dv.getUint32(o), i16 = (o) => dv.getInt16(o);
    const out = new Set();
    const numTables = u16(4);
    let cmapOff = null;
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      const tag = String.fromCharCode(bytes[rec], bytes[rec + 1], bytes[rec + 2], bytes[rec + 3]);
      if (tag === 'cmap') { cmapOff = u32(rec + 8); break; }
    }
    if (cmapOff === null) return out;
    const numSub = u16(cmapOff + 2);
    for (let i = 0; i < numSub; i++) {
      const rec = cmapOff + 4 + i * 8;
      const platformID = u16(rec), encodingID = u16(rec + 2);
      const isUnicode = platformID === 0 || (platformID === 3 && (encodingID === 1 || encodingID === 10));
      if (!isUnicode) continue;
      const abs = cmapOff + u32(rec + 4);
      const format = u16(abs);
      if (format === 4) {
        const segX2 = u16(abs + 6), seg = segX2 / 2;
        const endOff = abs + 14, startOff = endOff + segX2 + 2, deltaOff = startOff + segX2, rangeOff = deltaOff + segX2;
        for (let s = 0; s < seg; s++) {
          const end = u16(endOff + s * 2), start = u16(startOff + s * 2);
          const delta = i16(deltaOff + s * 2), range = u16(rangeOff + s * 2);
          if (start === 0xffff) continue;
          for (let c = start; c <= end && c !== 0xffff; c++) {
            let gid;
            if (range === 0) gid = (c + delta) & 0xffff;
            else {
              const addr = rangeOff + s * 2 + range + (c - start) * 2;
              if (addr + 1 >= bytes.length) continue;
              gid = u16(addr);
              if (gid !== 0) gid = (gid + delta) & 0xffff;
            }
            if (gid !== 0) out.add(c);
          }
        }
      } else if (format === 12) {
        const n = u32(abs + 12);
        for (let g = 0, o = abs + 16; g < n; g++, o += 12) {
          for (let c = u32(o); c <= u32(o + 4); c++) out.add(c);
        }
      }
    }
    return out;
  }
  function ensureLucioleCoverage() {
    if (lucioleCoverage) return lucioleCoverage;
    try {
      const b64 = window.ASSETS && window.ASSETS.lucioleRegular;
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      lucioleCoverage = readCmapCoverage(bytes);
    } catch (e) {
      lucioleCoverage = new Set(); // couverture inconnue : seule la table ci-dessous s'applique
    }
    return lucioleCoverage;
  }

  // Substitutions choisies (plan v0.3, lot 1, R4) : le sens est garde, pas
  // la forme. Les ciseaux de decoupe sont purement decoratifs (supprimes ;
  // la ligne de decoupe elle-meme est traitee par detectCutLines).
  const GLYPH_SUBSTITUTIONS = {
    '✶': '*', '✱': '*', '✳': '*', '✴': '*', '✵': '*', '★': '*', '☆': '*',
    '➜': '→', '➔': '→', '➝': '→', '➞': '→', '➡': '→', '→': '→',
    '►': '▶', '▸': '▶', '‣': '•', '▪': '•', '■': '•', '□': '☐',
    '✓': '☑', '✔': '☑', '✗': 'x', '✘': 'x',
    '✂': '', '✄': '', '✁': '', '✃': '',
  };
  const SCISSORS_RE = /[✁-✄]/;
  function substituteGlyphs(str) {
    if (!str || /^[\u0000-ɏ]*$/.test(str)) return str; // latin : rien a faire (cas courant, rapide)
    const cov = ensureLucioleCoverage();
    let out = '';
    for (const ch of str) {
      const cp = ch.codePointAt(0);
      if (cov.has(cp) || cp <= 0x20) { out += ch; continue; }
      let rep = GLYPH_SUBSTITUTIONS[ch];
      if (rep !== undefined && [...rep].every((c) => !cov.size || cov.has(c.codePointAt(0)))) { out += rep; continue; }
      // Repli generique : forme de compatibilite Unicode (« ① » -> « 1 »,
      // « ᵉ » -> « e », ligatures), si elle est couverte.
      const nfkc = ch.normalize('NFKC');
      if (nfkc !== ch && [...nfkc].every((c) => cov.has(c.codePointAt(0)))) { out += nfkc; continue; }
      // Symbole decoratif sans equivalent : retire. Une lettre ou un chiffre
      // inconnu est garde (mieux vaut une case vide qu'un mot ampute).
      if (/[\p{S}\p{Co}]/u.test(ch)) continue;
      out += ch;
    }
    return out;
  }

  // Un trait de barre passe grossierement a mi-hauteur de la casse (plus haut
  // que le soulignement, qui longe la ligne de base) : entre ~20% et ~45% du
  // corps au-dessus de la ligne de base, empiriquement.
  function findStrikeLine(strikeLines, y, size, x0, x1) {
    if (!strikeLines || !strikeLines.length) return null;
    const yMin = y + 0.18 * size, yMax = y + 0.48 * size;
    const runWidth = Math.max(1, x1 - x0);
    for (const l of strikeLines) {
      const ly = (l.y0 + l.y1) / 2;
      if (ly < yMin || ly > yMax) continue;
      const overlap = Math.min(x1, l.x1) - Math.max(x0, l.x0);
      const lineLen = l.x1 - l.x0;
      // Un filet/separateur decoratif (ligne de coupe, regle de tableau)
      // peut traverser un glyphe sans que ce soit du barre : on exige que la
      // ligne reste proportionnee au texte qu'elle croise, pas un trait
      // pleine largeur. Faux positif observe : le caractere "✄" assis sur
      // une ligne de coupe de 631 pt (2_Memo_Carte_indiv1.pdf, 20/09/2026).
      if (overlap > 0.5 * runWidth && lineLen < runWidth * 4) return l;
    }
    return null;
  }

  // Regroupe les items de getTextContent() en lignes physiques.
  // `strikeLines` (issu de extractPageShapes -> classifyShapes) sert a
  // detecter le texte barre : pdf.js n'expose aucun attribut "strikethrough",
  // un traitement de texte le dessine comme un trait vectoriel independant.
  // Scinde une liste d'items (deja triee par x) en plusieurs groupes des
  // qu'une frontiere de colonne de tableau (Z4.4bis) tombe entre deux items
  // consecutifs. Sans cette coupe, le libelle d'une cellule ("Noms") et le
  // contenu de la cellule voisine sur la meme ordonnee fusionnent en une
  // seule "ligne physique" avant meme que la mise en page sache qu'il s'agit
  // d'un tableau -- bug reel observe sur 10_FicheOrtho.pdf (20/09/2026) : le
  // libelle de colonne se retrouvait englouti au milieu du texte voisin.
  //
  // v0.3, lot 1 (R1/R6) -- cause racine trouvee en reproduisant les
  // tableaux de conjugaison sur une fixture (tests/fixtures_v03.py,
  // v3-tableau-large) : pdf.js insere entre deux items eloignes un item
  // ESPACE synthetique dont la largeur couvre TOUT l'ecart (ex. " " de
  // x=146 a x=189 entre deux cellules). La fin de l'item precedent
  // (`prevEnd`) tombait alors de l'autre cote de la frontiere de colonne,
  // qui n'etait plus jamais detectee : toute une rangee de tableau
  // devenait une seule ligne, affectee a UNE cellule (rangees effondrees,
  // R6) dont la hauteur aberrante emballait la pagination (gel, R1).
  // Correctif : un item blanc qui enjambe une frontiere est retire, et la
  // fin de segment ne tient compte que des items non blancs.
  const isBlankItem = (e) => e.str.trim() === '';
  function itemEnd(e) { return e.x + (e.it.width || 0); }
  function splitItemsAtColumnBoundaries(sortedItems, colBoundaries) {
    if (!colBoundaries || !colBoundaries.length) return [sortedItems];
    const items = sortedItems.filter((e) => !(isBlankItem(e) &&
      colBoundaries.some((b) => e.x < b - 1 && itemEnd(e) > b + 1)));
    if (!items.length) return [];
    const segments = [];
    let seg = [items[0]];
    let prevEnd = isBlankItem(items[0]) ? items[0].x : itemEnd(items[0]);
    for (let i = 1; i < items.length; i++) {
      const cur = items[i];
      const crosses = !isBlankItem(cur) && colBoundaries.some((b) => prevEnd <= b + 1 && cur.x >= b - 1);
      if (crosses) { segments.push(seg); seg = [cur]; } else { seg.push(cur); }
      if (!isBlankItem(cur)) prevEnd = itemEnd(cur);
    }
    segments.push(seg);
    return segments;
  }

  // v0.3, lot 1 (R5) -- un exposant (« 1re », « 2e ») est un item plus petit
  // (< 70 % du corps) pose plus haut que la ligne de base de son voisin :
  // l'ecart vertical depasse le seuil de regroupement en ligne (0,3 x
  // corps), il devenait une ligne a part (« re e » isoles sous la phrase).
  // Le rattache a la ligne de l'item qui le precede immediatement a gauche.
  // Rendu : au corps du texte (jamais en petit, plancher Z2), accole.
  function snapSuperscripts(enriched) {
    for (const e of enriched) {
      if (isBlankItem(e)) continue;
      let host = null;
      for (const h of enriched) {
        if (h === e || isBlankItem(h) || e.size >= 0.7 * h.size) continue;
        const rise = e.y - h.y;
        if (rise < 0.12 * h.size || rise > 0.7 * h.size) continue;
        const gapX = e.x - itemEnd(h);
        if (gapX < -0.5 * h.size || gapX > 0.4 * h.size) continue;
        host = h;
        break;
      }
      if (host) { e.y = host.y; e.superscript = true; }
    }
  }

  // v0.3 (L2, decision E8) -- pastille de numero : un chiffre (1 a 3)
  // pose dans un petit disque/carre colore (forme « decorative » < 26 pt).
  // Centre dans la pastille, il n'est pas sur la ligne de base de l'en-tete
  // de collection voisin et devenait une ligne isolee (ou disparaissait :
  // chiffre blanc sur fond blanc une fois la pastille non rendue). Rattache
  // a la ligne de l'en-tete a sa gauche -> « Orthographe 7 » sur une ligne ;
  // sa couleur (blanche) est ramenee a un contraste lisible au rendu (C1).
  function snapPastilles(enriched, decorative) {
    const filled = (decorative || []).filter((d) => d.fill);
    if (!filled.length) return;
    for (const e of enriched) {
      if (!/^\s*\d{1,3}\s*$/.test(e.str)) continue;
      const cx = e.x + (e.it.width || 0) / 2, cy = e.y + 0.35 * e.size;
      const inBadge = filled.some((d) => cx >= d.x0 - 1 && cx <= d.x1 + 1 && cy >= d.y0 - 1 && cy <= d.y1 + 1);
      if (!inBadge) continue;
      let host = null, bestGap = Infinity;
      for (const h of enriched) {
        if (h === e || isBlankItem(h) || /^\s*\d{1,3}\s*$/.test(h.str)) continue;
        if (Math.abs(h.y - e.y) > 1.2 * Math.max(h.size, e.size)) continue;
        const gap = e.x - itemEnd(h);
        if (gap < -2 || gap > 4 * Math.max(h.size, e.size)) continue;
        if (gap < bestGap) { bestGap = gap; host = h; }
      }
      if (host) { e.y = host.y; e.pastille = true; }
    }
  }

  // v0.3 -- une frontiere de colonne (bord de cellule, d'encadre, colonne
  // interne, ligne de decoupe verticale) ne vaut QUE sur la hauteur du
  // conteneur qui la produit : {x, y0, y1}. Avant, elle valait sur toute
  // la page -- un titre en haut de fiche etait « coupe » aux abscisses des
  // colonnes du tableau du bas (mesure sur le corpus, 24/09/2026 : titres
  // scindes en deux paragraphes, espaces perdues entre mots en italique).
  function boundariesAt(bounds, y) {
    if (!bounds || !bounds.length) return [];
    return bounds.filter((b) => typeof b === 'number' || (y >= b.y0 - 2 && y <= b.y1 + 2)).map((b) => (typeof b === 'number' ? b : b.x));
  }

  function groupIntoLines(items, styles, strikeLines, colBoundaries, decorative) {
    const enriched = items.map((it, idx) => {
      const size = Math.hypot(it.transform[0], it.transform[1]) || 1;
      const x = it.transform[4];
      const y = it.transform[5];
      const str = it.str === undefined ? undefined : substituteGlyphs(it.str);
      return { it, idx, size, x, y, str, style: styles[idx] };
    }).filter((e) => e.str !== undefined);

    snapSuperscripts(enriched);
    snapPastilles(enriched, decorative);
    enriched.sort((a, b) => (b.y - a.y) || (a.x - b.x));

    const lines = [];
    let current = null;
    for (const e of enriched) {
      if (e.str.trim() === '' && e.str !== ' ') continue;
      if (!current || Math.abs(current.y - e.y) > 0.3 * Math.max(e.size, current.size)) {
        current = { y: e.y, items: [], size: e.size };
        lines.push(current);
      }
      current.items.push(e);
      current.size = Math.max(current.size, e.size);
    }

    return lines.flatMap((line) => {
      line.items.sort((a, b) => a.x - b.x);
      const segments = splitItemsAtColumnBoundaries(line.items, boundariesAt(colBoundaries, line.y));
      // ADDENDUM 6, Z12, D2 -- correctif du 20/09/2026 (cause racine reelle
      // du faux titre en gros/gras signale par le cadrage, un item de liste
      // a puce d'une ligne d'ingredient, sur Sq4_Fiche1_lire_recettes.pdf) :
      // le regroupement en "ligne physique" ci-dessus (boucle for) ne teste
      // QUE la proximite en Y, jamais en X -- deux items de DEUX BOITES
      // DIFFERENTES de la grille 2x2 (ex. le meme item de liste a puce,
      // boite A, x=321, corps 10 ; le titre de boite voisine, boite B,
      // x=182, corps 16) peuvent tomber sur des ordonnees presque
      // identiques (ecart de 0.35 pt observe, sous le seuil 0.3*corps) et
      // se retrouver dans le
      // MEME objet `line`, dont `line.size = Math.max(...)` sur TOUS ses
      // items vaut alors 16. splitItemsAtColumnBoundaries() separe bien le
      // TEXTE en segments distincts (colBoundaries contient les bords de
      // chaque boite, Z10) -- mais chaque segment heritait quand meme du
      // `line.size` PARTAGE, contamine par l'autre boite. Recalcule donc le
      // corps localement, a partir des seuls items DU SEGMENT.
      return segments
        .map((segItems) => {
          const segSize = segItems.reduce((m, e) => Math.max(m, e.size), 0) || line.size;
          return buildLineFromItems(line.y, segSize, segItems, strikeLines);
        })
        .filter((l) => l.text.trim().length > 0);
    });
  }

  function buildLineFromItems(lineY, lineSize, lineItems, strikeLines) {
    let text = '';
    let prevEndX = null;
    let avgCharW = 0;
    let charCount = 0;
    const runsRaw = [];
    // ADDENDUM 6, Z12, D3 -- offsets (dans `text`) ou l'ecart horizontal
    // avec l'item precedent depasse 3x la largeur d'une espace : signale
    // une frontiere de mini-colonne (deux items de liste « Libelle :
    // quantite » bout a bout sur la meme ligne de base source), a rejouer
    // plus tard par splitLineAtColumnGaps() -- cette information disparait
    // sinon (les runs finaux n'ont plus de coordonnees x, cf. plus bas).
    const gapSplits = [];
    // v0.3, lot 1 : fin du dernier item NON BLANC -- un item espace
    // synthetique de pdf.js couvre tout l'ecart qui le suit (cf.
    // splitItemsAtColumnBoundaries) et masquait les grands ecarts (D3).
    let prevInkEndX = null;
    let prevItem = null;
    for (const e of lineItems) {
      const w = (e.it.width || (e.str.length * e.size * 0.5));
      const blank = e.str.trim() === '';
      if (!blank) {
        avgCharW += w;
        charCount += Math.max(e.str.length, 1);
      }
      if (prevEndX !== null && !blank) {
        const gap = e.x - prevEndX;
        const threshold = 0.25 * (avgCharW / Math.max(charCount, 1)) * Math.max(e.str.length, 1) || 0.25 * e.size;
        // Apres un exposant (« 1re »), le mot suivant est toujours un
        // nouveau mot : le seuil d'espace ordinaire (calcule sur la longueur
        // de l'item suivant) ne s'applique pas.
        const afterSup = (prevItem && prevItem.superscript && !e.superscript && gap > 0.1 * e.size) || (e.pastille && gap > 0);
        if ((afterSup || gap > Math.max(threshold, 0.2 * e.size)) && !/^\s/.test(e.str) && !text.endsWith(' ')) {
          // v0.3, lot 1 (R1/W2) -- l'espace synthetique est ajoutee AU TEXTE
          // ET AU DERNIER RUN. Avant, elle n'allait qu'au texte : texte et
          // runs se desynchronisaient (cause racine des gels de
          // sliceLineAtOffsets sur 7 fiches, et des espaces perdues entre
          // deux runs d'un titre, W2 -- le rendu part des runs).
          text += ' ';
          if (runsRaw.length) runsRaw[runsRaw.length - 1].text += ' ';
        }
        const inkGap = e.x - (prevInkEndX === null ? prevEndX : prevInkEndX);
        const spaceWidth = 0.3 * e.size;
        if (inkGap > 3 * spaceWidth && !e.superscript && !e.pastille) gapSplits.push(text.length);
      }
      text += e.str;
      prevEndX = e.x + w;
      if (!blank) { prevInkEndX = e.x + w; prevItem = e; }
      runsRaw.push({
        text: e.str, bold: e.style.bold, italic: e.style.italic, color: e.style.color,
        x0: e.x, x1: e.x + w,
      });
    }
    // Espaces de fin : retirees du texte ET des runs (meme raison).
    text = text.replace(/\s+$/, '');
    while (runsRaw.length && /\s$/.test(runsRaw[runsRaw.length - 1].text)) {
      const last = runsRaw[runsRaw.length - 1];
      last.text = last.text.replace(/\s+$/, '');
      if (!last.text) runsRaw.pop(); else break;
    }
    // Fusionne les runs consecutifs de meme style (gras/italique/couleur)
    const runs = [];
    for (const r of runsRaw) {
      const last = runs[runs.length - 1];
      if (last && last.bold === r.bold && last.italic === r.italic && colorsEqual(last.color, r.color)) {
        last.text += r.text;
        last.x1 = r.x1;
      } else {
        runs.push({ ...r });
      }
    }
    for (const r of runs) {
      const strike = findStrikeLine(strikeLines, lineY, lineSize, r.x0, r.x1);
      if (strike) r.strikethrough = true;
      delete r.x0; delete r.x1; // usage interne uniquement, pas expose en aval
    }
    const firstInk = lineItems.find((e) => e.str.trim() !== '') || lineItems[0];
    const x0 = firstInk.x;
    return { y: lineY, x0, x1: prevInkEndX !== null ? prevInkEndX : prevEndX, size: lineSize, text, runs, gapSplits };
  }

  // Detecte 1 ou 2 colonnes via un histogramme des abscisses de debut de ligne.
  function detectColumns(lines, pageWidth) {
    if (lines.length < 6) return [lines];
    const xs = lines.map((l) => l.x0).sort((a, b) => a - b);
    // Histogramme grossier en 20 bacs
    const bins = new Array(20).fill(0);
    const binW = pageWidth / 20;
    xs.forEach((x) => {
      const b = Math.min(19, Math.max(0, Math.floor(x / binW)));
      bins[b] += 1;
    });
    // Cherche deux pics separes par une vallee quasi-vide
    let peak1 = -1, peak2 = -1;
    for (let i = 0; i < bins.length; i++) {
      if (bins[i] > (peak1 === -1 ? 0 : 0) && bins[i] > lines.length * 0.15) {
        if (peak1 === -1) peak1 = i;
        else if (i - peak1 > 3) peak2 = i;
      }
    }
    if (peak1 === -1 || peak2 === -1) return [lines];
    // Verifie une gouttiere franche entre les deux pics
    let valleyEmpty = true;
    for (let i = peak1 + 2; i < peak2 - 1; i++) {
      if (bins[i] > lines.length * 0.05) valleyEmpty = false;
    }
    if (!valleyEmpty) return [lines];

    const splitX = (peak1 + peak2) / 2 * binW;
    const left = lines.filter((l) => l.x0 < splitX);
    const right = lines.filter((l) => l.x0 >= splitX);
    if (left.length < 3 || right.length < 3) return [lines];
    left.sort((a, b) => b.y - a.y);
    right.sort((a, b) => b.y - a.y);
    return [left, right];
  }

  // Approxime les lignes physiques d'une page (juste x0/y/taille, sans
  // fusion de style) : suffisant pour detecter un decoupage en colonnes,
  // pas pour construire le texte final. Reutilise pour la detection de
  // colonnes A L'INTERIEUR d'une boite (voir detectColumnSplitX) : a ce
  // stade de l'extraction, groupIntoLines() n'a pas encore tourne (elle a
  // justement besoin des frontieres de colonne en entree), donc les
  // "vraies" lignes n'existent pas encore.
  function roughLinePositions(items) {
    const enriched = items.filter((it) => it.str && it.str.trim()).map((it) => ({
      x: it.transform[4], y: it.transform[5], size: Math.hypot(it.transform[0], it.transform[1]) || 1,
    }));
    enriched.sort((a, b) => (b.y - a.y) || (a.x - b.x));
    const lines = [];
    let current = null;
    for (const e of enriched) {
      if (!current || Math.abs(current.y - e.y) > 0.3 * Math.max(e.size, current.size)) {
        current = { y: e.y, x0: e.x, size: e.size };
        lines.push(current);
      }
    }
    return lines;
  }

  // ADDENDUM 6, Z10 -- Detecte une coupure en 2 colonnes de TEXTE SANS
  // BORDURE (ex. une liste d'ingredients presentee en 2 colonnes alignees
  // par espacement, sans aucun trait de grille) a l'interieur d'une region
  // donnee (typiquement une boite). Meme principe que detectColumns()
  // (histogramme des abscisses de debut de ligne, 2 pics separes par une
  // vallee vide), mais localise a la region au lieu de la page entiere, et
  // ne retourne que la coordonnee X de coupure (pour alimenter
  // colBoundaries / splitItemsAtColumnBoundaries -- meme mecanisme deja
  // utilise pour les tableaux bordes). Bug reel trouve sur
  // Sq4_Fiche1_lire_recettes.pdf : une liste d'ingredients en 2 colonnes
  // sans bordure se retrouvait fusionnee ligne par ligne avec les etapes de
  // preparation voisines, DANS UNE BOITE (pas un tableau, donc invisible a
  // detectTables()).
  function detectColumnSplitX(regionLines, regionX0, regionWidth) {
    if (regionLines.length < 6 || regionWidth <= 0) return null;
    const bins = new Array(20).fill(0);
    const binW = regionWidth / 20;
    for (const l of regionLines) {
      const rel = l.x0 - regionX0;
      const b = Math.min(19, Math.max(0, Math.floor(rel / binW)));
      bins[b] += 1;
    }
    let peak1 = -1, peak2 = -1;
    for (let i = 0; i < bins.length; i++) {
      if (bins[i] > regionLines.length * 0.15) {
        if (peak1 === -1) peak1 = i;
        else if (i - peak1 > 3) peak2 = i;
      }
    }
    if (peak1 === -1 || peak2 === -1) return null;
    let valleyEmpty = true;
    for (let i = peak1 + 2; i < peak2 - 1; i++) {
      if (bins[i] > regionLines.length * 0.05) valleyEmpty = false;
    }
    if (!valleyEmpty) return null;
    const splitX = regionX0 + (peak1 + peak2) / 2 * binW;
    const left = regionLines.filter((l) => l.x0 < splitX).length;
    const right = regionLines.length - left;
    if (left < 3 || right < 3) return null;
    return splitX;
  }

  function detectListMarker(text) {
    return /^\s*([•\-–*▪]|\d+[.)])\s+/.test(text);
  }

  function stripListMarker(text) {
    return text.replace(/^\s*([•\-–*▪]|\d+[.)])\s+/, '');
  }

  // ADDENDUM 6, Z12, D1 -- une ligne PDF peut contenir PLUSIEURS marqueurs
  // de liste EMBARQUES dans le meme texte, pas seulement en tete de ligne.
  // Cas reel : Sq4_Fiche1_lire_recettes.pdf, une liste d'ustensiles a 4
  // items separes par des puces arrive de groupIntoLines() comme une SEULE
  // ligne (le document met les ustensiles bout a bout sur la meme ligne
  // de base) --
  // groupIntoLines() ne scinde jamais une ligne PDF, donc flushPara() en
  // faisait un unique paragraphe-fourre-tout. Restreint a la puce non
  // ambigue (•, ▪) : un tiret ou une puce numerique EN PLEIN TEXTE (pas en
  // tete de ligne) est bien plus souvent une ponctuation normale (incise,
  // dialogue) qu'un marqueur de liste -- detectListMarker() reste la seule
  // reference pour une ligne entiere, plus permissive a bon droit.
  // Coupe une ligne deja assemblee (l.text/l.runs) en plusieurs lignes
  // virtuelles aux offsets de caractere donnes (`cuts`, positions dans
  // l.text). Partagee par splitLineAtEmbeddedMarkers (D1) et
  // splitLineAtColumnGaps (D3) -- seule la facon de CALCULER `cuts` differe
  // entre les deux. Reconstruit les runs de chaque segment caractere par
  // caractere : par construction (buildLineFromItems), l.runs n'a plus de
  // coordonnees x individuelles (supprimees, "usage interne uniquement"),
  // seul l'ordre sequentiel texte <-> runs reste exploitable ici.
  function sliceLineAtOffsets(l, cuts) {
    const text = l.text;
    if (!cuts.length) return [l];
    const bounds = [0, ...cuts, text.length];
    const segments = [];
    for (let i = 0; i < bounds.length - 1; i++) segments.push([bounds[i], bounds[i + 1]]);
    const runsBySeg = segments.map(() => []);
    let offset = 0, segIdx = 0;
    // ADDENDUM v0.3, phase 0.3 -- garde-fou anti-gel (R1). Mesure le
    // 23/09/2026 par pile CDP echantillonnee (Debugger.pause, plusieurs
    // captures espacees) sur 4_Memo_Carte_indiv.pdf, 9_Memo_Carte_indiv.pdf
    // et 5 fiches Memo_Tableau (13/14/15/17/19) : dans les 4 cas, la pile
    // s'arrete systematiquement ICI, boucle synchrone sans jamais rendre la
    // main. Cause tracee avec un compteur temporaire : la somme des
    // longueurs de l.runs peut depasser l.text.length de quelques
    // caracteres (ecart de construction en amont -- cause racine hors
    // perimetre de ce lot, cf. lot 1 du plan v0.3) ; quand ce depassement
    // tombe apres la derniere frontiere de segment, `segIdx` reste bloque
    // sur le dernier segment ET `segEnd` (borne par `segments[segIdx][1]`)
    // ne peut plus jamais depasser `pos` -- `pos = segEnd` n'avance plus,
    // boucle infinie (confirme : `pos` et `segIdx` strictement identiques
    // sur plus de 30000 iterations consecutives). Double garde : sortie
    // immediate des qu'aucun progres n'est possible (non-progression, plus
    // sur que d'attendre un plafond) + plafond de secours si jamais un
    // autre cas de figure progressait de facon anormalement lente. Au-dela :
    // abandon de la scission, la ligne est rendue TELLE QUELLE (comme si
    // `cuts` etait vide) plutot que de bloquer l'onglet -- jamais declenche
    // sur les 34 fiches qui aboutissent aujourd'hui (verifie par le corpus).
    const PLAFOND_ITER_SLICE = 5000;
    let iterGardeFou = 0;
    let depasse = false;
    for (const r of l.runs) {
      const rStart = offset, rEnd = offset + r.text.length;
      let pos = rStart;
      while (pos < rEnd) {
        iterGardeFou++;
        while (segIdx < segments.length - 1 && pos >= segments[segIdx][1]) segIdx++;
        const segEnd = Math.min(rEnd, segments[segIdx][1]);
        if (segEnd <= pos || iterGardeFou > PLAFOND_ITER_SLICE) {
          console.warn('[garde-fou] sliceLineAtOffsets : ' +
            (segEnd <= pos ? 'aucun progres possible (l.runs plus long que l.text)' : 'plafond de ' + PLAFOND_ITER_SLICE + ' iterations depasse') +
            ' (texte "' + text.slice(0, 30) + '"), scission abandonnee, ligne placee telle quelle.');
          depasse = true;
          break;
        }
        const chunk = r.text.slice(pos - rStart, segEnd - rStart);
        if (chunk.length) runsBySeg[segIdx].push({ ...r, text: chunk });
        pos = segEnd;
      }
      if (depasse) break;
      offset = rEnd;
    }
    if (depasse) return [l];
    // Coordonnees geometriques (y/x0/x1/size) approximatives, partagees par
    // tous les segments -- une ligne PDF n'a qu'une seule bbox, cf.
    // commentaire "Bbox approximative" sur flushPara() plus bas (suffisant
    // pour l'association a une boite/cellule, pas pour un rendu direct).
    // v0.3, lot 1 (R1) : les espaces de tete retirees du texte d'un segment
    // le sont aussi de ses runs (avant : texte seul -- runs plus longs que
    // le texte, cause racine des gels, cf. garde-fou ci-dessus).
    for (const segRuns of runsBySeg) {
      while (segRuns.length && /^\s/.test(segRuns[0].text)) {
        segRuns[0] = { ...segRuns[0], text: segRuns[0].text.replace(/^\s+/, '') };
        if (!segRuns[0].text) segRuns.shift(); else break;
      }
    }
    return segments.map((seg, i) => ({
      y: l.y, x0: l.x0, x1: l.x1, size: l.size,
      text: text.slice(seg[0], seg[1]).replace(/^\s+/, ''),
      runs: runsBySeg[i],
      // Grands ecarts (D3) du segment, re-indexes sur son propre texte :
      // avant, ils etaient perdus des qu'une puce embarquee (D1) avait
      // deja scinde la ligne.
      gapSplits: (() => {
        const lead = text.slice(seg[0], seg[1]).length - text.slice(seg[0], seg[1]).replace(/^\s+/, '').length;
        return (l.gapSplits || []).filter((c) => c > seg[0] + lead && c < seg[1]).map((c) => c - seg[0] - lead);
      })(),
      // Segment i > 0 : nait d'une coupure (marqueur embarque ou grand
      // ecart, D1/D3) -- doit TOUJOURS ouvrir un nouveau paragraphe, meme
      // quand son texte ne commence pas lui-meme par un marqueur de liste
      // (cas D3 : un item de liste « Libelle : quantite » n'a aucun
      // marqueur). Cf. la boucle de regroupement en paragraphes plus bas,
      // qui lit ce champ.
      afterSplit: i > 0,
    })).filter((vl) => vl.text.length > 0);
  }

  const EMBEDDED_MARKER_RE = /(^|\s)([•▪])\s+/g;
  function splitLineAtEmbeddedMarkers(l) {
    const text = l.text;
    const cuts = [];
    let m;
    EMBEDDED_MARKER_RE.lastIndex = 0;
    while ((m = EMBEDDED_MARKER_RE.exec(text))) {
      const markerStart = m.index + m[1].length;
      if (markerStart > 0) cuts.push(markerStart);
    }
    return sliceLineAtOffsets(l, cuts);
  }

  // ADDENDUM 6, Z12, D3 -- deux mini-colonnes SANS marqueur ni bordure
  // (deux items de liste « Libelle : quantite » sur la meme ligne,
  // Sq4_Fiche1_lire_recettes.pdf) arrivent de groupIntoLines() comme une
  // seule ligne, pour la meme raison
  // structurelle que D1 (le document les met bout a bout sur la meme ligne
  // de base). buildLineFromItems() (ci-dessus) marque desormais chaque
  // grand ecart horizontal RENCONTRE PENDANT L'ASSEMBLAGE (> 3x la largeur
  // d'une espace -- seuil du cadrage) dans `l.gapSplits`, avant que cette
  // information ne soit perdue (les runs finaux n'ont plus de coordonnees
  // x, cf. sliceLineAtOffsets ci-dessus) : cette fonction les rejoue ici
  // pour scinder la ligne, au meme titre qu'un marqueur de liste embarque.
  function splitLineAtColumnGaps(l) {
    const cuts = (l.gapSplits || []).filter((c) => c > 0 && c < l.text.length);
    // v0.3 -- une ligne TABULEE de mots isoles (serie de terminaisons
    // « ais  ais  ait  ions  iez  aient » etalee sur la largeur d'un
    // encadre) n'est pas une suite de mini-colonnes : la scinder donnait un
    // paragraphe par mot (corpus, 24/09/2026). Gardee d'un seul tenant si
    // elle compte au moins 3 morceaux, tous d'un seul mot court.
    if (cuts.length >= 2) {
      const bounds = [0, ...cuts, l.text.length];
      const pieces = [];
      for (let i = 0; i < bounds.length - 1; i++) pieces.push(l.text.slice(bounds[i], bounds[i + 1]).trim());
      if (pieces.every((t) => t && !/\s/.test(t) && t.length <= 12)) return [l];
    }
    return sliceLineAtOffsets(l, cuts);
  }

  // Recolle les cesures : "mar-" + "telant" -> "martelant"
  function joinHyphenation(a, b) {
    if (/[a-zà-ÿ]-$/.test(a) && /^[a-zà-ÿ]/.test(b)) {
      return a.replace(/-$/, '') + b;
    }
    return null;
  }

  // Filet de securite global : recolle toute cesure "mot- mot" residuelle a
  // l'INTERIEUR d'un texte de paragraphe deja assemble (utile pour l'OCR, ou
  // Tesseract segmente parfois un mot cesure en deux "mots" separes par une
  // espace au sein d'une meme ligne reconnue, en dehors de toute frontiere
  // de ligne que joinHyphenation() (ci-dessus) puisse intercepter).
  function rejoinHyphensInText(text) {
    return text.replace(/([a-zà-ÿ])-\s+([a-zà-ÿ])/gu, '$1$2');
  }

  function computeModalSize(lines) {
    const counts = new Map();
    for (const l of lines) {
      const key = Math.round(l.size * 2) / 2;
      counts.set(key, (counts.get(key) || 0) + l.text.length);
    }
    let best = null, bestCount = -1;
    for (const [size, count] of counts) {
      if (count > bestCount) { best = size; bestCount = count; }
    }
    return best || 12;
  }

  // Normalise une ligne pour la comparaison de repetition : les numeros de
  // page varient d'une page a l'autre ("Page 1", "Page 2"...) mais le
  // gabarit textuel autour reste identique -- on remplace les nombres par
  // un marqueur commun avant de comparer.
  function normalizeForRepetition(text) {
    return text.trim().toLowerCase().replace(/\d+/g, '#');
  }

  // Detecte les en-tetes/pieds de page repetes a la meme ordonnee sur >=3 pages
  // (gabarit normalise, insensible aux numeros de page variables), et les
  // lignes courtes purement numeriques dans les 7% haut/bas de page.
  function detectRepeatedHeaderFooter(pagesLines, pageHeight) {
    const freq = new Map(); // key: gabarit normalise + rounded y-bucket -> count
    for (const lines of pagesLines) {
      for (const l of lines) {
        const near = l.y < pageHeight * 0.07 || l.y > pageHeight * 0.93;
        if (!near) continue;
        const key = normalizeForRepetition(l.text) + '|' + Math.round(l.y / 10);
        freq.set(key, (freq.get(key) || 0) + 1);
      }
    }
    const repeated = new Set();
    for (const [key, count] of freq) {
      if (count >= 3) repeated.add(key);
    }
    return function isHeaderFooter(l) {
      const near = l.y < pageHeight * 0.07 || l.y > pageHeight * 0.93;
      if (!near) return false;
      const key = normalizeForRepetition(l.text) + '|' + Math.round(l.y / 10);
      if (repeated.has(key)) return true;
      if (/^\d{1,4}$/.test(l.text.trim())) return true; // folio isole purement numerique
      return false;
    };
  }

  // ADDENDUM 6, Z12, F3 -- echantillonne (pas pixel a pixel, un point sur 4
  // suffit pour une decision "vide ou pas" et reste rapide) le contenu d'un
  // recadrage pour decider s'il ne reste plus, apres blanchiment du texte
  // (C2), qu'un fond quasi uniforme sans information visuelle utile.
  //
  // Seuil relève de 2% a 10% (lot 3, verifie sur le PDF EXPORTE) : le
  // blanchiment (C2) ne couvre que les BBOX DE TEXTE -- jamais la bordure
  // VECTORIELLE d'un encadre (classifyShapes, pas du texte), qui reste donc
  // TOUJOURS visible dans un recadrage qui coincide avec le cadre d'une
  // boite. Mesure reelle : un encadre de fiche de grammaire
  // (2_Memo_Carte_indiv1.pdf) blanchi de tout son texte ne montre plus que
  // son propre filet -- 5,8% de pixels non blancs sur un recadrage de
  // 829x288, repassait quand meme le seuil de 2% et redevenait visible (la
  // segmentation en blocs plus fine du lot 3, point 2, a legerement change
  // la forme des bbox blanchis, sans consequence sur le fond : la bordure a
  // toujours ete la, jamais couverte). 10% reste tres en dessous de ce
  // qu'une capture VRAIMENT pleine de texte affiche (un bloc de texte a lui
  // seul couvre deja largement plus que 10% de sa propre bbox).
  function isMostlyBlank(ctx, w, h) {
    if (w < 1 || h < 1) return true;
    const { data } = ctx.getImageData(0, 0, w, h);
    let nonBlanc = 0, total = 0;
    for (let i = 0; i < data.length; i += 16) { // 1 pixel sur 4 (RGBA = 4 octets)
      const r = data[i], g = data[i + 1], b = data[i + 2];
      total++;
      if (r < 245 || g < 245 || b < 245) nonBlanc++;
    }
    return total === 0 || nonBlanc / total < 0.10; // < 10% de pixels non blancs
  }

  // Extrait les images d'une page en blocs RI {type:'image', dataUrl,
  // width, height, srcPage}. Approche pragmatique : rendu de la page entiere
  // une fois (a resolution moderee), puis recadrage par la matrice de
  // transformation courante au moment de paintImageXObject/paintJpegXObject
  // (cas courant : image non pivotee, transform = [w,0,0,h,x,y]). Les images
  // de moins de 80 px de cote (puces, filets) sont ignorees.
  async function extractImageBlocksForPage(pdfDoc, pageNum, page, opList, keptTextBboxes) {
    if (!opList) opList = await page.getOperatorList();
    const OPS = window.pdfjsLib.OPS;
    const rawImages = [];
    let currentTransform = null;
    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i];
      if (fn === OPS.transform) {
        currentTransform = opList.argsArray[i];
      } else if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject) {
        if (currentTransform) rawImages.push({ transform: currentTransform.slice() });
      }
    }
    if (!rawImages.length) return [];

    const scale = 1.5; // resolution moderee, suffisante pour un rendu A4 reflow
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    try {
      await page.render({ canvasContext: ctx, viewport }).promise;
    } catch (e) {
      return [];
    }

    // ADDENDUM 6, Z12, C2+F3 -- correctif du 20/09/2026. Ce recadrage decoupe
    // dans un rendu de PAGE COMPLETE, texte compris : tout bloc de texte
    // CONSERVE (donc deja affiche par ailleurs, en texte adapte) qui se
    // trouve geometriquement sous une image recadree se retrouve DUPLIQUE --
    // une fois en texte, une fois fige dans les pixels de l'image. Deux cas
    // reels constates le 20/09/2026 : un titre de fiche
    // (10_FicheOrtho.pdf) apparait deux fois sur la page 1 ; un encadre
    // de fiche de grammaire (2_Memo_Carte_indiv1.pdf) contient une "photo" qui
    // n'est en realite qu'une capture miniature ILLISIBLE de son propre
    // texte (le bloc de texte et l'image qui le recadre coincident presque
    // exactement). Corrige en blanchissant, sur le CANVAS DE PAGE partage
    // (avant tout recadrage), le rectangle de chaque bloc de texte conserve
    // -- meme conversion coordonnees PDF -> pixels canvas que pour les
    // images ci-dessous (viewport.convertToViewportPoint).
    if (keptTextBboxes && keptTextBboxes.length) {
      ctx.fillStyle = '#ffffff';
      // ADDENDUM 6, Z12, lot 3 (marge decouverte en verifiant F2/point 2 sur
      // le PDF exporte) -- une marge de securite de quelques px absorbe les
      // residus qu'un bbox de bloc de texte, precis mais pas parfait,
      // laisse a ses bords : puce/marqueur dont le glyphe deborde tres
      // legerement du bbox mesure, antialiasing. Sans elle, une capture
      // presque entierement blanchie (ex. l'encadre de grammaire cite plus
      // haut, 2_Memo_Carte_indiv1.pdf) pouvait laisser passer quelques points
      // isoles sous le seuil de isMostlyBlank() SANS le franchir a tort,
      // mais visibles a l'oeil -- constate le partitionnement par conteneur
      // (point 2 de ce lot) a legerement change la segmentation en blocs,
      // donc la forme exacte de chaque bbox, et fait resurgir ce residu.
      const PAD_PX = 3;
      for (const bb of keptTextBboxes) {
        const [bx0, by0] = viewport.convertToViewportPoint(bb.x0, bb.y1);
        const [bx1, by1] = viewport.convertToViewportPoint(bb.x1, bb.y0);
        const left = Math.max(0, Math.min(bx0, bx1) - PAD_PX);
        const top = Math.max(0, Math.min(by0, by1) - PAD_PX);
        const right = Math.min(canvas.width, Math.max(bx0, bx1) + PAD_PX);
        const bottom = Math.min(canvas.height, Math.max(by0, by1) + PAD_PX);
        if (right > left && bottom > top) ctx.fillRect(left, top, right - left, bottom - top);
      }
    }

    const blocks = [];
    for (const img of rawImages) {
      // transform PDF [a,b,c,d,e,f] mappe le carre unite [0,1]x[0,1] dans
      // l'espace utilisateur ; on ignore les rotations/cisaillements (b,c~0)
      // pour ce recadrage best-effort.
      const [a, b, c, d, e, f] = img.transform;
      const wUser = Math.abs(a), hUser = Math.abs(d);
      if (wUser < 1 || hUser < 1) continue;
      // BUG PRE-EXISTANT corrige le 20/09/2026 (ADDENDUM 6) : la condition
      // de signe pour y0User etait inversee par rapport a x0User. Pour une
      // image non retournee verticalement (cas courant, d > 0), f EST deja
      // le bord bas (point (0,0) du carre unite -> (e,f) en espace PDF,
      // origine bas-gauche) : aucune soustraction a faire, symetriquement a
      // x0User qui ne soustrait que si a < 0 (retournee horizontalement).
      // L'ancienne condition soustrayait hUser justement quand il ne le
      // fallait PAS (d >= 0), decalant tout recadrage d'image non retournee
      // de sa propre hauteur vers le bas de page. Detecte via la nouvelle
      // bbox (ADDENDUM 6, Z4.4) : l'image de 10_FicheOrtho.pdf tombait dans
      // la zone de l'encadre "À retenir" au lieu du haut de page, et se
      // retrouvait donc rattachee au mauvais bloc.
      const x0User = e - (a < 0 ? wUser : 0);
      const y0User = f - (d < 0 ? hUser : 0);
      // Coordonnees utilisateur -> pixels canvas via le viewport
      const [px0, py0] = viewport.convertToViewportPoint(x0User, y0User + hUser);
      const [px1, py1] = viewport.convertToViewportPoint(x0User + wUser, y0User);
      const left = Math.max(0, Math.min(px0, px1));
      const top = Math.max(0, Math.min(py0, py1));
      const right = Math.min(canvas.width, Math.max(px0, px1));
      const bottom = Math.min(canvas.height, Math.max(py0, py1));
      const w = right - left, h = bottom - top;
      // v0.3 (T2, decision E6) : les petites images (16 a 53 pt) ne sont plus
      // jetees d'office -- ce sont notamment les mascottes-legendes des
      // en-tetes de tableau et des cartes. Marquees `small` : la mise en
      // page ne les garde qu'en icone a cote de leur libelle, DANS une
      // cellule ou une boite (hors conteneur : ecartees comme avant --
      // puces, logos).
      if (w < 24 || h < 24) continue; // puces / filets decoratifs ignores
      const small = w < 80 || h < 80;

      const crop = document.createElement('canvas');
      crop.width = Math.round(w);
      crop.height = Math.round(h);
      const cropCtx = crop.getContext('2d');
      cropCtx.drawImage(canvas, left, top, w, h, 0, 0, crop.width, crop.height);
      // ADDENDUM 6, Z12, F3 -- une image dont le contenu utile etait
      // entierement une capture de texte, desormais blanchi ci-dessus
      // (C2), peut ne plus rien contenir d'autre qu'un fond uni : l'ecarter
      // plutot que d'exporter un rectangle blanc (ou presque) inutile.
      if (isMostlyBlank(cropCtx, crop.width, crop.height)) continue;
      blocks.push({
        type: 'image',
        runs: [],
        srcPage: pageNum,
        dataUrl: crop.toDataURL('image/jpeg', 0.85),
        width: crop.width,
        height: crop.height,
        small,
        bbox: { x0: x0User, y0: y0User, x1: x0User + wUser, y1: y0User + hUser },
      });
    }
    return blocks;
  }

  // --- ADDENDUM 6, section Z1/Z4.2 : extraction de la geometrie vectorielle
  // (tableaux, encadres, connecteurs de diagramme) pour la reconstruction par
  // blocs. Independant du flux texte lineaire ci-dessus ; consomme par le
  // futur moteur de mise en page par blocs (03-layout-engine.js).
  //
  // Simule la pile de matrices du content stream PDF (save/restore/cm) pour
  // convertir les coordonnees brutes de constructPath (espace utilisateur au
  // moment de l'appel) en coordonnees page. Necessaire : contrairement au
  // texte (dont pdf.js resout deja `transform` dans getTextContent), les
  // coordonnees de chemin de getOperatorList() restent brutes.
  // Produit en convention « vecteur ligne » du PDF : un point p devient
  // p x m1 x m2, c.-a-d. m1 s'applique D'ABORD. v0.3, lot 1 -- l'operateur
  // `cm` s'ecrit donc CTM' = M x CTM, soit matMul(M, CTM) ; il etait appele
  // matMul(CTM, M) (M applique apres la CTM), faux des que deux `cm`
  // s'imbriquent avec une echelle (ex. mise a l'echelle puis translation :
  // formes decalees). Sans effet quand une seule transformation est active.
  function matMul(m1, m2) {
    const [a1, b1, c1, d1, e1, f1] = m1;
    const [a2, b2, c2, d2, e2, f2] = m2;
    return [
      a1 * a2 + b1 * c2, a1 * b2 + b1 * d2,
      c1 * a2 + d1 * c2, c1 * b2 + d1 * d2,
      e1 * a2 + f1 * c2 + e2, e1 * b2 + f1 * d2 + f2,
    ];
  }
  function matApply(m, x, y) {
    const [a, b, c, d, e, f] = m;
    return [a * x + c * y + e, b * x + d * y + f];
  }

  // Parcourt la liste d'operateurs d'une page et retourne les tracés
  // effectivement peints (fill/stroke reel), en ignorant les chemins qui ne
  // servent qu'au clipping (tres frequents : la plupart des PDF issus de
  // traitement de texte encadrent chaque image ou bloc decoratif d'un
  // `clip` sans jamais le peindre lui-meme).
  function extractPaintedShapes(opList, OPS) {
    const opNames = extractPaintedShapes._opNames || (extractPaintedShapes._opNames = (() => {
      const m = {}; for (const k in OPS) m[OPS[k]] = k; return m;
    })());
    let stack = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    let fillColor = null, strokeColor = null, dash = null;
    const shapes = [];

    for (let i = 0; i < opList.fnArray.length; i++) {
      const name = opNames[opList.fnArray[i]];
      const args = opList.argsArray[i];
      switch (name) {
        // v0.3, lot 1 (R2) : couleurs et pointille empiles avec la matrice
        // (meme correctif que extractTextColors ci-dessous).
        case 'save': stack.push([ctm, fillColor, strokeColor, dash]); break;
        case 'restore': { const r = stack.pop(); if (r) { [ctm, fillColor, strokeColor, dash] = r; } break; }
        case 'transform': ctm = matMul(args, ctm); break; // `cm` : CTM' = M x CTM (v0.3 : ordre corrige, cf. matMul)
        case 'setFillRGBColor': fillColor = args; break;
        case 'setStrokeRGBColor': strokeColor = args; break;
        // v0.3 (E1/S1) : un trait pointille par motif de tirets (`d`) est
        // un seul chemin -- seul l'etat de pointille le distingue d'un filet.
        case 'setDash': dash = args && args[0] && args[0].length ? args[0].slice() : null; break;
        case 'constructPath': {
          const [pathOps, coords] = args;
          const xs = [], ys = [];
          let ci = 0;
          for (const pop of pathOps) {
            if (pop === OPS.moveTo || pop === OPS.lineTo) {
              const [px, py] = matApply(ctm, coords[ci], coords[ci + 1]);
              xs.push(px); ys.push(py); ci += 2;
            } else if (pop === OPS.curveTo) {
              for (let k = 0; k < 3; k++) {
                const [px, py] = matApply(ctm, coords[ci], coords[ci + 1]);
                xs.push(px); ys.push(py); ci += 2;
              }
            } else if (pop === OPS.rectangle) {
              const rx = coords[ci], ry = coords[ci + 1], rw = coords[ci + 2], rh = coords[ci + 3];
              for (const [dx, dy] of [[0, 0], [rw, 0], [rw, rh], [0, rh]]) {
                const [px, py] = matApply(ctm, rx + dx, ry + dy);
                xs.push(px); ys.push(py);
              }
              ci += 4;
            } // closePath : pas de coordonnees a consommer
          }
          if (xs.length) {
            shapes.push({
              x0: Math.min(...xs), x1: Math.max(...xs),
              y0: Math.min(...ys), y1: Math.max(...ys),
              // fillColor/strokeColor sont l'etat AMBIANT de l'etat
              // graphique au moment du trace, pas necessairement la couleur
              // reellement utilisee pour PEINDRE cette forme precise (voir
              // ci-dessous, cas fill/eoFill/stroke). Stockes en attente de
              // confirmation par l'operation de peinture qui suit.
              fill: fillColor, stroke: strokeColor, dashed: !!dash,
              painted: false, wasFilled: false, wasStroked: false,
            });
          }
          break;
        }
        // BUG REEL corrige le 20/09/2026 (ADDENDUM 6, Z10) : une forme
        // tracee au CONTOUR SEUL (stroke, jamais fill) heritait quand meme
        // de `fill` = derniere couleur de remplissage active dans l'etat
        // graphique -- souvent une couleur totalement etrangere a cette
        // forme (ex. le noir d'une icone decorative dessinee plus tot dans
        // le flux). classifyShapes() prenait ensuite ce `fill` fantome pour
        // le fond reel de la boite. Trouve sur Sq4_Fiche1_lire_recettes.pdf :
        // les 4 cartes de recette (contour seul, fond transparent) se
        // retrouvaient avec un fond NOIR plein page. Corrige en ne
        // conservant `fill`/`stroke` que si la forme a REELLEMENT ete peinte
        // par l'operation correspondante (fill vs stroke distingues).
        case 'fill': case 'eoFill': {
          const last = shapes[shapes.length - 1];
          if (last) { last.painted = true; last.wasFilled = true; }
          break;
        }
        case 'stroke': {
          const last = shapes[shapes.length - 1];
          if (last) { last.painted = true; last.wasStroked = true; }
          break;
        }
      }
    }
    return shapes.filter((s) => s.painted).map((s) => ({
      x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1,
      fill: s.wasFilled ? s.fill : null,
      stroke: s.wasStroked ? s.stroke : null,
      dashed: s.wasStroked && s.dashed,
    }));
  }

  // Classe les tracés peints en boites (fond + bordure), lignes (traits fins,
  // grilles de tableau, connecteurs de diagramme) et decorations (icones/
  // logos, ecartes par la taille -- non pertinents comme conteneurs de mise
  // en page). Fusionne une paire fill+stroke de bbox quasi identique en une
  // seule boite (motif courant : encadre arrondi = remplissage puis contour
  // dessines separement sur le meme trace).
  function classifyShapes(shapes, pageWidth) {
    const DECORATIVE_MAX = 26; // pt ; icones/puces/logos, pas des conteneurs
    const used = new Array(shapes.length).fill(false);
    const boxes = [], lines = [], decorative = [];

    const bboxClose = (a, b, tol) =>
      Math.abs(a.x0 - b.x0) < tol && Math.abs(a.x1 - b.x1) < tol &&
      Math.abs(a.y0 - b.y0) < tol && Math.abs(a.y1 - b.y1) < tol;

    for (let i = 0; i < shapes.length; i++) {
      if (used[i]) continue;
      const s = shapes[i];
      const w = s.x1 - s.x0, h = s.y1 - s.y0;
      if (w < 1 && h < 1) continue; // point degenere

      // Un trace degenere sur un axe (largeur ou hauteur quasi nulle) est un
      // vrai trait -- grille de tableau, filet, mais aussi souligne/barre de
      // texte, potentiellement tres court (un mot). Contrairement aux icones
      // 2D (filtrees plus bas par taille), on ne filtre jamais un trait par
      // longueur : un barre de 3 lettres ferait ~15-20 pt, sous DECORATIVE_MAX.
      const isThin = w < 1.5 || h < 1.5;
      if (isThin) {
        lines.push({ x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, color: s.stroke || s.fill, dashed: !!s.dashed });
        continue;
      }
      if (w <= DECORATIVE_MAX && h <= DECORATIVE_MAX) {
        // `fill` conserve (v0.3, E8) : une pastille de numero est un petit
        // disque colore dont le chiffre, blanc, n'est lisible que sur lui.
        decorative.push({ x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, fill: s.fill });
        continue;
      }
      // Cherche un partenaire fill/stroke de bbox quasi identique a fusionner
      let partner = -1;
      const tol = Math.max(1.5, 0.01 * Math.max(w, h));
      for (let j = i + 1; j < shapes.length; j++) {
        if (used[j]) continue;
        if (bboxClose(s, shapes[j], tol)) { partner = j; break; }
      }
      let fill = s.fill, stroke = s.stroke;
      if (partner !== -1) {
        used[partner] = true;
        if (!fill && shapes[partner].fill) fill = shapes[partner].fill;
        if (!stroke && shapes[partner].stroke) stroke = shapes[partner].stroke;
      }
      boxes.push({ x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, fill, stroke });
    }
    return { boxes, lines, decorative };
  }

  // ADDENDUM 6, Z4.4 -- Reconstruit les grilles de tableau a partir des
  // traits fins classifies (classifyShapes.lines). Vit ici (extraction) et
  // pas dans le moteur de mise en page : le regroupement du texte en lignes
  // physiques (groupIntoLines, plus bas) en a lui-meme besoin pour scinder
  // une ligne aux frontieres de colonne AVANT de former des paragraphes --
  // sinon le texte de deux cellules voisines sur la meme ordonnee (ex. le
  // libelle "Noms" et le contenu de la cellule suivante) fusionne en un seul
  // bloc, avant meme que la mise en page sache qu'il s'agit d'un tableau.
  //
  // Heuristique de premier jet, validee sur 10_FicheOrtho.pdf (tableau 2
  // colonnes x 4 rangees) : les limites de colonnes ne viennent pas toujours
  // d'un trait vertical explicite (la colonne de gauche de ce tableau n'est
  // delimitee que par le bord d'un rectangle de fond colore), d'ou l'ajout
  // des bords de boites en plus des traits verticaux. A generaliser si un
  // tableau reel ne correspond pas a ce patron (ex. grille sans aucun trait
  // horizontal, tout en fonds colores).
  //
  // v0.3, lot 1 (S6) -- « faux tableaux ». Mesure du diagnostic : sur 21
  // fiches, detectTables fabriquait un tableau a partir de traits qui n'en
  // forment pas un (filet de titre, bords d'encadre, lignes d'ecriture,
  // ligne de decoupe, bords de boites de diagramme) : shouldMergeHoriz ne
  // testait que le recouvrement en X, donc deux traits de meme largeur
  // n'importe ou sur la page finissaient dans le meme « tableau » (jusqu'a
  // la page entiere : rangees aberrantes, emballement de la pagination).
  // Trois contraintes ajoutees (opts, toutes facultatives -- sans elles le
  // comportement anterieur est conserve) :
  //  1. deux traits ne s'enchainent que s'ils sont proches verticalement
  //     (<= 3 x le corps courant) OU relies par un trait vertical / un bord
  //     de boite qui va de l'un a l'autre (vraie grille) ;
  //  2. un « tableau » d'UNE seule colonne sans aucun trait vertical n'en
  //     est pas un (lignes d'ecriture, filets empiles) ;
  //  3. les lignes de decoupe (opts.cutLines) n'entrent jamais dans un
  //     tableau, et les rangees de bord vides et plus basses qu'une ligne
  //     de texte sont retirees (filet de titre colle a un encadre).
  function detectTables(shapeLines, boxes, opts) {
    boxes = boxes || [];
    opts = opts || {};
    const isCut = (l) => (opts.cutLines || []).some((c) =>
      Math.abs(c.x0 - l.x0) < 2 && Math.abs(c.x1 - l.x1) < 2 && Math.abs(c.y0 - l.y0) < 2 && Math.abs(c.y1 - l.y1) < 2);
    const lines = (shapeLines || []).filter((l) => !isCut(l));
    const horiz = lines.filter((l) => Math.abs(l.y1 - l.y0) < 1.5 && (l.x1 - l.x0) > 15);
    const vert = lines.filter((l) => Math.abs(l.x1 - l.x0) < 1.5 && (l.y1 - l.y0) > 15);
    if (horiz.length < 2) return [];
    const modal = opts.modalSize || null;
    const maxFreeGap = modal ? 3 * modal : Infinity;
    // Segments verticaux utilisables comme liaison : traits verticaux et
    // bords gauche/droit des boites.
    const connectors = vert.map((v) => ({ x: (v.x0 + v.x1) / 2, y0: v.y0, y1: v.y1 }));
    for (const b of boxes) {
      connectors.push({ x: b.x0, y0: b.y0, y1: b.y1 }, { x: b.x1, y0: b.y0, y1: b.y1 });
    }
    const hy = (l) => (l.y0 + l.y1) / 2;
    function connected(h, o) {
      const lo = Math.min(hy(h), hy(o)), hi = Math.max(hy(h), hy(o));
      const xa = Math.max(h.x0, o.x0) - 3, xb = Math.min(h.x1, o.x1) + 3;
      return connectors.some((c) => c.x >= xa && c.x <= xb && c.y0 <= lo + 2 && c.y1 >= hi - 2);
    }

    // Fusionne deux traits horizontaux dans le meme cluster s'ils se
    // touchent/chevauchent LEGEREMENT (continuite d'une meme rangee entre
    // deux colonnes, ex. le diviseur de la colonne d'en-tete a fond colore
    // qui rejoint exactement le diviseur de la colonne principale) -- mais
    // PAS si l'un des deux traits est entierement avale au milieu de l'autre
    // avec une marge des deux cotes : c'est le signe d'une decoration isolee
    // (ex. le petit filet sous l'onglet "À retenir", 49,5 pt, pris a tort
    // dans le cluster du tableau principal (348,9 pt) avant ce correctif,
    // 10_FicheOrtho.pdf, 20/09/2026), pas d'une continuation de rangee.
    const TOUCH_TOL = 3;
    function shouldMergeHoriz(h, o) {
      const overlap = Math.min(h.x1, o.x1) - Math.max(h.x0, o.x0);
      if (overlap <= -TOUCH_TOL) return false;
      const [short, long] = (h.x1 - h.x0) <= (o.x1 - o.x0) ? [h, o] : [o, h];
      const swallowed = short.x0 > long.x0 + TOUCH_TOL && short.x1 < long.x1 - TOUCH_TOL;
      if (swallowed) return false;
      // v0.3 (S6), contrainte 1.
      return Math.abs(hy(h) - hy(o)) <= maxFreeGap || connected(h, o);
    }
    // Regroupement par composantes connexes (union-find) : l'ordre
    // d'arrivee des traits ne doit pas changer le resultat.
    const parent = horiz.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < horiz.length; i++) {
      for (let j = i + 1; j < horiz.length; j++) {
        if (shouldMergeHoriz(horiz[i], horiz[j])) parent[find(i)] = find(j);
      }
    }
    const byRoot = new Map();
    horiz.forEach((h, i) => { const r = find(i); if (!byRoot.has(r)) byRoot.set(r, []); byRoot.get(r).push(h); });
    const clusters = [...byRoot.values()];

    const textLines = opts.textLines || null;
    const tables = [];
    for (const cluster of clusters) {
      if (cluster.length < 2) continue;
      const x0 = Math.min(...cluster.map((l) => l.x0));
      const x1 = Math.max(...cluster.map((l) => l.x1));
      let rowBounds = [...new Set(cluster.map((l) => Math.round(l.y0)))].sort((a, b) => b - a); // haut -> bas
      // v0.3 (S6), contrainte 3 : rangee de bord sans texte et plus basse
      // qu'une ligne de texte (filet de titre juste au-dessus d'un encadre).
      if (textLines && modal) {
        const hasText = (top, bottom) => textLines.some((t) => t.y < top && t.y > bottom && t.x0 >= x0 - 2 && t.x0 <= x1 + 2);
        while (rowBounds.length > 2 && rowBounds[0] - rowBounds[1] < modal && !hasText(rowBounds[0], rowBounds[1])) rowBounds.shift();
        while (rowBounds.length > 2 && rowBounds[rowBounds.length - 2] - rowBounds[rowBounds.length - 1] < modal &&
               !hasText(rowBounds[rowBounds.length - 2], rowBounds[rowBounds.length - 1])) rowBounds.pop();
      }
      if (rowBounds.length < 2) continue;
      const yTop = rowBounds[0], yBottom = rowBounds[rowBounds.length - 1];
      // Rejette un "tableau" degenere (quelques pt de haut) : un filet
      // decoratif double (ex. le soulignement pointille sous un titre de
      // fiche) peut presenter 2 traits horizontaux tres proches,
      // faussement detectes comme 2 rangees.
      // Bug reel trouve sur Sq4_Fiche1_lire_recettes.pdf (20/09/2026,
      // Addendum 6 Z10) : une case vide de 1 pt de haut s'affichait comme
      // un faux tableau sous le titre.
      if (yTop - yBottom < 8) continue;

      const colXs = new Set([Math.round(x0), Math.round(x1)]);
      let verticalCount = 0;
      for (const v of vert) {
        if (v.y1 < yBottom - 2 || v.y0 > yTop + 2) continue;
        if (v.x0 < x0 - 3 || v.x0 > x1 + 3) continue; // v0.3 : trait vertical hors de l'emprise du tableau
        colXs.add(Math.round(v.x0));
        verticalCount++;
      }
      for (const b of boxes) {
        if (b.y1 < yBottom || b.y0 > yTop) continue;
        if (b.x0 >= x0 - 2 && b.x0 <= x1 + 2) colXs.add(Math.round(b.x0));
        if (b.x1 >= x0 - 2 && b.x1 <= x1 + 2) colXs.add(Math.round(b.x1));
      }
      // Frontieres de colonne quasi confondues (trait vertical a 1 pt du
      // bord) : une seule.
      const colBounds = [...colXs].sort((a, b) => a - b).filter((x, i, arr) => i === 0 || x - arr[i - 1] > 2);
      if (colBounds.length < 2) continue;
      // v0.3 (S6), contrainte 2.
      if (opts.modalSize && colBounds.length === 2 && verticalCount === 0) continue;

      tables.push({ x0, y0: yBottom, x1, y1: yTop, rowBounds, colBounds });
    }
    return tables;
  }

  // Point d'entree geometrie : formes vectorielles classifiees pour une page
  // donnee (boites/lignes/decorations), coordonnees en points page (origine
  // bas-gauche, coherent avec les coordonnees texte deja utilisees ici).
  // `opList` peut etre fourni pre-recupere (le point d'entree texte en a deja
  // besoin pour la couleur, cf. extractTextColors) pour eviter de rappeler
  // page.getOperatorList() deux fois.
  async function extractPageShapes(page, opList) {
    if (!opList) opList = await page.getOperatorList();
    const OPS = window.pdfjsLib.OPS;
    const painted = extractPaintedShapes(opList, OPS);
    const viewport = page.getViewport({ scale: 1 });
    return classifyShapes(painted, viewport.width);
  }

  // Couleur de remplissage du texte, par position. getTextContent() ne
  // fournit aucune couleur ; il faut la lire dans getOperatorList() (ou elle
  // est associee a chaque appel showText via l'etat graphique courant), puis
  // la reassocier a chaque item de getTextContent(). L'appariement par ORDRE
  // D'APPARITION est peu fiable (verifie empiriquement : un doc de 131 items
  // texte peut ne generer que 76 appels showText, l'ecart correspondant a des
  // items d'espace synthetiques que pdf.js insere sans operateur associe --
  // l'ordre glisse silencieusement). On apparie donc par POSITION : le point
  // d'origine du texte au moment de chaque showText (CTM x matrice-texte
  // appliquee a (0,0)) est mis en correspondance avec le point (transform[4],
  // transform[5]) de chaque item, au plus proche, sous un seuil de tolerance.
  // Repli : un item sans correspondance fiable (perte de precision sur les
  // segments medians d'un meme mot, observee empiriquement autour de 3-4 pt
  // d'ecart) herite de la couleur du item precedent -- correct dans l'
  // immense majorite des cas, une rupture de couleur en milieu de mot etant
  // rarissime en pratique.
  function extractTextColors(opList, OPS, items) {
    const opNames = extractTextColors._opNames || (extractTextColors._opNames = (() => {
      const m = {}; for (const k in OPS) m[OPS[k]] = k; return m;
    })());
    let stack = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    let textMatrix = [1, 0, 0, 1, 0, 0];
    // v0.3, lot 1 -- position de texte suivie comme le fait un lecteur PDF
    // (Td/TD/T*, avance apres chaque Tj/TJ), plus seulement au dernier Tm.
    // Avant, plusieurs runs de couleurs differentes enchaines dans UN objet
    // texte (terminaison coloree accolee a son radical, lettre coloree en
    // debut de mot) etaient tous echantillonnes au MEME point -- seul le
    // premier trouvait son item, les suivants heritaient de la couleur
    // precedente (couleur de terminaison perdue).
    let lineMatrix = [1, 0, 0, 1, 0, 0];
    let fontSize = 1, charSpacing = 0, wordSpacing = 0, hScale = 1, leading = 0;
    let fillColor = [0, 0, 0];
    const samples = [];
    const moveText = (tx, ty) => {
      const [a, b, c, d, e, f] = lineMatrix;
      lineMatrix = [a, b, c, d, tx * a + ty * c + e, tx * b + ty * d + f];
      textMatrix = lineMatrix.slice();
    };

    for (let i = 0; i < opList.fnArray.length; i++) {
      const name = opNames[opList.fnArray[i]];
      const args = opList.argsArray[i];
      switch (name) {
        // v0.3, lot 1 (R2) -- la couleur de remplissage fait partie de
        // l'etat graphique : `q` la sauvegarde, `Q` la restaure. Avant, seule
        // la matrice etait empilee : le bleu clair d'une case-reponse remplie
        // dans un q...Q « fuyait » sur tout le texte suivant (texte noir dans
        // la source rendu en bleu pale illisible).
        case 'save': stack.push([ctm, textMatrix, fillColor]); break;
        case 'restore': { const r = stack.pop(); if (r) { ctm = r[0]; textMatrix = r[1]; fillColor = r[2]; } break; }
        case 'transform': ctm = matMul(args, ctm); break; // `cm` : CTM' = M x CTM (v0.3 : ordre corrige, cf. matMul)
        case 'setFillRGBColor': fillColor = args; break;
        case 'beginText': textMatrix = [1, 0, 0, 1, 0, 0]; lineMatrix = textMatrix.slice(); break;
        case 'setTextMatrix': textMatrix = args.slice(); lineMatrix = args.slice(); break;
        case 'moveText': moveText(args[0], args[1]); break;
        case 'setLeadingMoveText': leading = -args[1]; moveText(args[0], args[1]); break;
        case 'setLeading': leading = args[0]; break;
        case 'nextLine': moveText(0, -leading); break;
        case 'setFont': if (args && typeof args[1] === 'number') fontSize = args[1]; break;
        case 'setCharSpacing': charSpacing = args[0] || 0; break;
        case 'setWordSpacing': wordSpacing = args[0] || 0; break;
        case 'setHScale': hScale = (args[0] || 100) / 100; break;
        case 'showText': case 'showSpacedText': {
          const [x, y] = matApply(matMul(textMatrix, ctm), 0, 0);
          samples.push({ x, y, color: fillColor });
          let adv = 0;
          const glyphs = Array.isArray(args[0]) ? args[0] : [];
          for (const g of glyphs) {
            if (typeof g === 'number') adv -= g / 1000 * fontSize * hScale;
            else if (g && typeof g.width === 'number') {
              adv += (g.width / 1000 * fontSize + charSpacing + (g.isSpace ? wordSpacing : 0)) * hScale;
            }
          }
          textMatrix = [textMatrix[0], textMatrix[1], textMatrix[2], textMatrix[3],
            textMatrix[4] + adv * textMatrix[0], textMatrix[5] + adv * textMatrix[1]];
          break;
        }
      }
    }

    const MATCH_TOLERANCE_PT = 6; // > la derive mesuree (~3.5 pt), < l'espacement entre segments distincts
    const used = new Array(samples.length).fill(false);
    let lastColor = [0, 0, 0];
    const colors = [];
    for (const it of items) {
      if (it.str === undefined || it.str.trim() === '') { colors.push(lastColor); continue; }
      const ix = it.transform[4], iy = it.transform[5];
      let best = -1, bestD = Infinity;
      for (let si = 0; si < samples.length; si++) {
        if (used[si]) continue;
        const d = Math.hypot(samples[si].x - ix, samples[si].y - iy);
        if (d < bestD) { bestD = d; best = si; }
      }
      if (best !== -1 && bestD < MATCH_TOLERANCE_PT) {
        used[best] = true;
        lastColor = samples[best].color;
      }
      colors.push(lastColor);
    }
    return colors;
  }

  function rgbToCss(c) {
    if (!c) return null;
    return 'rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ')';
  }

  // --- v0.3, lot 2 (S1/S2, decision E1) : lignes de decoupe et exemplaires --
  // Les fiches d'exercices repetent 3 a 5 fois le meme exercice, separe par
  // des lignes de decoupe (a decouper en classe) : recopies tels quels, ils
  // donnaient 8 pages par fiche. Decision E1 : UNE seule version.
  //
  // Ligne de decoupe = trait POINTILLE (motif de tirets, ou suite de tirets
  // dessines un par un) horizontal couvrant >= 80 % de la largeur de page, ou
  // vertical >= 60 % de la hauteur -- avec ou sans ciseaux a cote (plan v0.3,
  // lot 2, critere mesure le 22/09 sur les fiches). Un GROUPE de pointilles
  // paralleles, rapproches et de meme emprise, sans ciseaux, est au
  // contraire un ensemble de lignes d'ecriture (E3 : jamais restituees,
  // jamais un tableau, mais pas des frontieres de region non plus).
  function detectCutLines(pageShapes, pageW, pageH, scissors) {
    const src = (pageShapes.lines || []).concat(
      (pageShapes.decorative || []).filter((d) => Math.max(d.x1 - d.x0, d.y1 - d.y0) <= 4));
    const spans = [];
    for (const orient of ['h', 'v']) {
      const along = orient === 'h' ? ['x0', 'x1'] : ['y0', 'y1'];
      const across = (l) => (orient === 'h' ? (l.y0 + l.y1) / 2 : (l.x0 + l.x1) / 2);
      const thin = src.filter((l) => (orient === 'h' ? (l.y1 - l.y0) < 1.5 && (l.x1 - l.x0) >= (l.y1 - l.y0)
        : (l.x1 - l.x0) < 1.5 && (l.y1 - l.y0) > (l.x1 - l.x0)) || Math.max(l.x1 - l.x0, l.y1 - l.y0) <= 4);
      const byPos = new Map();
      for (const l of thin) {
        const k = Math.round(across(l));
        if (!byPos.has(k)) byPos.set(k, []);
        byPos.get(k).push(l);
      }
      for (const [pos, group] of byPos) {
        group.sort((a, b) => a[along[0]] - b[along[0]]);
        let cur = null;
        for (const l of group) {
          if (cur && l[along[0]] - cur.end <= 10) {
            cur.end = Math.max(cur.end, l[along[1]]); cur.members.push(l); cur.dashed = cur.dashed || !!l.dashed;
          } else {
            if (cur) spans.push(cur);
            cur = { orient, pos, start: l[along[0]], end: l[along[1]], members: [l], dashed: !!l.dashed };
          }
        }
        if (cur) spans.push(cur);
      }
    }
    const nearScissors = (sp) => (scissors || []).some((sc) => (sp.orient === 'h'
      ? Math.abs(sc.y - sp.pos) < 20 && sc.x >= sp.start - 30 && sc.x <= sp.end + 30
      : Math.abs(sc.x - sp.pos) < 20 && sc.y >= sp.start - 30 && sc.y <= sp.end + 30));
    const candidates = spans.filter((sp) => {
      const len = sp.end - sp.start;
      const longEnough = sp.orient === 'h' ? len >= 0.8 * pageW : len >= 0.6 * pageH;
      const pointille = sp.dashed || sp.members.length >= 8;
      return longEnough && (pointille || nearScissors(sp));
    });
    return candidates.filter((sp) => {
      if (nearScissors(sp)) return true;
      const writingGroup = candidates.some((o) => o !== sp && o.orient === sp.orient &&
        Math.abs(o.pos - sp.pos) <= 40 && Math.abs(o.start - sp.start) < 6 && Math.abs(o.end - sp.end) < 6);
      return !writingGroup;
    }).map((sp) => ({
      orient: sp.orient, pos: sp.pos, start: sp.start, end: sp.end, members: sp.members,
    }));
  }

  // Decoupe la page en regions (sous-pages) selon les lignes de decoupe :
  // bandes horizontales, puis colonnes a l'interieur d'une bande quand une
  // ligne verticale la traverse. Ordre de lecture : haut -> bas, gauche ->
  // droite. Aucune ligne de decoupe : une seule region (la page).
  function buildRegions(cuts, pageW, pageH) {
    const hs = cuts.filter((c) => c.orient === 'h').map((c) => c.pos).sort((a, b) => b - a);
    const vs = cuts.filter((c) => c.orient === 'v');
    const bounds = [pageH + 1, ...hs, -1];
    const regions = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const top = bounds[i], bottom = bounds[i + 1];
      if (top - bottom < 2) continue;
      const xs = vs.filter((v) => Math.min(top, v.end) - Math.max(bottom, v.start) > 0.5 * (top - bottom))
        .map((v) => v.pos).sort((a, b) => a - b);
      const xb = [-1, ...xs, pageW + 1];
      for (let j = 0; j < xb.length - 1; j++) {
        regions.push({ x0: xb[j], x1: xb[j + 1], y0: bottom, y1: top });
      }
    }
    return regions;
  }
  const inRegion = (r, x, y) => x >= r.x0 && x < r.x1 && y > r.y0 && y <= r.y1;
  function regionIndexOf(regions, x, y) {
    for (let i = 0; i < regions.length; i++) if (inRegion(regions[i], x, y)) return i;
    return -1;
  }

  // E1 : une region dont le texte normalise est CONTENU dans celui d'une
  // region precedente (egalite, ou precedente = meme texte + titre de page)
  // est un exemplaire en double. Marquee, pas supprimee : decision
  // d'affichage, comme le contenu secondaire (Z3).
  function normalizeForDedup(text) {
    return text.toLowerCase().normalize('NFD').replace(/[^\p{L}\p{N}]/gu, '');
  }
  function markDuplicateRegions(regions, lines) {
    const texts = regions.map(() => []);
    const sorted = lines.slice().sort((a, b) => (b.y - a.y) || (a.x0 - b.x0));
    for (const l of sorted) {
      const ri = regionIndexOf(regions, l.x0 + 1, l.y);
      if (ri >= 0) texts[ri].push(l.text);
    }
    const norm = texts.map((t) => normalizeForDedup(t.join(' ')));
    for (let i = 0; i < regions.length; i++) {
      if (norm[i].length < 10) continue;
      for (let j = 0; j < i; j++) {
        if (!regions[j].duplicate && norm[j].includes(norm[i])) { regions[i].duplicate = true; regions[i].duplicateOf = j; break; }
      }
    }
  }

  // Point d'entree principal.
  async function extractNativePdf(pdfDoc, onProgress) {
    const pagesLines = [];
    const pageMeta = [];
    for (let p = 1; p <= pdfDoc.numPages; p++) {
      const page = await pdfDoc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const opList = await page.getOperatorList();
      const OPS = window.pdfjsLib.OPS;

      const colors = extractTextColors(opList, OPS, textContent.items);
      const styles = [];
      for (let idx = 0; idx < textContent.items.length; idx++) {
        styles.push({ ...resolveFontStyle(page, textContent.items[idx]), color: colors[idx] });
      }

      let pageShapes = { boxes: [], lines: [], decorative: [] };
      let colBoundaries = [];
      // ADDENDUM 6, Z12, lot 3 (point 2) -- sizableBoxes/tables calcules ici
      // pour les colBoundaries (Z10) sont EXACTEMENT ce dont a besoin le
      // partitionnement par conteneur plus bas (avant construction des
      // paragraphes) : persistes dans pageMeta pour ne pas les recalculer
      // (et surtout ne pas risquer une divergence entre les deux usages).
      let sizableBoxes = [];
      let tables = [];
      let regions = null;
      try {
        pageShapes = classifyShapes(extractPaintedShapes(opList, OPS), viewport.width);
        sizableBoxes = pageShapes.boxes.filter((b) => (b.x1 - b.x0) > 20 && (b.y1 - b.y0) > 20);
        const roughLines0 = roughLinePositions(textContent.items);
        const sizeCounts = new Map();
        for (const l of roughLines0) { const k = Math.round(l.size * 2) / 2; sizeCounts.set(k, (sizeCounts.get(k) || 0) + 1); }
        let modalRough = null, modalN = 0;
        for (const [k, n] of sizeCounts) if (n > modalN) { modalN = n; modalRough = k; }
        // v0.3, lot 2 (E1/S1) : lignes de decoupe (ciseaux reperes AVANT la
        // substitution de glyphes, qui les retire du texte).
        const scissors = textContent.items.filter((it) => it.str && SCISSORS_RE.test(it.str))
          .map((it) => ({ x: it.transform[4], y: it.transform[5] }));
        const cuts = detectCutLines(pageShapes, viewport.width, viewport.height, scissors);
        pageShapes.cutLines = cuts.map((c) => ({ orient: c.orient, pos: c.pos, start: c.start, end: c.end }));
        if (cuts.length) regions = buildRegions(cuts, viewport.width, viewport.height);
        const cutMembers = new Set(cuts.flatMap((c) => c.members));
        const cutLineShapes = pageShapes.lines.filter((l) => cutMembers.has(l));
        // v0.3, lot 1 (S6) : contraintes de detectTables (cf. son commentaire).
        tables = detectTables(pageShapes.lines, sizableBoxes, { modalSize: modalRough, textLines: roughLines0, cutLines: cutLineShapes });
        pageShapes.tables = tables;
        colBoundaries = tables.flatMap((t) => t.colBounds.map((x) => ({ x, y0: t.y0, y1: t.y1 })));
        // Une ligne de decoupe verticale separe deux exemplaires cote a cote :
        // deux items sur la meme ligne de base de part et d'autre ne forment
        // jamais une meme ligne physique.
        for (const c of cuts) if (c.orient === 'v') colBoundaries.push({ x: c.pos, y0: c.start, y1: c.end });

        // Bords de CHAQUE boite comme frontieres de colonne (ADDENDUM 6,
        // Z10). Bug reel trouve sur Sq4_Fiche1_lire_recettes.pdf : deux
        // boites VOISINES (grille 2x2 de recettes) ont leur contenu
        // fusionne en un seul paragraphe des que leurs titres/lignes
        // tombent a une ordonnee proche -- la rubrique "Ingrédients :" d'une
        // boite de recette se retrouvait accrochee a la rubrique
        // "préparation :" d'une boite VOISINE (autre recette de la meme
        // rangee de la grille). Sans frontiere entre les deux boites,
        // rien ne distingue "meme colonne, lignes adjacentes" (a fusionner)
        // de "boites differentes, juste proches en Y" (a ne jamais
        // fusionner). Ajoute donc x0 ET x1 de CHAQUE boite, pas seulement
        // les tableaux bordes.
        for (const box of sizableBoxes) {
          colBoundaries.push({ x: box.x0, y0: box.y0, y1: box.y1 }, { x: box.x1, y0: box.y0, y1: box.y1 });
        }

        // Colonnes de texte sans bordure a l'interieur d'une boite (Z10,
        // voir detectColumnSplitX). N'affecte que les boites qui ne sont
        // pas deja couvertes par un tableau borde (sinon double-detection
        // sans consequence, mais inutile).
        const roughLines = roughLinePositions(textContent.items);
        for (const box of sizableBoxes) {
          const inBoxTable = tables.some((t) => Math.abs(box.x0 - t.x0) < 3 && Math.abs(box.x1 - t.x1) < 3);
          if (inBoxTable) continue;
          const linesInBox = roughLines.filter((l) => l.x0 >= box.x0 - 2 && l.x0 <= box.x1 + 2 && l.y >= box.y0 && l.y <= box.y1);
          const splitX = detectColumnSplitX(linesInBox, box.x0, box.x1 - box.x0);
          if (splitX !== null) colBoundaries.push({ x: splitX, y0: box.y0, y1: box.y1 });
        }
      } catch (e) { /* geometrie best-effort : la ligne de base texte reste exploitable sans elle */ }

      let lines = groupIntoLines(textContent.items, styles, pageShapes.lines, colBoundaries, pageShapes.decorative);
      pagesLines.push(lines);
      if (regions) pageShapes.regions = regions;
      pageMeta.push({ width: viewport.width, height: viewport.height, page, opList, shapes: pageShapes, colBoundaries, sizableBoxes, tables, regions });
      if (onProgress) onProgress({ phase: 'extraction-texte', page: p, total: pdfDoc.numPages });
    }

    const pageHeight = pageMeta[0] ? pageMeta[0].height : 800;
    const isHeaderFooter = detectRepeatedHeaderFooter(pagesLines, pageHeight);

    const blocks = [];
    let totalChars = 0;
    let qualityUsablePages = 0;
    const perPageQuality = [];

    for (let p = 0; p < pagesLines.length; p++) {
      let lines = pagesLines[p].filter((l) => !isHeaderFooter(l));
      const pageText = lines.map((l) => l.text).join(' ');
      totalChars += pageText.length;
      const quality = assessTextQuality(pageText);
      perPageQuality.push(quality);
      if (quality.usable) qualityUsablePages += 1;

      if (!quality.usable) {
        // Couche texte inexploitable -> ne produit aucun bloc pour cette page ;
        // le pipeline appelant devra la faire passer par l'OCR (voir 02-ocr.js).
        blocks.push({ type: 'needs-ocr', runs: [], srcPage: p + 1 });
        continue;
      }

      const modalSize = computeModalSize(lines);

      // ADDENDUM 6, Z3/Z4.4quinquies : ecarte les lignes secondaires (mention
      // d'editeur/copyright, petit corps pres d'un bord de page) AVANT toute
      // detection de colonnes ou construction de paragraphe -- pas seulement
      // apres coup sur le bloc final. Bug reel observe sur 10_FicheOrtho.pdf
      // (20/09/2026) : "© Retz", en marge droite tournee a 90 deg, tombe
      // numeriquement (par sa seule coordonnee Y brute) EN PLEIN MILIEU de la
      // sequence de lignes du tableau, forcant une coupure de paragraphe
      // injustifiee (une phrase de prose en cours) en deux blocs au lieu
      // d'un seul. Filtrer apres coup (sur le bloc
      // deja construit) aurait bien masque le texte du copyright, mais pas
      // reparé la coupure qu'il avait deja provoquee en amont.
      const pw = pageMeta[p].width, ph = pageMeta[p].height;
      const isSecondaryLine = (l) => {
        const nearMargin = l.x0 < pw * 0.08 || l.x1 > pw * 0.92 || l.y < ph * 0.08 || l.y > ph * 0.92;
        return l.size < modalSize * 0.75 && nearMargin;
      };
      const secondaryLines = lines.filter(isSecondaryLine);
      lines = lines.filter((l) => !isSecondaryLine(l));

      pageMeta[p].modalSize = modalSize;

      // Bande de colonne de tableau (Z4.4bis) : deux lignes de part et
      // d'autre d'une frontiere de colonne ne doivent jamais fusionner
      // dans le meme paragraphe, meme Y-adjacentes et de meme style --
      // sinon le libelle d'une cellule ("Noms") se retrouve accroche au
      // debut du texte de la cellule voisine (bug reel, 10_FicheOrtho.pdf,
      // 20/09/2026 : la coupe de groupIntoLines separe bien les lignes,
      // mais sans ce controle ici, flushPara les refusionnait quand meme).
      const pageColBoundaries = pageMeta[p].colBoundaries || [];
      function columnBand(x, y) {
        let band = 0;
        for (const b of boundariesAt(pageColBoundaries, y)) if (x >= b) band++;
        return band;
      }

      // Construit les paragraphes d'UN groupe de lignes (independant de
      // tout autre groupe -- cf. partitionnement par conteneur ci-dessous).
      // Corps de boucle inchange depuis avant ce lot ; seule sa PORTEE a
      // change (un groupe = un conteneur ou une colonne de flux libre,
      // jamais plus).
      function buildParagraphsFromLines(groupLines, rightEdge) {
        // v0.3 (limite « listes sans puce » du README) : bord droit du texte
        // de ce groupe = la ligne la plus longue (un texte qui n'occupe pas
        // toute la largeur, ou qui contourne une image, ne doit pas voir
        // chacune de ses lignes prise pour un retour force). Exception : un
        // groupe dont AUCUNE ligne n'approche le bord estime (`rightEdge`,
        // marges supposees symetriques) n'est fait que de lignes courtes --
        // une liste pure : c'est alors ce bord estime qui fait foi, sinon
        // l'item le plus long absorberait le suivant.
        // Par bande de colonne (colonne de tableau, colonne interne d'une
        // boite) : le bord droit d'une cellule n'est pas celui du tableau.
        const maxX1ByBand = new Map();
        for (const l of groupLines) {
          const b = columnBand(l.x0, l.y);
          maxX1ByBand.set(b, Math.max(maxX1ByBand.get(b) || 0, l.x1 || 0));
        }
        const bands = new Set(groupLines.map((l) => columnBand(l.x0, l.y)));
        const textRightFor = (l) => {
          const maxX1 = maxX1ByBand.get(columnBand(l.x0, l.y)) || 0;
          return rightEdge && bands.size === 1 && maxX1 < 0.85 * rightEdge ? rightEdge : maxX1;
        };
        let paraLines = [];
        let lastLine = null;
        const flushPara = () => {
          if (!paraLines.length) return;
          // Recolle les cesures entre lignes du paragraphe
          let runs = [];
          for (let i = 0; i < paraLines.length; i++) {
            const l = paraLines[i];
            if (runs.length) {
              const prevRun = runs[runs.length - 1];
              const joined = joinHyphenation(prevRun.text, l.runs[0] ? l.runs[0].text : '');
              if (joined !== null) {
                prevRun.text = joined;
                runs = runs.concat(l.runs.slice(1));
                continue;
              }
              prevRun.text += ' ';
            }
            runs = runs.concat(l.runs.map((r) => ({ ...r })));
          }
          const size = paraLines[0].size;
          const isHeading = size > modalSize * 1.15;
          const isListItem = detectListMarker(paraLines[0].text);
          let type = 'p';
          if (isHeading) {
            if (size > modalSize * 1.45) type = 'h1';
            else if (size > modalSize * 1.25) type = 'h2';
            else type = 'h3';
          } else if (isListItem) {
            type = 'li';
            if (runs[0]) runs[0].text = stripListMarker(runs[0].text);
          }
          // Bbox approximative du paragraphe (ADDENDUM 6, Z4.4) : sert a
          // l'associer a une boite/cellule de table conteneur. Precision
          // suffisante pour un test de recouvrement, pas pour un rendu direct.
          const x0 = Math.min(...paraLines.map((l) => l.x0));
          const x1 = Math.max(...paraLines.map((l) => l.x1));
          const yTop = Math.max(...paraLines.map((l) => l.y)) + paraLines[0].size;
          const yBottom = Math.min(...paraLines.map((l) => l.y)) - paraLines[paraLines.length - 1].size * 0.3;
          // ADDENDUM 6, Z3/Z4.4quater : contenu secondaire (mention d'editeur,
          // copyright), detecte par corps nettement plus petit que le corps
          // median de la page ET position pres d'un bord (n'importe lequel :
          // la mention peut etre tournee a 90 deg en marge droite, cf.
          // 10_FicheOrtho.pdf ou la mention d'editeur en marge est a 7 pt
          // contre ~12 pt de corps median, sur la marge droite).
          // Version basique : masque par defaut, pas encore de case a cocher
          // pour le reafficher (prevu au plan, pas fait) -- mieux vaut ne pas
          // l'afficher du tout que de le laisser polluer le flux au mauvais
          // endroit (remonte par Loic le 20/09/2026).
          const pw = pageMeta[p].width, ph = pageMeta[p].height;
          const nearMargin = x0 < pw * 0.08 || x1 > pw * 0.92 || yBottom < ph * 0.08 || yTop > ph * 0.92;
          const secondary = size < modalSize * 0.75 && nearMargin;
          // `size` (corps PDF source, en pt) expose en aval (ADDENDUM 6,
          // Z12, D2) : isHeading ci-dessus compare au corps median de la
          // PAGE ENTIERE, or un bloc peut appartenir a une boite/cellule
          // ayant son propre corps median tres different -- 03-layout-
          // engine.js recalcule alors le type "titre ?" localement au
          // conteneur une fois l'association bloc<->conteneur connue
          // (assignBlocksToContainers), ce qui n'est pas encore le cas ICI.
          blocks.push({ type, runs, srcPage: p + 1, bbox: { x0, x1, y0: yBottom, y1: yTop }, secondary, size });
          paraLines = [];
        };

        // ADDENDUM 6, Z12, D1 -- une ligne qui commence par un marqueur de
        // liste ouvre TOUJOURS un nouveau paragraphe, meme quand le style et
        // l'interligne avec la ligne precedente ne distinguaient rien (cas
        // reel : 2_Memo_Carte_indiv1.pdf, une liste a puces de 3 items
        // (une definition par type) sont 3 lignes sources distinctes,
        // memes taille/police/interligne, que flushPara()
        // fusionnait donc en un seul paragraphe -- alors que la source a
        // une ligne par type). splitLineAtEmbeddedMarkers() traite en amont
        // le cas ou plusieurs marqueurs sont dans la MEME ligne source
        // (Sq4, "Ustensiles : • ... • ...") en la scindant d'abord en
        // lignes virtuelles qui, elles, commencent chacune par un marqueur
        // et retombent donc dans cette meme regle.
        // ADDENDUM 6, Z12, D3 -- meme principe que D1 ci-dessus, pour deux
        // mini-colonnes SANS marqueur bout a bout sur la meme ligne source
        // (deux items de liste « Libelle : quantite », Sq4). splitLineAtColumnGaps()
        // scinde aux grands ecarts horizontaux deja reperes par
        // buildLineFromItems() (l.gapSplits) ; applique APRES le split par
        // marqueur pour que les deux se combinent sur une ligne qui aurait
        // les deux (non rencontre sur les 3 documents cibles, mais sans
        // hypothese d'exclusion mutuelle).
        const expandedLines = groupLines
          .flatMap(splitLineAtEmbeddedMarkers)
          .flatMap(splitLineAtColumnGaps);
        for (const l of expandedLines) {
          if (lastLine) {
            const interline = lastLine.size * 1.2;
            const sameStyle = Math.abs(l.size - lastLine.size) < 0.5;
            const gap = lastLine.y - l.y;
            // Deux lignes de part et d'autre d'une frontiere valable a LEUR
            // hauteur (celle de la ligne precedente ou de la courante).
            const columnChange = columnBand(l.x0, l.y) !== columnBand(lastLine.x0, l.y) ||
              columnBand(l.x0, lastLine.y) !== columnBand(lastLine.x0, lastLine.y);
            const opensListItem = detectListMarker(l.text);
            // ADDENDUM 6, Z12, lot 3 (point 2, effet de bord decouvert EN
            // VERIFIANT le partitionnement par conteneur ci-dessus, sur le
            // PDF reellement exporte) -- correctif du 20/09/2026. Avant le
            // partitionnement par conteneur, une ligne d'un AUTRE conteneur
            // s'intercalait parfois par coincidence de Y entre deux lignes
            // d'un MEME conteneur, forcant -- pour la mauvaise raison -- une
            // coupure entre deux faits courts empiles SANS marqueur ni grand
            // ecart (ex. Sq4, boite de recette : plusieurs lignes de
            // metadonnees courtes (nombre de parts, temps de preparation,
            // temps de cuisson), ~14pt d'ecart entre chaque ligne -- sous
            // le seuil normal 1.6*interligne). Le partitionnement, correct,
            // a retire cette coupure ACCIDENTELLE : ces lignes se
            // fusionnaient alors TOUJOURS en un seul paragraphe -- y
            // compris un segment D3 tout juste ouvert (un item de liste
            // « Libelle : quantite », afterSplit) qui se refaisait
            // immediatement absorber par l'item suivant, defaisant le
            // correctif D3.
            // Signal retenu, verifie sur les 3 documents cibles : une ligne
            // qui NE COMMENCE PAS par une minuscule n'est, en francais,
            // quasiment jamais la suite grammaticale de la ligne precedente
            // -- une vraie continuation de phrase commence presque toujours
            // par une minuscule (ex. la suite d'une consigne de recette en
            // cours de phrase).
            // Garde-fou ajoute apres un second passage de verification sur
            // le PDF EXPORTE (pas seulement l'apercu) : cette regle seule
            // cassait une consigne de recette en 2 phrases completes
            // (Sq4, boite de recette) en 2 paragraphes -- la 2e phrase
            // commence par une majuscule, mais c'est la 2e PHRASE d'une
            // meme puce (consigne en plusieurs phrases completes), pas un
            // nouveau fait isole. Distinction retenue : si la ligne
            // PRECEDENTE se termine deja par une ponctuation de fin de
            // phrase (. ! ?), tout ce qui suit -- meme au style Sujet-Verbe
            // capitalise -- est une phrase de PLUS dans le MEME paragraphe,
            // jamais un nouveau fait isole (qui, lui, ne se termine jamais
            // par un point : les lignes de metadonnees courtes d'une boite
            // de recette -- aucune ponctuation de fin de phrase).
            // v0.3 -- retour a la ligne FORCE : la ligne precedente s'arrete
            // nettement avant le bord droit du texte alors que le premier mot
            // de celle-ci y aurait tenu. Un retour a la ligne automatique ne
            // laisse jamais autant de place : c'est donc un nouvel item (liste
            // sans puce -- une liste de valise ne doit plus se lire comme un
            // paragraphe). Pas pour un titre (titre sur deux lignes voulu).
            const firstWord = (l.text.trim().split(/\s+/)[0] || '');
            const charW = (l.x1 - l.x0) / Math.max(1, l.text.length);
            const slack = textRightFor(lastLine) - lastLine.x1;
            const forcedBreak = lastLine.size <= modalSize * 1.15 && !/-$/.test(lastLine.text.trim()) &&
              slack > 1.3 * firstWord.length * charW + 0.3 * lastLine.size;
            const prevEndsSentence = /[.!?]\s*$/.test(lastLine.text.trim());
            const looksLikeNewFact = !prevEndsSentence && !/^[a-zà-öø-ÿ]/.test(l.text.trimStart());
            // D3 : un segment issu d'une coupure (afterSplit, cf.
            // sliceLineAtOffsets) ouvre toujours un nouveau paragraphe lui
            // aussi, meme sans marqueur de liste en tete (cas d'un item de
            // liste « Libelle : quantite »).
            if (!sameStyle || gap > 1.6 * interline || gap <= 0 || columnChange || opensListItem || l.afterSplit || looksLikeNewFact || forcedBreak) {
              flushPara();
            }
          }
          paraLines.push(l);
          lastLine = l;
        }
        flushPara();
      }

      // ADDENDUM 6, Z12, lot 3 (point 2) -- correctif du 20/09/2026 (racine
      // deja tracee, cf. commit D3 : une consigne de recette wrappee sur 2
      // lignes source coupee en 2 paragraphes, le second desindente).
      // AVANT : toutes les lignes de la page passaient par UN SEUL flux,
      // trie par Y (detectColumns) -- une ligne d'un encadre VOISIN de la
      // grille 2x2 (ex. un item de liste d'ingredient d'une boite de
      // recette) pouvait tomber, par pure coincidence d'ordonnee, ENTRE
      // deux lignes d'un AUTRE encadre (une boite de recette voisine), et
      // le garde-fou anti-fusion inter-colonnes (columnChange, Z4.4bis --
      // pense pour ne JAMAIS fusionner deux conteneurs distincts) les
      // separait alors a tort l'une de l'autre : une meme phrase, wrappee
      // sur 2 lignes SOURCE, finissait coupee en 2 paragraphes. Confirme
      // par instrumentation avant ce correctif (console.warn temporaire) :
      // `lastLine` de la 2e moitie de phrase etait bien une ligne d'UNE
      // AUTRE boite, pas la 1ere moitie de la meme phrase.
      //
      // Partitionne desormais les lignes PAR CONTENEUR (boite ou tableau,
      // deja detectes plus haut pour colBoundaries -- cf. pageMeta[p]
      // .sizableBoxes/.tables) AVANT tri par Y et construction des
      // paragraphes : chaque conteneur recoit son PROPRE flux, traite
      // independamment -- aucune ligne d'un AUTRE conteneur ne peut plus
      // jamais s'y intercaler. Les lignes hors de tout conteneur suivent
      // le chemin EXISTANT (detectColumns, pour un vrai layout 2 colonnes
      // de page, inchange par ce lot).
      //
      // Conteneurs tries par AIRE CROISSANTE (meme principe que freeBoxes
      // en 03-layout-engine.js) : une boite imbriquee dans une autre
      // (bande decorative englobante, cf. 2_Memo_Carte_indiv1.pdf) doit
      // capter ses lignes AVANT l'englobante, sinon celle-ci les captensuite
      // en premier et la boite interieure reste vide.
      const containers = [
        ...pageMeta[p].sizableBoxes.map((b) => ({ x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1 })),
        ...pageMeta[p].tables.map((t) => ({ x0: t.x0, x1: t.x1, y0: t.y0, y1: t.y1, isTable: true })),
      ].sort((a, b) => (a.x1 - a.x0) * (a.y1 - a.y0) - (b.x1 - b.x0) * (b.y1 - b.y0));

      const containerLines = containers.map(() => []);
      const freeLines = [];
      lineLoop: for (const l of lines) {
        for (let ci = 0; ci < containers.length; ci++) {
          const c = containers[ci];
          if (l.x0 >= c.x0 - 2 && l.x0 <= c.x1 + 2 && l.y >= c.y0 - 2 && l.y <= c.y1 + 2) {
            containerLines[ci].push(l);
            continue lineLoop;
          }
        }
        freeLines.push(l);
      }

      containerLines.forEach((cLines, ci) => {
        if (!cLines.length) return;
        // Bord droit du texte dans le conteneur : rembourrage suppose
        // symetrique (meme retrait a droite qu'a gauche).
        const c = containers[ci];
        const minX0 = Math.min(...cLines.map((l) => l.x0));
        buildParagraphsFromLines(cLines, c.isTable ? 0 : c.x1 - Math.max(0, minX0 - c.x0));
      });

      // v0.3, lot 2 (S1) : les lignes de flux libre sont regroupees PAR
      // REGION de decoupe avant la detection de colonnes et la construction
      // des paragraphes -- aucune fusion a travers une ligne de decoupe.
      const pageRegions = pageMeta[p].regions;
      const pageBox = { x0: 0, x1: pageMeta[p].width };
      const freeGroups = pageRegions
        ? pageRegions.map((r) => ({ lines: freeLines.filter((l) => inRegion(r, l.x0 + 1, l.y)), zone: r }))
        : [{ lines: freeLines, zone: pageBox }];
      if (pageRegions) {
        const orphan = freeLines.filter((l) => regionIndexOf(pageRegions, l.x0 + 1, l.y) < 0);
        if (orphan.length) freeGroups.push({ lines: orphan, zone: pageBox });
      }
      for (const { lines: group, zone } of freeGroups) {
        if (!group.length) continue;
        const cols = detectColumns(group, pageMeta[p].width);
        // Flux libre sur une seule colonne : marges supposees symetriques
        // dans sa zone (page, ou region de decoupe). Sur deux colonnes : la
        // ligne la plus longue de chaque colonne fait foi.
        const zx0 = Math.max(0, zone.x0), zx1 = Math.min(pageMeta[p].width, zone.x1);
        for (const colLines of cols) {
          const minX0 = Math.min(...colLines.map((l) => l.x0));
          buildParagraphsFromLines(colLines, cols.length === 1 ? zx1 - Math.max(0, minX0 - zx0) : 0);
        }
      }
      // Lignes secondaires ecartees plus haut : produites en blocs a part,
      // tagues, jamais perdues -- mais APRES la boucle principale pour ne
      // plus jamais interferer avec sa logique de paragraphe (Z3/Z4.4quinquies).
      for (const l of secondaryLines) {
        blocks.push({
          type: 'p', runs: l.runs, srcPage: p + 1, secondary: true,
          bbox: { x0: l.x0, x1: l.x1, y0: l.y - l.size * 0.3, y1: l.y + l.size },
        });
      }
      // v0.3, lot 2 (E1/S2) : exemplaires en double, marques (jamais
      // supprimes) -- bloc, et plus bas images, dont le centre tombe dans
      // une region en double.
      if (pageRegions) {
        markDuplicateRegions(pageRegions, lines);
        for (const b of blocks) {
          if (b.srcPage !== p + 1 || !b.bbox) continue;
          const ri = regionIndexOf(pageRegions, (b.bbox.x0 + b.bbox.x1) / 2, (b.bbox.y0 + b.bbox.y1) / 2);
          if (ri >= 0 && pageRegions[ri].duplicate) b.duplicate = true;
        }
      }
      try {
        // ADDENDUM 6, Z12, C2 -- bbox des blocs de texte CONSERVES (affiches
        // en texte adapte) de CETTE page, pour que extractImageBlocksForPage
        // les blanchisse avant de recadrer -- sinon un titre/texte situe
        // sous une image finit duplique (une fois en texte, une fois fige
        // dans les pixels de l'image recadree). `secondary` explicitement
        // exclu : ce texte n'est affiche NULLE PART ailleurs (masque par
        // defaut, Z3/Z4.4quater), le laisser dans l'image ne duplique rien.
        const keptTextBboxes = blocks
          .filter((b) => b.srcPage === p + 1 && b.bbox && !b.secondary && b.type !== 'image')
          .map((b) => b.bbox);
        const imageBlocks = await extractImageBlocksForPage(pdfDoc, p + 1, pageMeta[p].page, pageMeta[p].opList, keptTextBboxes);
        if (pageRegions) {
          for (const ib of imageBlocks) {
            const ri = regionIndexOf(pageRegions, (ib.bbox.x0 + ib.bbox.x1) / 2, (ib.bbox.y0 + ib.bbox.y1) / 2);
            if (ri >= 0 && pageRegions[ri].duplicate) ib.duplicate = true;
          }
        }
        blocks.push(...imageBlocks);
      } catch (e) { /* extraction d'image best-effort : echec silencieux, texte preserve */ }
      blocks.push({ type: 'pagebreak', runs: [], srcPage: p + 1 });
    }

    return {
      blocks,
      pageShapes: pageMeta.map((m) => m.shapes),
      pageSizes: pageMeta.map((m) => ({ width: m.width, height: m.height, modalSize: m.modalSize || 12 })),
      stats: {
        pageCount: pdfDoc.numPages,
        totalChars,
        qualityUsablePages,
        perPageQuality,
      },
    };
  }

  // --- ADDENDUM 4, section T.2 : detection des pages liminaires (page de
  // garde, page de copyright) par densite de signaux typiques -- ISBN,
  // mentions legales, numero d'edition, coordonnees postales/telephoniques.
  // Optionnelle a l'usage (case a cocher, cochee par defaut) : on se
  // contente ici de TAGUER les pages candidates, le filtrage effectif se
  // fait au moment de la mise en page (05-main.js), pour rester reversible
  // sans reextraire/reOCRiser le document.
  function scoreFrontMatterSignals(text) {
    const signals = [
      /\bISBN\b/i,
      /tous droits r[ée]serv[ée]s|droits r[ée]serv[ée]s/i,
      /d[ée]p[ôo]t l[ée]gal|num[ée]ro d['’]?[ée]dition/i,
      /\bT[ée]l\.?\s*:|\bFax\s*:/i,
      /\d{2}[\s.]\d{2}[\s.]\d{2}[\s.]\d{2}[\s.]\d{2}/, // telephone FR
      /\b\d{5}\b\s+[A-ZÀ-Ý]/, // code postal + ville
      /©|copyright/i,
      /imprim[ée]\s*(et\s*reli[ée]\s*)?en/i,
      /[ée]dition[s]?\b/i,
    ];
    let hits = 0;
    for (const re of signals) if (re.test(text)) hits += 1;
    return hits;
  }

  function detectFrontMatterPages(blocks) {
    const perPageText = new Map();
    for (const b of blocks) {
      if (!b.srcPage || !b.runs) continue;
      const t = b.runs.map((r) => r.text).join(' ');
      perPageText.set(b.srcPage, (perPageText.get(b.srcPage) || '') + ' ' + t);
    }
    const flagged = new Set();
    for (const [page, text] of perPageText) {
      if (scoreFrontMatterSignals(text) >= 3) flagged.add(page);
    }
    return flagged;
  }

  window.ExtractNative = {
    extractNativePdf,
    assessTextQuality,
    ensureWordlist,
    joinHyphenation,
    rejoinHyphensInText,
    detectFrontMatterPages,
    detectListMarker,
    stripListMarker,
    extractPageShapes,
    detectTables,
  };
})();
