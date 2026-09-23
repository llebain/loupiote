#!/usr/bin/env python3
"""
Assemble adaptateur-pdf-luciole.html a partir de src/ et assets/.

Toutes les bibliotheques tierces et donnees binaires sont encodees en base64
et exposees en JS via `window.ASSETS = {...}` (voir src/00-lib-loader.js pour
le decodage). Le CSS et notre propre code JS sont inseres tels quels (texte
brut) : aucune requete reseau, aucune dependance externe, un seul fichier.
"""
import base64
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "src"
ASSETS = ROOT / "assets"
OUT = ROOT / "adaptateur-pdf-luciole.html"


def b64_file(path: pathlib.Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def read_text(path: pathlib.Path) -> str:
    return path.read_text(encoding="utf-8")


def main():
    print("Lecture des sources...")
    css = read_text(SRC / "style.css")
    js_lib_loader = read_text(SRC / "00-lib-loader.js")
    js_extract_native = read_text(SRC / "01-extract-native.js")
    js_ocr_pipeline = read_text(SRC / "02-ocr-pipeline.js")
    js_layout_engine = read_text(SRC / "03-layout-engine.js")
    js_pdf_export = read_text(SRC / "04-pdf-export.js")
    js_main = read_text(SRC / "05-main.js")
    template = read_text(SRC / "index-template.html")

    print("Encodage des assets (base64)...")
    assets = {
        "pdfjsLib": b64_file(ASSETS / "vendor" / "pdfjs-pdf.min.js"),
        "pdfjsWorker": b64_file(ASSETS / "vendor" / "pdfjs-pdf.worker.min.js"),
        "jspdf": b64_file(ASSETS / "vendor" / "jspdf.umd.min.js"),
        "tesseractMain": b64_file(ASSETS / "vendor" / "tesseract.min.js"),
        "tesseractWorker": b64_file(ASSETS / "vendor" / "tesseract-worker.min.js"),
        "tesseractCore": b64_file(ASSETS / "vendor" / "tesseract-core-simd.wasm.js"),
        "fraTraineddata": b64_file(ASSETS / "tessdata" / "fra.traineddata"),
        "osdTraineddata": b64_file(ASSETS / "tessdata" / "osd.traineddata"),
        "lucioleRegular": b64_file(ASSETS / "fonts" / "Luciole-Regular.ttf"),
        "lucioleBold": b64_file(ASSETS / "fonts" / "Luciole-Bold.ttf"),
        "lucioleItalic": b64_file(ASSETS / "fonts" / "Luciole-Regular-Italic.ttf"),
        "lucioleBoldItalic": b64_file(ASSETS / "fonts" / "Luciole-Bold-Italic.ttf"),
        "frWordlist": b64_file(ASSETS / "wordlist" / "fr-2000.txt"),
    }
    assets_json = json.dumps(assets, separators=(",", ":"))
    # Securite : les valeurs sont toutes du base64 pur ([A-Za-z0-9+/=]), donc
    # ce JSON ne peut jamais contenir "</script" -- verifie explicitement.
    assert "</" not in assets_json, "sequence </ inattendue dans les assets encodes"

    html = template
    html = html.replace("__CSS__", css)
    html = html.replace("__ASSETS_JSON__", assets_json)
    html = html.replace("__JS_LIB_LOADER__", js_lib_loader)
    html = html.replace("__JS_EXTRACT_NATIVE__", js_extract_native)
    html = html.replace("__JS_OCR_PIPELINE__", js_ocr_pipeline)
    html = html.replace("__JS_LAYOUT_ENGINE__", js_layout_engine)
    html = html.replace("__JS_PDF_EXPORT__", js_pdf_export)
    html = html.replace("__JS_MAIN__", js_main)

    # Detecte un marqueur de substitution du gabarit oublie (le gabarit
    # utilise exclusivement des noms en __XXX__ ; on ignore les identifiants
    # internes comme __DEBUG_BLOCKS__ qui font partie du code applicatif).
    TEMPLATE_MARKERS = {"__CSS__", "__ASSETS_JSON__", "__JS_LIB_LOADER__", "__JS_EXTRACT_NATIVE__",
                         "__JS_OCR_PIPELINE__", "__JS_LAYOUT_ENGINE__", "__JS_PDF_EXPORT__", "__JS_MAIN__"}
    leftover = [m for m in TEMPLATE_MARKERS if m in html]
    if leftover:
        print("ATTENTION : marqueurs de gabarit non remplaces :", leftover)

    OUT.write_text(html, encoding="utf-8")
    size_mb = OUT.stat().st_size / (1024 * 1024)
    print(f"Ecrit {OUT} ({size_mb:.2f} Mo)")
    if size_mb > 40:
        print("ERREUR : taille > 40 Mo, point d'arret du plan.", file=sys.stderr)
        sys.exit(1)
    elif size_mb > 30:
        print("ATTENTION : taille > 30 Mo (budget cible), sous le plafond de 40 Mo.")


if __name__ == "__main__":
    main()
