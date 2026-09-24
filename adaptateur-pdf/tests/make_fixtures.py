#!/usr/bin/env python3
"""
Fabrique les fixtures de test (Phase 5 du plan) avec fpdf2.
Textes en francais naturel (evite les faux positifs du filtre anti-charabia,
cf. ADDENDUM 3, qui reagit mal a des textes trop courts/techniques).
"""
import pathlib
from fpdf import FPDF

HERE = pathlib.Path(__file__).parent
FIXDIR = HERE / "fixtures"
FIXDIR.mkdir(exist_ok=True)

PARA1 = ("Il etait une fois, dans un petit village au bord de la mer, une famille qui "
         "aimait par-dessus tout se retrouver autour d'un bon repas. Chaque dimanche, "
         "la maison se remplissait de rires et de bonnes odeurs de pain frais.")
PARA2 = ("Les enfants du village adoraient jouer dans les ruelles etroites, courant "
         "entre les maisons colorees. Le soir venu, ils rentraient chez eux, fatigues "
         "mais heureux, pour raconter leurs aventures a leurs parents attentifs.")
PARA3 = ("Cette histoire nous rappelle combien il est important de prendre le temps "
         "de partager de bons moments en famille, loin de l'agitation quotidienne, "
         "pour construire des souvenirs qui dureront toute une vie.")


def fixture_1_hierarchie():
    """H1/H2/H3, gras, italique, liste a puces."""
    pdf = FPDF(format='A4', unit='mm')
    pdf.set_auto_page_break(True, margin=20)
    pdf.add_page()
    pdf.set_font('Helvetica', 'B', 22)
    pdf.multi_cell(0, 12, "Le grand voyage de la famille Dupont")
    pdf.ln(2)
    pdf.set_font('Helvetica', 'B', 16)
    pdf.multi_cell(0, 9, "Chapitre premier : le depart")
    pdf.ln(1)
    pdf.set_font('Helvetica', '', 12)
    pdf.multi_cell(0, 7, PARA1)
    pdf.ln(2)
    pdf.set_font('Helvetica', 'B', 13)
    pdf.multi_cell(0, 8, "Les preparatifs")
    pdf.ln(1)
    pdf.set_font('Helvetica', '', 12)
    pdf.multi_cell(0, 7, PARA2)
    pdf.ln(2)
    pdf.set_font('Helvetica', '', 12)
    txt = pdf.text_width if hasattr(pdf, 'text_width') else None
    pdf.write(7, "Avant le grand depart, la famille devait ")
    pdf.set_font('Helvetica', 'BI', 12)
    pdf.write(7, "absolument")
    pdf.set_font('Helvetica', '', 12)
    pdf.write(7, " preparer les bagages. Voici la liste :\n")
    pdf.ln(3)
    pdf.set_font('Helvetica', '', 12)
    for item in ["Des vetements pour une semaine", "Le vieux chapeau de grand-pere",
                 "Un panier de fruits frais", "La carte au tresor dessinee par Leo"]:
        pdf.set_x(20)
        pdf.multi_cell(0, 7, "- " + item)
    pdf.ln(2)
    pdf.set_font('Helvetica', 'B', 16)
    pdf.multi_cell(0, 9, "Chapitre deux : la route")
    pdf.ln(1)
    pdf.set_font('Helvetica', '', 12)
    pdf.multi_cell(0, 7, PARA3)
    pdf.output(str(FIXDIR / "01-hierarchie-styles-listes.pdf"))


def fixture_2_deux_colonnes():
    """Document deux colonnes (ordre de lecture)."""
    pdf = FPDF(format='A4', unit='mm')
    pdf.add_page()
    pdf.set_font('Helvetica', 'B', 16)
    pdf.multi_cell(0, 9, "Journal du village")
    pdf.ln(2)
    col_w = 85
    left_x, right_x = 15, 110
    y0 = pdf.get_y()
    pdf.set_xy(left_x, y0)
    pdf.set_font('Helvetica', '', 11)
    pdf.multi_cell(col_w, 6, "Colonne gauche.\n\n" + PARA1 + " " + PARA2)
    pdf.set_xy(right_x, y0)
    pdf.multi_cell(col_w, 6, "Colonne droite.\n\n" + PARA3 + " " + PARA1)
    pdf.output(str(FIXDIR / "02-deux-colonnes.pdf"))


