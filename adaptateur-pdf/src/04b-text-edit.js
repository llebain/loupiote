/* ============================================================================
 * 04b-text-edit.js
 * Relecture du texte AVANT la mise en page (retour de test du 05/10/2026 :
 * « pouvoir supprimer une phrase en trop, corriger le texte directement »).
 *
 * Deux modes, tous deux purement sur le modele de blocs (aucune dependance au
 * DOM ni a la mise en page, testable sous Node) :
 *  - « blocs » : le texte visible est expose paragraphe par paragraphe ; la
 *    correction est reportee sur le bloc d'origine, qui garde sa place, son
 *    style (titre, gras, couleur...) et son conteneur (tableau, encadre) ;
 *  - « brut »  : le texte edite devient un document de paragraphes simples,
 *    sans cadre, tableau ni image (mise en forme perdue).
 * Aucun bloc n'est jamais modifie sur place : chaque fonction rend de
 * nouveaux objets, `masterBlocks` (05-main.js) reste l'original.
 * ==========================================================================*/

(function () {
  'use strict';

  const A4_PT = { width: 595.28, height: 841.89 };

  // Texte d'un bloc, espaces normalises (une espace, pas de saut de ligne).
  function blockText(b) {
    return (b.runs || []).map((r) => r.text || '').join('').replace(/\s+/g, ' ').trim();
  }

  // Un bloc est editable s'il est AFFICHE a la mise en page (memes filtres
  // que computeBlockLayout et recomputeLayoutAndRender) et porte du texte.
  function isEditable(b, settings) {
    if (!b || b.type === 'image' || b.type === 'pagebreak' || b.type === 'needs-ocr') return false;
    if (b.secondary || b.duplicate) return false;
    if (b.frontMatter && settings.skipFrontMatter) return false;
    if (b.headerFooter && !settings.showHeaderFooter) return false;
    return blockText(b).length > 0;
  }

  function visibleBlocks(blocks, settings) {
    return blocks.filter((b) => isEditable(b, settings));
  }

  // Paragraphes <-> texte : un paragraphe = un bloc de texte separe du
  // suivant par une ligne vide ; un simple retour a la ligne dans un
  // paragraphe est une espace.
  function joinParagraphs(paragraphs) {
    return paragraphs.join('\n\n');
  }
  function parseParagraphs(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .split(/\n[ \t]*\n/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }

  // --- Alignement paragraphes d'origine <-> paragraphes edites -------------

  function bigrams(s) {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  }
  // Coefficient de Dice sur les bigrammes de caracteres (0..1).
  function similarity(a, b) {
    if (a === b) return 1;
    a = a.toLowerCase(); b = b.toLowerCase();
    if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
    const ga = bigrams(a), gb = bigrams(b);
    let inter = 0;
    for (const [g, n] of ga) if (gb.has(g)) inter += Math.min(n, gb.get(g));
    return (2 * inter) / (a.length - 1 + b.length - 1);
  }

  // Alignement ordonne : rend des operations
  //   { op: 'keep'|'edit', i, j } | { op: 'del', i } | { op: 'add', j }
  // dans l'ordre du document. D'abord les paragraphes strictement egaux
  // (plus longue sous-suite commune), puis, dans chaque intervalle entre
  // deux ancres : meme nombre de paragraphes de part et d'autre -> ils se
  // correspondent un a un (le texte a ete corrige sur place) ; sinon
  // appariement par ressemblance, le reste est suppression / ajout.
  function alignParagraphs(orig, edited) {
    const n = orig.length, m = edited.length;
    // LCS exact.
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = orig[i] === edited[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    const anchors = [];
    for (let i = 0, j = 0; i < n && j < m;) {
      if (orig[i] === edited[j]) { anchors.push([i, j]); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
      else j++;
    }
    anchors.push([n, m]); // sentinelle

    const ops = [];
    let pi = 0, pj = 0;
    for (const [ai, aj] of anchors) {
      const gi = ai - pi, gj = aj - pj;
      if (gi > 0 || gj > 0) ops.push(...alignGap(orig, edited, pi, ai, pj, aj));
      if (ai < n) ops.push({ op: 'keep', i: ai, j: aj });
      pi = ai + 1; pj = aj + 1;
    }
    return ops;
  }

  function alignGap(orig, edited, i0, i1, j0, j1) {
    const gi = i1 - i0, gj = j1 - j0;
    const ops = [];
    if (gi === gj) {
      for (let k = 0; k < gi; k++) ops.push({ op: 'edit', i: i0 + k, j: j0 + k });
      return ops;
    }
    if (gi === 0) { for (let j = j0; j < j1; j++) ops.push({ op: 'add', j }); return ops; }
    if (gj === 0) { for (let i = i0; i < i1; i++) ops.push({ op: 'del', i }); return ops; }
    if (gi * gj > 250000) { // intervalle enorme : on ne cherche pas la ressemblance
      for (let k = 0; k < Math.min(gi, gj); k++) ops.push({ op: 'edit', i: i0 + k, j: j0 + k });
      for (let i = i0 + Math.min(gi, gj); i < i1; i++) ops.push({ op: 'del', i });
      for (let j = j0 + Math.min(gi, gj); j < j1; j++) ops.push({ op: 'add', j });
      return ops;
    }
    const THRESHOLD = 0.35;
    const W = gj + 1;
    const score = new Float64Array((gi + 1) * W);
    const sim = (a, b) => similarity(orig[i0 + a], edited[j0 + b]);
    for (let a = gi - 1; a >= 0; a--) {
      for (let b = gj - 1; b >= 0; b--) {
        let best = Math.max(score[(a + 1) * W + b], score[a * W + b + 1]);
        const s = sim(a, b);
        if (s >= THRESHOLD) best = Math.max(best, score[(a + 1) * W + b + 1] + s);
        score[a * W + b] = best;
      }
    }
    let a = 0, b = 0;
    while (a < gi || b < gj) {
      if (a < gi && b < gj) {
        const s = sim(a, b);
        if (s >= THRESHOLD && Math.abs(score[a * W + b] - (score[(a + 1) * W + b + 1] + s)) < 1e-9) {
          ops.push({ op: 'edit', i: i0 + a, j: j0 + b }); a++; b++; continue;
        }
        if (score[(a + 1) * W + b] >= score[a * W + b + 1]) { ops.push({ op: 'del', i: i0 + a }); a++; continue; }
        ops.push({ op: 'add', j: j0 + b }); b++; continue;
      }
      if (a < gi) { ops.push({ op: 'del', i: i0 + a }); a++; } else { ops.push({ op: 'add', j: j0 + b }); b++; }
    }
    return ops;
  }

  // --- Report d'une correction sur les runs --------------------------------

  // Remplace le texte d'un bloc en gardant le style des runs pour tout ce qui
  // n'a pas change : prefixe et suffixe communs gardent leur run d'origine,
  // le texte inseré prend le style du run a l'endroit de la modification.
  function applyTextToRuns(runs, newText) {
    // Caracteres d'origine, espaces normalisees (comme blockText).
    const chars = [];
    runs.forEach((r, ri) => {
      for (const c of (r.text || '')) {
        const isSpace = /\s/.test(c);
        const prev = chars[chars.length - 1];
        if (isSpace && (!prev || prev.c === ' ')) continue;
        chars.push({ c: isSpace ? ' ' : c, ri });
      }
    });
    while (chars.length && chars[chars.length - 1].c === ' ') chars.pop();
    const oldArr = chars.map((x) => x.c);
    const newArr = Array.from(newText);

    let p = 0;
    while (p < oldArr.length && p < newArr.length && oldArr[p] === newArr[p]) p++;
    let s = 0;
    while (s < oldArr.length - p && s < newArr.length - p &&
      oldArr[oldArr.length - 1 - s] === newArr[newArr.length - 1 - s]) s++;

    const fallback = runs.length ? 0 : -1;
    const runAt = (k) => {
      if (!chars.length) return fallback;
      return chars[Math.min(Math.max(k, 0), chars.length - 1)].ri;
    };
    const out = [];
    const push = (ri, c) => {
      const last = out[out.length - 1];
      if (last && last.ri === ri) last.text += c; else out.push({ ri, text: c });
    };
    for (let k = 0; k < p; k++) push(chars[k].ri, newArr[k]);
    // Texte remplace : il reprend le style du texte remplace ; simple
    // insertion : le style du caractere qui precede (comme un traitement de
    // texte).
    const replaced = oldArr.length - s - p > 0;
    const insertRi = runAt(replaced ? p : Math.max(p - 1, 0));
    for (let k = p; k < newArr.length - s; k++) push(insertRi, newArr[k]);
    for (let k = 0; k < s; k++) push(chars[oldArr.length - s + k].ri, newArr[newArr.length - s + k]);

    if (!out.length) return [];
    return out.map(({ ri, text }) => ({ ...(ri >= 0 ? runs[ri] : {}), text }));
  }

  // Applique les paragraphes edites au modele de blocs (mode « blocs »).
  // `blocks` : tous les blocs (visibles ou non) ; rend un NOUVEAU tableau.
  function applyEdit(blocks, editedParagraphs, settings) {
    const visible = visibleBlocks(blocks, settings);
    const orig = visible.map(blockText);
    const ops = alignParagraphs(orig, editedParagraphs);

    const decision = new Map();  // bloc visible -> { drop } | { runs }
    const addAfter = new Map();  // bloc visible -> [textes ajoutes juste apres lui]
    const addBefore = [];        // textes ajoutes avant le premier bloc visible
    let lastVisible = null;
    for (const o of ops) {
      if (o.op === 'keep') { lastVisible = visible[o.i]; continue; }
      if (o.op === 'edit') {
        const b = visible[o.i];
        decision.set(b, { runs: applyTextToRuns(b.runs, editedParagraphs[o.j]) });
        lastVisible = b;
      } else if (o.op === 'del') {
        decision.set(visible[o.i], { drop: true });
        lastVisible = visible[o.i];
      } else if (o.op === 'add') {
        if (lastVisible) {
          if (!addAfter.has(lastVisible)) addAfter.set(lastVisible, []);
          addAfter.get(lastVisible).push(editedParagraphs[o.j]);
        } else addBefore.push(editedParagraphs[o.j]);
      }
    }

    // Un paragraphe ajoute copie la place (page, conteneur) du bloc voisin,
    // en texte courant (pas en titre).
    const cloneFor = (model, text) => {
      const firstRun = (model.runs && model.runs[0]) || {};
      return {
        type: model.type === 'li' ? 'li' : 'p', srcPage: model.srcPage, bbox: model.bbox, size: model.size,
        srcType: model.srcType, added: true,
        runs: [{ ...firstRun, text, bold: false, underline: false }],
      };
    };
    const firstVisible = visible[0];
    const out = [];
    for (const b of blocks) {
      if (b === firstVisible) for (const t of addBefore) out.push(cloneFor(b, t));
      const d = decision.get(b);
      if (d && d.drop) {
        // Un bloc supprime laisse la place a ses voisins ; si des ajouts lui
        // etaient accroches, ils prennent sa place.
        for (const t of addAfter.get(b) || []) out.push(cloneFor(b, t));
        continue;
      }
      out.push(d && d.runs ? { ...b, runs: d.runs, edited: true } : b);
      for (const t of addAfter.get(b) || []) out.push(cloneFor(b, t));
    }
    return out;
  }

  // --- Mode « texte simple » ------------------------------------------------

  // Document de paragraphes simples, une seule « page source » qui se pagine
  // en A4 (comme n'importe quelle page trop haute). Les blocs sont ordonnes
  // par une ordonnee source decroissante, sans chevauchement vertical.
  function plainDocument(text) {
    const paragraphs = parseParagraphs(text);
    const TOP = 1e6, STEP = 40;
    const blocks = paragraphs.map((t, k) => ({
      type: 'p', srcPage: 1, plain: true,
      runs: [{ text: t }],
      bbox: { x0: 0, x1: A4_PT.width, y0: TOP - k * STEP - 20, y1: TOP - k * STEP },
    }));
    const extraction = {
      blocks,
      pageShapes: [{ boxes: [], lines: [], decorative: [] }],
      pageSizes: [{ width: A4_PT.width, height: A4_PT.height, modalSize: 12 }],
    };
    return { blocks, extraction };
  }

  window.TextEdit = {
    blockText,
    isEditable,
    visibleBlocks,
    joinParagraphs,
    parseParagraphs,
    alignParagraphs,
    applyTextToRuns,
    applyEdit,
    plainDocument,
  };
})();
