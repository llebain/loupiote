// Lecteur minimal de la table 'cmap' d'un fichier TrueType (.ttf), formats 4
// et 12 uniquement (les seuls rencontres dans Luciole-Regular/Bold -- verifie
// empiriquement sur ce fichier). Pas de dependance npm : aucune bibliotheque
// de parsing de police n'etait deja presente dans node_modules (verifie :
// pdfjs-dist/jspdf/playwright-core n'exposent pas de lecteur cmap reutilisable
// en dehors d'un contexte PDF), et l'outil de corpus doit rester sans nouvelle
// dependance reseau (§0.2 du plan).
//
// Usage : const cmap = lireCmap(fs.readFileSync('Luciole-Regular.ttf'));
//         cmap.has(0x2726) // false : '✶' absent de Luciole

function u16(buf, off) { return buf.readUInt16BE(off); }
function u32(buf, off) { return buf.readUInt32BE(off); }
function i16(buf, off) { return buf.readInt16BE(off); }

function parseFormat4(buf, off, out) {
  // en-tete format 4 : format(2) length(2) language(2) segCountX2(2) ...
  const segCountX2 = u16(buf, off + 6);
  const segCount = segCountX2 / 2;
  const endCodesOff = off + 14;
  const startCodesOff = endCodesOff + segCountX2 + 2; // +2 : reservedPad
  const idDeltaOff = startCodesOff + segCountX2;
  const idRangeOff = idDeltaOff + segCountX2;
  for (let s = 0; s < segCount; s++) {
    const endCode = u16(buf, endCodesOff + s * 2);
    const startCode = u16(buf, startCodesOff + s * 2);
    const idDelta = i16(buf, idDeltaOff + s * 2);
    const idRangeOffset = u16(buf, idRangeOff + s * 2);
    if (startCode === 0xffff && endCode === 0xffff) continue;
    for (let c = startCode; c <= endCode && c !== 0xffff; c++) {
      let gid;
      if (idRangeOffset === 0) {
        gid = (c + idDelta) & 0xffff;
      } else {
        const glyphIndexAddr = idRangeOff + s * 2 + idRangeOffset + (c - startCode) * 2;
        if (glyphIndexAddr + 1 >= buf.length) continue;
        gid = u16(buf, glyphIndexAddr);
        if (gid !== 0) gid = (gid + idDelta) & 0xffff;
      }
      if (gid !== 0) out.add(c);
    }
  }
}

function parseFormat12(buf, off, out) {
  // en-tete format 12 : format(2) reserved(2) length(4) language(4) nGroups(4)
  const nGroups = u32(buf, off + 12);
  let g = off + 16;
  for (let i = 0; i < nGroups; i++) {
    const startCharCode = u32(buf, g);
    const endCharCode = u32(buf, g + 4);
    for (let c = startCharCode; c <= endCharCode; c++) out.add(c);
    g += 12;
  }
}

/**
 * Retourne un Set<number> des points de code Unicode couverts (glyphe non
 * .notdef) par la table cmap du fichier TTF passe en Buffer.
 */
export function lireCmap(buf) {
  const numTables = u16(buf, 4);
  let cmapOff = null;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = buf.toString('ascii', rec, rec + 4);
    if (tag === 'cmap') { cmapOff = u32(buf, rec + 8); break; }
  }
  if (cmapOff == null) throw new Error('table cmap absente du fichier TTF');

  const numSubtables = u16(buf, cmapOff + 2);
  const subtables = [];
  for (let i = 0; i < numSubtables; i++) {
    const rec = cmapOff + 4 + i * 8;
    subtables.push({
      platformID: u16(buf, rec),
      encodingID: u16(buf, rec + 2),
      offset: u32(buf, rec + 4),
    });
  }
  // Priorite : Unicode BMP+supplementaire (3,10) ou (0,4)/(0,6), puis format 4
  // Windows Unicode BMP (3,1) ou (0,3).
  const out = new Set();
  let used = 0;
  for (const st of subtables) {
    const abs = cmapOff + st.offset;
    const format = u16(buf, abs);
    const isUnicode =
      (st.platformID === 3 && (st.encodingID === 1 || st.encodingID === 10)) ||
      st.platformID === 0;
    if (!isUnicode) continue;
    if (format === 12) { parseFormat12(buf, abs, out); used++; }
    else if (format === 4) { parseFormat4(buf, abs, out); used++; }
  }
  if (used === 0) {
    // repli : n'importe quelle sous-table lisible (formats 4/12 seulement)
    for (const st of subtables) {
      const abs = cmapOff + st.offset;
      const format = u16(buf, abs);
      if (format === 12) parseFormat12(buf, abs, out);
      else if (format === 4) parseFormat4(buf, abs, out);
    }
  }
  return out;
}