def fixture_4_entete_pied():
    """En-tete et pied de page repetes sur plusieurs pages (bruit a supprimer)."""
    pdf = FPDF(format='A4', unit='mm')
    pdf.set_auto_page_break(True, margin=25)

    def header_footer(p):
        p.set_font('Helvetica', '', 9)
        p.set_xy(15, 10)
        p.cell(0, 5, "Bulletin municipal - Edition speciale", align='C')

    for i in range(1, 4):
        pdf.add_page()
        header_footer(pdf)
        pdf.set_xy(15, 25)
        pdf.set_font('Helvetica', 'B', 14)
        pdf.multi_cell(0, 8, f"Article {i}")
        pdf.set_x(15)
        pdf.set_font('Helvetica', '', 12)
        pdf.multi_cell(0, 7, PARA1 + " " + PARA2 + " " + PARA3)
        pdf.set_xy(15, 280)
        pdf.set_font('Helvetica', '', 9)
        pdf.cell(0, 5, f"Page {i}", align='C')
    pdf.output(str(FIXDIR / "04-entete-pied-repetes.pdf"))


def fixture_6_page_dense():
    """Une seule page tres dense (verifie la pagination en sortie)."""
    pdf = FPDF(format='A4', unit='mm')
    pdf.add_page()
    pdf.set_font('Helvetica', '', 10)
    long_text = (PARA1 + " " + PARA2 + " " + PARA3 + " ") * 8
    pdf.multi_cell(0, 5, long_text)
    pdf.output(str(FIXDIR / "06-page-unique-dense.pdf"))


def fixture_5_avec_images():
    """PDF avec une image (extraction + pagination)."""
    from PIL import Image, ImageDraw
    img_path = FIXDIR / "_tmp_illustration.png"
    img = Image.new('RGB', (600, 400), (210, 230, 250))
    d = ImageDraw.Draw(img)
    d.ellipse((150, 80, 450, 320), fill=(250, 200, 80), outline=(0, 0, 0), width=4)
    d.text((220, 190), "Illustration", fill=(0, 0, 0))
    img.save(img_path)

    pdf = FPDF(format='A4', unit='mm')
    pdf.add_page()
    pdf.set_font('Helvetica', 'B', 16)
    pdf.multi_cell(0, 9, "Le tresor du village")
    pdf.ln(2)
    pdf.set_font('Helvetica', '', 12)
    pdf.multi_cell(0, 7, PARA1)
    pdf.ln(3)
    pdf.image(str(img_path), x=40, w=130)
    pdf.ln(3)
    pdf.set_font('Helvetica', '', 12)
    pdf.multi_cell(0, 7, PARA2 + " " + PARA3)
    pdf.output(str(FIXDIR / "05-avec-images.pdf"))
    img_path.unlink()


def fixture_3_scan():
    """Simule un scan : le texte est rendu comme une IMAGE dans le PDF (pas de
    couche texte native exploitable), pour forcer le chemin OCR."""
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new('RGB', (1654, 2339), 'white')  # A4 a 200dpi environ
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 42)
    except Exception:
        font = ImageFont.load_default()
    text = (
        "Le vieux moulin\n\n"
        "Au bout du chemin qui longe la riviere se dressait un vieux moulin de pierre.\n"
        "Les enfants du village racontaient que le meunier y cachait un tresor secret,\n"
        "enferme depuis des annees dans une caisse en bois sculpte.\n\n"
        "Un matin d'ete, Camille et son frere Theo deciderent d'aller voir par eux-memes.\n"
        "Ils marcherent longtemps sous le soleil, traversant des champs de ble dore,\n"
        "avant d'apercevoir enfin la silhouette familiere du vieux moulin.\n\n"
        "La porte grincait doucement dans le vent. A l'interieur, la poussiere dansait\n"
        "dans les rayons de lumiere qui traversaient les planches disjointes du toit."
    )
    d.multiline_text((100, 100), text, fill='black', font=font, spacing=28)
    img_path = FIXDIR / "_tmp_scan.png"
    img.save(img_path)

    pdf = FPDF(format='A4', unit='mm')
    pdf.add_page()
    pdf.image(str(img_path), x=0, y=0, w=210, h=297)
    pdf.output(str(FIXDIR / "03-scan-page-image.pdf"))
    img_path.unlink()


