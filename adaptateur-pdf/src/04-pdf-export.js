/* ============================================================================
 * 04-pdf-export.js
 * Creation du document jsPDF (mesure ET export), embarquement de la police
 * Luciole, rendu de la mise en page calculee par 03-layout-engine.js,
 * metadonnees legales (voir README / mention d'usage).
 * ==========================================================================*/

(function () {
  'use strict';

  function embedLucioleFonts(doc) {
    const F = window.ASSETS;
    doc.addFileToVFS('Luciole-Regular.ttf', F.lucioleRegular);
    doc.addFont('Luciole-Regular.ttf', 'Luciole', 'normal');
    doc.addFileToVFS('Luciole-Bold.ttf', F.lucioleBold);
    doc.addFont('Luciole-Bold.ttf', 'Luciole', 'bold');
    // v0.3 (E9) : les polices italiques ne sont plus embarquees -- aucun
    // italique n'est jamais rendu (styleForRun, 03-layout-engine.js).
  }

  // Cree un document jsPDF pret a l'emploi, utilisable a la fois comme
  // moteur de MESURE (getTextWidth) et comme document d'EXPORT final. Le
  // format A4 par defaut convient a la mesure (getTextWidth n'en depend
  // pas) ; pour un export reel, voir createExportDoc ci-dessous.
  function createMeasurementDoc(jsPDFCtor, orientation) {
    const doc = new jsPDFCtor({
      unit: 'pt',
      format: 'a4',
      orientation: orientation === 'paysage' ? 'landscape' : 'portrait',
      compress: true,
    });
    embedLucioleFonts(doc);
    return doc;
  }

  // ADDENDUM 6, Z4.4 : chaque page source peut produire une page de sortie
  // plus grande qu'A4 (le format grandit avec le contenu, cf. PLAN section
  // Z1). Cree le document d'export a la taille EXACTE de la premiere page
  // calculee -- les pages suivantes sont ajoutees individuellement a leur
  // propre taille dans renderLayoutToPdf().
  function createExportDoc(jsPDFCtor, firstPageDims) {
    const doc = new jsPDFCtor({
      unit: 'pt',
      format: [firstPageDims.width, firstPageDims.height],
      // v0.3 (E4) : orientation explicite -- sans elle, jsPDF remet en
      // portrait un format plus large que haut (premiere page paysage).
      orientation: firstPageDims.width > firstPageDims.height ? 'landscape' : 'portrait',
      compress: true,
    });
    embedLucioleFonts(doc);
    return doc;
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return [0, 0, 0];
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  }

  function renderImage(doc, img) {
    try {
      doc.addImage(img.src, 'JPEG', img.x, img.y, img.width, img.height, undefined, 'MEDIUM');
    } catch (e) {
      try {
        doc.addImage(img.src, 'PNG', img.x, img.y, img.width, img.height, undefined, 'MEDIUM');
      } catch (e2) { /* image illisible : ignoree silencieusement, deja signalee ailleurs */ }
    }
  }

  // `bg` (v0.3, lot 1, C1) : couleur du fond REELLEMENT derriere ces lignes
  // (page, boite ou cellule), pour le plancher de contraste de
  // resolveTextColor -- meme valeur que l'apercu (05-main.js).
  function renderLines(doc, lines, settings, theme, bg) {
    for (const line of lines) {
      let x = line.x;
      for (const seg of line.segments) {
        doc.setFont('Luciole', seg.style === 'bold' ? 'bold' : 'normal'); // E9 : jamais d'italique
        doc.setFontSize(line.sizePt);
        const [r, g, b] = window.LayoutEngine.resolveTextColor(seg.color, settings, theme, bg);
        doc.setTextColor(r, g, b);
        // jsPDF n'a pas d'option "barre" native : trace un filet a mi-hauteur
        // de casse sous le texte, dans la meme couleur que le segment.
        doc.text(seg.text, x, line.y, { charSpace: undefined });
        if (seg.strikethrough || seg.underline) {
          doc.setDrawColor(r, g, b);
          doc.setLineWidth(Math.max(0.5, line.sizePt * 0.045));
        }
        if (seg.strikethrough) {
          const strikeY = line.y - line.sizePt * 0.3;
          doc.line(x, strikeY, x + seg.width, strikeY);
        }
        // v0.3 (E5) : souligne (marque N&B d'un run deja gras).
        if (seg.underline) {
          const underY = line.y + line.sizePt * 0.12;
          doc.line(x, underY, x + seg.width, underY);
        }
        x += seg.width;
      }
    }
  }

  // Rend la mise en page (issue de LayoutEngine.computeBlockLayoutForDocument)
  // dans le document jsPDF fourni (deja cree via createExportDoc, a la
  // taille de la premiere page), en ajoutant les pages suivantes chacune a
  // SA PROPRE taille (ADDENDUM 6, Z4.4 : une page grandit selon son
  // contenu, plus de format A4 fixe partage). Retourne le meme `doc`, pret
  // pour .output()/.save().
  function renderLayoutToPdf(doc, layout, sourceFileName) {
    const settings = layout.settings;
    const theme = layout.theme;
    const [bgR, bgG, bgB] = hexToRgb(theme.bg);

    layout.pages.forEach((page, pageIndex) => {
      if (pageIndex > 0) doc.addPage([page.pageDims.width, page.pageDims.height], page.pageDims.width > page.pageDims.height ? 'landscape' : 'portrait');

      // Contraste invers/colore : rectangle plein page D'ABORD, texte ensuite.
      doc.setFillColor(bgR, bgG, bgB);
      doc.rect(0, 0, page.pageDims.width, page.pageDims.height, 'F');

      for (const item of page.items) {
        if (item.kind === 'image') {
          if (!settings.showImages) continue;
          renderImage(doc, item);
        } else if (item.kind === 'flow') {
          renderLines(doc, item.lines, settings, theme, [bgR, bgG, bgB]);
        } else if (item.kind === 'box') {
          // Calque de fond decoratif (bande enveloppante fusionnee dans cet
          // item, cf. Addendum 6 Z10bis -- jamais un item separe, pour ne
          // pas risquer d'atterrir sur une autre page que son contenu).
          if (item.outerWrap) {
            const wrapColors = window.LayoutEngine.resolveContainerColors(item.outerWrap.fill, item.outerWrap.stroke, settings, theme);
            doc.setFillColor(wrapColors.fill[0], wrapColors.fill[1], wrapColors.fill[2]);
            doc.setDrawColor(wrapColors.stroke[0], wrapColors.stroke[1], wrapColors.stroke[2]);
            doc.setLineWidth(1.2);
            const p = item.outerWrap.pad;
            doc.roundedRect(item.x - p, item.y - p, item.width + 2 * p, item.height + 2 * p, 10, 10, 'FD');
          }
          const colors = window.LayoutEngine.resolveContainerColors(item.fill, item.stroke, settings, theme);
          doc.setFillColor(colors.fill[0], colors.fill[1], colors.fill[2]);
          doc.setDrawColor(colors.stroke[0], colors.stroke[1], colors.stroke[2]);
          doc.setLineWidth(1.2);
          doc.roundedRect(item.x, item.y, item.width, item.height, 8, 8, 'FD');
          renderLines(doc, item.lines, settings, theme, colors.fill);
          // ADDENDUM 6, Z12, C1 : images de la boite (cf. 03-layout-engine.js,
          // reflowBlocksInWidth) -- meme fonction de rendu que les images de
          // premier niveau, coordonnees deja absolues.
          if (settings.showImages && item.images) for (const im of item.images) renderImage(doc, im);
        } else if (item.kind === 'table') {
          const gridRgb = window.LayoutEngine.hexToRgbArr(theme.fg);
          doc.setDrawColor(gridRgb[0], gridRgb[1], gridRgb[2]);
          doc.setLineWidth(0.75);
          for (const row of item.rows) {
            for (const cell of row.cells) {
              // ADDENDUM 6, Z12, E2 -- fond de cellule (ex. colonne d'en-tete
              // orangee "Noms/Verbes/...", 10_FicheOrtho.pdf) : meme donnee
              // `cell.fill` que l'apercu DOM (05-main.js), meme resolution
              // de couleur -- l'export PDF doit rester identique a l'apercu
              // (principe fondateur, cf. CADRAGE-Z12.md).
              let cellBg = [bgR, bgG, bgB];
              if (cell.fill) {
                const cellColors = window.LayoutEngine.resolveContainerColors(cell.fill, null, settings, theme);
                doc.setFillColor(cellColors.fill[0], cellColors.fill[1], cellColors.fill[2]);
                doc.rect(item.x + cell.x, item.y + row.y, cell.width, row.height, 'FD');
                cellBg = cellColors.fill;
              } else {
                doc.rect(item.x + cell.x, item.y + row.y, cell.width, row.height, 'S');
              }
              renderLines(doc, cell.lines, settings, theme, cellBg);
              // ADDENDUM 6, Z12, C1 : images de la cellule.
              if (settings.showImages && cell.images) for (const im of cell.images) renderImage(doc, im);
            }
          }
        }
      }
    });

    // --- Metadonnees : la mention d'usage reservee voyage dans le PDF via
    // les metadonnees (subject/keywords/creator), JAMAIS imprimee en petits
    // caracteres sur les pages (voir README / interface -- exigence client,
    // ADDENDUM 2 section K).
    const baseName = (sourceFileName || 'document').replace(/\.pdf$/i, '');
    doc.setProperties({
      title: baseName + ' — version adaptée',
      subject: 'Document adapté pour une consultation strictement personnelle par une personne en situation de handicap — article L.122-5, 7° CPI.',
      keywords: 'adaptation handicap, usage personnel, L.122-5-7 CPI',
      creator: 'Adaptateur PDF Luciole',
      author: 'Adaptateur PDF Luciole',
    });
    try { doc.setLanguage('fr'); } catch (e) { /* selon version jsPDF */ }

    return doc;
  }

  function outputFileName(sourceFileName, fontSize) {
    const base = (sourceFileName || 'document').replace(/\.pdf$/i, '');
    return base + '-luciole-' + Math.round(fontSize) + 'pt.pdf';
  }

  window.PdfExport = {
    embedLucioleFonts,
    createMeasurementDoc,
    createExportDoc,
    renderLayoutToPdf,
    outputFileName,
  };
})();
