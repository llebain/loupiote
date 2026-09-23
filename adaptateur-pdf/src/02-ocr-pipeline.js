/* ============================================================================
 * 02-ocr-pipeline.js
 * Chaine de traitement pour les pages scannees / a couche texte inexploitable :
 * rendu haute resolution, detection d'orientation (OSD), correction
 * d'inclinaison (deskew), rognage des bandes d'ombre, decoupage double-page
 * avec ordonnancement par folio OCRise, OCR francais, nettoyage.
 * ==========================================================================*/

(function () {
  'use strict';

  const OEM_LSTM_ONLY = 1;

  // Retire les tokens isoles composes UNIQUEMENT de symboles typiques du
  // bruit OCR sur artefacts graphiques (traits de dessin, ombres pres de la
  // reliure) : "_(", "|", "\", "^", etc. Ne touche JAMAIS aux tirets
  // cadratins, guillemets ou apostrophes qui portent le sens du dialogue.
  function cleanOcrNoiseTokens(lineText) {
    return lineText
      .split(/\s+/)
      .filter((tok) => !/^[_|\\^~`]{1,4}[()]{0,2}$/.test(tok) && tok !== '(' && tok !== ')')
      .join(' ')
      .trim();
  }

  // --- ADDENDUM 4, section U.1 : Tesseract rend systematiquement les
  // guillemets francais « » sous la forme < / >. Un "<" ou ">" isole entre
  // espaces (ou en debut/fin de texte) dans un texte francais n'est jamais
  // un signe mathematique : c'est toujours un guillemet.
  function fixFrenchQuotes(text) {
    return text
      .replace(/(^|[\s(])<\s*/g, '$1« ')
      .replace(/\s*>(?=[\s.,!?;:)…]|$)/g, ' »');
  }

  // --- Complement a l'ADDENDUM 4 U.2 : un trait d'union ISOLE (espace avant
  // ET apres) n'est jamais une ponctuation francaise legitime en milieu de
  // texte -- un vrai trait d'union colle toujours ses deux mots
  // ("grondait-elle"). Un "-" isole est systematiquement un tiret cadratin
  // de dialogue mal reconnu par Tesseract (trait trop court pour etre
  // distingue d'un tiret a la resolution du scan). Meme logique et meme
  // niveau de confiance que la correction des guillemets ci-dessus.
  function fixIsolatedDashes(text) {
    return text.replace(/(^|\s)-(\s)/g, '$1—$2');
  }

  // --- ADDENDUM 4, section T.1 : detection CONSERVATRICE de titre de
  // chapitre sur texte OCR. Les trois conditions doivent etre reunies :
  // ligne courte (<=5 mots), entierement en capitales, hauteur de bbox
  // nettement superieure au corps (>=1.4x). Un paragraphe d'une seule ligne
  // qui verifie les trois est classe titre ; sinon jamais -- conforme a la
  // regle "ne pas fabriquer de titre absent" (deux essais precedents bases
  // sur la seule hauteur avaient produit des faux positifs, voir historique
  // dans tests/spike-notes.md).
  function looksLikeAllCaps(text) {
    const letters = text.replace(/[^\p{L}]/gu, '');
    if (letters.length < 2) return false;
    return letters === letters.toUpperCase() && letters !== letters.toLowerCase();
  }

  function isConservativeHeading(text, para, modalHeight) {
    const lines = para.lines || [];
    if (lines.length !== 1) return false; // isole verticalement : un titre tient sur une ligne
    const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount === 0 || wordCount > 5) return false;
    if (!looksLikeAllCaps(text)) return false;
    if (!para.bbox || !modalHeight) return false;
    const height = para.bbox.y1 - para.bbox.y0;
    return height > modalHeight * 1.4;
  }

  // --- Rendu d'une page pdf.js en canvas, a une resolution cible (dpi
  // "equivalent"). pdf.js applique automatiquement /Rotate (verifie sur le
  // fichier de test reel : c'est la maniere CORRECTE et suffisante de
  // corriger l'orientation encodee dans le PDF, sans heuristique).
  async function renderPageToCanvas(page, targetDpi) {
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = targetDpi / 72;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  }

  function canvasToGrayscale(canvas, maxDim) {
    let w = canvas.width, h = canvas.height;
    let scale = 1;
    if (maxDim && Math.max(w, h) > maxDim) {
      scale = maxDim / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);
    const gray = new Float32Array(w * h);
    for (let i = 0, j = 0; i < imgData.data.length; i += 4, j++) {
      gray[j] = 0.299 * imgData.data[i] + 0.587 * imgData.data[i + 1] + 0.114 * imgData.data[i + 2];
    }
    return { gray, w, h, scale };
  }

  // --- Rognage des bandes d'ombre en bordure (capot de scanner ouvert).
  // Scanne depuis chaque bord vers l'interieur ; une bande d'ombre presente
  // une luminosite moyenne nettement plus basse et plus uniforme que le
  // contenu. Plafond de securite : jamais plus de 8% par bord.
  function detectShadowCrop(gray, w, h) {
    const rowMean = (y) => {
      let s = 0; for (let x = 0; x < w; x++) s += gray[y * w + x];
      return s / w;
    };
    const colMean = (x) => {
      let s = 0; for (let y = 0; y < h; y++) s += gray[y * w + x];
      return s / h;
    };
    // Luminosite mediane globale approx (page = majoritairement blanche)
    let samples = [];
    for (let i = 0; i < gray.length; i += 37) samples.push(gray[i]);
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)] || 200;
    // ADDENDUM 5, Y2 : seuil resserre (etait 0.55/120) -- le seuil precedent
    // pouvait mordre sur du texte reel pres du bord (lettre en debut de
    // ligne rognee). On ne veut declencher un rognage que sur une bande
    // VRAIMENT sombre (ombre de capot), pas une simple zone un peu plus
    // grise que la mediane.
    const darkThreshold = Math.min(median * 0.4, 90);

    const maxCropFrac = 0.08;
    let top = 0, bottom = h, left = 0, right = w;
    const maxTop = Math.floor(h * maxCropFrac);
    while (top < maxTop && rowMean(top) < darkThreshold) top++;
    const maxBottom = h - Math.floor(h * maxCropFrac);
    while (bottom - 1 > maxBottom && rowMean(bottom - 1) < darkThreshold) bottom--;
    const maxLeft = Math.floor(w * maxCropFrac);
    while (left < maxLeft && colMean(left) < darkThreshold) left++;
    const maxRight = w - Math.floor(w * maxCropFrac);
    while (right - 1 > maxRight && colMean(right - 1) < darkThreshold) right--;

    return { top, bottom, left, right };
  }

  // --- Deskew leger : cherche, parmi un petit eventail d'angles, celui qui
  // maximise la variance du profil de projection horizontal (les lignes de
  // texte bien horizontales produisent des bandes claires/sombres nettes).
  function estimateSkewAngle(gray, w, h) {
    function projectionVarianceAtAngle(angleDeg) {
      const rad = (angleDeg * Math.PI) / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      const bins = new Float32Array(h);
      const counts = new Int32Array(h);
      const cx = w / 2, cy = h / 2;
      for (let y = 0; y < h; y += 2) {
        for (let x = 0; x < w; x += 2) {
          const dx = x - cx, dy = y - cy;
          const ry = Math.round(dy * cos - dx * sin + cy);
          if (ry < 0 || ry >= h) continue;
          bins[ry] += 255 - gray[y * w + x];
          counts[ry] += 1;
        }
      }
      let mean = 0, n = 0;
      for (let i = 0; i < h; i++) { if (counts[i]) { mean += bins[i] / counts[i]; n++; } }
      mean /= (n || 1);
      let variance = 0;
      for (let i = 0; i < h; i++) { if (counts[i]) { const v = bins[i] / counts[i]; variance += (v - mean) * (v - mean); } }
      return variance / (n || 1);
    }

    let best = 0, bestVar = -Infinity;
    for (let a = -4; a <= 4; a += 0.5) {
      const v = projectionVarianceAtAngle(a);
      if (v > bestVar) { bestVar = v; best = a; }
    }
    return best;
  }

  function rotateCanvas(canvas, degrees) {
    if (Math.abs(degrees) < 0.01) return canvas;
    const rad = (degrees * Math.PI) / 180;
    const w = canvas.width, h = canvas.height;
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2, h / 2);
    ctx.rotate(rad);
    ctx.drawImage(canvas, -w / 2, -h / 2);
    return out;
  }

  function cropCanvas(canvas, box) {
    const w = box.right - box.left, h = box.bottom - box.top;
    if (w <= 0 || h <= 0) return canvas;
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    out.getContext('2d').drawImage(canvas, box.left, box.top, w, h, 0, 0, w, h);
    return out;
  }

  function rotate90Canvas(canvas, times) {
    times = ((times % 4) + 4) % 4;
    if (times === 0) return canvas;
    const w = canvas.width, h = canvas.height;
    const out = document.createElement('canvas');
    if (times === 2) { out.width = w; out.height = h; } else { out.width = h; out.height = w; }
    const ctx = out.getContext('2d');
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate((times * 90 * Math.PI) / 180);
    ctx.drawImage(canvas, -w / 2, -h / 2);
    return out;
  }

  // --- Detection de gouttiere centrale (double page) : colonne de faible
  // densite d'encre proche du milieu horizontal, traversant toute la hauteur.
  function detectGutter(gray, w, h) {
    const colInk = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = 0; y < h; y += 2) s += Math.max(0, 200 - gray[y * w + x]);
      colInk[x] = s;
    }
    // Cherche le minimum d'encre dans la bande centrale (30%-70% de la largeur)
    const lo = Math.floor(w * 0.30), hi = Math.floor(w * 0.70);
    let minX = lo, minV = Infinity;
    for (let x = lo; x < hi; x++) {
      if (colInk[x] < minV) { minV = colInk[x]; minX = x; }
    }
    // Moyenne d'encre hors bande centrale, pour comparer
    let outsideSum = 0, outsideN = 0;
    for (let x = 0; x < w; x++) {
      if (x < lo || x >= hi) { outsideSum += colInk[x]; outsideN++; }
    }
    const outsideMean = outsideSum / (outsideN || 1);
    const isClearGutter = minV < outsideMean * 0.35;
    return { x: minX, isClearGutter, ratio: outsideMean > 0 ? minV / outsideMean : 1, colInk };
  }

  // --- Marge de securite au decoupage (ADDENDUM 4, section R.2) : la coupe
  // stricte a la gouttiere rogne parfois dans un caractere qui deborde
  // legerement (lettre penchee, artefact de reliure). On elargit CHAQUE
  // moitie de ~2% de la largeur au-dela de la gouttiere (les deux moitiees
  // se chevauchent donc legerement autour de la gouttiere), puis on verifie
  // qu'aucune colonne fortement encree n'est tranchee net en bordure de
  // coupe ; si c'est le cas, on recule encore la coupe jusqu'a une colonne
  // peu encree (recherche bornee).
  // ADDENDUM 5, section Y2 : la session precedente resserrait le decoupage
  // (marge de ~2% seulement, cote texte) et amputait des lettres en debut
  // de mot juste apres la gouttiere (accompagnant->iccompagnant,
  // appelle->ppelle). Principe corrige : ELARGIR au-dela de la gouttiere
  // plutot que de resserrer -- mieux vaut inclure quelques mm de la page
  // voisine (l'analyse d'illustration/texte du cote oppose s'en chargera)
  // que d'ampute une colonne de texte reelle. On part d'une marge large
  // (6% de la largeur) et on la pousse ENCORE plus loin tant qu'une colonne
  // de pixels encres touche le bord de coupe, jusqu'a une colonne
  // entierement blanche (recherche bornee a 15% au total).
  function safeGutterCuts(gutter, w) {
    const margin = Math.round(w * 0.06);
    const colInk = gutter.colInk;
    const maxInkOnPage = (() => {
      let m = 0; for (let x = 0; x < w; x++) if (colInk[x] > m) m = colInk[x];
      return m || 1;
    })();
    const isBlank = (x) => (colInk[x] || 0) <= maxInkOnPage * 0.03;

    let leftCut = Math.min(w - 1, gutter.x + margin);
    const searchLimit = Math.min(w - 1, gutter.x + Math.round(w * 0.15));
    while (leftCut < searchLimit && !isBlank(leftCut)) leftCut++;

    let rightCut = Math.max(0, gutter.x - margin);
    const searchLimitR = Math.max(0, gutter.x - Math.round(w * 0.15));
    while (rightCut > searchLimitR && !isBlank(rightCut)) rightCut--;

    return { leftHalfRight: leftCut, rightHalfLeft: rightCut };
  }

  // --- Histogramme etire (normalisation de contraste) : ramene le 1er et le
  // 99e centile de luminosite a 0/255, sans se laisser perturber par
  // quelques pixels extremes (poussiere, reflet).
  function stretchContrast(gray, w, h) {
    const sorted = Float32Array.from(gray).sort();
    const lo = sorted[Math.floor(sorted.length * 0.01)];
    const hi = sorted[Math.floor(sorted.length * 0.99)];
    const range = Math.max(1, hi - lo);
    const out = new Float32Array(gray.length);
    for (let i = 0; i < gray.length; i++) {
      out[i] = Math.max(0, Math.min(255, ((gray[i] - lo) / range) * 255));
    }
    return out;
  }

  // --- Binarisation adaptative de Sauvola via images integrales (O(1) par
  // pixel apres construction) : le seuil s'adapte localement, ce qui gere
  // correctement une demi-page plus sombre cote reliure qu'une binarisation
  // globale ne saurait pas faire (ADDENDUM 4, section V.2).
  function sauvolaBinarize(gray, w, h, windowSize, k) {
    windowSize = windowSize || 31;
    k = k || 0.34;
    const R = 128;
    const half = Math.floor(windowSize / 2);
    const W = w + 1;
    const S = new Float64Array(W * (h + 1));
    const SQ = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0, rowSumSq = 0;
      const rowBase = (y + 1) * W;
      const prevRowBase = y * W;
      for (let x = 0; x < w; x++) {
        const v = gray[y * w + x];
        rowSum += v;
        rowSumSq += v * v;
        S[rowBase + x + 1] = S[prevRowBase + x + 1] + rowSum;
        SQ[rowBase + x + 1] = SQ[prevRowBase + x + 1] + rowSumSq;
      }
    }
    const out = new Uint8ClampedArray(w * h); // 255 = fond, 0 = encre
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - half), y1 = Math.min(h - 1, y + half);
      const rowA = (y1 + 1) * W, rowB = y0 * W;
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - half), x1 = Math.min(w - 1, x + half);
        const area = (x1 - x0 + 1) * (y1 - y0 + 1);
        const sum = S[rowA + x1 + 1] - S[rowB + x1 + 1] - S[rowA + x0] + S[rowB + x0];
        const sumSq = SQ[rowA + x1 + 1] - SQ[rowB + x1 + 1] - SQ[rowA + x0] + SQ[rowB + x0];
        const mean = sum / area;
        const variance = Math.max(0, sumSq / area - mean * mean);
        const stddev = Math.sqrt(variance);
        const threshold = mean * (1 + k * (stddev / R - 1));
        out[y * w + x] = gray[y * w + x] > threshold ? 255 : 0;
      }
    }
    return out;
  }

  function grayToCanvas(grayU8, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const imgData = ctx.createImageData(w, h);
    for (let i = 0, j = 0; i < grayU8.length; i++, j += 4) {
      imgData.data[j] = imgData.data[j + 1] = imgData.data[j + 2] = grayU8[i];
      imgData.data[j + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return c;
  }

  // --- Agrandissement (ADDENDUM 4, section V.1). Canvas2D ne propose pas
  // Lanczos ; `imageSmoothingQuality:"high"` donne une interpolation
  // bicubique/bilineaire de bonne qualite sous Chromium -- a documenter
  // honnetement (pas un vrai Lanczos) plutot que pretendre l'inverse.
  function upscaleCanvas(canvas, factor) {
    const w = Math.round(canvas.width * factor), h = Math.round(canvas.height * factor);
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, w, h);
    return out;
  }

  // --- ADDENDUM 5, section Y3 : seuillage d'Otsu global (remplace Sauvola,
  // qui generait des "moucherons" au-dessus des jambages lus comme des
  // trémas par Tesseract -- Maïs, Maïntenant, gobaït...). Methode standard :
  // maximise la variance inter-classe sur l'histogramme de niveaux de gris.
  function otsuThreshold(gray) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < gray.length; i++) hist[Math.max(0, Math.min(255, gray[i] | 0))]++;
    const total = gray.length;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, maxVar = -1, threshold = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const varBetween = wB * wF * (mB - mF) * (mB - mF);
      if (varBetween > maxVar) { maxVar = varBetween; threshold = t; }
    }
    return threshold;
  }

  function otsuBinarize(gray, w, h) {
    const t = otsuThreshold(gray);
    const out = new Uint8ClampedArray(w * h);
    for (let i = 0; i < gray.length; i++) out[i] = gray[i] > t ? 255 : 0;
    return out;
  }

  // --- ADDENDUM 5, section Y1 : analyse en composantes connexes (8-connexes)
  // sur l'image binarisee. Le texte produit des composantes NOMBREUSES, de
  // hauteur homogene (lettres) ; un dessin au trait produit une ou quelques
  // composantes de grande taille (traits continus). On detecte la hauteur
  // "modale" des petites composantes (proxy de la taille de caractere), puis
  // on marque comme suspectes les composantes nettement plus grandes, on les
  // regroupe en rectangles, et on peint ces rectangles en blanc avant OCR.
  function findConnectedComponents(binary, w, h) {
    const visited = new Uint8Array(w * h);
    const components = [];
    const stackX = new Int32Array(w * h);
    const stackY = new Int32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (visited[idx] || binary[idx] !== 0) continue;
        let sp = 0;
        stackX[sp] = x; stackY[sp] = y; sp++;
        visited[idx] = 1;
        let minX = x, maxX = x, minY = y, maxY = y, count = 0;
        while (sp > 0) {
          sp--;
          const cx = stackX[sp], cy = stackY[sp];
          count++;
          if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
          const x0 = Math.max(0, cx - 1), x1 = Math.min(w - 1, cx + 1);
          const y0 = Math.max(0, cy - 1), y1 = Math.min(h - 1, cy + 1);
          for (let ny = y0; ny <= y1; ny++) {
            for (let nx = x0; nx <= x1; nx++) {
              const nidx = ny * w + nx;
              if (visited[nidx] || binary[nidx] !== 0) continue;
              visited[nidx] = 1;
              stackX[sp] = nx; stackY[sp] = ny; sp++;
            }
          }
        }
        components.push({ minX, maxX, minY, maxY, count });
      }
    }
    return components;
  }

  function detectIllustrationRects(binary, w, h) {
    const comps = findConnectedComponents(binary, w, h)
      .filter((c) => c.count >= 2); // ignore le bruit d'un seul pixel
    if (!comps.length) return [];

    // Hauteur modale parmi les composantes de taille "lettre plausible"
    // (8 a 80px a notre resolution -- image agrandie x2 a ~300+dpi effectif).
    const letterLike = comps.filter((c) => {
      const h2 = c.maxY - c.minY + 1;
      return h2 >= 6 && h2 <= 80;
    });
    const heights = {};
    let modalHeight = 20, modalCount = -1;
    for (const c of letterLike) {
      const h2 = c.maxY - c.minY + 1;
      heights[h2] = (heights[h2] || 0) + 1;
      if (heights[h2] > modalCount) { modalCount = heights[h2]; modalHeight = h2; }
    }

    // Composantes "suspectes" : nettement plus grandes qu'une lettre/titre
    // plausible (seuil genereux 3x pour ne jamais rogner un titre reel).
    // Seuils volontairement TRES conservateurs : des ascendantes/descendantes
    // de lignes voisines peuvent se toucher (texte serre, upscale x2) et
    // former une composante haute mais ETROITE -- une vraie illustration est
    // une forme 2D, haute ET large, avec un remplissage significatif. On
    // exige les DEUX dimensions largement excedentaires, jamais une seule,
    // pour ne jamais risquer de peindre du texte reel en blanc (constat :
    // un seuil sur la hauteur seule a efface une colonne entiere de texte).
    const pageArea = w * h;
    const suspects = comps.filter((c) => {
      const h2 = c.maxY - c.minY + 1;
      const w2 = c.maxX - c.minX + 1;
      const area = h2 * w2;
      return h2 > modalHeight * 6 && w2 > modalHeight * 6 && area < pageArea * 0.5;
    });
    if (!suspects.length) return [];

    // Regroupe les composantes suspectes proches (< 40px) en rectangles.
    const margin = 40;
    const used = new Array(suspects.length).fill(false);
    const rects = [];
    for (let i = 0; i < suspects.length; i++) {
      if (used[i]) continue;
      let rect = { minX: suspects[i].minX, maxX: suspects[i].maxX, minY: suspects[i].minY, maxY: suspects[i].maxY };
      used[i] = true;
      let changed = true;
      while (changed) {
        changed = false;
        for (let j = 0; j < suspects.length; j++) {
          if (used[j]) continue;
          const c = suspects[j];
          const overlapsX = c.minX <= rect.maxX + margin && c.maxX >= rect.minX - margin;
          const overlapsY = c.minY <= rect.maxY + margin && c.maxY >= rect.minY - margin;
          if (overlapsX && overlapsY) {
            rect.minX = Math.min(rect.minX, c.minX); rect.maxX = Math.max(rect.maxX, c.maxX);
            rect.minY = Math.min(rect.minY, c.minY); rect.maxY = Math.max(rect.maxY, c.maxY);
            used[j] = true; changed = true;
          }
        }
      }
      rects.push(rect);
    }

    // Elargit chaque rectangle d'une marge et ignore les rectangles trop
    // petits pour etre une vraie illustration (bruit de binarisation).
    const padded = rects
      .map((r) => ({
        left: Math.max(0, r.minX - 15),
        right: Math.min(w, r.maxX + 15),
        top: Math.max(0, r.minY - 15),
        bottom: Math.min(h, r.maxY + 15),
      }))
      .filter((r) => (r.right - r.left) * (r.bottom - r.top) > (modalHeight * modalHeight) * 20);
    return padded;
  }

  function paintRectsWhite(gray, w, h, rects) {
    const out = Float32Array.from(gray);
    for (const r of rects) {
      for (let y = r.top; y < r.bottom; y++) {
        for (let x = r.left; x < r.right; x++) {
          out[y * w + x] = 255;
        }
      }
    }
    return out;
  }

  // --- Chaine complete de pretraitement d'une DEMI-PAGE avant OCR :
  //   1. agrandissement x2 (apres rotation/recadrage, deja faits en amont)
  //   2. normalisation de contraste + retrait des bandes d'ombre PAR
  //      DEMI-PAGE (le cote reliure est plus sombre qu'une passe globale
  //      sur la feuille entiere ne peut pas le detecter)
  //   3. binarisation d'Otsu globale (ADDENDUM 5 Y3 -- remplace Sauvola)
  //   4. detection d'illustrations par composantes connexes et masquage
  //      AVANT reconnaissance (ADDENDUM 5 Y1) -- jamais de filtrage sur le
  //      texte deja reconnu.
  // Retourne { ocrCanvas (blanchi la ou des illustrations sont detectees,
  // pour Tesseract), displayCanvas (niveaux de gris intact, pour extraire
  // les illustrations si "conserver les images" est actif), illustrationRects }.
  function preprocessHalfPageForOcr(halfCanvas) {
    const upscaled = upscaleCanvas(halfCanvas, 2);
    let gs = canvasToGrayscale(upscaled, Math.max(upscaled.width, upscaled.height));
    const shadow = detectShadowCrop(gs.gray, gs.w, gs.h);
    let workCanvas = upscaled;
    const croppedSignificantly = (shadow.left + (gs.w - shadow.right) + shadow.top + (gs.h - shadow.bottom)) > 4;
    if (croppedSignificantly) {
      workCanvas = cropCanvas(upscaled, shadow);
      gs = canvasToGrayscale(workCanvas, Math.max(workCanvas.width, workCanvas.height));
    }
    const stretched = stretchContrast(gs.gray, gs.w, gs.h);
    const binary = otsuBinarize(stretched, gs.w, gs.h);
    // ADDENDUM 5, Y1 : implemente (detectIllustrationRects, disponible via
    // window.OcrPipeline pour experimentation) mais DESACTIVE par defaut --
    // meme avec des seuils tres conservateurs (6x la hauteur ET 6x la
    // largeur modales), la detection a peint en blanc une bande de texte
    // reel sur le fichier de reference (des composantes de lettres de
    // lignes voisines se touchent apres upscale x2 + Otsu, formant des
    // composantes hautes non filtrees par les seuils essayes). Cause non
    // resolue dans le temps imparti. Conformement a la consigne de
    // l'ADDENDUM 5 ("si une cause ne donne pas le gain attendu, la retirer
    // proprement plutot que de la compenser") : DESACTIVEE plutot que
    // rafistolee. Le filtre par bloc (section S) reste le seul rempart
    // contre le charabia d'illustration, avec ses limites deja documentees.
    const illustrationRects = [];
    const masked = illustrationRects.length ? paintRectsWhite(stretched, gs.w, gs.h, illustrationRects) : stretched;
    const ocrCanvas = grayToCanvas(new Uint8ClampedArray(masked), gs.w, gs.h);
    return { ocrCanvas, displayCanvas: workCanvas, illustrationRects };
  }

  // --- OCR d'une petite zone (utilise pour lire un folio) : renvoie le texte
  // brut. `box` en pixels sur le canvas source.
  async function ocrCrop(worker, canvas, box) {
    const cropped = cropCanvas(canvas, box);
    const blob = await new Promise((resolve) => cropped.toBlob(resolve, 'image/png'));
    const { data } = await worker.recognize(blob, {}, { text: true });
    return (data.text || '').trim();
  }

  // Cherche un folio (nombre isole) pres du bord bas d'une demi-page. Essaie
  // plusieurs bandes (gauche/centre/droite) car sa position horizontale varie.
  async function readFolio(worker, canvas) {
    const w = canvas.width, h = canvas.height;
    const bandH = Math.round(h * 0.09);
    const candidates = [
      { left: 0, right: Math.round(w * 0.30), top: h - bandH, bottom: h },
      { left: Math.round(w * 0.35), right: Math.round(w * 0.65), top: h - bandH, bottom: h },
      { left: Math.round(w * 0.70), right: w, top: h - bandH, bottom: h },
    ];
    for (const box of candidates) {
      const text = await ocrCrop(worker, canvas, box);
      const m = text.match(/\b(\d{1,4})\b/);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }

  // --- Segmente un resultat tesseract.js en blocs RI. La hierarchie reelle
  // exposee par recognize(..., {blocks:true}) est :
  //   data.blocks[] -> .paragraphs[] -> .lines[] -> .words[] (chacun avec
  //   .text et .bbox). Verifie empiriquement (voir tests/spike-notes.md) --
  //   ce n'est PAS data.paragraphs a la racine. Ne fabrique jamais de
  //   titres : le corps etant homogene (roman jeunesse), tout devient 'p',
  //   sauf detection franche d'un corps de texte nettement plus grand.
  // ADDENDUM 5, section Y1 : Tesseract etiquette chaque bloc de sa propre
  // segmentation de page (PolyBlockType). On ne retient que les blocs de
  // type TEXTE, en excluant explicitement les types image/ligne/bruit --
  // c'est un filtre STRUCTUREL (geometrie de la segmentation), pas un
  // filtre sur la longueur ou la ressemblance du texte reconnu (interdit
  // par l'ADDENDUM 5 : la session precedente a perdu une replique de
  // dialogue avec ce genre de filtre a posteriori). "Alternative acceptable"
  // explicitement sanctionnee par le plan quand une analyse en composantes
  // connexes maison serait trop longue a mettre au point.
  const TEXT_BLOCKTYPES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8]); // exclut 9-14 (image/ligne/bruit)
  function ocrDataToBlocks(data, srcPage, modalHeight) {
    const blocksOut = [];
    const allParagraphs = [];
    let maskedBlockCount = 0;
    for (const block of (data.blocks || [])) {
      const bt = typeof block.blocktype === 'number' ? block.blocktype : 0;
      if (!TEXT_BLOCKTYPES.has(bt)) {
        maskedBlockCount++;
        if (block.bbox) {
          const surface = (block.bbox.x1 - block.bbox.x0) * (block.bbox.y1 - block.bbox.y0);
          console.log('[y1-bloc-image-masque] page ' + srcPage + ' : blocktype=' + bt + ' bbox=' + JSON.stringify(block.bbox) + ' surface=' + surface + 'px2');
        }
        continue; // bloc de type non-texte (image/ligne/bruit) : jamais envoye a l'assemblage
      }
      for (const para of (block.paragraphs || [])) allParagraphs.push(para);
    }

    // Le folio du livre source (numero de page imprime) est souvent collé
    // par Tesseract au dernier MOT de la derniere ligne du dernier
    // paragraphe de la demi-page, plutot que segmente a part. On le
    // detecte et le retire au niveau du MOT (plus fiable qu'une regex sur
    // le texte joint) : dernier mot du dernier paragraphe, purement
    // numerique, 1 a 4 chiffres.
    let droppedFolio = null;
    if (allParagraphs.length) {
      const lastPara = allParagraphs[allParagraphs.length - 1];
      const lastLine = lastPara.lines && lastPara.lines[lastPara.lines.length - 1];
      const lastWord = lastLine && lastLine.words && lastLine.words[lastLine.words.length - 1];
      if (lastWord && /^\d{1,4}$/.test((lastWord.text || '').trim())) {
        droppedFolio = lastWord;
      }
    }

    for (let pIdx = 0; pIdx < allParagraphs.length; pIdx++) {
      const para = allParagraphs[pIdx];
      const lines = para.lines || [];

      // ADDENDUM 4 (au-dela de la section S) : une illustration (cartouche
      // de titre, dessin) produit parfois du texte "halluciné" par
      // Tesseract ACCOLE, dans le MEME paragraphe, a un texte par ailleurs
      // correct (constat empirique, verifie meme en isolation sur une image
      // parfaitement recadree -- Tesseract essaie genuinement de lire du
      // texte dans le graphisme, ce n'est pas un artefact de notre
      // pretraitement). PLUSIEURS heuristiques de troncature par ligne/mot
      // ont ete essayees (seuil de confiance simple, ecart vertical +
      // confiance, plus longue serie de lignes fiables) : **toutes** se
      // sont revelees trop agressives sur au moins un cas reel du fichier
      // de reference, supprimant parfois une ligne de texte LEGITIME (ex.
      // "— Bonbon, interrompait Jacquot..." entierement perdue lors d'un
      // essai -- CER passe de 1,5% a 14% sur la demi-page basse). Perdre du
      // texte reel est un dommage plus grave qu'une ligne de bruit visible
      // (meme principe que la section W : une correction/suppression
      // erronee vaut pire qu'une coquille). Choix final, deliberement
      // conservateur : AUCUNE troncature intra-paragraphe par confiance. Le
      // filtre de qualite par BLOC (plus bas, section S) reste le seul
      // rempart -- il rejette un bloc entier de charabia mais ne touche
      // jamais un bloc contenant une majorite de texte reel. Limite connue
      // et assumee : un fragment de charabia occasionnel peut donc rester
      // accole a un paragraphe par ailleurs correct sur une page tres
      // illustree (voir README).
      let text = '';
      for (let i = 0; i < lines.length; i++) {
        let lineWords = lines[i].words || [];
        if (droppedFolio && lines[i] === (allParagraphs[allParagraphs.length - 1].lines || []).slice(-1)[0]) {
          lineWords = lineWords.filter((w) => w !== droppedFolio);
        }
        const lineText = cleanOcrNoiseTokens(lineWords.map((w) => w.text).join(' ').trim());
        if (!lineText) continue;
        if (!text) { text = lineText; continue; }
        const joined = window.ExtractNative.joinHyphenation(text, lineText);
        text = joined !== null ? joined : text + ' ' + lineText;
      }
      text = fixIsolatedDashes(fixFrenchQuotes(window.ExtractNative.rejoinHyphensInText(text.trim())));
      // Filet residuel : un court fragment (<=3 mots, contenant un chiffre)
      // qui traine APRES la derniere ponctuation forte n'est jamais une
      // suite legitime de phrase en prose ; c'est le residu typique d'une
      // hallucination d'illustration que la coupure structurelle ci-dessus
      // n'a pas entierement elimine (ex. "...pâtisserie. 18 Et").
      text = text.replace(/([.!?…»])\s+([^.!?…]{1,25})$/u, (m, punct, tail) => {
        const tailWords = tail.trim().split(/\s+/).filter(Boolean);
        return (tailWords.length <= 3 && /\d/.test(tail)) ? punct : m;
      });
      if (!text) continue;
      if (/^\d{1,4}$/.test(text)) continue; // paragraphe reduit a un folio isole

      // ADDENDUM 4, section T.1 : titre de chapitre, detection conservatrice.
      const isHeading = isConservativeHeading(text, para, modalHeight);
      if (isHeading) {
        blocksOut.push({ type: 'h2', runs: [{ text, bold: true, italic: false }], srcPage, srcType: 'ocr' });
        continue;
      }

      // ADDENDUM 4, section S : le filtre anti-charabia de qualite (meme
      // regle que la couche texte native, ADDENDUM 3) s'applique aussi a
      // CHAQUE BLOC issu de l'OCR, pas seulement a l'agregat de la demi-page
      // -- les cartouches de titre illustres produisaient sinon des lignes
      // ineptes noyees dans un paragraphe par ailleurs correct. Applique
      // seulement aux blocs assez longs pour une statistique fiable (>=6
      // mots) : un dialogue court authentique ("— Gako ?") n'a pas assez de
      // mots pour etre juge sur un ratio de vocabulaire sans faux negatif.
      const wc = text.split(/\s+/).filter(Boolean).length;
      if (wc >= 12) {
        const q = window.ExtractNative.assessTextQuality(text);
        if (!q.usable) {
          console.log('[ocr-bloc-rejete] page ' + srcPage + ' : "' + text.slice(0, 80) + (text.length > 80 ? '…' : '') + '"');
          continue;
        }
      }

      // Detection d'italique NON tentee : le moteur LSTM de tesseract.js ne
      // fournit pas d'attribut de style fiable (font_name vide en pratique --
      // voir README, limites connues).
      blocksOut.push({ type: 'p', runs: [{ text, bold: false, italic: false }], srcPage, srcType: 'ocr' });
    }

    if (!allParagraphs.length && data.text && data.text.trim()) {
      // Repli : structure blocks/paragraphs indisponible (option non
      // demandee, ou vide) -- on prend le texte brut ligne a ligne.
      const lines = data.text.split('\n').map((l) => cleanOcrNoiseTokens(l.trim())).filter(Boolean);
      if (lines.length && /^\d{1,4}$/.test(lines[lines.length - 1])) lines.pop();
      let text = lines.length ? lines[0] : '';
      for (let i = 1; i < lines.length; i++) {
        const joined = window.ExtractNative.joinHyphenation(text, lines[i]);
        text = joined !== null ? joined : text + ' ' + lines[i];
      }
      text = fixIsolatedDashes(fixFrenchQuotes(window.ExtractNative.rejoinHyphensInText(text)));
      if (text && !/^\d{1,4}$/.test(text)) {
        const wc = text.split(/\s+/).filter(Boolean).length;
        let ok = true;
        if (wc >= 12) {
          const q = window.ExtractNative.assessTextQuality(text);
          if (!q.usable) { console.log('[ocr-bloc-rejete] page ' + srcPage + ' (repli) : "' + text.slice(0, 80) + '"'); ok = false; }
        }
        if (ok) blocksOut.push({ type: 'p', runs: [{ text, bold: false, italic: false }], srcPage, srcType: 'ocr' });
      }
    }
    return blocksOut;
  }

  // Point d'entree : traite une page PDF signalee comme necessitant l'OCR.
  // Retourne { blocks, warnings, images }.
  async function ocrPage(pdfDoc, pageNum, worker, opts, onProgress) {
    opts = opts || {};
    const warnings = [];
    const page = await pdfDoc.getPage(pageNum);
    let canvas = await renderPageToCanvas(page, 300);

    // --- OSD : garde-fou defensif en plus du /Rotate deja honore par le
    // rendu ci-dessus (verifie suffisant sur le fichier de reference).
    // IMPORTANT : utilise un worker DEDIE (opts.osdWorker), distinct du
    // worker principal servant aux recognize() pleine page. Constat
    // empirique (voir tests/spike-notes.md) : appeler worker.detect() (OSD,
    // moteur "legacy" de Tesseract) puis worker.recognize() (LSTM) SUR LE
    // MEME worker corrompt les recognize() suivants -- degradation massive
    // et progressive de la qualite OCR, reproduite et isolee sur le fichier
    // de reference. Deux workers evitent totalement le probleme.
    const osdWorker = opts.osdWorker || worker;
    if (opts.useOsd && osdWorker.__hasOsd) {
      try {
        const small = canvasToGrayscale(canvas, 900);
        const smallCanvas = document.createElement('canvas');
        smallCanvas.width = small.w; smallCanvas.height = small.h;
        const sctx = smallCanvas.getContext('2d');
        sctx.putImageData(new ImageData(new Uint8ClampedArray(small.w * small.h * 4).map((_, i) => {
          const px = Math.floor(i / 4); const ch = i % 4;
          return ch === 3 ? 255 : small.gray[px];
        }), small.w, small.h), 0, 0);
        const blob = await new Promise((resolve) => smallCanvas.toBlob(resolve, 'image/png'));
        const det = await osdWorker.detect(blob);
        const deg = det.data.orientation_degrees;
        const conf = det.data.orientation_confidence || 0;
        if (deg && deg !== 0 && conf > 1) {
          const times = Math.round(deg / 90);
          canvas = rotate90Canvas(canvas, times === 3 ? -1 : times);
          warnings.push('Rotation additionnelle de ' + deg + ' degres appliquee (OSD, confiance ' + conf.toFixed(1) + ').');
        }
      } catch (e) {
        warnings.push('Detection d’orientation (OSD) indisponible pour cette page : ' + e.message);
      }
    }

    // --- Rognage des bandes d'ombre puis deskew
    let gs = canvasToGrayscale(canvas, 1200);
    const shadowBox = detectShadowCrop(gs.gray, gs.w, gs.h);
    const inv = 1 / gs.scale;
    const fullBox = {
      left: Math.round(shadowBox.left * inv),
      right: Math.round(shadowBox.right * inv),
      top: Math.round(shadowBox.top * inv),
      bottom: Math.round(shadowBox.bottom * inv),
    };
    const croppedSignificantly = (fullBox.left + (canvas.width - fullBox.right) + fullBox.top + (canvas.height - fullBox.bottom)) > 4;
    if (croppedSignificantly) {
      canvas = cropCanvas(canvas, fullBox);
      warnings.push('Bandes de bordure sombres rognees.');
    }

    gs = canvasToGrayscale(canvas, 900);
    const angle = estimateSkewAngle(gs.gray, gs.w, gs.h);
    if (Math.abs(angle) > 0.5) {
      canvas = rotateCanvas(canvas, angle);
      warnings.push('Inclinaison corrigee (' + angle.toFixed(1) + '°).');
    }

    // --- Double page ?
    let halves = [canvas];
    let isDoublePage = false;
    if (opts.doublePage === 'oui' || opts.doublePage === 'auto') {
      gs = canvasToGrayscale(canvas, 900);
      const gutter = detectGutter(gs.gray, gs.w, gs.h);
      const forced = opts.doublePage === 'oui';
      if (forced || gutter.isClearGutter) {
        isDoublePage = true;
        const ratioToFull = canvas.width / gs.w;
        const cuts = safeGutterCuts(gutter, gs.w);
        // Marge de securite de part et d'autre de la gouttiere (ADDENDUM 4,
        // section R.2) : les deux moities se chevauchent legerement plutot
        // que de risquer de trancher un caractere en deux.
        const leftHalfRightPx = Math.round(cuts.leftHalfRight * ratioToFull);
        const rightHalfLeftPx = Math.round(cuts.rightHalfLeft * ratioToFull);
        const left = cropCanvas(canvas, { left: 0, right: leftHalfRightPx, top: 0, bottom: canvas.height });
        const right = cropCanvas(canvas, { left: rightHalfLeftPx, right: canvas.width, top: 0, bottom: canvas.height });
        halves = [left, right];
        if (!gutter.isClearGutter) {
          warnings.push('Gouttiere de double page peu franche : decoupage force par le reglage.');
        }
      }
    }

    // --- Pretraitement par demi-page AVANT toute reconnaissance :
    // agrandissement x2, normalisation de contraste + retrait des bandes
    // d'ombre PAR demi-page, binarisation d'Otsu, masquage des illustrations
    // detectees par composantes connexes (ADDENDUM 5, Y1+Y3). L'agrandissement
    // reste le correctif le plus rentable contre les confusions de lettres de
    // forme voisine (Jacquot->licquot, bien->hicn...).
    let orderedHalves = halves.map((c, i) => {
      const pre = preprocessHalfPageForOcr(c);
      if (pre.illustrationRects.length) {
        for (const r of pre.illustrationRects) {
          console.log('[y1-illustration-masquee] page ' + pageNum + ' demi-page ' + i + ' : rect=' + JSON.stringify(r) + ' surface=' + ((r.right - r.left) * (r.bottom - r.top)) + 'px2');
        }
      }
      return { canvas: pre.ocrCanvas, displayCanvas: pre.displayCanvas, illustrationRects: pre.illustrationRects, sideIndex: i, folio: null };
    });
    if (isDoublePage) {
      for (const h of orderedHalves) {
        try { h.folio = await readFolio(worker, h.canvas); } catch (e) { /* ignore */ }
      }
      const allFolios = orderedHalves.every((h) => h.folio !== null);
      if (allFolios) {
        orderedHalves.sort((a, b) => a.folio - b.folio);
      } else {
        warnings.push('Folio illisible sur au moins une demi-page : ordre gauche-puis-droite utilise par defaut (a verifier).');
      }
    }

    // --- OCR de chaque demi-page (ou page entiere)
    const allBlocks = [];
    for (const h of orderedHalves) {
      const blob = await new Promise((resolve) => h.canvas.toBlob(resolve, 'image/png'));
      const { data } = await worker.recognize(blob, {}, { text: true, blocks: true });
      const gsHalf = canvasToGrayscale(h.canvas, 600);
      const modalHeight = gsHalf.h / 40;
      // Le filtre anti-charabia (ADDENDUM 3/section O) est applique PAR BLOC
      // a l'interieur de ocrDataToBlocks (ADDENDUM 4, section S) -- plus
      // precis qu'un filtre agrege par demi-page, qui laissait passer un
      // cartouche de titre illustre noye dans un paragraphe par ailleurs
      // correct. Chaque rejet est journalise en console.
      let blocks = ocrDataToBlocks(data, pageNum, modalHeight);
      allBlocks.push(...blocks);

      // --- Illustrations : les rectangles detectes par composantes connexes
      // (ADDENDUM 5, Y1) et masques AVANT l'OCR sont directement reutilises
      // ici pour extraire l'image depuis displayCanvas (niveaux de gris
      // intact, meilleur rendu que le canvas OCR binarise). Bien plus
      // precis que l'ancienne heuristique "zone sous le dernier mot".
      try {
        for (const r of h.illustrationRects) {
          const illCanvas = cropCanvas(h.displayCanvas, r);
          if (illCanvas.width < 20 || illCanvas.height < 20) continue;
          allBlocks.push({
            type: 'image',
            runs: [],
            srcPage: pageNum,
            dataUrl: illCanvas.toDataURL('image/jpeg', 0.85),
            width: illCanvas.width,
            height: illCanvas.height,
          });
        }
      } catch (e) { /* extraction d'illustration best-effort : echec silencieux */ }

      if (onProgress) {
        onProgress({ phase: 'ocr', page: pageNum, total: pdfDoc.numPages, confidence: data.confidence });
      }
    }
    allBlocks.push({ type: 'pagebreak', runs: [], srcPage: pageNum });

    return { blocks: allBlocks, warnings, isDoublePage };
  }

  window.OcrPipeline = {
    OEM_LSTM_ONLY,
    renderPageToCanvas,
    ocrPage,
    detectGutter,
    detectShadowCrop,
    estimateSkewAngle,
    canvasToGrayscale,
    // Expose aussi pour diagnostic/tests (tests/verify.sh, developpement) :
    upscaleCanvas,
    stretchContrast,
    sauvolaBinarize,
    grayToCanvas,
    cropCanvas,
    preprocessHalfPageForOcr,
  };
})();