def fixture_7_mascottes():
    """v0.3 (E6/T2) : tableau dont les en-tetes portent une petite image
    (mascotte ~30 pt) a cote du libelle -- les images de moins de 53 pt
    etaient jetees. Utilise fpdf2 + PIL (images bitmap)."""
    from PIL import Image, ImageDraw
    paths = []
    for i, col in enumerate([(230, 90, 60), (60, 140, 220), (90, 180, 90)]):
        img = Image.new('RGB', (120, 120), 'white')
        d = ImageDraw.Draw(img)
        d.ellipse((10, 10, 110, 110), fill=col, outline=(0, 0, 0), width=4)
        d.ellipse((35, 40, 50, 55), fill=(0, 0, 0)); d.ellipse((70, 40, 85, 55), fill=(0, 0, 0))
        pth = FIXDIR / f"_tmp_mascotte{i}.png"
        img.save(pth)
        paths.append(pth)
    pdf = FPDF(format='A4', unit='pt')
    pdf.add_page()
    pdf.set_font('Helvetica', 'B', 16)
    pdf.set_xy(56, 60)
    pdf.cell(0, 20, "Les classes de mots")
    x0, y0, cw, rh = 56, 110, 160, 40
    labels = ["Determinant", "Nom", "Adjectif"]
    # Grille en TRAITS (comme les fiches du corpus), pas en rectangles.
    for r in range(4):
        pdf.line(x0, y0 + r * rh, x0 + 3 * cw, y0 + r * rh)
    for c in range(4):
        pdf.line(x0 + c * cw, y0, x0 + c * cw, y0 + 3 * rh)
    for c in range(3):
        pdf.image(str(paths[c]), x=x0 + c * cw + 6, y=y0 + 5, w=30, h=30)
        pdf.set_font('Helvetica', 'B', 12)
        pdf.set_xy(x0 + c * cw + 42, y0 + 12)
        pdf.cell(100, 16, labels[c])
    rows = [["le", "chat", "noir"], ["une", "maison", "grande"]]
    pdf.set_font('Helvetica', '', 12)
    for r, row in enumerate(rows, start=1):
        for c, txt in enumerate(row):
            pdf.set_xy(x0 + c * cw + 8, y0 + r * rh + 12)
            pdf.cell(100, 16, txt)
    pdf.set_xy(56, 260)
    pdf.multi_cell(480, 16, PARA1)
    pdf.output(str(FIXDIR / "07-mascottes.pdf"))
    for pth in paths:
        pth.unlink()


def fixtures_erreur():
    """Fixtures d'erreur citees par le README : PDF protege par mot de
    passe, fichier corrompu. Verifiees par v03-navigateur.mjs (message
    d'erreur explicite, pas de plantage)."""
    (FIXDIR / "erreur-corrompu.pdf").write_bytes(b"%PDF-1.4\n" + b"\x00\xff ceci n'est pas un PDF " * 40)
    try:
        pdf = FPDF(format='A4', unit='mm')
        pdf.set_encryption(owner_password="proprietaire", user_password="secret")
        pdf.add_page()
        pdf.set_font('Helvetica', '', 12)
        pdf.multi_cell(0, 7, PARA1)
        pdf.output(str(FIXDIR / "erreur-mot-de-passe.pdf"))
    except Exception as e:  # chiffrement indisponible (module cryptography absent)
        print("  (fixture mot de passe non generee :", e, ")")


if __name__ == "__main__":
    fixture_1_hierarchie()
    fixture_2_deux_colonnes()
    fixture_3_scan()
    fixture_4_entete_pied()
    fixture_5_avec_images()
    fixture_6_page_dense()
    fixture_7_mascottes()
    fixtures_erreur()
    # Fixtures du plan v0.3 : une par defaut du diagnostic (PDF brut, sans
    # dependance, cf. fixtures_v03.py).
    import fixtures_v03
    fixtures_v03.generer(FIXDIR)
    print("Fixtures generees dans", FIXDIR)
    for f in sorted(FIXDIR.glob("*.pdf")):
        print(" -", f.name, f.stat().st_size, "octets")
