// ADDENDUM 6, Z9 -- Harnais de non-regression : charge les modules reels du
// projet (src/01-extract-native.js, 03-layout-engine.js, 04-pdf-export.js)
// dans un contexte Node minimal (vm), sans DOM. Valide le meme code que
// celui livre dans adaptateur-pdf-luciole.html (build.py les concatene tels
// quels) -- ce n'est PAS une reimplementation parallele.
//
// Limite connue : l'extraction d'image (extractImageBlocksForPage) utilise
// `document.createElement('canvas')` / `page.render()`, absents ici -- elle
// echoue silencieusement (try/catch deja present dans le code source), donc
// les blocs 'image' ne sont jamais produits sous ce harnais. Sans impact sur
// les invariants verifies (geometrie, pagination, texte), mais un test qui
// voudrait verifier la presence d'images devra passer par un vrai navigateur
// (cf. README de ce dossier).
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '../../src');
const ASSETS_DIR = path.resolve(__dirname, '../../assets');

const require = createRequire(import.meta.url);
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const { jsPDF } = require('jspdf');

function b64(file) {
  return fs.readFileSync(path.join(ASSETS_DIR, 'fonts', file)).toString('base64');
}

export async function setup() {
  const win = {
    pdfjsLib,
    LibLoader: { b64ToText: (b) => Buffer.from(b, 'base64').toString('utf8') },
    // Petite liste de mots suffisante : le test de qualite de texte
    // (assessTextQuality) n'a besoin que d'un signal d'appoint, la regle
    // principale (longueur de token / ratio de symboles) ne depend pas du
    // vocabulaire -- voir 01-extract-native.js, ADDENDUM 3.
    ASSETS: {
      frWordlist: Buffer.from('le\nun\nune\nde\nles\nla\net\nest\nque\nqui\ndans\npour\n').toString('base64'),
      lucioleRegular: b64('Luciole-Regular.ttf'),
      lucioleBold: b64('Luciole-Bold.ttf'),
      lucioleItalic: b64('Luciole-Regular-Italic.ttf'),
      lucioleBoldItalic: b64('Luciole-Bold-Italic.ttf'),
    },
  };
  global.window = win;

  for (const f of ['01-extract-native.js', '03-layout-engine.js', '04-pdf-export.js']) {
    const src = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
    vm.runInThisContext(src, { filename: f });
  }
  return { pdfjsLib, jsPDF, ExtractNative: win.ExtractNative, LayoutEngine: win.LayoutEngine, PdfExport: win.PdfExport };
}

export async function extractPdf(ctx, pdfPath) {
  const doc = await ctx.pdfjsLib.getDocument({ url: pdfPath, disableFontFace: true, verbosity: 0 }).promise;
  const extraction = await ctx.ExtractNative.extractNativePdf(doc, null);
  return extraction;
}

export function makeMeasurer(ctx) {
  const doc = ctx.PdfExport.createMeasurementDoc(ctx.jsPDF, 'portrait');
  return { doc, measurer: ctx.LayoutEngine.makeMeasurer(doc) };
}

// Construit la mise en page ET exporte un PDF reel (comme handleDownload()
// dans 05-main.js), retourne { layout, pdfBuffer, reparsed } ou `reparsed`
// est le redoublage du PDF exporte via pdf.js (verifie que le fichier
// produit est un vrai PDF exploitable, pas seulement que le calcul de mise
// en page n'a pas plante).
export async function runFullPipeline(ctx, pdfPath, settingsOverrides) {
  const extraction = await extractPdf(ctx, pdfPath);
  const blocks = extraction.blocks.filter((b) => b.type !== 'pagebreak' && b.type !== 'needs-ocr');
  const settings = ctx.LayoutEngine.clampSettings(settingsOverrides || {});
  const { measurer } = makeMeasurer(ctx);
  const layout = ctx.LayoutEngine.computeBlockLayoutForDocument(extraction, blocks, settings, measurer);

  const exportDoc = ctx.PdfExport.createExportDoc(ctx.jsPDF, layout.pages[0].pageDims);
  ctx.PdfExport.renderLayoutToPdf(exportDoc, layout, path.basename(pdfPath));
  const pdfArrayBuffer = exportDoc.output('arraybuffer');
  const pdfBuffer = Buffer.from(pdfArrayBuffer);

  const reparsedDoc = await ctx.pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer), disableFontFace: true, verbosity: 0 }).promise;
  const pages = [];
  for (let p = 1; p <= reparsedDoc.numPages; p++) {
    const page = await reparsedDoc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const ys = tc.items.filter((it) => it.str && it.str.trim()).map((it) => it.transform[5]);
    pages.push({
      width: vp.width, height: vp.height, textItemCount: tc.items.length,
      topItemY: ys.length ? Math.max(...ys) : null, // pt, origine bas-page -- proche de `height` = colle au bord haut
    });
  }

  return { extraction, blocks, layout, pdfBuffer, reparsed: { pageCount: reparsedDoc.numPages, pages } };
}
