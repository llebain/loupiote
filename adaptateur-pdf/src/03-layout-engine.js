/* ============================================================================
 * 03-layout-engine.js
 * Moteur de mise en page : UNE SEULE passe de calcul, DEUX rendus (apercu DOM
 * et export PDF proviennent de la MEME liste de lignes positionnees).
 * L'autorite metrologique est jsPDF (doc.getTextWidth avec la Luciole
 * embarquee) : c'est elle qui decide des retours a la ligne.
 * ==========================================================================*/

(function () {
  'use strict';

  const MM_TO_PT = 2.83464567;
  const MARGIN_MM = 20;

  const DEFAULTS = Object.freeze({
    fontSize: 24,       // pt, preset conforme par defaut (plancher reel : 20, cf. clampSettings)
    lineHeight: 1.5,    // plancher absolu
    contrast: 'noir-blanc',
    letterSpacing: 'normal', // normal | 0.05em | 0.1em
    wordSpacing: 'normal',   // normal | elargi
    showImages: true,
    orientation: 'portrait',
    skipFrontMatter: true, // ADDENDUM 4, section T.2 : ignore pages de garde/copyright par defaut
    colorMode: 'couleur',   // ADDENDUM 6, section Z5 : 'couleur' | 'nb' -- decision d'affichage,
                            // appliquee aux couleurs deja extraites (formes + texte), jamais a
                            // l'extraction elle-meme
  });

  const CONTRAST_THEMES = {
    'noir-blanc': { bg: '#ffffff', fg: '#000000' },
    'blanc-noir': { bg: '#000000', fg: '#ffffff' },
    'jaune-bleu': { bg: '#0a1a3c', fg: '#ffe066' },
    'noir-creme': { bg: '#faf3e0', fg: '#000000' },
  };

  function clampSettings(s) {
    const out = { ...DEFAULTS, ...s };
    // ADDENDUM 6, section Z2 : plancher abaisse de 24 a 20 pt -- mesure sur
    // capHeight de Luciole-Regular (763/1000 em) : 20 pt = 5,38 mm de hauteur
    // de capitale, au-dessus du seuil de 0,5 cm (~8% de marge). Ne jamais
    // descendre sous 20, ni remonter le plancher au-dela sans reverifier la
    // mesure.
    out.fontSize = Math.max(20, Number(out.fontSize) || 24);
    if (![1.5, 1.75, 2].includes(Number(out.lineHeight))) out.lineHeight = 1.5;
    out.lineHeight = Math.max(1.5, Number(out.lineHeight));
    if (!CONTRAST_THEMES[out.contrast]) out.contrast = 'noir-blanc';
    if (out.colorMode !== 'nb') out.colorMode = 'couleur';
    return out;
  }

  function pageDimsPt(orientation) {
    const A4W = 210 * MM_TO_PT, A4H = 297 * MM_TO_PT;
    const portrait = { width: A4W, height: A4H };
    const landscape = { width: A4H, height: A4W };
    return orientation === 'paysage' ? landscape : portrait;
  }

  // Construit un moteur de mesure a partir d'un document jsPDF avec la
  // Luciole deja embarquee (voir 04-pdf-export.js: embedLucioleFonts).
  function makeMeasurer(jspdfDoc) {
    return {
      widthOf(text, sizePt, style) {
        jspdfDoc.setFont('Luciole', style || 'normal');
        jspdfDoc.setFontSize(sizePt);
        return jspdfDoc.getTextWidth(text);
      },
    };
  }

  // v0.3, lot 1 (E9, decision du 22/09/2026) : AUCUN italique, nulle part.
  // L'italique reste capte a l'extraction (run.italic, information
  // conservee dans le modele) mais n'est jamais rendu : italique -> romain,
  // gras-italique -> gras. Seul point de passage de tous les rendus
  // (apercu, export, mesure), donc la regle ne peut pas diverger.
  function styleForRun(run) {
    return run.bold ? 'bold' : 'normal';
  }

  // v0.3 (E5, defaut) -- en mode Noir & Blanc, ce que la couleur signalait
  // DANS un bloc (terminaison, graphème, mot mis en evidence) est marque
  // par du gras, ou par un souligne si le run est deja gras. « Signalait » =
  // run d'une couleur franche (non grise) DIFFERENTE de la couleur dominante
  // du bloc : un titre entierement colore n'est pas marque (la couleur y est
  // decorative, pas distinctive). Decision d'affichage : les runs source ne
  // sont pas modifies, une copie est rendue.
  function isChromatic(c) {
    if (!c) return false;
    const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
    return mx - mn > 40;
  }
  function sameColor(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return Math.abs(a[0] - b[0]) < 8 && Math.abs(a[1] - b[1]) < 8 && Math.abs(a[2] - b[2]) < 8;
  }
  // v0.3 (X1, plan lot 4) : un trou (suite de points de suspension) dans
  // une couleur pale -- sous 3:1 sur blanc -- est rendu dans la couleur du
  // theme : des points fins et pales sont invisibles pour un lecteur basse
  // vision meme une fois assombris juste au seuil (mesure : 1,86:1 a
  // l'ecran sur deux fiches d'exercices).
  const HOLE_RE = /^[\s.…_]+$/;
  function paleHoles(runs) {
    return runs.map((r) => (r.color && HOLE_RE.test(r.text || '') && /[.…_]/.test(r.text) &&
      contrastRatio(r.color, [255, 255, 255]) < 3 ? { ...r, color: null } : r));
  }
  function runsForDisplay(runs, settings) {
    if (!runs) return runs;
    runs = paleHoles(runs);
    if (settings.colorMode !== 'nb') return runs;
    const weights = [];
    for (const r of runs) {
      const n = (r.text || '').replace(/\s/g, '').length;
      const w = weights.find((x) => sameColor(x.color, r.color));
      if (w) w.n += n; else weights.push({ color: r.color, n });
    }
    weights.sort((a, b) => b.n - a.n);
    const dominant = weights.length ? weights[0].color : null;
    return runs.map((r) => {
      if (!isChromatic(r.color) || sameColor(r.color, dominant) || !(r.text || '').trim()) return r;
      return r.bold ? { ...r, underline: true } : { ...r, bold: true };
    });
  }

  function applySpacingToWidth(width, text, settings) {
    let w = width;
    if (settings.letterSpacing === '0.05em') w += text.length * settings.fontSize * 0.05;
    else if (settings.letterSpacing === '0.1em') w += text.length * settings.fontSize * 0.1;
    if (settings.wordSpacing === 'elargi') {
      const spaces = (text.match(/ /g) || []).length;
      w += spaces * settings.fontSize * 0.25;
    }
    return w;
  }

  // Decoupe une sequence de runs {text,bold,italic} en lignes tenant dans
  // `maxWidth`, en respectant les styles (gras/italique melanges dans une
  // meme ligne). Retourne un tableau de lignes = tableau de segments
  // {text, style, width}.
  // ADDENDUM 6, Z5 : compare deux couleurs RGB (tableaux [r,g,b], ou
  // absentes) pour la fusion de tokens -- deux `undefined` sont egaux, deux
  // references differentes mais memes valeurs aussi (les couleurs viennent
  // de extractTextColors(), rarement le meme objet meme quand identiques).
  function colorsSame(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  }

  // v0.3, lot 1 (W1) -- decoupe en MOTS, pas en tokens par run. Avant, la
  // tokenisation se faisait run par run : un mot fait de deux runs accoles
  // sans espace (lettre ou graphème colore en debut de mot, terminaison
  // coloree accolee au radical) donnait deux tokens independants, et le
  // retour a la ligne -- ou le saut de page -- pouvait tomber ENTRE les
  // deux (« E » en fin de page 1, « xemple » en tete de page 2). Un mot est
  // desormais une suite de morceaux (un par run) insecable ; seuls les
  // blancs coupent.
  //
  // v0.3, lot 1 (R3) -- dernier recours : un mot plus large que la ligne a
  // lui seul est coupe entre deux caracteres plutot que de deborder du
  // cadre (texte coupe au bord de la page ou de la cellule). Ne se produit
  // qu'au-dela de la largeur disponible, jamais pour un mot qui tient.
  function wrapRuns(runs, maxWidth, sizePt, measurer, settings) {
    const words = [];
    let cur = null;
    for (const run of runs) {
      const style = styleForRun(run);
      const parts = (run.text || '').split(/(\s+)/).filter((p) => p !== '');
      for (const part of parts) {
        const piece = { text: part, style, color: run.color, strikethrough: run.strikethrough, underline: run.underline };
        if (/^\s+$/.test(part)) { words.push({ space: true, pieces: [piece] }); cur = null; }
        else if (cur) cur.pieces.push(piece);
        else { cur = { space: false, pieces: [piece] }; words.push(cur); }
      }
    }
    const measurePiece = (pc) => applySpacingToWidth(measurer.widthOf(pc.text, sizePt, pc.style), pc.text, settings);
    for (const w of words) {
      for (const pc of w.pieces) pc.width = measurePiece(pc);
      w.width = w.pieces.reduce((a, pc) => a + pc.width, 0);
    }

    // Coupe un mot trop large en fragments qui tiennent chacun dans `max`
    // (au moins un caractere par fragment).
    function breakWord(word, max) {
      const out = [];
      let frag = { space: false, pieces: [], width: 0 };
      for (const pc of word.pieces) {
        let acc = '';
        for (const ch of pc.text) {
          const trial = { ...pc, text: acc + ch };
          const wTrial = measurePiece(trial);
          if (frag.width + wTrial > max && (frag.pieces.length || acc)) {
            if (acc) { const p2 = { ...pc, text: acc }; p2.width = measurePiece(p2); frag.pieces.push(p2); frag.width += p2.width; }
            out.push(frag);
            frag = { space: false, pieces: [], width: 0 };
            acc = ch;
          } else {
            acc += ch;
          }
        }
        if (acc) { const p2 = { ...pc, text: acc }; p2.width = measurePiece(p2); frag.pieces.push(p2); frag.width += p2.width; }
      }
      if (frag.pieces.length) out.push(frag);
      return out;
    }

    const lines = [];
    let current = [];
    let currentWidth = 0;

    function pushLine() {
      // Retire les espaces de fin de ligne
      while (current.length && current[current.length - 1].space) {
        currentWidth -= current[current.length - 1].width;
        current.pop();
      }
      if (current.length) lines.push(current);
      current = [];
      currentWidth = 0;
    }

    for (const word of words) {
      if (word.space) {
        if (current.length === 0) continue; // pas d'espace en debut de ligne
        current.push(word);
        currentWidth += word.width;
        continue;
      }
      // Tolerance d'un centieme de point : les largeurs de colonne sont des
      // sommes/differences de flottants, un mot mesure exactement a la
      // largeur de sa colonne ne doit pas etre coupe pour 1e-13 pt.
      const fragments = word.width > maxWidth + 0.01 ? breakWord(word, maxWidth) : [word];
      for (const frag of fragments) {
        if (currentWidth + frag.width > maxWidth + 0.01 && current.length > 0) pushLine();
        current.push(frag);
        currentWidth += frag.width;
      }
    }
    pushLine();

    // Fusionne les segments consecutifs de meme style en une chaine (pour le
    // rendu), tout en gardant la largeur totale de ligne.
    return lines.map((ws) => {
      const merged = [];
      for (const w of ws) {
        for (const s of w.pieces) {
          const last = merged[merged.length - 1];
          if (last && last.style === s.style && colorsSame(last.color, s.color) &&
              !!last.strikethrough === !!s.strikethrough && !!last.underline === !!s.underline) {
            last.text += s.text; last.width += s.width;
          } else {
            merged.push({ text: s.text, style: s.style, color: s.color, strikethrough: s.strikethrough, underline: s.underline, width: s.width });
          }
        }
      }
      const totalWidth = merged.reduce((a, s) => a + s.width, 0);
      return { segments: merged, width: totalWidth };
    });
  }

  const HEADING_FACTORS = { h1: 1.6, h2: 1.35, h3: 1.15 };

  // Calcule la mise en page complete. Retourne :
  //  { pages: [{ lines: [{y, segments}], images: [...] }],
  //    charsPerLineWarning: bool, avgCharsPerLine, pageDims }
  function computeLayout(blocks, settings, measurer) {
    settings = clampSettings(settings);
    const dims = pageDimsPt(settings.orientation);
    const margin = MARGIN_MM * MM_TO_PT;
    const usableWidth = dims.width - 2 * margin;
    const usableHeight = dims.height - 2 * margin;

    const bodySize = settings.fontSize;
    const bodyLineGap = bodySize * settings.lineHeight;
    const paraGap = bodyLineGap * 0.75;
    const headingGapBefore = bodyLineGap * 1.0;
    const headingGapAfter = bodyLineGap * 0.5;

    const pages = [];
    let curPage = { lines: [], images: [] };
    let y = margin;

    function newPage() {
      pages.push(curPage);
      curPage = { lines: [], images: [] };
      y = margin;
    }

    function remainingHeight() { return dims.height - margin - y; }

    let totalCharSamples = 0, totalLineSamples = 0;

    for (const block of blocks) {
      if (block.type === 'pagebreak') continue; // le pagebreak source n'implique pas un saut visuel : reflow continu
      if (block.type === 'needs-ocr') continue;  // traite en amont (remplace par blocs OCR)

      if (block.type === 'image') {
        if (!settings.showImages || block.small) continue;
        if (!block.dataUrl || !block.width || !block.height) continue;
        const w = usableWidth;
        const h = w * (block.height / block.width);
        if (h > remainingHeight() && curPage.lines.length + curPage.images.length > 0) newPage();
        curPage.images.push({ y, x: margin, width: w, height: h, src: block.dataUrl });
        y += h + paraGap;
        continue;
      }

      const isHeading = block.type === 'h1' || block.type === 'h2' || block.type === 'h3';
      const isListItem = block.type === 'li';
      const sizePt = isHeading ? bodySize * HEADING_FACTORS[block.type] : bodySize;
      const lineGap = isHeading ? sizePt * settings.lineHeight : bodyLineGap;
      const style = isHeading ? 'bold' : (isListItem ? 'normal' : null);

      let runs = runsForDisplay(block.runs, settings);
      let indent = 0;
      if (isListItem) {
        indent = sizePt * 1.2;
        runs = [{ text: '•  ', bold: false, italic: false }, ...runs];
      }

      const wrapped = wrapRuns(runs, usableWidth - indent, sizePt, measurer, settings)
        .map((l) => ({ ...l, isHeading, isListItem, sizePt, lineGap, indent }));

      // ADDENDUM 6, Z12, F1 -- ne compter que les lignes issues d'un retour
      // a la ligne AUTOMATIQUE (toutes sauf la derniere de chaque bloc). La
      // derniere ligne d'un bloc s'arrete la ou le texte source s'arrete,
      // pas la ou la largeur du conteneur l'a force a couper : une puce
      // courte ("Des glacons") ou une fin de paragraphe fait chuter la
      // moyenne sans rien dire de la largeur reellement disponible. Constate
      // : l'avertissement "lignes courtes" s'affichait a 18-22 car./ligne
      // alors que les lignes reellement pleines en font nettement plus.
      totalLineSamples += Math.max(0, wrapped.length - 1);
      for (let wi = 0; wi < wrapped.length - 1; wi++) {
        const text = wrapped[wi].segments.map((s) => s.text).join('');
        totalCharSamples += text.length;
      }

      // Espace avant un titre
      if (isHeading && curPage.lines.length > 0) y += headingGapBefore;

      // Regle : un titre doit etre suivi d'au moins deux lignes sur la meme
      // page, sinon il bascule entierement sur la suivante. Jamais de saut a
      // l'interieur d'un titre (un titre = toujours <= quelques lignes,
      // traite comme un bloc atomique ci-dessous).
      const blockHeight = wrapped.length * lineGap;
      if (isHeading) {
        const needed = blockHeight + 2 * bodyLineGap; // titre + 2 lignes de corps mini
        if (needed > remainingHeight() && curPage.lines.length > 0) newPage();
      } else {
        // Veuves/orphelines : evite qu'une seule ligne d'un paragraphe reste
        // isolee en bas de page. Si moins de 2 lignes tiennent et qu'il en
        // reste davantage, on bascule tout le paragraphe.
        const linesFit = Math.floor(remainingHeight() / lineGap);
        if (linesFit < wrapped.length && linesFit < 2 && curPage.lines.length > 0) {
          newPage();
        }
      }

      for (let i = 0; i < wrapped.length; i++) {
        if (remainingHeight() < lineGap) newPage();
        curPage.lines.push({
          y: y + lineGap * 0.8,
          x: margin + indent,
          segments: wrapped[i].segments,
          sizePt,
          isHeading,
          isListItem,
        });
        y += lineGap;
      }

      // Espace apres le bloc
      if (isHeading) y += headingGapAfter;
      else y += paraGap;
    }

    if (curPage.lines.length || curPage.images.length) pages.push(curPage);
    if (!pages.length) pages.push({ lines: [], images: [] });

    const avgCharsPerLine = totalLineSamples ? totalCharSamples / totalLineSamples : 0;

    return {
      pages,
      pageDims: dims,
      margin,
      usableWidth,
      settings,
      avgCharsPerLine,
      charsPerLineWarning: avgCharsPerLine > 0 && avgCharsPerLine < 35,
      theme: CONTRAST_THEMES[settings.contrast],
    };
  }

  /* ==========================================================================
   * ADDENDUM 6, Z4.4 -- Moteur de mise en page PAR BLOCS.
   * Conserve tableaux/encadres/colonnes au lieu du reflow lineaire 1-colonne
   * ci-dessus (option 2 de l'addendum, cf. PLAN, section Z1).
   *
   * Principe : la taille de POLICE suit uniquement settings.fontSize (comme
   * computeLayout ci-dessus) ; la GEOMETRIE (position/largeur des boites et
   * tableaux) est mise a l'echelle par S = settings.fontSize / modalSize
   * (taille de corps mesuree dans le PDF source), pour que la boite grandisse
   * dans les memes proportions que le texte qu'elle contenait a l'origine.
   * La hauteur de chaque conteneur n'est JAMAIS supposee : elle est toujours
   * recalculee a partir du contenu reellement reflowe (wrapRuns), qui peut
   * differer de la mise a l'echelle geometrique a cause des metriques de
   * Luciole (largeurs de caracteres differentes de la police source).
   * ==========================================================================*/

  function bboxCenter(b) { return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }; }
  function pointInBbox(b, x, y) { return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1; }
  // detectTables() vit desormais dans 01-extract-native.js (window.ExtractNative) :
  // c'est une reconstruction de geometrie, dont l'extraction texte a elle-meme
  // besoin (pour scinder les lignes physiques aux frontieres de colonne d'un
  // tableau -- cf. Z4.4bis), pas seulement le rendu. On y accede via l'alias
  // local ci-dessous pour ne pas modifier le reste de ce fichier.
  const detectTables = (...args) => window.ExtractNative.detectTables(...args);

  // Convertit une bbox source (points PDF, origine bas-gauche) en rectangle
  // de sortie (origine haut-gauche), a l'echelle GEOMETRIQUE `widthRatio` =
  // largeur de sortie / largeur de page source. AUCUN rapport avec la
  // taille de police : voir le commentaire dans computeBlockLayout sur la
  // distinction geometrie/police (correctif du 20/09/2026, la geometrie
  // suivait auparavant la taille de police -- "juste un zoom", remonte par
  // Loic).
  function toOutputRect(bbox, widthRatio, pageHeightSrc) {
    return {
      x: bbox.x0 * widthRatio,
      y: (pageHeightSrc - bbox.y1) * widthRatio,
      width: (bbox.x1 - bbox.x0) * widthRatio,
      height: (bbox.y1 - bbox.y0) * widthRatio,
    };
  }

  // Determine, pour chaque bloc de texte/image, s'il appartient a une
  // cellule de tableau, a une boite, ou reste en flux libre -- au centre de
  // sa bbox (simple et robuste : un bloc ne peut pas etre a cheval sur deux
  // conteneurs si l'extraction de paragraphes est correcte).
  function assignBlocksToContainers(blocks, tables, boxes) {
    const tableCells = tables.map((t) => {
      const cells = [];
      for (let r = 0; r < t.rowBounds.length - 1; r++) {
        const row = [];
        for (let c = 0; c < t.colBounds.length - 1; c++) {
          row.push({
            bbox: { x0: t.colBounds[c], x1: t.colBounds[c + 1], y0: t.rowBounds[r + 1], y1: t.rowBounds[r] },
            blocks: [],
          });
        }
        cells.push(row);
      }
      return cells;
    });
    const boxContents = boxes.map(() => []);
    const free = [];

    outer: for (const block of blocks) {
      if (!block.bbox) { free.push(block); continue; }
      const c = bboxCenter(block.bbox);
      for (let ti = 0; ti < tables.length; ti++) {
        if (!pointInBbox({ x0: tables[ti].x0, x1: tables[ti].x1, y0: tables[ti].y0, y1: tables[ti].y1 }, c.x, c.y)) continue;
        for (const row of tableCells[ti]) {
          for (const cell of row) {
            if (pointInBbox(cell.bbox, c.x, c.y)) { cell.blocks.push(block); continue outer; }
          }
        }
      }
      for (let bi = 0; bi < boxes.length; bi++) {
        if (pointInBbox(boxes[bi], c.x, c.y)) { boxContents[bi].push(block); continue outer; }
      }
      // ADDENDUM 6, Z12, E1 -- correctif du 20/09/2026. Une ETIQUETTE posee
      // A CHEVAL sur la bordure haute de son encadre (ex. "A retenir",
      // 10_FicheOrtho.pdf : le libelle est dessine centre sur le filet du
      // haut, moitie au-dessus/moitie a l'interieur) a son CENTRE hors de
      // la boite -- le test ci-dessus par centre echoue, elle devient un
      // item de flux libre independant, qui peut atterrir sur une AUTRE
      // page que son encadre a la pagination (bug reel constate : "A
      // retenir" seul sur une page, son encadre vide sur la suivante).
      // Repli : si aucune boite ne contient le CENTRE du bloc, rattache-le
      // quand meme a la boite dont la bordure HAUTE (y1, cf. convention
      // PDF -- origine bas-gauche, y1 = haut) traverse sa bbox (chevauche
      // le segment [bbox.y0, bbox.y1]), a condition d'un recouvrement
      // horizontal reel avec la boite (pas juste une coincidence de Y avec
      // une boite tres eloignee en X).
      for (let bi = 0; bi < boxes.length; bi++) {
        const box = boxes[bi];
        const straddlesTopBorder = block.bbox.y0 < box.y1 && block.bbox.y1 > box.y1;
        const overlapsX = block.bbox.x1 > box.x0 && block.bbox.x0 < box.x1;
        if (straddlesTopBorder && overlapsX) { boxContents[bi].push(block); continue outer; }
      }
      free.push(block);
    }

    // ADDENDUM 6, Z12, lot 3 (point 3, F2) -- correctif du 20/09/2026. Les
    // images d'une page sont extraites en un PASSAGE SEPARE de celui du
    // texte (extractImageBlocksForPage, 01-extract-native.js), et poussees
    // dans le tableau `blocks` GLOBAL apres TOUS les blocs de texte de leur
    // page -- jamais entre deux paragraphes, meme quand la photo est en
    // tete de recette dans la source. Le for..of ci-dessus preserve cet
    // ordre d'ARRIVEE dans `blocks` a l'interieur de chaque conteneur :
    // une image se retrouvait donc systematiquement en DERNIER dans son
    // encadre, quelle que soit sa position reelle -- bug reel constate,
    // Sq4_Fiche1_lire_recettes.pdf : la photo d'une boite de recette
    // (en tete d'encadre dans la source) apparaissait apres les 10 etapes
    // de la recette. Retrie chaque conteneur par ORDRE DE LECTURE reel
    // (bbox.y1 decroissant -- origine PDF bas-gauche, y1 = haut -- donc
    // haut de page en premier), texte ET images uniformement, une fois
    // l'affectation terminee : Array.prototype.sort est stable (ES2019),
    // deux blocs de meme y1 gardent leur ordre relatif d'origine.
    const parReadingOrder = (a, b) => {
      const ay = a.bbox ? a.bbox.y1 : -Infinity;
      const by = b.bbox ? b.bbox.y1 : -Infinity;
      return by - ay;
    };
    boxContents.forEach((blocksHere) => blocksHere.sort(parReadingOrder));
    for (const row of tableCells.flat(2)) row.blocks.sort(parReadingOrder);

    return { tableCells, boxContents, free };
  }

  // ADDENDUM 6, Z12, D2 -- correctif du 20/09/2026. isHeading (01-extract-
  // native.js, flushPara) compare le corps du bloc au corps median de la
  // PAGE ENTIERE : correct pour le flux libre, mais une boite ou une
  // cellule peut avoir son propre corps median tres different. Bug reel :
  // Sq4_Fiche1_lire_recettes.pdf page 4, un item de liste d'ingredient
  // ressort en gros/gras au milieu de la liste d'ingredients d'une autre
  // boite de recette -- sa taille depasse le corps median de
  // la PAGE (dominee par le corps, plus petit, du texte hors boite), mais
  // pas celui, plus grand, du CONTENU de sa propre boite. Une fois les
  // blocs associes a leur conteneur (assignBlocksToContainers, ci-dessus),
  // recalcule isHeading en comparant chaque bloc au corps median DE SON
  // CONTENEUR plutot qu'a celui de la page -- meme logique de seuils que
  // flushPara (>1.15 corps median = titre, paliers h1/h2/h3 a 1.45/1.25).
  //
  // N'agit que sur un bloc dont `size` est connu (ADDENDUM 6, Z12, D2 cote
  // extraction) ET dont le conteneur a au moins 2 blocs -- avec un seul
  // bloc, il n'y a rien a comparer, le corps du conteneur EST le corps du
  // bloc (ratio toujours 1), le reclasser demoterait a tort tout titre de
  // boite mono-bloc : on garde alors la decision (page-relative) prise a
  // l'extraction.
  function containerModalSize(blocksHere) {
    const counts = new Map();
    for (const b of blocksHere) {
      if (!b.size) continue;
      const key = Math.round(b.size * 2) / 2;
      const len = (b.runs || []).reduce((a, r) => a + (r.text ? r.text.length : 0), 0);
      counts.set(key, (counts.get(key) || 0) + Math.max(len, 1));
    }
    let best = null, bestCount = -1;
    for (const [size, count] of counts) if (count > bestCount) { best = size; bestCount = count; }
    return best;
  }

  function reclassifyHeadingsInContainer(blocksHere) {
    if (blocksHere.length < 2) return;
    const modal = containerModalSize(blocksHere);
    if (!modal) return;
    for (const b of blocksHere) {
      if (!b.size) continue;
      const wasHeading = b.type === 'h1' || b.type === 'h2' || b.type === 'h3';
      const isHeadingNow = b.size > modal * 1.15;
      if (!wasHeading && !isHeadingNow) continue;
      if (isHeadingNow) {
        b.type = b.size > modal * 1.45 ? 'h1' : (b.size > modal * 1.25 ? 'h2' : 'h3');
      } else {
        // Demotion : un marqueur de liste eventuel n'a jamais ete retire
        // d'un bloc classe titre a l'extraction (stripListMarker ne
        // s'applique qu'a la branche isListItem de flushPara) -- cas non
        // rencontre sur les 3 documents cibles (les faux titres reclasses
        // sont de simples lignes, jamais des puces).
        b.type = 'p';
      }
    }
  }

  // Largeur du mot (token insecable) le plus large parmi des blocs, a la
  // taille de police cible. Sert de largeur MINIMALE a une colonne de
  // tableau/cellule (ADDENDUM 6, Z4.4sexies) : wrapRuns() ne peut couper
  // qu'aux espaces, donc une colonne plus etroite que son mot le plus long
  // chevauche systematiquement la colonne voisine -- observe reellement sur
  // 10_FicheOrtho.pdf apres le decouplage geometrie/police du 20/09/2026
  // ("Adjectifs" et "invariables" ne tenaient plus dans leur colonne, fixee
  // a la largeur proportionnelle d'origine, pensee pour un corps 2x plus
  // petit).
  function widestTokenWidth(blocksHere, bodySize, measurer, settings) {
    let max = 0;
    for (const block of blocksHere) {
      const isHeading = block.type === 'h1' || block.type === 'h2' || block.type === 'h3';
      const sizePt = isHeading ? bodySize * HEADING_FACTORS[block.type] : bodySize;
      // v0.3 (W1) : un mot peut s'etendre sur plusieurs runs accoles (cf.
      // wrapRuns) -- sa largeur est la somme de ses morceaux.
      let wordW = 0;
      for (const run of runsForDisplay(block.runs || [], settings)) {
        const style = styleForRun(run);
        const parts = (run.text || '').split(/(\s+)/).filter((p) => p !== '');
        for (const part of parts) {
          if (/^\s+$/.test(part)) { wordW = 0; continue; }
          wordW += applySpacingToWidth(measurer.widthOf(part, sizePt, style), part, settings);
          if (wordW > max) max = wordW;
        }
      }
    }
    return max;
  }

  // ADDENDUM 6, Z12, B2 : une rangee de tableau deja RENDUE (item.rows[r],
  // apres reflowBlocksInWidth) est une rangee d'EN-TETE si TOUTES ses
  // cellules non vides ne contiennent QUE du texte en gras -- seul signal
  // disponible a ce stade (le fond de cellule n'est pas encore cable, cf.
  // Z12/E2). Une rangee entierement vide (colonnes vides sur cette ligne du
  // tableau source) ne compte pas comme en-tete : `anyText` doit rester
  // vrai pour au moins une cellule.
  function isHeaderRow(row) {
    let anyText = false;
    for (const cell of row.cells) {
      for (const line of cell.lines) {
        for (const seg of line.segments) {
          if (!seg.text.trim()) continue;
          anyText = true;
          if (seg.style !== 'bold' && seg.style !== 'bolditalic') return false;
        }
      }
    }
    return anyText;
  }

  // Reflow les runs d'une liste de blocs dans une largeur donnee, retourne
  // des lignes au meme format que computeLayout ({y relatif, x relatif,
  // segments, sizePt, isHeading, isListItem}) plus la hauteur totale.
  function reflowBlocksInWidth(blocksHere, width, settings, measurer, startY, maxImageHeight) {
    const bodySize = settings.fontSize;
    const bodyLineGap = bodySize * settings.lineHeight;
    const paraGap = bodyLineGap * 0.6;
    const lines = [];
    const images = [];
    let y = startY;
    // v0.3 (E6) : icone (petite image, mascotte) en attente d'etre posee a
    // gauche du bloc de texte qui la suit.
    let pendingIcon = null;
    for (const block of blocksHere) {
      if (block.type === 'image' && block.small) {
        if (!settings.showImages || !block.dataUrl || !block.width || !block.height) continue;
        // Icone a ~1,5 x le corps, ratio conserve, jamais plus large que la
        // moitie du conteneur.
        let h = 1.5 * bodySize;
        let w = h * (block.width / block.height);
        if (w > width / 2) { w = width / 2; h = w * (block.height / block.width); }
        if (pendingIcon) y = Math.max(y, pendingIcon.y + pendingIcon.height + paraGap);
        pendingIcon = { y, x: 0, width: w, height: h, src: block.dataUrl };
        images.push(pendingIcon);
        continue;
      }
      if (block.type === 'image') {
        // ADDENDUM 6, Z12, C1 -- correctif du 20/09/2026 (cause racine R3
        // du cadrage Z12) : cette ligne disait "images traitees a part par
        // l'appelant", un commentaire mensonger constate a l'usage -- AUCUN
        // appelant (ni la branche boite, ni la branche cellule de tableau,
        // plus bas dans ce fichier) ne les traitait. Consequence reelle :
        // les 4 photos de recette de Sq4_Fiche1_lire_recettes.pdf (toutes
        // dans des encadres) disparaissaient silencieusement. Desormais
        // rendue a l'echelle de la largeur INTERNE du conteneur (`width`,
        // deja net de son rembourrage), jamais celle de la page entiere --
        // coordonnees RELATIVES au conteneur, comme les lignes de texte
        // (l'appelant leur ajoute le meme padding, cf. plus bas).
        if (!settings.showImages || !block.dataUrl || !block.width || !block.height) continue;
        let h = width * (block.height / block.width);
        let w = width;
        // Plafonne la HAUTEUR (garde le ratio, donc reduit aussi la largeur
        // si besoin -- l'image n'occupe alors plus toute la largeur
        // interne, mais reste entiere et lisible). Bug reel trouve en
        // testant cette session (harnais visuel, Sq4_Fiche1_lire_recettes)
        // : une photo de recette a pleine largeur de boite pouvait a elle
        // seule (avec son texte) depasser 758pt, plus haut qu'une page A4
        // utile entiere (~728pt) -- B1 (Z12) ne scinde JAMAIS une image
        // (element atomique, cf. splitBoxItem), donc sans ce plafond, une
        // boite avec une photo tres verticale ne pouvait tenir sur AUCUNE
        // page, meme vide, et retombait systematiquement dans le
        // debordement de dernier recours (B3) -- regression directe de
        // l'invariant "aucun debordement" garanti par B1/B2.
        if (maxImageHeight && h > maxImageHeight) {
          w = w * (maxImageHeight / h);
          h = maxImageHeight;
        }
        images.push({ y, x: 0, width: w, height: h, src: block.dataUrl });
        y += h + paraGap;
        continue;
      }
      const isHeading = block.type === 'h1' || block.type === 'h2' || block.type === 'h3';
      const isListItem = block.type === 'li';
      const sizePt = isHeading ? bodySize * HEADING_FACTORS[block.type] : bodySize;
      const lineGap = isHeading ? sizePt * settings.lineHeight : bodyLineGap;
      let runs = runsForDisplay(block.runs, settings);
      let indent = 0;
      if (isListItem) {
        indent = sizePt * 1.2;
        runs = [{ text: '•  ', bold: false, italic: false }, ...runs];
      }
      let iconBottom = null;
      if (pendingIcon) {
        // Libelle a droite de son icone, premiere ligne alignee sur elle --
        // sauf si le mot le plus long du libelle n'y tient plus (colonne
        // etroite) : l'icone reste alors seule au-dessus, sans couper de mot.
        const iconIndent = pendingIcon.width + 0.3 * bodySize;
        if (widestTokenWidth([block], bodySize, measurer, settings) <= width - indent - iconIndent) {
          indent += iconIndent;
          y = pendingIcon.y;
          iconBottom = pendingIcon.y + pendingIcon.height;
        } else {
          y = Math.max(y, pendingIcon.y + pendingIcon.height + 0.25 * bodySize);
        }
        pendingIcon = null;
      }
      const wrapped = wrapRuns(runs, width - indent, sizePt, measurer, settings);
      // ADDENDUM 6, Z12, F1 -- `isLastLine` marque la derniere ligne de CE
      // bloc source : elle s'arrete la ou le texte s'arrete, pas la ou le
      // retour a la ligne automatique l'a coupee. Sert au calcul de
      // `avgCharsPerLine` (ne doit compter que les lignes de retour
      // automatique) et au harnais visuel, qui doit appliquer exactement la
      // meme definition sur le DOM rendu (cf. visual.mjs).
      wrapped.forEach((l, wi) => {
        lines.push({ y: y + lineGap * 0.8, x: indent, segments: l.segments, sizePt, isHeading, isListItem, isLastLine: wi === wrapped.length - 1 });
        y += lineGap;
      });
      if (iconBottom !== null) y = Math.max(y, iconBottom);
      y += paraGap;
    }
    if (pendingIcon) y = Math.max(y, pendingIcon.y + pendingIcon.height + paraGap);
    return { lines, images, height: Math.max(0, y - startY - paraGap) };
  }

  // Point d'entree : construit la mise en page par blocs d'UNE page source
  // (pas encore de pagination multi-page -- cf. PLAN Z4, a traiter une fois
  // le rendu de base valide visuellement).
  function computeBlockLayout(pageBlocks, pageShapesForPage, pageSizeForPage, settings, measurer) {
    settings = clampSettings(settings);
    // ADDENDUM 6, Z3/Z4.4quater : contenu secondaire (mention d'editeur,
    // copyright en marge) masque par defaut -- decision d'affichage, pas
    // d'extraction (le bloc existe toujours dans pageBlocks, seulement
    // ecarte ici). Pas encore de reglage pour le reafficher (prevu au plan).
    pageBlocks = pageBlocks.filter((b) => !b.secondary && !b.duplicate);
    const pageHeightSrc = pageSizeForPage.height;

    // ADDENDUM 6, Z4.4sexies -- correctif du 20/09/2026 (remonte par Loic :
    // "la taille de la police fait juste un zoom"). AVANT : la geometrie
    // (largeur/position des boites, largeur de page) etait mise a l'echelle
    // par S = taille_police / corps_source, donc toute la page grandissait
    // dans les DEUX dimensions avec la police -- visuellement un zoom
    // uniforme, pas une vraie adaptation (une boite qui tenait 10 mots par
    // ligne a 12 pt en tenait encore ~10 a 40 pt, juste plus grande).
    // MAINTENANT : la largeur de sortie est FIXE (format A4 du reglage
    // orientation, independant de la police) ; seule la HAUTEUR des blocs
    // grandit pour absorber le texte reflowe a la taille demandee (Addendum
    // 6, Z1 : "le bloc grandit en hauteur si besoin" -- c'etait deja
    // l'intention ecrite, l'implementation ne la respectait pas). A 40 pt,
    // une boite garde donc la MEME largeur qu'a 24 pt, mais son texte
    // tient sur moins de mots par ligne, davantage de lignes -- comme
    // agrandir la police dans un traitement de texte classique.
    const dims = pageDimsPt(settings.orientation);
    const pageWidthOut = dims.width;
    const widthRatio = pageWidthOut / (pageSizeForPage.width || pageWidthOut);

    // v0.3 : tableaux detectes UNE fois, a l'extraction (avec les
    // contraintes S6 et l'exclusion des lignes de decoupe, qui ont besoin
    // du texte de la page) ; recalcul local seulement pour une extraction
    // anterieure qui ne les fournirait pas.
    // v0.3 (E1) : regions d'exemplaires en double -- leurs boites et
    // tableaux ne sont pas rendus (leur texte est deja ecarte, cf. filtre
    // `duplicate` ci-dessus).
    const hidden = (pageShapesForPage.regions || []).filter((r) => r.duplicate);
    const inHidden = (b) => hidden.some((r) => {
      const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
      return cx >= r.x0 && cx < r.x1 && cy > r.y0 && cy <= r.y1;
    });
    const boxes = (pageShapesForPage.boxes || []).filter((b) => (b.x1 - b.x0) > 20 && (b.y1 - b.y0) > 20 && !inHidden(b));
    const tables = (pageShapesForPage.tables || detectTables(pageShapesForPage.lines, boxes)).filter((t) => !inHidden(t));
    // Exclut des "boites" celles CONTENUES dans un tableau deja detecte (pas
    // seulement celles qui en epousent exactement les bords) : un fond
    // colore de colonne d'en-tete (ex. la colonne "Noms/Verbes/..." de
    // 10_FicheOrtho.pdf) est plus petit que le tableau entier mais ne doit
    // pas devenir une boite flottante redondante en plus de ses cellules.
    let freeBoxes = boxes.filter((b) => !tables.some((t) =>
      b.x0 >= t.x0 - 3 && b.x1 <= t.x1 + 3 && b.y0 >= t.y0 - 3 && b.y1 <= t.y1 + 3));
    // ADDENDUM 6, Z12, E2 -- correctif du 20/09/2026. Le fond colore d'une
    // colonne d'en-tete (ex. "Noms/Verbes/Adjectifs/Mots invariables",
    // 10_FicheOrtho.pdf) EST une boite au sens de pageShapesForPage.boxes,
    // exclue ci-dessus de freeBoxes pour ne pas devenir une boite flottante
    // redondante -- mais jusqu'ici jamais REAFFECTEE non plus : son fond
    // disparaissait purement et simplement (case commentee "hors perimetre"
    // depuis le lot P0). `tableBoxes` retient ces boites exclues, pour les
    // reaffecter plus bas aux cellules qu'elles couvrent.
    const tableBoxes = boxes.filter((b) => tables.some((t) =>
      b.x0 >= t.x0 - 3 && b.x1 <= t.x1 + 3 && b.y0 >= t.y0 - 3 && b.y1 <= t.y1 + 3));

    // Boites IMBRIQUEES (une bande de fond decorative contenant un encadre
    // plus specifique -- motif reel sur 2_Memo_Carte_indiv1.pdf : une bande
    // teal pleine largeur contient un encadre blanc a bordure teal, meme
    // texte). Trie par surface CROISSANTE avant l'assignation de contenu
    // (assignBlocksToContainers prend la PREMIERE boite dont le centre du
    // bloc tombe dedans) pour que la boite la plus imbriquee (la plus
    // pertinente visuellement -- fond blanc, bon contraste) recoive le
    // texte en priorite, plutot que la grande boite englobante (bug reel :
    // le texte d'un encadre de grammaire atterrissait sur le fond teal
    // exterieur, illisible car quasi la meme couleur que son propre fond).
    freeBoxes = freeBoxes.slice().sort((a, b) =>
      (a.x1 - a.x0) * (a.y1 - a.y0) - (b.x1 - b.x0) * (b.y1 - b.y0));

    const { tableCells, boxContents, free } = assignBlocksToContainers(pageBlocks, tables, freeBoxes);

    // ADDENDUM 6, Z12, D2 -- une fois les blocs associes a leur conteneur,
    // corrige les faux titres detectes contre le corps median de la PAGE
    // (cf. commentaire sur reclassifyHeadingsInContainer ci-dessus).
    boxContents.forEach(reclassifyHeadingsInContainer);
    for (const cell of tableCells.flat(2)) reclassifyHeadingsInContainer(cell.blocks);

    const boxPadding = 0.5 * settings.fontSize;
    const cellPadding = 0.35 * settings.fontSize;
    // ADDENDUM 6, Z12, C1 : plafond de hauteur d'une image DANS une boite/
    // cellule -- 60% de la hauteur utile d'une page pleine, marge large
    // pour garder aussi de la place au rembourrage et au minimum de 2
    // lignes de texte veuve/orpheline (B1) qui pourraient l'accompagner
    // sur le meme fragment. Sans ce plafond, une photo tres verticale a
    // pleine largeur de conteneur peut a elle seule depasser une page A4
    // entiere -- une image ne se scinde jamais (element atomique, cf.
    // splitBoxItem), donc un tel cas ne peut alors JAMAIS tenir, meme sur
    // une page vide (bug reel constate sur Sq4_Fiche1_lire_recettes.pdf en
    // testant cette session : boite de 758pt, plus haute que les ~728.6pt
    // utiles d'une page A4 portrait).
    const maxImageHeight = (dims.height - 2 * MARGIN_MM * MM_TO_PT) * 0.6;

    const items = [];

    // Boites (encadres) : reflow interne, la boite grandit pour absorber le
    // debordement eventuel (jamais l'inverse).
    const marginForBoxes = MARGIN_MM * MM_TO_PT;
    const usableWidthForBoxes = pageWidthOut - 2 * marginForBoxes;
    freeBoxes.forEach((box, bi) => {
      // Une boite SANS AUCUN bloc associe est en general purement
      // decorative (accent de coin de page, filet, logo) -- observe
      // reellement sur Sq4_Fiche1_lire_recettes.pdf (un coin arrondi vert
      // et un filet vide sous le titre s'affichaient comme de fausses
      // boites de contenu, remonte par Loic). Aucune information n'est
      // perdue en l'ecartant : elle ne portait aucun texte a adapter.
      const wrapsAnotherBox = freeBoxes.some((other) => other !== box &&
        other.x0 >= box.x0 - 1 && other.x1 <= box.x1 + 1 && other.y0 >= box.y0 - 1 && other.y1 <= box.y1 + 1);
      // Une boite qui EN CONTIENT une autre (bande de fond decorative
      // autour d'un encadre plus specifique, ex. la carte teal de
      // 2_Memo_Carte_indiv1.pdf) n'est PAS un item independant : deux
      // items separes pour un seul "calque visuel" peuvent atterrir sur
      // deux pages differentes a la pagination (bug reel trouve le
      // 20/09/2026 -- la bande restait sur une page, son contenu partait
      // sur la suivante). Fusionnee plus bas dans l'item de la boite
      // qu'elle enveloppe (outerWrap), jamais poussee ici.
      if (wrapsAnotherBox) return;
      if (!boxContents[bi] || boxContents[bi].length === 0) return;
      const rect = toOutputRect(box, widthRatio, pageHeightSrc);
      const minWidth = widestTokenWidth(boxContents[bi], settings.fontSize, measurer, settings) + 2 * boxPadding;
      // ADDENDUM 6, Z12, A1 -- correctif du 20/09/2026 (cause racine R1 du
      // cadrage Z12) : une boite est desormais remise en page sur la LARGEUR
      // UTILE DE PAGE, exactement comme les tableaux juste en dessous
      // (rect.x = marginX, largeur recalculee), plutot que de garder la
      // largeur/position PROPORTIONNELLE de sa bbox source. AVANT : les 3
      // documents cibles sont des fiches sur deux colonnes, donc chaque
      // encadre ne faisait que ~45% de la largeur de page -- a 24pt dans une
      // colonne de 45%, on obtenait 11 a 20 caracteres par ligne, une moitie
      // de page blanche a cote, et des encadres 3 a 4 fois trop hauts
      // (mediane mesuree par le harnais visuel : 11-20 car./ligne, sous le
      // seuil de lisibilite de 35). Decision de cadrage assumee : la sortie
      // est deja un empilement vertical a une colonne (pas de cote-a-cote
      // supporte, cf. Z4.4/Z6/Z10) -- garder une largeur source de 45% ne
      // preservait donc aucune fidelite reelle, elle ne faisait que gacher
      // la moitie de la page. L'identite VISUELLE de la boite (fond,
      // bordure, coins arrondis, outerWrap) est inchangee : seule sa
      // GEOMETRIE (x, width) est recalculee.
      const outWidth = Math.max(usableWidthForBoxes, minWidth); // deborde en dernier recours si meme le mot le plus long l'exige (cas non rencontre sur les 3 documents cibles)
      const boxX = marginForBoxes;
      const innerWidth = Math.max(40, outWidth - 2 * boxPadding);
      const { lines, images, height } = reflowBlocksInWidth(boxContents[bi], innerWidth, settings, measurer, boxPadding, maxImageHeight);
      const outHeight = Math.max(rect.height, height + 2 * boxPadding);

      // Boite qui ENVELOPPE celle-ci (bande de fond decorative) : fusionnee
      // comme calque de fond supplementaire de CE MEME item, jamais comme
      // item separe (voir commentaire ci-dessus). RESTREINT au cas 1
      // enveloppe <-> 1 contenu strict (verifie en comptant CONTIENT
      // combien de boites) : un conteneur qui englobe PLUSIEURS boites (ex.
      // les 3 cases d'un diagramme en arbre, 2_Memo_Carte_indiv1.pdf) ne
      // doit PAS etre fusionne dans chacune d'elles independamment --
      // chaque enfant "reclamerait" le meme grand conteneur pour lui seul,
      // produisant 3 calques de fond dupliques et des chevauchements
      // visuels (bug reel trouve le 20/09/2026 en verifiant ce document).
      let outerWrap = null;
      const candidateWrapper = freeBoxes.find((other) => other !== box &&
        other.x0 <= box.x0 + 1 && other.x1 >= box.x1 - 1 && other.y0 <= box.y0 + 1 && other.y1 >= box.y1 - 1);
      if (candidateWrapper) {
        const containedCount = freeBoxes.filter((b2) => b2 !== candidateWrapper &&
          b2.x0 >= candidateWrapper.x0 - 1 && b2.x1 <= candidateWrapper.x1 + 1 &&
          b2.y0 >= candidateWrapper.y0 - 1 && b2.y1 <= candidateWrapper.y1 + 1).length;
        if (containedCount === 1) {
          const padSrc = ((box.x0 - candidateWrapper.x0) + (candidateWrapper.x1 - box.x1) +
            (box.y0 - candidateWrapper.y0) + (candidateWrapper.y1 - box.y1)) / 4;
          outerWrap = { fill: candidateWrapper.fill, stroke: candidateWrapper.stroke, pad: Math.max(0, padSrc * widthRatio) };
        }
      }

      items.push({
        kind: 'box', x: boxX, y: rect.y, width: outWidth, height: outHeight,
        fill: box.fill, stroke: box.stroke, outerWrap,
        // srcBottomY/srcLeftX (ADDENDUM 6, Z12, A2) : bbox source COMPLETE
        // (pas seulement le sommet), necessaire au regroupement par bande
        // verticale de l'ordre de lecture, cf. plus bas.
        srcTopY: box.y1, srcBottomY: box.y0, srcLeftX: box.x0, srcCenterX: (box.x0 + box.x1) / 2,
        lines: lines.map((l) => ({ ...l, x: l.x + boxPadding })),
        // ADDENDUM 6, Z12, C1 : images de la boite, memes coordonnees
        // relatives + rembourrage que les lignes ci-dessus.
        images: images.map((im) => ({ ...im, x: im.x + boxPadding })),
      });
    });

    // Tableaux : chaque rangee prend la hauteur de sa cellule la plus haute.
    // Largeur utile de page (calculee ici, avant sa declaration plus bas :
    // les tableaux en ont besoin pour ne jamais deborder -- bug reel
    // observe le 20/09/2026, remonte par Loic : elargir une colonne
    // etroite (Z8) sans revegetifier que le total tient encore sur la page
    // faisait deborder le tableau au-dela de la marge droite.).
    const usableWidthForTables = pageWidthOut - 2 * MARGIN_MM * MM_TO_PT;
    const landscapeDims = pageDimsPt('paysage');
    const usableWidthLandscape = landscapeDims.width - 2 * MARGIN_MM * MM_TO_PT;
    const consumedTitleBlocks = new Set();

    const cellText = (cell) => cell.blocks.map((b) => (b.runs || []).map((r) => r.text || '').join('')).join(' ').replace(/\s+/g, ' ').trim();

    // Construit un item 'table' a partir de la grille source `grid`
    // (tableCells[ti]) restreinte aux colonnes `cols`, dans la largeur
    // `maxWidth`, avec les reglages `tSettings` (corps propre possible,
    // cf. E4). `evenWidths` : colonnes de largeur egale (groupes paysage)
    // plutot que proportionnelles a la source.
    function buildTableItem(table, grid, cols, tSettings, maxWidth, evenWidths) {
      const cp = 0.35 * tSettings.fontSize;
      const numCols = cols.length;
      // Largeur minimale par colonne = son mot le plus long, sur toutes ses
      // cellules (voir widestTokenWidth) -- une colonne ne peut jamais etre
      // plus etroite sans faire deborder son propre texte sur la voisine.
      const minWidths = cols.map((c) => {
        let colMax = 0;
        for (let r = 0; r < grid.length; r++) {
          colMax = Math.max(colMax, widestTokenWidth(grid[r][c].blocks, tSettings.fontSize, measurer, tSettings));
        }
        return colMax + 2 * cp;
      });
      const baseWidths = evenWidths
        ? cols.map(() => maxWidth / numCols)
        : cols.map((c) => (table.colBounds[c + 1] - table.colBounds[c]) * widthRatio);
      const rawWidths = baseWidths.map((w, i) => Math.max(w, minWidths[i]));
      const totalRaw = rawWidths.reduce((a, w) => a + w, 0);

      let finalWidths = rawWidths;
      if (totalRaw > maxWidth) {
        // Retire l'exces aux colonnes qui ont de la marge par rapport a LEUR
        // PROPRE minimum (jamais en dessous), au prorata de cette marge.
        const slack = rawWidths.map((w, i) => w - minWidths[i]);
        const totalSlack = slack.reduce((a, x) => a + x, 0);
        const overflow = totalRaw - maxWidth;
        if (totalSlack > 0) {
          const reducible = Math.min(overflow, totalSlack);
          finalWidths = rawWidths.map((w, i) => w - (slack[i] / totalSlack) * reducible);
        }
        // v0.3, lot 1 (R3) -- si meme la somme des minimums ne tient pas, le
        // tableau n'est plus autorise a deborder de la page (texte coupe au
        // bord dans le PDF) : colonnes ramenees a la largeur disponible au
        // prorata, le mot trop long est coupe dans sa cellule (wrapRuns).
        const total = finalWidths.reduce((a, w) => a + w, 0);
        if (total > maxWidth + 0.01) finalWidths = finalWidths.map((w) => w * (maxWidth / total));
      }

      // Le tableau demarre a la marge de page, pas a sa position source
      // proportionnelle : une fois les largeurs de colonne ajustees, la
      // position d'origine n'a plus de sens fiable a preserver.
      const marginX = MARGIN_MM * MM_TO_PT;
      const colXsOut = [marginX];
      for (let i = 0; i < numCols; i++) colXsOut.push(colXsOut[i] + finalWidths[i]);

      // ADDENDUM 6, Z12, E2 -- boites de fond COLOREES de ce tableau (ex. le
      // fond orange de la colonne d'en-tete "Noms/Verbes/..."), retenues
      // dans tableBoxes plus haut. Reaffectees plus bas a toute cellule
      // qu'elles couvrent MAJORITAIREMENT (recouvrement d'aire > 50% de la
      // cellule -- une boite de fond peut deborder tres legerement sur ses
      // voisines par arrondi de detection de bord, un simple chevauchement
      // non nul creerait des faux positifs).
      const boxesForThisTable = tableBoxes.filter((b) =>
        b.x0 >= table.x0 - 3 && b.x1 <= table.x1 + 3 && b.y0 >= table.y0 - 3 && b.y1 <= table.y1 + 3);
      function fillForCell(cellBbox) {
        const cellArea = Math.max(1, (cellBbox.x1 - cellBbox.x0) * (cellBbox.y1 - cellBbox.y0));
        for (const b of boxesForThisTable) {
          const ix = Math.max(0, Math.min(cellBbox.x1, b.x1) - Math.max(cellBbox.x0, b.x0));
          const iy = Math.max(0, Math.min(cellBbox.y1, b.y1) - Math.max(cellBbox.y0, b.y0));
          if ((ix * iy) / cellArea > 0.5) return b.fill;
        }
        return null;
      }

      let rowY = 0;
      const rows = [];
      for (let r = 0; r < grid.length; r++) {
        const cellsOut = [];
        let rowHeight = 0;
        cols.forEach((c, i) => {
          const cell = grid[r][c];
          const cellWidth = colXsOut[i + 1] - colXsOut[i];
          const innerWidth = Math.max(1, cellWidth - 2 * cp);
          const { lines, images, height } = reflowBlocksInWidth(cell.blocks, innerWidth, tSettings, measurer, cp, maxImageHeight);
          rowHeight = Math.max(rowHeight, height + 2 * cp);
          cellsOut.push({
            x: colXsOut[i] - colXsOut[0], width: cellWidth,
            fill: fillForCell(cell.bbox),
            lines: lines.map((l) => ({ ...l, x: l.x + cp })),
            // ADDENDUM 6, Z12, C1 : images de la cellule (meme traitement
            // que les boites ci-dessus).
            images: images.map((im) => ({ ...im, x: im.x + cp })),
          });
        });
        rows.push({ y: rowY, height: rowHeight, cells: cellsOut });
        rowY += rowHeight;
      }
      // ADDENDUM 6, Z12, B2 : identifie une rangee d'EN-TETE pour la
      // repeter en haut de chaque fragment quand le tableau doit etre
      // scinde entre deux pages (cf. splitTableItem ci-dessous). Detection
      // par TOUTES ses cellules en gras uniquement.
      const headerRow = rows.length && isHeaderRow(rows[0]) ? rows[0] : null;
      const rect = toOutputRect(table, widthRatio, pageHeightSrc);
      return {
        kind: 'table', x: marginX, y: rect.y, width: colXsOut[colXsOut.length - 1] - colXsOut[0],
        height: rowY, colBounds: colXsOut.map((x) => x - colXsOut[0]), rows,
        // srcBottomY/srcLeftX (ADDENDUM 6, Z12, A2) : cf. commentaire sur
        // l'item 'box' ci-dessus.
        srcTopY: table.y1, srcBottomY: table.y0, srcLeftX: table.x0, srcCenterX: (table.x0 + table.x1) / 2,
        headerRow,
        cellPadding: cp,
      };
    }

    // v0.3, lot 5 (T1, decision E4) -- colonne d'en-tete de rangee
    // redondante : chaque cellule de donnee commence deja par son libelle
    // (« je / j' » -> « j'etais »). Vrai pour tous les tableaux de
    // conjugaison remplis ; on la supprime alors des tableaux larges.
    function rowHeaderIsRedundant(grid) {
      let checked = 0;
      for (let r = 0; r < grid.length; r++) {
        const label = cellText(grid[r][0]).toLowerCase();
        if (!label) continue;
        const alts = label.split('/').map((a) => a.trim()).filter(Boolean);
        for (let c = 1; c < grid[r].length; c++) {
          const t = cellText(grid[r][c]).toLowerCase();
          if (!t) continue;
          const ok = alts.some((a) => (/['’]$/.test(a) ? t.startsWith(a) : (t === a || t.startsWith(a + ' '))));
          if (!ok) return false;
          checked++;
        }
      }
      return checked >= 2;
    }

    // Titre du tableau source : le titre (h1-h3) de flux libre le plus proche
    // AU-DESSUS du tableau, dans son emprise horizontale.
    function findTableTitle(table) {
      let best = null, bestD = Infinity;
      for (const b of free) {
        if (!b.bbox || !/^h[123]$/.test(b.type)) continue;
        const d = b.bbox.y0 - table.y1;
        if (d < -4 || d > 150) continue;
        if (b.bbox.x1 < table.x0 || b.bbox.x0 > table.x1) continue;
        if (d < bestD) { bestD = d; best = b; }
      }
      return best;
    }

    tables.forEach((table, ti) => {
      const grid = tableCells[ti];
      const numCols = table.colBounds.length - 1;
      const allCols = [...Array(numCols).keys()];
      const item = buildTableItem(table, grid, allCols, settings, usableWidthForTables, false);
      const minTotal = allCols.reduce((a, c) => {
        let m = 0;
        for (let r = 0; r < grid.length; r++) m = Math.max(m, widestTokenWidth(grid[r][c].blocks, settings.fontSize, measurer, settings));
        return a + m + 2 * cellPadding;
      }, 0);
      // v0.3, lot 5 (E4, decision du 22/09/2026) -- tableau LARGE : sa
      // largeur minimale (mot le plus long par colonne) depasse la largeur
      // utile au corps choisi. Rendu : page A4 PAYSAGE, corps 20 pt pour ce
      // tableau seulement (plancher Z2), 3 colonnes de donnees par page au
      // plus, dans l'ordre source, en-tete repete ; colonne des pronoms
      // retiree si redondante ; titre du tableau repete, suffixe (k/n).
      // Chaque groupe demarre sur sa propre page paysage et la page suivante
      // repasse en portrait (E7 : paysage page par page, tableaux larges
      // uniquement).
      if (minTotal <= usableWidthForTables || numCols < 3) { items.push(item); return; }
      const dropHeader = rowHeaderIsRedundant(grid);
      const dataCols = allCols.slice(1);
      const groups = [];
      for (let i = 0; i < dataCols.length; i += 3) groups.push(dataCols.slice(i, i + 3));
      const tSettings = { ...settings, fontSize: 20 };
      const titleBlock = findTableTitle(table);
      const titleText = titleBlock ? (titleBlock.runs || []).map((r) => r.text).join('').replace(/\s+/g, ' ').trim() : '';
      if (titleBlock) consumedTitleBlocks.add(titleBlock);
      const maxW = settings.orientation === 'paysage' ? usableWidthForTables : usableWidthLandscape;
      groups.forEach((g, k) => {
        const groupId = 'paysage-' + (pageSizeForPage.srcIndex || 0) + '-' + ti + '-' + k;
        const cols = dropHeader ? g : [0, ...g];
        const suffix = groups.length > 1 ? ' (' + (k + 1) + '/' + groups.length + ')' : '';
        const captionText = titleText ? titleText + suffix : (suffix ? 'Tableau' + suffix : '');
        const order = table.x0 + (k + 1) * 0.01;
        if (captionText) {
          const cap = reflowBlocksInWidth([{ type: 'h2', runs: [{ text: captionText, bold: true, color: titleBlock && titleBlock.runs[0] ? titleBlock.runs[0].color : null }] }],
            maxW, tSettings, measurer, 0);
          items.push({ kind: 'flow', x: MARGIN_MM * MM_TO_PT, y: 0, width: maxW, height: cap.height, lines: cap.lines,
            srcTopY: table.y1, srcBottomY: table.y0, srcLeftX: order - 0.005, srcCenterX: (table.x0 + table.x1) / 2, landscapeGroup: groupId });
        }
        const gi = buildTableItem(table, grid, cols, tSettings, maxW, true);
        gi.srcLeftX = order;
        gi.landscapeGroup = groupId;
        items.push(gi);
      });
    });

    // Blocs libres (hors boite/tableau) : reflow a la largeur utile de page.
    // Marge FIXE (independante de la police, comme la largeur de page --
    // cf. commentaire plus haut).
    const margin = MARGIN_MM * MM_TO_PT;
    const usableWidth = pageWidthOut - 2 * margin;
    // Regroupe les blocs libres consecutifs (l'appelant les reordonne avec
    // les conteneurs par position Y ci-dessous ; ici on ne fait que les
    // reflow individuellement pour connaitre leur hauteur).
    for (const block of free) {
      if (consumedTitleBlocks.has(block)) continue; // repris en tete de chaque page paysage (E4)
      if (block.type === 'image') {
        if (!settings.showImages || !block.bbox || block.small) continue; // petite image hors conteneur : ecartee (E6)
        const rect = toOutputRect(block.bbox, widthRatio, pageHeightSrc);
        items.push({ kind: 'image', x: margin, y: rect.y, width: usableWidth,
          height: usableWidth * (rect.height / rect.width), src: block.dataUrl,
          srcTopY: block.bbox.y1, srcBottomY: block.bbox.y0, srcLeftX: block.bbox.x0, srcCenterX: (block.bbox.x0 + block.bbox.x1) / 2 });
        continue;
      }
      const { lines, height } = reflowBlocksInWidth([block], usableWidth, settings, measurer, 0);
      items.push({
        kind: 'flow', x: margin, y: 0 /* recalcule ci-dessous */, width: usableWidth, height,
        lines,
        // srcBottomY/srcLeftX (ADDENDUM 6, Z12, A2) : un item 'flow' occupe
        // toute la largeur utile de sortie, il ne chevauche donc jamais un
        // AUTRE item horizontalement -- srcLeftX = 0 (origine de la page
        // SOURCE, systeme de coordonnees commun a box.x0/table.x0 ci-dessus
        // ; jamais une valeur en points de SORTIE comme `margin`, qui
        // n'est pas a la meme echelle), pour qu'il gagne systematiquement
        // le tri gauche->droite au sein d'une bande s'il devait un jour en
        // partager une.
        srcTopY: block.bbox ? block.bbox.y1 : 0, srcBottomY: block.bbox ? block.bbox.y0 : 0, srcLeftX: 0,
        srcCenterX: block.bbox ? (block.bbox.x0 + block.bbox.x1) / 2 : undefined,
      });
    }

    // ADDENDUM 6, Z12, A2 -- Ordre de lecture par BANDE VERTICALE, puis
    // gauche->droite au sein d'une bande. Remplace l'algorithme de
    // Z4.4ter (tri global par srcTopY seul, puis insertion des conteneurs
    // dans le flux libre par simple comptage de position) : celui-ci ne
    // departageait JAMAIS deux conteneurs de la MEME bande horizontale --
    // observe reellement sur Sq4_Fiche1_lire_recettes.pdf, une grille 2x2
    // de recettes (Moelleux haut-gauche, Creme haut-droite, Cocktail
    // bas-gauche, Lessive bas-droite) : la sortie etait Moelleux, Creme,
    // Lessive, Cocktail -- les 2 boites du bas inversees, le tri par seule
    // position Y (sans egard a X) les laissant dans un ordre arbitraire
    // (issu du tri par SURFACE croissante fait plus haut pour l'imbrication
    // de boites, cf. Z11 -- un ordre sans aucun rapport avec la lecture).
    //
    // Principe : regroupe TOUS les items (flux libre y compris -- un item
    // 'flow' occupe toute la largeur de sortie, srcLeftX = 0, il gagne donc
    // toujours le tri gauche->droite s'il devait partager une bande) par
    // bande verticale -- un chevauchement SIGNIFICATIF (> 40% de la hauteur
    // du plus petit des deux) de leur bbox source Y0..Y1 -- puis trie
    // gauche->droite au sein d'une bande, les bandes elles-memes triees de
    // haut en bas. Sur un document a une seule colonne ou rien ne chevauche
    // jamais verticalement (10_FicheOrtho.pdf, 2_Memo_Carte_indiv1.pdf),
    // chaque item forme sa propre bande : ce cas degenere en un tri par
    // srcTopY decroissant, IDENTIQUE au comportement precedent -- l'ancien
    // algorithme n'est donc pas regresse, seulement generalise au cas d'une
    // grille.
    function chevauchementVertical(a, b) {
      return Math.min(a.srcTopY, b.srcTopY) - Math.max(a.srcBottomY, b.srcBottomY);
    }
    function ordonnerParBandes(liste) {
      const parBandeau = liste.slice().sort((a, b) => b.srcTopY - a.srcTopY);
      const bandes = [];
      for (const it of parBandeau) {
        const h = Math.max(1, it.srcTopY - it.srcBottomY);
        let bande = bandes.find((bd) => chevauchementVertical(bd, it) > 0.4 * Math.min(bd.hauteur, h));
        if (!bande) {
          bande = { srcTopY: it.srcTopY, srcBottomY: it.srcBottomY, hauteur: h, items: [] };
          bandes.push(bande);
        } else {
          bande.srcTopY = Math.max(bande.srcTopY, it.srcTopY);
          bande.srcBottomY = Math.min(bande.srcBottomY, it.srcBottomY);
          bande.hauteur = Math.max(1, bande.srcTopY - bande.srcBottomY);
        }
        bande.items.push(it);
      }
      bandes.sort((a, b) => b.srcTopY - a.srcTopY);
      const out = [];
      for (const bande of bandes) {
        bande.items.sort((a, b) => a.srcLeftX - b.srcLeftX);
        out.push(...bande.items);
      }
      return out;
    }
    // v0.3, lot 2 (S1) -- ordre de lecture REGION PAR REGION de decoupe
    // (haut -> bas, gauche -> droite, cf. buildRegions) : deux exercices
    // differents poses cote a cote de part et d'autre d'une ligne de
    // decoupe verticale ne doivent pas s'entrelacer bande par bande.
    const regions = pageShapesForPage.regions || null;
    let orderedItems;
    if (regions && regions.length > 1) {
      const regionOf = (it) => {
        if (it.srcCenterX === undefined) return -1;
        const cy = (it.srcTopY + it.srcBottomY) / 2;
        return regions.findIndex((r) => it.srcCenterX >= r.x0 && it.srcCenterX < r.x1 && cy > r.y0 && cy <= r.y1);
      };
      const parRegion = new Map();
      for (const it of items) {
        const ri = regionOf(it);
        if (!parRegion.has(ri)) parRegion.set(ri, []);
        parRegion.get(ri).push(it);
      }
      orderedItems = [];
      for (const ri of [...parRegion.keys()].sort((a, b) => a - b)) orderedItems.push(...ordonnerParBandes(parRegion.get(ri)));
    } else {
      orderedItems = ordonnerParBandes(items);
    }
    items.length = 0;
    items.push(...orderedItems);

    // ADDENDUM 6, Z9 -- Pagination A4 reelle : une page source peut produire
    // PLUSIEURS pages de sortie (format A4 fixe, cf. Z8), plutot qu'une
    // seule page qui grandissait sans limite (regression remontee par Loic
    // : "n'est plus A4"). Distribue les items sur des pages A4, convertit
    // les coordonnees de ligne en ABSOLU par page (necessaire pour l'export
    // PDF, qui n'a pas de positionnement relatif comme le CSS de l'apercu
    // DOM -- fait ici, une seule fois, pour que les deux rendus restent
    // garantis identiques).
    const gap = 0.8 * settings.fontSize;
    const usableHeight = dims.height - 2 * margin;
    const outPages = paginateItems(orderedItems, usableHeight, margin, gap, settings, measurer,
      { usableHeightLandscape: landscapeDims.height - 2 * margin });

    for (const pageItems of outPages) {
      for (const item of pageItems) {
        if (item.kind === 'flow' || item.kind === 'box') {
          for (const l of item.lines) { l.x += item.x; l.y += item.y; }
          // ADDENDUM 6, Z12, C1 : images de boite, meme passage en absolu
          // que les lignes (l'appelant, ici, ne connait que 'lines' avant
          // cette session -- une boite 'flow' de premier niveau n'a jamais
          // d'images, seules les boites 'box' en recoivent via
          // reflowBlocksInWidth, mais le garde ci-dessous est defensif).
          if (item.images) for (const im of item.images) { im.x += item.x; im.y += item.y; }
        } else if (item.kind === 'table') {
          for (const row of item.rows) {
            for (const cell of row.cells) {
              for (const l of cell.lines) { l.x += item.x + cell.x; l.y += item.y + row.y; }
              if (cell.images) for (const im of cell.images) { im.x += item.x + cell.x; im.y += item.y + row.y; }
            }
          }
        }
      }
    }

    return {
      pages: outPages.map((pageItems) => ({
        items: pageItems,
        // v0.3 (E4) : une page de tableau large est en A4 paysage, quel
        // que soit le reglage d'orientation du reste du document.
        pageDims: pageItems.landscape ? { width: landscapeDims.width, height: landscapeDims.height }
          : { width: pageWidthOut, height: dims.height },
        margin,
      })),
      settings,
      scaleFactor: widthRatio,
    };
  }

  // Distribue une liste d'items DEJA ORDONNEE (lecture correcte) sur des
  // pages de hauteur utile `usableHeight`. ADDENDUM 6, Z12, B1/B2 : une
  // boite et un tableau sont desormais SCINDABLES eux aussi (a une
  // frontiere de ligne / de rangee, cf. splitBoxItem/splitTableItem
  // ci-dessous) -- avant cette session, seul un item 'flow' (paragraphe)
  // pouvait l'etre, et une boite/tableau trop haut tombait systematiquement
  // dans la branche de debordement "en dernier recours" plus bas (cause
  // racine R2 du cadrage Z12 : rencontree sur 4 pages sur 5 de
  // Sq4_Fiche1_lire_recettes.pdf une fois A1 applique, les boites etant
  // devenues bien plus hautes en largeur de page pleine). Une image reste
  // seule non scindable (element atomique, y compris quand elle est a
  // l'interieur d'une boite/cellule, cf. Z12 C1 et splitBoxItem).
  function paginateItems(orderedItems, usableHeightPortrait, margin, gap, settings, measurer, opts) {
    const pages = [];
    let current = [];
    // v0.3 (E4) : un groupe d'items `landscapeGroup` (titre + tableau large)
    // occupe sa ou ses propres pages paysage ; le contenu suivant repart sur
    // une page portrait.
    const usableHeightLandscape = (opts && opts.usableHeightLandscape) || usableHeightPortrait;
    let curGroup = null;
    let usableHeight = usableHeightPortrait;
    // `y` est la position ABSOLUE sur la page de sortie (0 = bord haut de la
    // page), pas relative a la zone utile : demarre a `margin`, jamais a 0,
    // sinon le premier item de chaque page colle au bord (bug reel corrige
    // le 20/09/2026 -- la marge de page disparaissait completement, y
    // compris tout en haut de la 1ere page, remonte visuellement par un
    // tableau touchant le bord).
    let y = margin;

    function newPage() {
      if (current.length) { current.landscape = !!curGroup; pages.push(current); }
      current = [];
      y = margin;
    }

    for (let item of orderedItems) {
      const group = item.landscapeGroup || null;
      if (group !== curGroup) {
        newPage();
        curGroup = group;
        usableHeight = curGroup ? usableHeightLandscape : usableHeightPortrait;
      }
      // ADDENDUM 6, Z12, C1 -- garde-fou anti-boucle infinie (bug REEL
      // rencontre en implementant C1, Chrome bloque a 100% CPU sans jamais
      // rendre la page) : splitBoxItem()/splitTableItem()/splitFlowItem()
      // peuvent renvoyer `rest === item` (AUCUN progres possible, ex. un
      // fragment reduit au minimum de 2 lignes qui porte encore, a lui
      // seul, une IMAGE (Z12 C1) plus haute qu'une page A4 entiere). Sans
      // garde, le code ci-dessous rappelait newPage() puis retentait le
      // MEME split avec le MEME resultat, indefiniment -- boucle infinie
      // synchrone, jamais rencontree avant que les boites puissent porter
      // des images. Desormais : une seule nouvelle page est tentee quand la
      // page courante n'est pas vide ; si meme une page VIDE ne suffit pas
      // (aucun progres ET y === margin), on abandonne la scission et on
      // tombe directement dans le debordement de dernier recours (B3).
      let dejaRetenteSurPageVide = false;
      // ADDENDUM v0.3, phase 0.3 -- garde-fou anti-gel/anti-emballement
      // memoire (R1). Mesure le 23/09/2026 par pile CDP echantillonnee
      // (Debugger.pause) sur les 9 fiches sans sortie du corpus : sur
      // 16_Memo_Tableau_indiv.pdf et 20_Memo_Tableau_indiv.pdf (plantage
      // d'onglet, "Target crashed"), la boucle ci-dessous tourne encore a
      // plus de 30000 iterations sur UN SEUL item 'table' apres 30s,
      // chaque iteration rappelant newPage() pour n'y placer qu'une
      // fraction infime du tableau (compteur temporaire ajoute pour cette
      // mesure, retire ensuite) -- l'emballement memoire vient du nombre
      // de pages/fragments ainsi crees, pas d'un `while` qui ne progresse
      // jamais du tout (la cause racine, une mesure de rangee/ligne
      // aberrante issue d'un tableau mal segmente, reste au lot 1 : ici on
      // se contente de ne plus jamais laisser cette boucle tourner sans
      // fin). Plafond tres au-dessus du nombre de scissions necessaires
      // sur les 34 fiches qui aboutissent aujourd'hui (verifie par le
      // corpus -- `npm run corpus -- --compare`, aucun `[garde-fou]` sur
      // elles) : au-dela, on abandonne toute scission supplementaire pour
      // CET item et on le place tel quel, comme le debordement de dernier
      // recours (B3) plus bas.
      let iterGardeFouItem = 0;
      const PLAFOND_ITER_PAGINATION = 500;
      while (item) {
        iterGardeFouItem++;
        if (iterGardeFouItem > PLAFOND_ITER_PAGINATION) {
          const labelGf = item.kind === 'table' ? 'tableau'
            : item.kind === 'box' ? 'boite'
            : item.kind === 'image' ? 'image'
            : 'bloc de texte';
          const premiereCelluleTexte = item.rows && item.rows[0] && item.rows[0].cells && item.rows[0].cells[0] &&
            item.rows[0].cells[0].lines && item.rows[0].cells[0].lines[0] && item.rows[0].cells[0].lines[0].text;
          const apercu = (item.lines && item.lines[0] && item.lines[0].text) || premiereCelluleTexte || '';
          console.warn('[garde-fou] paginateItems : plafond de ' + PLAFOND_ITER_PAGINATION +
            ' scissions depasse pour ' + labelGf + ' (position source y=' + Math.round(item.srcTopY || 0) +
            'pt, hauteur ' + Math.round(item.height) + 'pt' +
            (item.rows ? ', ' + item.rows.length + ' rangees restantes' : '') +
            (item.lines ? ', ' + item.lines.length + ' lignes restantes' : '') +
            ', debut "' + String(apercu).slice(0, 30) + '"), place tel quel sans scission supplementaire.');
          item.y = y;
          current.push(item);
          y += item.height + gap;
          item = null;
          break;
        }
        const remaining = margin + usableHeight - y;
        if (!dejaRetenteSurPageVide && item.height <= remaining) {
          item.y = y;
          current.push(item);
          y += item.height + gap;
          item = null;
        } else if (!dejaRetenteSurPageVide && item.kind === 'flow' && item.height > 0) {
          const lignesAvant = item.lines.length;
          const [fits, rest] = splitFlowItem(item, remaining, usableHeight, gap, settings, measurer);
          const lignesApres = rest && rest.lines ? rest.lines.length : 0;
          // ADDENDUM v0.3, phase 0.3 -- garde-fou de non-progression (R1),
          // par symetrie avec la branche 'table' plus bas (voir son
          // commentaire pour la mesure et le raisonnement complets). Filet
          // de securite : pas mesure comme bloquant sur le corpus actuel
          // pour 'flow' (splitFlowItem() ne re-prepend rien, une vraie
          // scission retire donc toujours au moins une ligne -- ce cas
          // n'est en pratique jamais vrai aujourd'hui).
          //
          // `sansProgres` ne se declenche QUE si `rest` est un objet
          // DISTINCT de `item` (une vraie tentative de scission a eu lieu,
          // pas le cas `splitAt === 0` deja gere par le mecanisme EXISTANT
          // `dejaRetenteSurPageVide`/B3 plus bas) ET que cette tentative a
          // eu lieu sur une page DEJA VIDE (`y === margin`, budget deja
          // maximal : `remaining === usableHeight`, aucune page future,
          // aussi vide soit-elle, ne pourra offrir plus de place). Sur une
          // page NON vide, l'absence de progres est NORMALE (une vraie
          // frontiere de ligne peut n'apparaitre qu'une fois le budget
          // agrandi sur une page fraiche) : dans ce cas on laisse le
          // mecanisme EXISTANT (push de `fits`, `newPage()`, avance a
          // `rest`) suivre son cours SANS AUCUNE MODIFICATION -- c'est ce
          // qui a cause la regression trouvee par le corpus sur
          // F1/02_FicheOrtho et F1/09_FicheOrtho (voir le commentaire de la
          // branche 'table' pour le detail de cette mesure) quand une
          // version precedente de ce garde-fou interceptait aussi ce cas.
          const sansProgres = !!rest && rest !== item && lignesApres >= lignesAvant && y === margin;
          if (sansProgres) {
            console.warn('[garde-fou] paginateItems/splitFlowItem : scission sans progres sur page vide (' +
              lignesApres + ' lignes restantes apres coupure, contre ' + lignesAvant + ' avant), ' +
              'bloc de texte (position source y=' + Math.round(item.srcTopY || 0) + 'pt, hauteur ' +
              Math.round(item.height) + 'pt) place tel quel.');
            item.y = y; current.push(item); y += item.height + gap; item = null;
          } else {
            if (fits) { fits.y = y; current.push(fits); y += fits.height + gap; }
            if (rest && rest !== item) { newPage(); item = rest; }
            else if (rest && y > margin) { newPage(); } // meme item inchange : une seule relance sur page fraiche
            else if (rest) { dejaRetenteSurPageVide = true; } // toujours bloque sur une page VIDE : abandonne, deborde en dernier recours
            else { item = null; }
          }
        } else if (!dejaRetenteSurPageVide && item.kind === 'box' && item.lines && item.lines.length > 0) {
          // ADDENDUM 6, Z12, B1.
          const lignesAvant = item.lines.length;
          const [fits, rest] = splitBoxItem(item, remaining, settings);
          const lignesApres = rest && rest.lines ? rest.lines.length : 0;
          // ADDENDUM v0.3, phase 0.3 -- garde-fou de non-progression (R1),
          // meme principe et meme critere que la branche 'flow' ci-dessus
          // (filet de securite, non mesure comme bloquant sur le corpus
          // actuel pour 'box').
          const sansProgres = !!rest && rest !== item && lignesApres >= lignesAvant && y === margin;
          if (sansProgres) {
            console.warn('[garde-fou] paginateItems/splitBoxItem : scission sans progres sur page vide (' +
              lignesApres + ' lignes restantes apres coupure, contre ' + lignesAvant + ' avant), ' +
              'boite (position source y=' + Math.round(item.srcTopY || 0) + 'pt, hauteur ' +
              Math.round(item.height) + 'pt) placee telle quelle.');
            item.y = y; current.push(item); y += item.height + gap; item = null;
          } else {
            if (fits) { fits.y = y; current.push(fits); y += fits.height + gap; }
            if (rest && rest !== item) { newPage(); item = rest; }
            else if (rest && y > margin) { newPage(); }
            else if (rest) { dejaRetenteSurPageVide = true; }
            else { item = null; }
          }
        } else if (!dejaRetenteSurPageVide && item.kind === 'table' && item.rows && item.rows.length > 1) {
          // ADDENDUM 6, Z12, B2.
          const rangeesAvant = item.rows.length;
          const [fits, rest] = splitTableItem(item, remaining);
          const rangeesApres = rest && rest.rows ? rest.rows.length : 0;
          // ADDENDUM v0.3, phase 0.3 -- garde-fou de non-progression (R1).
          // Mesure le 23/09/2026 (compteurs temporaires, scripts jetables
          // supprimes ensuite) sur 5 fiches F4 differentes :
          // - 16/20_Memo_Tableau_indiv : la rangee de DONNEES qui suit
          //   l'en-tete (rows[1]) mesure a elle seule ~813-1330pt, deja plus
          //   haute que la page utile ENTIERE (usableHeight ~729pt) ;
          // - 14/15/17/19_Memo_Tableau_indiv : AUCUNE rangee individuelle
          //   ne depasse la page a elle seule (mesure sur 17 : en-tete
          //   190pt, 1ere rangee de donnees 636pt, chacune < 729pt), mais
          //   leur SOMME (826pt) depasse quand meme -- meme a partir d'une
          //   page vide toute neuve.
          // Dans les deux cas, splitTableItem() re-prepend la rangee
          // d'en-tete au fragment "reste" (comportement correct pour un
          // vrai reste de plusieurs rangees, cf. son propre commentaire) :
          // comme le budget `remaining` NE PEUT PAS depasser `usableHeight`
          // (page vide = budget maximal), si en-tete + rangee suivante ne
          // tiennent pas ENSEMBLE sur une page vide, elles ne tiendront
          // JAMAIS -- rest.rows.length reste alors identique a
          // item.rows.length A CHAQUE appel, indefiniment (mesure :
          // identique sur 500 iterations consecutives), pendant que
          // paginateItems cree une nouvelle page a chaque tour (mesure :
          // 501-502 pages en sortie avant ce garde-fou). Cause racine
          // (hauteur de rangee(s) aberrante en amont, tableau mal segmente)
          // hors perimetre ici -- lot 1.
          //
          // Critere retenu (evite la regression trouvee par le corpus sur
          // F1/02_FicheOrtho, F1/09_FicheOrtho et 01/04/06/07/09/11_
          // ExercicesAuto -- tableaux SAINS ou l'absence de progres est soit
          // TRANSITOIRE -- une page fraiche suivante y arrive tres bien,
          // cf. F1 : 4->4 rangees sur la 1ere tentative en page NON vide,
          // puis 4->3 des la page fraiche suivante -- soit deja geree par
          // le mecanisme EXISTANT quand `rest === item` exactement, cf.
          // ExercicesAuto ou l'en-tete seule, ~1010pt, depasse deja
          // `remaining` : `splitAt` vaut alors 0 et `rest` EST `item`,
          // regle par `dejaRetenteSurPageVide`/B3 plus bas SANS passer par
          // ce garde-fou) : `sansProgres` exige `rest !== item` (vraie
          // tentative de scission, pas le cas `rest === item` deja gere)
          // ET que cette tentative ait eu lieu sur une page DEJA VIDE
          // (`y === margin`, budget deja maximal : aucune page future ne
          // pourra offrir plus de place). Sur une page NON vide, on laisse
          // le mecanisme EXISTANT (push de `fits`, `newPage()`, avance a
          // `rest`) suivre son cours SANS AUCUNE MODIFICATION -- exactement
          // ce qui manquait a une version precedente de ce garde-fou et
          // causait la regression F1/ExercicesAuto (page forcee EN PLEIN
          // MILIEU d'une page partiellement remplie, deborde hors cadre,
          // decale toute la pagination qui suit).
          const sansProgres = !!rest && rest !== item && rangeesApres >= rangeesAvant && y === margin;
          if (sansProgres) {
            console.warn('[garde-fou] paginateItems/splitTableItem : scission sans progres sur page vide (' +
              rangeesApres + ' rangees restantes apres coupure, contre ' + rangeesAvant + ' avant), ' +
              'tableau (position source y=' + Math.round(item.srcTopY || 0) + 'pt, hauteur ' +
              Math.round(item.height) + 'pt) place tel quel.');
            item.y = y; current.push(item); y += item.height + gap; item = null;
          } else {
            if (fits) { fits.y = y; current.push(fits); y += fits.height + gap; }
            if (rest && rest !== item) { newPage(); item = rest; }
            else if (rest && y > margin) { newPage(); }
            else if (rest) { dejaRetenteSurPageVide = true; }
            else { item = null; }
          }
        } else if (!dejaRetenteSurPageVide && y > margin) {
          // Boite/tableau/image qui ne peut pas etre scinde ICI (page non
          // vide) : entier sur la suivante. reessaie sur la page fraiche
          // (boucle while) ; si ca ne tient toujours pas (item plus haut
          // qu'une page entiere a lui seul), tombe dans la branche
          // ci-dessous et deborde en dernier recours.
          newPage();
        } else {
          // ADDENDUM 6, Z12, B3 -- correctif du 20/09/2026 : ce cas etait
          // auparavant un simple commentaire ("aucun des documents
          // test/v0.2/ ne l'a rencontre a ce jour"), silencieux. Avec B1/B2,
          // il ne devrait PLUS JAMAIS se produire sur les 3 documents cibles
          // (une boite/tableau qui ne tient toujours pas sur une page VIDE
          // signifie qu'il est plus haut que la page A4 entiere, ou -- pour
          // une boite/un tableau -- que la regle veuve/orpheline du lot B a
          // refuse de le scinder si pres du minimum de 2 lignes/rangees).
          // Garde-fou explicite plutot que degradation silencieuse : avertit
          // (nomme l'item) pour qu'un futur document problematique se
          // signale au developpeur au lieu de simplement deborder sans
          // explication.
          const label = item.kind === 'table' ? 'tableau'
            : item.kind === 'box' ? 'boite'
            : item.kind === 'image' ? 'image'
            : 'bloc de texte';
          console.warn('[mise en page] debordement de dernier recours : ' + label +
            ' plus haut que la page entiere, place tel quel sans etre scinde (hauteur ' +
            Math.round(item.height) + 'pt).');
          item.y = y;
          current.push(item);
          y += item.height + gap;
          item = null;
        }
      }
    }
    if (current.length) { current.landscape = !!curGroup; pages.push(current); }
    if (!pages.length) pages.push([]);
    return pages;
  }

  // Scinde un item 'flow' a la derniere frontiere de ligne qui tient dans
  // `remaining` (hauteur restante sur la page courante). Retourne
  // [fragmentQuiTient|null, fragmentRestant|null]. Les deux fragments sont
  // des items 'flow' independants, chacun avec des lignes RE-BASEES a 0 (le
  // fragment restant recommence en haut de la page suivante).
  function splitFlowItem(item, remaining, usableHeight, gap, settings, measurer) {
    // ADDENDUM 6, Z12, C1 -- correctif du 20/09/2026 : `remaining` NEGATIF
    // (bug reel trouve en testant cette session sur 2_Memo_Carte_indiv1.pdf)
    // etait traite comme "page vide, budget = page entiere" (`usableHeight`)
    // -- une hypothese fausse ici : `remaining` ne devient negatif QUE
    // lorsque `y` a deja DEPASSE le bas de la page utile (l'item precedent
    // tenait de justesse, mais `y += item.height + gap` a fait franchir la
    // limite a lui seul), pas seulement sur une page fraiche. Avec l'ancien
    // fallback, cet item etait alors considere comme tenant EN ENTIER dans
    // une page pleine imaginaire, et place tel quel bien APRES le bas reel
    // de la page -- debordement silencieux (aucun avertissement B3, la
    // fonction croyait sincerement que ca tenait). Expose pour la premiere
    // fois par C1 : une boite avec image occupe desormais presque toute la
    // hauteur utile, laissant moins de marge que `gap` avant le prochain
    // item. Budget correct : au plus `remaining`, jamais moins de 0 (si
    // negatif ou nul, RIEN ne peut tenir ici -- bascule tout sur la page
    // suivante, cf. `splitAt === 0` ci-dessous).
    const budget = Math.max(0, remaining);
    let splitAt = item.lines.length;
    // ADDENDUM v0.3, phase 0.3 -- garde-fou de croissance non bornee (R1) :
    // cette recherche est deja bornee par item.lines.length, mais un nombre
    // de lignes aberrant (extraction defaillante en amont) rendrait cette
    // boucle couteuse a chaque appel, elle-meme rappelee de nombreuses fois
    // par paginateItems -- plafond tres au-dessus du nombre de lignes de
    // toute fiche du corpus, warn + arret de la recherche a la meilleure
    // coupure trouvee jusqu'ici plutot que de continuer sans fin.
    const PLAFOND_LIGNES_FLOW = 20000;
    for (let i = 0; i < item.lines.length; i++) {
      if (i > PLAFOND_LIGNES_FLOW) {
        console.warn('[garde-fou] splitFlowItem : plafond de ' + PLAFOND_LIGNES_FLOW +
          ' lignes depasse (item avec ' + item.lines.length + ' lignes), recherche de coupure arretee.');
        break;
      }
      if (item.lines[i].y + item.lines[i].sizePt * 0.4 > budget) { splitAt = i; break; }
    }
    if (splitAt === 0) return [null, item]; // rien ne tient ici, tout sur la page suivante
    if (splitAt >= item.lines.length) return [item, null]; // tient en entier

    const firstLines = item.lines.slice(0, splitAt);
    const restLinesRaw = item.lines.slice(splitAt);
    const offset = restLinesRaw[0].y;
    const restLines = restLinesRaw.map((l) => ({ ...l, y: l.y - offset }));
    const lastFirst = firstLines[firstLines.length - 1];
    const fits = { ...item, lines: firstLines, height: lastFirst.y + lastFirst.sizePt * 0.4 };
    const rest = { ...item, lines: restLines, height: item.height - offset, srcTopY: item.srcTopY };
    return [fits, rest];
  }

  // ADDENDUM 6, Z12, B1 -- scinde un item 'box' (encadre) a la derniere
  // frontiere de LIGNE qui tient dans `remaining`, cadre (fond/bordure/
  // coins/outerWrap) REDESSINE sur chaque fragment (chaque fragment est un
  // item 'box' complet, avec sa propre hauteur recalculee -- cf. rendu
  // 04-pdf-export.js/05-main.js, qui dessine un rectangle par item 'box'
  // sans savoir qu'il s'agit d'un fragment). Regle veuve/orpheline : jamais
  // moins de 2 lignes d'un cote ; si la frontiere naturelle laisse moins de
  // 2 lignes sur le fragment "reste", la frontiere recule pour en garder 2 ;
  // si ce recul fait tomber le fragment "tient" sous 2 lignes a son tour, on
  // renonce a scinder ICI (la boite entiere bascule sur la page suivante,
  // cf. paginateItems). Les images de la boite (Z12, C1) sont des elements
  // ATOMIQUES : chacune part entiere du cote de la frontiere ou elle se
  // trouve, jamais coupee en deux.
  function splitBoxItem(item, remaining, settings) {
    const boxPad = 0.5 * settings.fontSize; // meme formule qu'a la construction de la boite (computeBlockLayout)
    const budget = remaining - boxPad; // reserve le rembourrage bas du cadre
    const imgs = item.images || [];
    // ADDENDUM 6, Z12, lot 3 (point 3, F2, collateral decouvert en
    // verifiant F2) -- correctif du 20/09/2026. Avant F2, une image de
    // boite finissait TOUJOURS apres tout le texte (extractImageBlocksFor
    // Page pousse les images apres tous les blocs de texte de la page,
    // cf. commentaire sur ce meme sujet dans assignBlocksToContainers) :
    // la recherche de frontiere ci-dessous, qui ne testait QUE les lignes,
    // ne pouvait donc jamais couper "trop tard" a cause d'une image -- le
    // texte, toujours coupe avant elle, la reléguait deja dans le fragment
    // "reste". F2 replace desormais chaque image a sa vraie position dans
    // l'ordre de lecture (peut etre en tete de boite) : une image proche
    // du HAUT peut alors, a elle seule, deja depasser le budget restant
    // AVANT meme d'atteindre la ligne suivante -- bug reel constate sur le
    // PDF EXPORTE, Sq4_Fiche1_lire_recettes.pdf page 3 (une boite de
    // recette avec sa photo, placee juste apres le titre dans la
    // source, debordait de 94px : la recherche s'arretait a la ligne qui
    // suit l'image sans avoir verifie que l'image ELLE-MEME tenait).
    //
    // fragmentExtent(i) = etendue verticale du fragment "tient" SI on
    // coupe juste avant la ligne d'indice i (firstLines = lignes[0..i-1])
    // -- max entre le bas de la derniere ligne incluse et le bas de TOUTE
    // image qui tomberait, elle aussi, dans ce fragment (im.y < cutY).
    // Strictement croissante avec i (cutY grandit, jamais moins de lignes/
    // images inclues) : une recherche lineaire simple suffit, on s'arrete
    // au premier i qui deborde.
    function fragmentExtent(i) {
      const cutY = i < item.lines.length ? item.lines[i].y : Infinity;
      let ext = i > 0 ? item.lines[i - 1].y + item.lines[i - 1].sizePt * 0.4 : 0;
      for (const im of imgs) if (im.y < cutY) ext = Math.max(ext, im.y + im.height);
      return ext;
    }
    let splitAt = 0;
    // ADDENDUM v0.3, phase 0.3 -- garde-fou de croissance non bornee (R1),
    // meme principe que splitFlowItem ci-dessus : deja borne par
    // item.lines.length, plafond defensif au-dela duquel on arrete la
    // recherche a la meilleure coupure trouvee (warn) plutot que de
    // continuer sans fin sur un nombre de lignes aberrant.
    const PLAFOND_LIGNES_BOX = 20000;
    for (let i = 0; i <= item.lines.length; i++) {
      if (i > PLAFOND_LIGNES_BOX) {
        console.warn('[garde-fou] splitBoxItem : plafond de ' + PLAFOND_LIGNES_BOX +
          ' lignes depasse (item avec ' + item.lines.length + ' lignes), recherche de coupure arretee.');
        break;
      }
      if (fragmentExtent(i) <= budget) splitAt = i; else break;
    }
    if (splitAt > item.lines.length - 2) splitAt = item.lines.length - 2; // jamais < 2 lignes sur le fragment "reste"
    if (splitAt < 2) return [null, item]; // pas assez de place pour 2 lignes de chaque cote : boite entiere sur la page suivante
    if (splitAt >= item.lines.length) return [item, null]; // tient en entier (defensif, ne devrait pas arriver ici)

    const cutY = item.lines[splitAt].y; // frontiere source : tout ce qui commence avant reste sur ce fragment
    const firstLines = item.lines.slice(0, splitAt);
    const restLinesRaw = item.lines.slice(splitAt);
    // ADDENDUM 6, Z12, lot 3 (point 1) -- correctif du 20/09/2026, cause
    // exactement tracee par Loic avant correction. `l.y` est une ligne de
    // BASE, pas un sommet : a la construction (reflowBlocksInWidth), la
    // toute PREMIERE ligne d'une boite (startY = boxPadding) a sa base a
    // `boxPadding + lineGap*0.8` (cf. `lines.push({ y: y + lineGap*0.8,
    // ... })`), jamais a `boxPadding` tout court. L'ancien calcul posait la
    // base de la 1ere ligne du fragment "reste" a `boxPad` directement --
    // le corps du texte (qui se dessine AU-DESSUS de sa ligne de base)
    // remontait alors de `0.8 * lineGap` au-dessus de son rembourrage haut,
    // droit sur le trait du cadre redessine. Reprend la MEME formule qu'a
    // la construction, avec le lineGap de CETTE ligne (les tailles de ligne
    // different pour un titre, cf. HEADING_FACTORS).
    const bodyLineGap0 = settings.fontSize * settings.lineHeight;
    const lineGap0 = restLinesRaw[0].isHeading ? restLinesRaw[0].sizePt * settings.lineHeight : bodyLineGap0;
    const offset = restLinesRaw[0].y - boxPad - lineGap0 * 0.8; // le fragment "reste" repart en haut avec son propre rembourrage
    const restLines = restLinesRaw.map((l) => ({ ...l, y: l.y - offset }));

    // `imgs` deja declare plus haut (recherche de frontiere, F2).
    const firstImages = imgs.filter((im) => im.y < cutY);
    const restImages = imgs.filter((im) => im.y >= cutY).map((im) => ({ ...im, y: im.y - offset }));

    const lastFirst = firstLines[firstLines.length - 1];
    let fitsHeight = lastFirst.y + lastFirst.sizePt * 0.4 + boxPad;
    for (const im of firstImages) fitsHeight = Math.max(fitsHeight, im.y + im.height + boxPad);
    let restHeight = item.height - offset;
    for (const im of restImages) restHeight = Math.max(restHeight, im.y + im.height + boxPad);

    const fits = { ...item, lines: firstLines, images: firstImages, height: fitsHeight };
    const rest = { ...item, lines: restLines, images: restImages, height: restHeight, srcTopY: item.srcTopY };
    return [fits, rest];
  }

  // ADDENDUM 6, Z12, B2 -- scinde un item 'table' a une frontiere de
  // RANGEE (jamais au milieu d'une rangee). Si la rangee 0 est identifiee
  // comme rangee d'en-tete (isHeaderRow, cf. plus haut), elle est REPETEE
  // en haut du fragment "reste" -- sans quoi la moitie basse d'un grand
  // tableau scinde perdrait le sens de ses colonnes (cas reel vise :
  // 10_FicheOrtho.pdf, colonnes "Noms/Verbes/Adjectifs/Mots invariables").
  // Limite assumee (cf. cadrage Z12, B2) : si une SEULE rangee est a elle
  // seule plus haute que l'espace disponible sur une page VIDE, elle n'est
  // pas scindee a l'interieur de ses cellules -- tombe dans le garde-fou de
  // debordement de dernier recours (B3) ; non rencontre sur les 3 documents
  // cibles.
  function splitTableItem(item, remaining) {
    const rows = item.rows;
    const header = item.headerRow;
    let cum = 0, splitAt = rows.length;
    // ADDENDUM v0.3, phase 0.3 -- garde-fou de croissance non bornee (R1).
    // Mesure le 23/09/2026 (16_Memo_Tableau_indiv.pdf, 20_Memo_Tableau_indiv.pdf) :
    // un tableau mal segmente en amont peut produire des dizaines de
    // milliers de rangees -- cette boucle, deja bornee par rows.length,
    // reste alors couteuse a CHAQUE appel, or paginateItems la rappelle une
    // fois par rangee retiree (cf. son propre plafond ci-dessus). Plafond
    // defensif ici aussi : au-dela, on arrete la recherche a la meilleure
    // coupure trouvee (warn) plutot que de parcourir le reste des rangees.
    const PLAFOND_RANGEES_TABLE = 20000;
    for (let r = 0; r < rows.length; r++) {
      if (r > PLAFOND_RANGEES_TABLE) {
        console.warn('[garde-fou] splitTableItem : plafond de ' + PLAFOND_RANGEES_TABLE +
          ' rangees depasse (tableau avec ' + rows.length + ' rangees), recherche de coupure arretee.');
        break;
      }
      cum += rows[r].height;
      if (cum > remaining) { splitAt = r; break; }
    }
    if (splitAt === 0) return [null, item]; // meme la 1ere rangee ne tient pas ici : tableau entier sur la page suivante
    if (splitAt >= rows.length) return [item, null]; // tient en entier (defensif)

    const firstRows = rows.slice(0, splitAt);
    const restRowsRaw = rows.slice(splitAt);
    // La rangee d'en-tete (deja presente dans firstRows, splitAt >= 1) est
    // repetee en tete du fragment "reste" -- meme objet de cellules,
    // seule sa position Y differe entre fragments (recalculee ci-dessous).
    const restRows = header ? [header, ...restRowsRaw] : restRowsRaw;

    let y1 = 0;
    const firstRowsOut = firstRows.map((r) => { const out = { ...r, y: y1 }; y1 += r.height; return out; });
    let y2 = 0;
    const restRowsOut = restRows.map((r) => { const out = { ...r, y: y2 }; y2 += r.height; return out; });

    const fits = { ...item, rows: firstRowsOut, height: y1 };
    const rest = { ...item, rows: restRowsOut, height: y2, srcTopY: item.srcTopY };
    return [fits, rest];
  }

  function hexToRgbArr(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!m) return [0, 0, 0];
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  }

  // ADDENDUM 6, Z5 : resolution couleur/N&B partagee entre l'apercu DOM et
  // l'export PDF (04-pdf-export.js), pour que les deux rendus restent
  // TOUJOURS identiques -- c'est le principe fondateur de ce moteur ("une
  // seule passe de calcul, deux rendus"), qui s'etendrait sinon a la
  // couleur seulement dans un des deux si la regle etait dupliquee.
  //
  // Regle : en mode "nb", tout suit le theme de contraste choisi. En mode
  // "couleur", une couleur de texte extraite du PDF source est conservee
  // telle quelle (elle porte un sens pedagogique -- mot mis en evidence,
  // categorie grammaticale) SAUF si elle est proche du noir pur, auquel cas
  // elle suit plutot le theme (permet par ex. un contraste jaune-sur-bleu
  // marine sans laisser du texte "noir" illisible sur fond sombre).
  //
  // v0.3, lot 1 (C1/M5/X1) -- plancher de contraste. Mesure du diagnostic :
  // les 43 fiches ont des titres/intitules dans leur couleur source a 1,7-
  // 2,2:1 sur blanc (vert d'eau, vert, orange), illisibles pour un lecteur
  // basse vision ; les terminaisons colorees et les trous pales aussi.
  // Regle : la couleur source est gardee si son contraste avec le fond
  // REELLEMENT derriere le texte (fond de page, de boite ou de cellule --
  // `bg`) atteint 4,5:1 (WCAG AA) ; sinon elle est assombrie (fond clair)
  // ou eclaircie (fond sombre) en gardant sa teinte, juste assez pour
  // l'atteindre. S'applique aussi a la couleur du theme (texte noir sur une
  // boite a fond sombre). Seuil unique 4,5:1 : l'outil sert un lecteur basse
  // vision, le seuil « grand texte » (3:1) ne suffit pas.
  // Cible 5,0:1 pour garantir 4,5:1 A L'ECRAN : mesure sur le corpus
  // (npm run corpus, 24/09/2026), une couleur calculee a 4,5:1 tout juste
  // ressort a 4,25-4,48:1 une fois rendue (anticrenelage des bords de
  // glyphe, surtout en gras et sur les petits signes).
  const MIN_CONTRAST = 5.0;
  function relLuminance(c) {
    const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  }
  function contrastRatio(a, b) {
    const la = relLuminance(a), lb = relLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  function ensureContrast(color, bg, minRatio) {
    if (contrastRatio(color, bg) >= minRatio) return color;
    const target = relLuminance(bg) > 0.18 ? [0, 0, 0] : [255, 255, 255];
    for (let t = 0.05; t <= 1.0001; t += 0.05) {
      const mixed = color.map((v, i) => Math.round(v + (target[i] - v) * t));
      if (contrastRatio(mixed, bg) >= minRatio) return mixed;
    }
    return target;
  }

  function resolveTextColor(runColor, settings, theme, bg) {
    const themeFg = hexToRgbArr(theme.fg);
    const back = bg || hexToRgbArr(theme.bg);
    let c;
    if (settings.colorMode === 'nb' || !runColor) c = themeFg;
    else if (runColor[0] < 20 && runColor[1] < 20 && runColor[2] < 20) c = themeFg;
    else c = [Math.round(runColor[0]), Math.round(runColor[1]), Math.round(runColor[2])];
    // Gris ou blanc sous le seuil (chiffre blanc d'une pastille dont le
    // disque n'est pas rendu) : couleur du theme plutot qu'un gris juste
    // passable -- seules les couleurs franches gardent leur teinte.
    if (!isChromatic(c) && contrastRatio(c, back) < MIN_CONTRAST) c = themeFg;
    return ensureContrast(c, back, MIN_CONTRAST);
  }

  // Boites/tableaux : en mode "nb", fond = fond de page (pas de bloc de
  // couleur), bordure = couleur de premier plan du theme. En mode "couleur",
  // conserve les couleurs source ; a defaut (ex. tableau sans trait de
  // couleur associe), replie sur un gris neutre discret plutot que rien.
  function resolveContainerColors(fillSrc, strokeSrc, settings, theme) {
    if (settings.colorMode === 'nb') {
      return { fill: hexToRgbArr(theme.bg), stroke: hexToRgbArr(theme.fg) };
    }
    return {
      fill: fillSrc || hexToRgbArr(theme.bg),
      stroke: strokeSrc || [153, 153, 153],
    };
  }

  // Rassemble toutes les lignes rendues d'une page (flux libre + boites +
  // cellules de tableau), pour les besoins communs aux deux renderers
  // (apercu DOM, export PDF) et au calcul de l'avertissement "lignes trop
  // courtes".
  function collectPageLines(pageLayout) {
    const out = [];
    for (const item of pageLayout.items) {
      if (item.kind === 'flow' || item.kind === 'box') {
        for (const l of item.lines) out.push(l);
      } else if (item.kind === 'table') {
        for (const row of item.rows) for (const cell of row.cells) for (const l of cell.lines) out.push(l);
      }
    }
    return out;
  }

  // Point d'entree DOCUMENT (multi-page) du moteur par blocs -- appelle
  // computeBlockLayout() page par page et assemble le resultat dans une
  // forme structurellement proche de computeLayout() (pages/settings/theme)
  // pour que l'appelant (05-main.js) n'ait qu'un seul point de bascule.
  // Contrairement a computeLayout(), chaque page a SES PROPRES pageDims
  // (elle grandit selon son propre contenu, cf. Addendum 6 Z1) : pas de
  // pageDims unique partagee.
  function computeBlockLayoutForDocument(extraction, blocks, settings, measurer) {
    settings = clampSettings(settings);
    const pageCount = extraction.pageSizes.length;
    const dims = pageDimsPt(settings.orientation);
    const pages = [];
    let totalCharSamples = 0, totalLineSamples = 0;

    for (let p = 0; p < pageCount; p++) {
      const pageBlocks = blocks.filter((b) => b.srcPage === p + 1 && b.type !== 'pagebreak' && b.type !== 'needs-ocr');
      const pageShapesForPage = extraction.pageShapes[p] || { boxes: [], lines: [], decorative: [] };
      const pageSizeForPage = extraction.pageSizes[p] || { width: dims.width, height: dims.height, modalSize: 12 };
      // ADDENDUM 6, Z9 : computeBlockLayout() pagine desormais lui-meme
      // (une page source peut produire plusieurs pages de sortie A4) --
      // on aplatit son resultat dans la liste globale de pages du document.
      const { pages: sourcePageOutputs } = computeBlockLayout(pageBlocks, pageShapesForPage, pageSizeForPage, settings, measurer);
      pages.push(...sourcePageOutputs);

      // Flux libre ET boites (pleine largeur de page depuis A1, Z12) sont
      // pertinents pour l'avertissement "lignes trop courtes" -- SEULES les
      // cellules de tableau restent legitimement plus etroites (colonnes) et
      // en sont exclues. Avant A1, les boites gardaient la largeur de leur
      // colonne source (~45%) et etaient a bon droit exclues ("une boite
      // etroite produit legitimement des lignes courtes") ; ce commentaire
      // est devenu FAUX une fois A1 aligne leur largeur sur celle du flux --
      // constate ici : les exclure encore faisait dire a l'avertissement
      // "23 caracteres par ligne" sur 2_Memo (tout son texte est en boites)
      // alors que ses lignes pleines mesurent 35+.
      for (const outPage of sourcePageOutputs) {
        for (const item of outPage.items) {
          if (item.kind !== 'flow' && item.kind !== 'box') continue;
          // ADDENDUM 6, Z12, F1 -- `isLastLine` (pose par reflowBlocksInWidth)
          // marque la fin naturelle d'un bloc, pas un retour a la ligne
          // automatique -- on l'exclut de la moyenne.
          for (const l of item.lines) {
            if (l.isLastLine) continue;
            totalLineSamples += 1;
            totalCharSamples += l.segments.reduce((a, s) => a + s.text.length, 0);
          }
        }
      }
    }

    const avgCharsPerLine = totalLineSamples ? totalCharSamples / totalLineSamples : 0;

    return {
      pages,
      settings,
      theme: CONTRAST_THEMES[settings.contrast],
      avgCharsPerLine,
      charsPerLineWarning: avgCharsPerLine > 0 && avgCharsPerLine < 35,
    };
  }

  window.LayoutEngine = {
    DEFAULTS,
    CONTRAST_THEMES,
    clampSettings,
    pageDimsPt,
    makeMeasurer,
    computeLayout,
    computeBlockLayout,
    computeBlockLayoutForDocument,
    collectPageLines,
    resolveTextColor,
    resolveContainerColors,
    hexToRgbArr,
    detectTables,
    assignBlocksToContainers,
    MM_TO_PT,
    MARGIN_MM,
  };
})();
