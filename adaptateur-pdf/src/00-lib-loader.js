/* ============================================================================
 * 00-lib-loader.js
 * Charge pdf.js, jsPDF et tesseract.js depuis les payloads base64 embarqués
 * (voir build.py), sans AUCUNE requête réseau, y compris pour les Web Workers.
 *
 * Contournements valides UNIQUEMENT sous file:// (verifies par des tests
 * reels, voir tests/spike-notes.md) :
 *
 *  1. pdf.js instancie normalement son worker via `new Worker(url,
 *     {type:"module"})`. Sous file://, l'origine vaut "null" et pdf.js route
 *     alors la creation du worker via un "CDN wrapper" (Blob imbriquant un
 *     second Blob) qui echoue systematiquement sous Chromium en contexte
 *     file://. Le patch ci-dessous retire ce detour : le Blob URL du worker,
 *     fabrique dans le meme document, est utilisable directement.
 *
 *  2. `new Worker(url)` echoue silencieusement (evenement "error" sans
 *     message) quand `url` est une DATA: URL de plus de ~2 Mo (limite de
 *     longueur d'URL de Chromium). A l'inverse un BLOB: URL n'a pas cette
 *     limite (le contenu n'est pas dans la chaine d'URL). On charge donc
 *     TOUJOURS le worker lui-meme via un petit Blob, et on ne passe par des
 *     data: URL que pour des appels internes `importScripts(...)`.
 *
 *  3. `importScripts(blobUrl)` DEPUIS l'INTERIEUR d'un worker deja charge
 *     depuis un Blob echoue (NetworkError) sous origine "null". La meme
 *     operation avec une data: URL fonctionne. D'ou : bootstrap worker en
 *     Blob (etape 2), qui charge les gros payloads (coeur wasm tesseract,
 *     worker.min.js) via importScripts(data:...).
 *
 *  4. tesseract.js 7.0.0 contient un bug : si `langs` est passe comme
 *     tableau d'objets {code,data}, l'etape `initialize()` construit la
 *     chaine de langue avec `l.data` au lieu de `l.code`
 *     (worker-script/index.js:238), ce qui casse l'appel natif Init() et
 *     produit "Tesseract couldn't load any languages!". Contournement :
 *     `langs` reste une chaine ('fra'), et on intercepte `self.fetch` DANS
 *     le worker pour servir les octets de fra.traineddata / osd.traineddata
 *     embarques a la place d'un vrai reseau.
 * ==========================================================================*/

