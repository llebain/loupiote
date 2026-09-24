/* ============================================================================
 * 05-main.js
 * Orchestration : chargement du PDF, extraction (native + OCR), mise en
 * page, apercu DOM, export, reglages, etats d'erreur -- tout en francais.
 * ==========================================================================*/

(function () {
  'use strict';

  const LS_KEY = 'adaptateur-pdf-luciole:reglages:v1';

  const els = {};
  function q(id) { return document.getElementById(id); }

  let jsPDFCtor = null;
  let pdfjsLib = null;
  let measurementDoc = null;
  let measurer = null;

  let masterBlocks = null; // tous les blocs extraits (avant filtrage pages de garde)
  let masterExtraction = null; // pageShapes/pageSizes de l'extraction (ADDENDUM 6, Z4.4 : moteur par blocs)
  let currentBlocks = null; // blocs effectivement utilises pour la mise en page (apres filtrage)
  let currentLayout = null;
  let currentFileName = null;
  let tesseractWorker = null;
  let anyOcrUsed = false;

  // Filet de securite final : recolle une cesure qui tombe exactement a la
  // frontiere entre deux blocs 'p' consecutifs (ex. fin de demi-page OCR
  // suivie du debut de la demi-page suivante), cas que les recollements
  // internes a un paragraphe (01-extract-native.js, 02-ocr-pipeline.js) ne
  // peuvent pas voir puisqu'ils operent bloc par bloc.
  function mergeHyphenatedBlockBoundaries(blocks) {
    const out = [];
    for (const b of blocks) {
      const prev = out[out.length - 1];
      if (
        prev && prev.type === 'p' && b.type === 'p' &&
        prev.runs.length && b.runs.length
      ) {
        const prevLastRun = prev.runs[prev.runs.length - 1];
        const firstRun = b.runs[0];
        const joined = window.ExtractNative.joinHyphenation(prevLastRun.text, firstRun.text);
        if (joined !== null) {
          prevLastRun.text = joined;
          prev.runs = prev.runs.concat(b.runs.slice(1));
          continue;
        }
      }
      out.push(b);
    }
    return out;
  }

  // ADDENDUM 4, section R.1 : quand une phrase traverse la pliure (jonction
  // entre deux demi-pages, ou entre deux pages du PDF source), l'OCR
  // decoupe systematiquement en deux paragraphes distincts au lieu de
  // continuer la phrase. Regle : si la derniere ligne du bloc precedent ne
  // se termine pas par une ponctuation forte (. ! ? … : » ) et que le bloc
  // suivant commence par une minuscule, fusionner les deux blocs avec une
  // simple espace -- meme logique que le recollement de cesures, au niveau
  // du bloc plutot que du mot. Limite au texte ISSU DE L'OCR (`srcType:
  // 'ocr'`) : un PDF texte natif segmente deja correctement ses paragraphes
  // via les ecarts verticaux (01-extract-native.js), fusionner y introduirait
  // des faux positifs.
  const STRONG_PUNCT_END = /[.!?…:»"]['"’]?\s*$/;
  function mergeSentenceContinuations(blocks) {
    const out = [];
    for (const b of blocks) {
      const prev = out[out.length - 1];
      if (
        prev && prev.type === 'p' && b.type === 'p' &&
        prev.srcType === 'ocr' && b.srcType === 'ocr' &&
        prev.runs.length && b.runs.length
      ) {
        const prevText = prev.runs[prev.runs.length - 1].text;
        const nextFirstRun = b.runs[0];
        const nextText = nextFirstRun.text;
        const endsStrong = STRONG_PUNCT_END.test(prevText);
        const startsLower = /^[a-zà-ÿ]/.test(nextText);
        const startsDialogue = /^[—«]/.test(nextText.trim());
        if (!endsStrong && startsLower && !startsDialogue) {
          prev.runs[prev.runs.length - 1].text = prevText.replace(/\s+$/, '') + ' ' + nextText;
          prev.runs = prev.runs.concat(b.runs.slice(1));
          continue;
        }
      }
      out.push(b);
    }
    return out;
  }

  // ADDENDUM 4, section U.2 : restaure prudemment un tiret cadratin de
  // dialogue manquant. Condition volontairement etroite ("en cas de doute,
  // ne pas inventer") : le bloc precedent immediat commence par un tiret
  // (on est donc deja dans un echange de repliques identifie), le bloc
  // courant n'a ni tiret ni guillemet ouvrant, et il est court (repique
  // plausible, pas un paragraphe narratif).
  function restoreDialogueDashes(blocks) {
    for (let i = 1; i < blocks.length; i++) {
      const prev = blocks[i - 1];
      const cur = blocks[i];
      if (!prev || !cur || prev.type !== 'p' || cur.type !== 'p') continue;
      if (cur.srcType !== 'ocr') continue;
      if (!prev.runs.length || !cur.runs.length) continue;
      const prevText = prev.runs[0].text.trim();
      const curFirstRun = cur.runs[0];
      const curText = curFirstRun.text.trim();
      if (!/^—/.test(prevText)) continue;
      if (/^[—«]/.test(curText)) continue;
      const wordCount = curText.split(/\s+/).filter(Boolean).length;
      if (wordCount > 8) continue;
      curFirstRun.text = '— ' + curFirstRun.text.replace(/^\s+/, '');
    }
    return blocks;
  }

  function loadSettings() {
    let saved = {};
    try {
      const raw = window.localStorage.getItem(LS_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch (e) { /* stockage indisponible : on ignore silencieusement */ }
    return window.LayoutEngine.clampSettings(saved);
  }

  function saveSettings(settings) {
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify(settings));
    } catch (e) { /* stockage indisponible (navigation privee, quota...) : ignore */ }
  }

  function readSettingsFromUI() {
    return window.LayoutEngine.clampSettings({
      fontSize: Number(els.taille.value),
      lineHeight: Number(els.interligne.value),
      contrast: els.contraste.value,
      letterSpacing: els.espacementCar.value,
      wordSpacing: els.espacementMot.value,
      showImages: els.images.value === 'conserver',
      orientation: els.orientation.value,
      skipFrontMatter: els.ignorerPagesGarde.checked,
      colorMode: els.couleur.value,
    });
  }

  function applySettingsToUI(s) {
    els.taille.value = s.fontSize;
    els.valeurTaille.textContent = s.fontSize;
    els.interligne.value = s.lineHeight;
    els.contraste.value = s.contrast;
    els.espacementCar.value = s.letterSpacing;
    els.espacementMot.value = s.wordSpacing;
    els.images.value = s.showImages ? 'conserver' : 'masquer';
    els.ignorerPagesGarde.checked = s.skipFrontMatter !== false;
    els.orientation.value = s.orientation;
    els.couleur.value = s.colorMode;
  }

  function setProgress(text, active) {
    els.progression.textContent = text || '';
    els.progression.dataset.active = active ? 'true' : 'false';
  }

  function showMessage(text, kind) {
    const div = document.createElement('div');
    div.className = kind === 'erreur' ? 'erreur' : 'avertissement';
    div.setAttribute('role', kind === 'erreur' ? 'alert' : 'status');
    div.textContent = text;
    els.messages.appendChild(div);
    return div;
  }

  function clearMessages() {
    els.messages.innerHTML = '';
  }

  function rgbCss(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }

  // Rend une liste de lignes (format commun flux/boite/cellule, cf.
  // 03-layout-engine.js) dans un conteneur DOM deja positionne, a l'echelle
  // d'affichage donnee.
  // `bg` (v0.3, C1) : fond reellement derriere ces lignes (page, boite,
  // cellule) -- meme valeur que l'export PDF (04-pdf-export.js).
  function renderLinesInto(container, lines, scale, settings, theme, estCellule, bg) {
    for (const line of lines) {
      const lineDiv = document.createElement('div');
      lineDiv.className = 'ligne';
      // ADDENDUM 6, Z12, F1 -- expose la meme distinction que
      // `avgCharsPerLine` (03-layout-engine.js) sur le DOM rendu : le
      // harnais visuel (tests/regression/visual.mjs) doit mesurer la
      // largeur de ligne avec exactement la meme definition que
      // l'avertissement de l'application (lignes de retour automatique,
      // flux libre + boites, JAMAIS les cellules de tableau -- legitimement
      // plus etroites, colonnes), sinon il echoue sur un faux positif deja
      // corrige une fois (median tiree vers le bas par une grosse cellule).
      if (line.isLastLine) lineDiv.dataset.derniereLigne = '1';
      if (estCellule) lineDiv.dataset.celluleTableau = '1';
      lineDiv.style.left = Math.round(line.x * scale) + 'px';
      lineDiv.style.top = Math.round((line.y - line.sizePt * 0.8) * scale) + 'px';
      lineDiv.style.fontSize = Math.max(6, Math.round(line.sizePt * scale)) + 'px';
      lineDiv.style.fontWeight = line.isHeading ? 'bold' : 'normal';
      lineDiv.style.letterSpacing = settings.letterSpacing !== 'normal' ? settings.letterSpacing : 'normal';
      lineDiv.style.wordSpacing = settings.wordSpacing === 'elargi' ? '0.4em' : 'normal';
      for (const seg of line.segments) {
        const span = document.createElement('span');
        if (seg.style === 'bold') span.style.fontWeight = 'bold'; // E9 : jamais d'italique
        const deco = [seg.strikethrough ? 'line-through' : '', seg.underline ? 'underline' : ''].filter(Boolean).join(' ');
        if (deco) span.style.textDecoration = deco;
        span.style.color = rgbCss(window.LayoutEngine.resolveTextColor(seg.color, settings, theme, bg));
        span.textContent = seg.text;
        lineDiv.appendChild(span);
      }
      container.appendChild(lineDiv);
    }
  }

  // ADDENDUM 6, Z12, C1 : rend les images d'une boite/cellule de tableau
  // (coordonnees deja ABSOLUES, cf. computeBlockLayout) -- meme classe
  // `image-apercu` que les images de flux libre, pour que le harnais
  // visuel (tests/regression/visual.mjs) les compte et detecte leur
  // eventuel debordement de la meme facon.
  function renderImagesInto(container, images, scale) {
    for (const im of images || []) {
      const el = document.createElement('img');
      el.className = 'image-apercu';
      el.src = im.src;
      el.alt = '';
      el.style.left = Math.round(im.x * scale) + 'px';
      el.style.top = Math.round(im.y * scale) + 'px';
      el.style.width = Math.round(im.width * scale) + 'px';
      el.style.height = Math.round(im.height * scale) + 'px';
      container.appendChild(el);
    }
  }

  // --- Rendu de l'apercu DOM a partir de `currentLayout` (memes blocs que
  // l'export PDF, cf. 03-layout-engine.js : computeBlockLayoutForDocument).
  // ADDENDUM 6, Z4.4 : chaque page a sa PROPRE taille (elle grandit selon
  // son contenu), donc l'echelle d'affichage se recalcule par page.
  function renderPreview(layout) {
    els.apercu.innerHTML = '';
    // Echelle FIXE (pt -> px d'affichage), PAS normalisee a une largeur fixe.
    // Bug corrige le 20/09/2026 (remonte par Loic : le curseur de taille de
    // texte semblait sans effet) -- l'ancienne echelle (largeur d'affichage
    // fixe / largeur de page) annulait tout changement de taille, puisque la
    // largeur de page grandit dans la MEME proportion que la police
    // (scaleFactor S, cf. computeBlockLayout) : page 2x plus large + texte
    // 2x plus gros -> echelle 2x plus petite -> meme taille de rendu a
    // l'ecran, alors que l'export PDF, lui, changeait bel et bien. Avec une
    // echelle fixe, la page s'affiche plus grande quand le texte grandit
    // (defilement horizontal si necessaire, cf. #apercu { overflow-x }),
    // conforme a l'export.
    const DISPLAY_SCALE = 0.42;
    const settings = layout.settings;
    const theme = layout.theme;

    layout.pages.forEach((page, idx) => {
      const scale = DISPLAY_SCALE;
      const pageDiv = document.createElement('div');
      pageDiv.className = 'page-apercu';
      pageDiv.style.width = Math.round(page.pageDims.width * scale) + 'px';
      pageDiv.style.height = Math.round(page.pageDims.height * scale) + 'px';
      pageDiv.style.background = theme.bg;
      pageDiv.style.color = theme.fg;

      for (const item of page.items) {
        if (item.kind === 'image') {
          if (!settings.showImages) continue;
          const im = document.createElement('img');
          im.className = 'image-apercu';
          im.src = item.src;
          im.alt = '';
          im.style.left = Math.round(item.x * scale) + 'px';
          im.style.top = Math.round(item.y * scale) + 'px';
          im.style.width = Math.round(item.width * scale) + 'px';
          im.style.height = Math.round(item.height * scale) + 'px';
          pageDiv.appendChild(im);
        } else if (item.kind === 'flow') {
          renderLinesInto(pageDiv, item.lines, scale, settings, theme, false, window.LayoutEngine.hexToRgbArr(theme.bg));
        } else if (item.kind === 'box') {
          // Coordonnees de lignes deja ABSOLUES (page), cf. computeBlockLayout
          // -- rendu a plat sur la page, la boite n'est qu'un rectangle de
          // fond/bordure dessine derriere, pas un conteneur de positionnement.
          if (item.outerWrap) {
            const wrapColors = window.LayoutEngine.resolveContainerColors(item.outerWrap.fill, item.outerWrap.stroke, settings, theme);
            const wrapDiv = document.createElement('div');
            wrapDiv.className = 'bloc-boite';
            const p = item.outerWrap.pad;
            wrapDiv.style.left = Math.round((item.x - p) * scale) + 'px';
            wrapDiv.style.top = Math.round((item.y - p) * scale) + 'px';
            wrapDiv.style.width = Math.round((item.width + 2 * p) * scale) + 'px';
            wrapDiv.style.height = Math.round((item.height + 2 * p) * scale) + 'px';
            wrapDiv.style.background = rgbCss(wrapColors.fill);
            wrapDiv.style.borderColor = rgbCss(wrapColors.stroke);
            pageDiv.appendChild(wrapDiv);
          }
          const colors = window.LayoutEngine.resolveContainerColors(item.fill, item.stroke, settings, theme);
          const boxDiv = document.createElement('div');
          boxDiv.className = 'bloc-boite';
          boxDiv.style.left = Math.round(item.x * scale) + 'px';
          boxDiv.style.top = Math.round(item.y * scale) + 'px';
          boxDiv.style.width = Math.round(item.width * scale) + 'px';
          boxDiv.style.height = Math.round(item.height * scale) + 'px';
          boxDiv.style.background = rgbCss(colors.fill);
          boxDiv.style.borderColor = rgbCss(colors.stroke);
          pageDiv.appendChild(boxDiv);
          renderLinesInto(pageDiv, item.lines, scale, settings, theme, false, colors.fill);
          if (settings.showImages) renderImagesInto(pageDiv, item.images, scale);
        } else if (item.kind === 'table') {
          for (const row of item.rows) {
            for (const cell of row.cells) {
              const cellDiv = document.createElement('div');
              cellDiv.className = 'cellule-tableau';
              cellDiv.style.left = Math.round((item.x + cell.x) * scale) + 'px';
              cellDiv.style.top = Math.round((item.y + row.y) * scale) + 'px';
              cellDiv.style.width = Math.round(cell.width * scale) + 'px';
              cellDiv.style.height = Math.round(row.height * scale) + 'px';
              cellDiv.style.borderColor = rgbCss(window.LayoutEngine.hexToRgbArr(theme.fg));
              // ADDENDUM 6, Z12, E2 -- fond de cellule (ex. colonne d'en-tete
              // orangee "Noms/Verbes/...", 10_FicheOrtho.pdf), reaffecte
              // depuis la boite de fond source par computeBlockLayout
              // (03-layout-engine.js) ; meme resolution que le fond d'une
              // boite (respecte le mode Noir&Blanc).
              let cellBg = window.LayoutEngine.hexToRgbArr(theme.bg);
              if (cell.fill) {
                const cellColors = window.LayoutEngine.resolveContainerColors(cell.fill, null, settings, theme);
                cellDiv.style.background = rgbCss(cellColors.fill);
                cellBg = cellColors.fill;
              }
              pageDiv.appendChild(cellDiv);
              renderLinesInto(pageDiv, cell.lines, scale, settings, theme, true, cellBg);
              if (settings.showImages) renderImagesInto(pageDiv, cell.images, scale);
            }
          }
        }
      }

      const num = document.createElement('div');
      num.className = 'numero-page';
      num.textContent = 'Page ' + (idx + 1) + ' / ' + layout.pages.length;
      pageDiv.appendChild(num);

      els.apercu.appendChild(pageDiv);
    });

    els.compteurPages.textContent = layout.pages.length + ' page' + (layout.pages.length > 1 ? 's' : '') + ' en sortie';

    if (layout.charsPerLineWarning) {
      // ADDENDUM 6, Z12, F1 -- l'ancien message suggerait "une taille de
      // police plus petite" : un contresens pour un outil dont l'objet est
      // justement d'AGRANDIR le texte pour un lecteur basse vision. Le
      // seul levier qui elargit la ligne sans reduire la police est le
      // format paysage (plus de largeur utile a corps egal).
      showMessage(
        'Avec ces reglages, les lignes sont courtes (environ ' + Math.round(layout.avgCharsPerLine) +
        ' caracteres par ligne, sous le minimum recommande de 35). Essayez le format paysage pour elargir la ligne sans reduire la taille du texte.',
        'avertissement'
      );
    }
  }

  function recomputeLayoutAndRender() {
    if (!masterBlocks) return;
    const settings = readSettingsFromUI();
    saveSettings(settings);
    // ADDENDUM 4, section T.2 : filtrage reversible des pages de garde/
    // copyright, sans reextraire ni reOCRiser (la case peut etre decochee).
    currentBlocks = settings.skipFrontMatter
      ? masterBlocks.filter((b) => !b.frontMatter)
      : masterBlocks;
    currentLayout = window.LayoutEngine.computeBlockLayoutForDocument(masterExtraction, currentBlocks, settings, measurer);
    window.__DEBUG_LAYOUT__ = currentLayout; // diagnostic (tests/verify.sh) -- inoffensif
    clearMessages();
    renderPreview(currentLayout);
    els.btnTelecharger.disabled = false;
    els.btnImprimer.disabled = false;
  }

  async function handleDownload() {
    const doc = window.PdfExport.createExportDoc(jsPDFCtor, currentLayout.pages[0].pageDims);
    window.PdfExport.renderLayoutToPdf(doc, currentLayout, currentFileName);
    const filename = window.PdfExport.outputFileName(currentFileName, currentLayout.settings.fontSize);
    doc.save(filename);
  }

  function handlePrint() {
    const styleId = 'style-impression-dynamique';
    let styleTag = document.getElementById(styleId);
    if (!styleTag) {
      styleTag = document.createElement('style');
      styleTag.id = styleId;
      document.head.appendChild(styleTag);
    }
    const orientationCss = currentLayout.settings.orientation === 'paysage' ? 'landscape' : 'portrait';
    styleTag.textContent = '@page { size: A4 ' + orientationCss + '; margin: 0; }';
    window.print();
  }

  // Worker PRINCIPAL (recognize() plein texte + lecture de folio). Ne fait
  // JAMAIS appel a detect()/OSD -- voir ensureOsdWorker ci-dessous pour la
  // raison (deux moteurs Tesseract distincts sur le meme worker se
  // corrompent l'un l'autre, constat empirique documente dans
  // tests/spike-notes.md).
  // `fresh: true` force la recreation du worker (termine l'ancien). Constat
  // empirique sur le fichier de reference : reutiliser le MEME worker
  // Tesseract pour de tres nombreux recognize() consecutifs (plusieurs
  // pages x demi-pages x lectures de folio) degrade PROGRESSIVEMENT et
  // CUMULATIVEMENT la qualite de reconnaissance des pages suivantes (au-dela
  // de la corruption OSD/recognize deja isolee, voir tests/spike-notes.md).
  // Recreer un worker par page PDF traitee elimine cette derive, au prix
  // d'un rechargement du coeur wasm (quelques secondes) par page.
  async function ensureTesseractWorker(fresh) {
    if (tesseractWorker && !fresh) return tesseractWorker;
    if (tesseractWorker) { try { await tesseractWorker.terminate(); } catch (e) {} }
    setProgress('Preparation de la reconnaissance de texte (OCR)…', true);
    tesseractWorker = await window.LibLoader.createOfflineTesseractWorker('fra', window.OcrPipeline.OEM_LSTM_ONLY, {
      logger: () => {},
    });
    return tesseractWorker;
  }

  let osdWorker = null;
  // Worker DEDIE exclusivement a la detection d'orientation (OSD). Jamais
  // utilise pour recognize() de texte plein -- voir commentaire ci-dessus.
  async function ensureOsdWorker() {
    if (osdWorker) return osdWorker;
    osdWorker = await window.LibLoader.createOfflineTesseractWorker('fra', window.OcrPipeline.OEM_LSTM_ONLY, {
      withOsd: true,
      legacyCore: true,
      logger: () => {},
    });
    osdWorker.__hasOsd = true;
    return osdWorker;
  }

  async function processFile(file) {
    clearMessages();
    els.apercu.innerHTML = '';
    els.btnTelecharger.disabled = true;
    els.btnImprimer.disabled = true;
    masterBlocks = null;
    masterExtraction = null;
    currentBlocks = null;
    currentLayout = null;
    currentFileName = file.name;

    const MAX_BYTES = 300 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      showMessage('Ce fichier est trop volumineux (plus de 300 Mo). Essayez un document plus court.', 'erreur');
      return;
    }

    setProgress('Lecture du fichier…', true);
    let arrayBuffer;
    try {
      arrayBuffer = await file.arrayBuffer();
    } catch (e) {
      showMessage('Impossible de lire ce fichier.', 'erreur');
      setProgress('', false);
      return;
    }

    let pdfDoc;
    try {
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      pdfDoc = await loadingTask.promise;
    } catch (e) {
      if (e && (e.name === 'PasswordException' || /password/i.test(e.message || ''))) {
        showMessage('Ce PDF est protege par un mot de passe. Retirez la protection avant de le deposer ici.', 'erreur');
      } else if (e && (e.name === 'InvalidPDFException' || /invalid pdf/i.test(e.message || ''))) {
        showMessage('Ce fichier ne semble pas etre un PDF valide (fichier corrompu ou format non reconnu).', 'erreur');
      } else {
        showMessage('Impossible d’ouvrir ce PDF : ' + (e && e.message ? e.message : 'erreur inconnue') + '.', 'erreur');
      }
      setProgress('', false);
      return;
    }

    setProgress('Analyse du texte du document…', true);
    let extraction;
    try {
      extraction = await window.ExtractNative.extractNativePdf(pdfDoc, (p) => {
        setProgress('Analyse du texte — page ' + p.page + ' / ' + p.total + '…', true);
      });
    } catch (e) {
      showMessage('Erreur pendant l’analyse du PDF : ' + (e && e.message ? e.message : e), 'erreur');
      setProgress('', false);
      return;
    }

    const needsOcrPages = extraction.blocks.filter((b) => b.type === 'needs-ocr').map((b) => b.srcPage);
    let blocks = extraction.blocks;

    if (needsOcrPages.length) {
      anyOcrUsed = true;
      showMessage(
        needsOcrPages.length + ' page(s) scannee(s) ou a couche texte inexploitable detectee(s) — reconnaissance automatique en cours. Une relecture est recommandee.',
        'avertissement'
      );
      const osdW = await ensureOsdWorker();
      const doublePageSetting = els.doublePage.value;
      const newBlocks = [];
      let ocrPageCount = 0;
      for (const b of blocks) {
        if (b.type !== 'needs-ocr') { newBlocks.push(b); continue; }
        ocrPageCount += 1;
        setProgress('Reconnaissance de texte (OCR) — page ' + ocrPageCount + ' / ' + needsOcrPages.length + '…', true);
        const worker = await ensureTesseractWorker(true);
        try {
          const result = await window.OcrPipeline.ocrPage(pdfDoc, b.srcPage, worker, {
            useOsd: true,
            osdWorker: osdW,
            doublePage: doublePageSetting,
          }, (p) => {
            setProgress('Reconnaissance de texte (OCR) — page ' + ocrPageCount + ' / ' + needsOcrPages.length + '…', true);
          });
          newBlocks.push(...result.blocks);
          result.warnings.forEach((w) => showMessage(w, 'avertissement'));
        } catch (e) {
          showMessage('Echec de la reconnaissance de texte sur la page ' + b.srcPage + ' : ' + (e && e.message ? e.message : e), 'avertissement');
        }
      }
      blocks = newBlocks;
    }

    blocks = mergeHyphenatedBlockBoundaries(blocks);
    // ADDENDUM 4, section R.1 : recolle une phrase coupee par une rupture de
    // paragraphe artificielle a la jonction de deux demi-pages (ou de deux
    // pages OCRisees consecutives).
    blocks = mergeSentenceContinuations(blocks);
    // ADDENDUM 4, section U.2 : restaure prudemment un tiret de dialogue
    // manquant juste apres une replique deja identifiee par un tiret.
    blocks = restoreDialogueDashes(blocks);

    const totalChars = blocks.reduce((acc, b) => acc + (b.runs || []).reduce((a, r) => a + (r.text ? r.text.length : 0), 0), 0);
    if (totalChars === 0) {
      showMessage('Aucun texte n’a pu etre detecte dans ce PDF, meme apres reconnaissance automatique.', 'erreur');
      setProgress('', false);
      return;
    }

    // ADDENDUM 4, section T.2 : tag (pas de suppression definitive) des
    // pages candidates "page de garde / copyright" -- filtrage reversible
    // applique a l'affichage via la case a cocher (recomputeLayoutAndRender).
    const frontMatterPages = window.ExtractNative.detectFrontMatterPages(blocks);
    if (frontMatterPages.size) {
      for (const b of blocks) { if (frontMatterPages.has(b.srcPage)) b.frontMatter = true; }
      showMessage(
        frontMatterPages.size + ' page(s) de garde/copyright detectee(s) (page(s) ' +
        Array.from(frontMatterPages).sort((a, b2) => a - b2).join(', ') +
        ') — ignoree(s) par defaut, decochable dans les reglages.',
        'avertissement'
      );
    }

    masterBlocks = blocks;
    masterExtraction = extraction; // pageShapes/pageSizes (ADDENDUM 6, Z4.4) -- geometrie inchangee par le filtrage de blocs
    window.__DEBUG_BLOCKS__ = blocks; // diagnostic (tests/verify.sh, developpement) -- inoffensif
    setProgress('', false);
    recomputeLayoutAndRender();
  }

  function wireSettingsEvents() {
    ['taille', 'interligne', 'contraste', 'espacementCar', 'espacementMot', 'images', 'orientation', 'doublePage', 'ignorerPagesGarde', 'couleur'].forEach((key) => {
      els[key].addEventListener('input', () => {
        if (key === 'taille') els.valeurTaille.textContent = els.taille.value;
        if (masterBlocks) recomputeLayoutAndRender();
      });
      els[key].addEventListener('change', () => {
        if (masterBlocks) recomputeLayoutAndRender();
      });
    });

    els.btnReinitialiser.addEventListener('click', () => {
      applySettingsToUI(window.LayoutEngine.DEFAULTS);
      els.doublePage.value = 'auto';
      saveSettings(window.LayoutEngine.clampSettings({}));
      if (masterBlocks) recomputeLayoutAndRender();
    });
  }

  function wireFileEvents() {
    els.dropzone.addEventListener('click', () => els.inputFichier.click());
    els.dropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.inputFichier.click(); }
    });
    els.btnChoisir.addEventListener('click', (e) => { e.stopPropagation(); els.inputFichier.click(); });
    els.inputFichier.addEventListener('change', () => {
      const f = els.inputFichier.files[0];
      if (f) processFile(f);
    });
    ['dragenter', 'dragover'].forEach((evt) => {
      els.dropzone.addEventListener(evt, (e) => { e.preventDefault(); els.dropzone.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach((evt) => {
      els.dropzone.addEventListener(evt, (e) => { e.preventDefault(); els.dropzone.classList.remove('dragover'); });
    });
    els.dropzone.addEventListener('drop', (e) => {
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f && f.type === 'application/pdf') processFile(f);
      else if (f) showMessage('Merci de deposer un fichier PDF.', 'erreur');
    });
  }

  async function init() {
    ['taille', 'valeurTaille', 'interligne', 'contraste', 'espacementCar', 'espacementMot', 'images',
      'orientation', 'doublePage', 'btnReinitialiser', 'dropzone', 'btnChoisir', 'inputFichier',
      'btnTelecharger', 'btnImprimer', 'compteurPages', 'progression', 'messages', 'apercu'].forEach((k) => {
      els[k] = null;
    });
    els.taille = q('reglage-taille');
    els.valeurTaille = q('valeur-taille');
    els.interligne = q('reglage-interligne');
    els.contraste = q('reglage-contraste');
    els.espacementCar = q('reglage-espacement-car');
    els.espacementMot = q('reglage-espacement-mot');
    els.images = q('reglage-images');
    els.orientation = q('reglage-orientation');
    els.couleur = q('reglage-couleur');
    els.doublePage = q('reglage-double-page');
    els.ignorerPagesGarde = q('reglage-ignorer-pages-garde');
    els.btnReinitialiser = q('btn-reinitialiser');
    els.dropzone = q('dropzone');
    els.btnChoisir = q('btn-choisir-fichier');
    els.inputFichier = q('input-fichier');
    els.btnTelecharger = q('btn-telecharger');
    els.btnImprimer = q('btn-imprimer');
    els.compteurPages = q('compteur-pages');
    els.progression = q('progression');
    els.messages = q('messages');
    els.apercu = q('apercu');

    applySettingsToUI(loadSettings());
    wireSettingsEvents();
    wireFileEvents();
    els.btnTelecharger.addEventListener('click', handleDownload);
    els.btnImprimer.addEventListener('click', handlePrint);

    setProgress('Chargement des composants (pdf.js, jsPDF)…', true);
    try {
      pdfjsLib = await window.LibLoader.initPdfJs();
      jsPDFCtor = await window.LibLoader.initJsPDF();
      await window.LibLoader.initTesseractMain();
      measurementDoc = window.PdfExport.createMeasurementDoc(jsPDFCtor, 'portrait');
      measurer = window.LayoutEngine.makeMeasurer(measurementDoc);
      window.ExtractNative.ensureWordlist();
    } catch (e) {
      showMessage('Erreur d’initialisation de l’outil : ' + (e && e.message ? e.message : e), 'erreur');
      setProgress('', false);
      return;
    }
    setProgress('', false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
