#!/usr/bin/env bash
# Controles automatises sur un PDF produit par adaptateur-pdf-luciole.html
# (Phase 5 du plan). Usage : ./verify.sh chemin/vers/sortie.pdf
#
# Verifie :
#  1. La police Luciole est bien embarquee (strings | grep -i luciole)
#  2. Le texte est extractible (pas une image) -- via pypdf (pdftotext non
#     disponible par defaut sur macOS ; a defaut, installer poppler
#     `brew install poppler` et remplacer la section pypdf ci-dessous par
#     `pdftotext "$PDF" -`).
#  3. Aucune URL http(s) chargee comme ressource dans l'outil HTML lui-meme
#     (seul le lien de credit vers luciole-vision.com est tolere).
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 chemin/vers/sortie.pdf [chemin/vers/adaptateur-pdf-luciole.html]"
  exit 2
fi

PDF="$1"
HTML="${2:-$(cd "$(dirname "$0")/.." && pwd)/adaptateur-pdf-luciole.html}"
FAIL=0

echo "=== 1. Police Luciole embarquee ==="
if strings "$PDF" | grep -qi luciole; then
  echo "OK : la chaine 'Luciole' est presente dans le PDF (police embarquee)."
else
  echo "ECHEC : aucune trace de la police Luciole dans le PDF."
  FAIL=1
fi

echo
echo "=== 2. Texte extractible (vrai texte, pas une image) ==="
python3 - "$PDF" <<'EOF'
import sys
try:
    from pypdf import PdfReader
except ImportError:
    print("ECHEC : le module pypdf n'est pas installe (pip install pypdf).")
    sys.exit(1)

r = PdfReader(sys.argv[1])
total = 0
for p in r.pages:
    total += len((p.extract_text() or "").strip())
print(f"Caracteres extraits sur {len(r.pages)} page(s) : {total}")
if total < 20:
    print("ECHEC : quasiment aucun texte extractible.")
    sys.exit(1)
print("OK : le texte est extractible (vrai texte, pas une image).")
EOF
if [ $? -ne 0 ]; then FAIL=1; fi

echo
echo "=== 3. Aucune ressource externe chargee dans l'outil HTML ==="
if [ -f "$HTML" ]; then
  URLS=$(grep -oE 'https?://[^"'"'"' )]+' "$HTML" | sort -u || true)
  echo "URL(s) trouvee(s) dans le fichier :"
  echo "$URLS"
  BAD=$(echo "$URLS" | grep -v '^https://www.luciole-vision.com/$' || true)
  if [ -n "$BAD" ]; then
    echo "ECHEC : URL(s) suspecte(s) au-dela du lien de credit Luciole :"
    echo "$BAD"
    FAIL=1
  else
    echo "OK : seul le lien de credit vers luciole-vision.com est present (jamais charge, lien de documentation uniquement)."
  fi
else
  echo "ATTENTION : fichier HTML introuvable ($HTML), etape ignoree."
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "=== TOUS LES CONTROLES AUTOMATISES SONT PASSES ==="
else
  echo "=== AU MOINS UN CONTROLE A ECHOUE ==="
fi
exit $FAIL