(function () {
  'use strict';

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function b64ToText(b64) {
    return new TextDecoder('utf-8').decode(b64ToBytes(b64));
  }
  function dataUrlFromB64(b64, mime) {
    return 'data:' + mime + ';base64,' + b64;
  }

  const PDFJS_SAME_ORIGIN_NEEDLE =
    'PDFWorkerUtil.isSameOrigin(window.location.href,t)||(t=PDFWorkerUtil.createCDNWrapper(new URL(t,window.location).href));';

  async function loadScriptFromText(jsText) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = URL.createObjectURL(new Blob([jsText], { type: 'text/javascript' }));
      s.onload = resolve;
      s.onerror = () => reject(new Error('Echec de chargement d’un script embarque.'));
      document.head.appendChild(s);
    });
  }

  async function initPdfJs() {
    const libText = b64ToText(window.ASSETS.pdfjsLib);
    if (!libText.includes(PDFJS_SAME_ORIGIN_NEEDLE)) {
      throw new Error(
        'Le correctif pdf.js (contournement file://) ne correspond plus au code source : ' +
        'la version de pdf.js embarquee a probablement change.'
      );
    }
    const patched = libText.replace(PDFJS_SAME_ORIGIN_NEEDLE, '');
    await loadScriptFromText(patched);
    if (!window.pdfjsLib) throw new Error('pdfjsLib absent apres chargement.');
    const workerText = b64ToText(window.ASSETS.pdfjsWorker);
    const workerBlobUrl = URL.createObjectURL(new Blob([workerText], { type: 'text/javascript' }));
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = workerBlobUrl;
    return window.pdfjsLib;
  }

  async function initJsPDF() {
    const src = b64ToText(window.ASSETS.jspdf);
    await loadScriptFromText(src);
    const ctor = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    if (!ctor) throw new Error('Constructeur jsPDF introuvable apres chargement.');
    return ctor;
  }

  async function initTesseractMain() {
    const src = b64ToText(window.ASSETS.tesseractMain);
    await loadScriptFromText(src);
    if (!window.Tesseract) throw new Error('window.Tesseract absent apres chargement.');
    return window.Tesseract;
  }

  // Construit le bootstrap de worker tesseract.js (voir points 2/3/4 ci-dessus).
  // embeddedLangs : { fra: base64, osd: base64 } -- osd optionnel.
  function buildTesseractWorkerBootstrapBlobUrl(embeddedLangsB64) {
    const coreDataUrl = dataUrlFromB64(window.ASSETS.tesseractCore, 'text/javascript');
    const workerDataUrl = dataUrlFromB64(window.ASSETS.tesseractWorker, 'text/javascript');

    const lines = [];
    lines.push('var EMBEDDED_LANGDATA_B64 = ' + JSON.stringify(embeddedLangsB64) + ';');
    lines.push('function b64ToBytesW(s){var bin=atob(s);var out=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);return out;}');
    lines.push('var EMBEDDED_LANGDATA = {};');
    lines.push('Object.keys(EMBEDDED_LANGDATA_B64).forEach(function(k){ EMBEDDED_LANGDATA[k] = b64ToBytesW(EMBEDDED_LANGDATA_B64[k]); });');
    lines.push('var _origFetch = (typeof fetch === "function") ? fetch : undefined;');
    lines.push('self.fetch = function(url) {');
    lines.push('  var u = String(url);');
    lines.push('  var m = /^embedded:\\/\\/langdata\\/([a-z]+)\\.traineddata$/.exec(u);');
    lines.push('  if (m && EMBEDDED_LANGDATA[m[1]]) {');
    lines.push('    return Promise.resolve(new Response(EMBEDDED_LANGDATA[m[1]], { status: 200, headers: { "Content-Type": "application/octet-stream" } }));');
    lines.push('  }');
    lines.push('  if (_origFetch) return _origFetch.apply(this, arguments);');
    lines.push('  return Promise.reject(new Error("fetch indisponible (hors-ligne) pour: " + u));');
    lines.push('};');
    lines.push('importScripts(' + JSON.stringify(coreDataUrl) + ');');
    lines.push('importScripts(' + JSON.stringify(workerDataUrl) + ');');
    const bootstrapText = lines.join('\n');
    return URL.createObjectURL(new Blob([bootstrapText], { type: 'text/javascript' }));
  }

  // Cree un worker tesseract.js pret a l'emploi, langue(s) donnee(s) en
  // chaine ('fra'), donnees embarquees (pas de reseau). `legacyCore: true`
  // est necessaire pour worker.detect() (OSD) -- le coeur "simd" combine
  // (legacy+LSTM) le permet tout en autorisant oem=LSTM_ONLY pour recognize().
  async function createOfflineTesseractWorker(langs, oem, opts) {
    opts = opts || {};
    const embedded = { fra: window.ASSETS.fraTraineddata };
    if (opts.withOsd) embedded.osd = window.ASSETS.osdTraineddata;
    const bootstrapBlobUrl = buildTesseractWorkerBootstrapBlobUrl(embedded);

    const worker = await window.Tesseract.createWorker(langs, oem, {
      workerPath: bootstrapBlobUrl,
      workerBlobURL: false,
      corePath: 'embarque-precharge-par-bootstrap.js',
      langPath: 'embedded://langdata',
      gzip: false,
      legacyCore: true,
      logger: opts.logger || function () {},
    });

    if (opts.withOsd) {
      const osdBytes = b64ToBytes(window.ASSETS.osdTraineddata);
      await worker.FS('writeFile', ['osd.traineddata', osdBytes]);
    }
    return worker;
  }

  window.LibLoader = {
    b64ToBytes,
    b64ToText,
    initPdfJs,
    initJsPDF,
    initTesseractMain,
    createOfflineTesseractWorker,
  };
})();
