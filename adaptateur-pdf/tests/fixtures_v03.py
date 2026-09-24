#!/usr/bin/env python3
"""
Fixtures synthetiques du plan v0.3 : chacune reproduit UN defaut du
diagnostic (docs/DIAGNOSTIC-v0.3.md, local) avec le meme MECANISME que dans
les fiches du corpus, sans en reprendre le texte (les fiches sont des
oeuvres protegees, cf. README racine). Textes inventes.

Ecrites en PDF "brut" (flux de contenu a la main, polices standard
Helvetica/ZapfDingbats) plutot qu'avec fpdf2 : il faut maitriser exactement
les operateurs emis (q/Q autour d'un remplissage, espaces absentes entre
deux items, exposant decale, trait pointille par setdash...), ce que fpdf2
ne garantit pas. Aucune dependance hors bibliotheque standard.

Appele par make_fixtures.py ; utilisable seul : python3 fixtures_v03.py
"""
import pathlib
import zlib

A4 = (595.28, 841.89)


def _esc(s):
    # Chaine PDF litterale, encodage WinAnsi (cp1252) pour Helvetica.
    b = s.encode('cp1252')
    out = b''
    for ch in b:
        c = bytes([ch])
        if c in (b'(', b')', b'\\'):
            out += b'\\' + c
        else:
            out += c
    return b'(' + out + b')'


class PdfBrut:
    """Ecrivain PDF minimal : pages A4, polices standard, texte positionne,
    traits, rectangles, pointilles. Coordonnees en points, origine en bas a
    gauche (convention PDF)."""

    FONTS = {
        'F1': 'Helvetica', 'F2': 'Helvetica-Bold', 'F3': 'Helvetica-Oblique',
        'F4': 'Helvetica-BoldOblique', 'FZ': 'ZapfDingbats',
    }

    def __init__(self, size=A4):
        self.size = size
        self.pages = []
        self.ops = None

    def add_page(self, size=None):
        self.ops = []
        self.pages.append((size or self.size, self.ops))

    def raw(self, s):
        self.ops.append(s.encode('latin-1') if isinstance(s, str) else s)

    # --- texte -------------------------------------------------------------
    def text(self, x, y, s, font='F1', size=12, color=(0, 0, 0), rise=0):
        """Un item de texte (un Tj) a la position (x, y) de ligne de base.
        `color=None` : n'emet AUCUN operateur de couleur (l'etat graphique
        courant s'applique -- necessaire pour reproduire R2). Par defaut,
        noir explicite (la couleur de remplissage persiste d'un BT a
        l'autre en PDF : sans operateur, un texte herite de la precedente)."""
        parts = [b'BT']
        if color is not None:
            parts.append(('%.3f %.3f %.3f rg' % tuple(color)).encode())
        parts.append(('/%s %.2f Tf' % (font, size)).encode())
        parts.append(('1 0 0 1 %.2f %.2f Tm' % (x, y + rise)).encode())
        if font == 'FZ':
            lit = b'(' + s.encode('latin-1').replace(b'\\', b'\\\\').replace(b'(', b'\\(').replace(b')', b'\\)') + b')'
        else:
            lit = _esc(s)
        parts.append(lit + b' Tj')
        parts.append(b'ET')
        self.ops.append(b' '.join(parts))

    def runs(self, x, y, parts, size=12):
        """Plusieurs runs dans UN SEUL objet texte, enchaines par le
        positionnement automatique du PDF (comme un traitement de texte) :
        `parts` = liste de (texte, police, couleur, decalage_vertical,
        corps) ou d'entiers (ajustement TJ en milliemes d'em, negatif =
        espace sans caractere espace -- mecanisme de W2)."""
        ops = [b'BT', ('1 0 0 1 %.2f %.2f Tm' % (x, y)).encode()]
        for part in parts:
            if isinstance(part, (int, float)):
                ops.append(('[%d] TJ' % part).encode())
                continue
            txt, font, color, rise, sz = (list(part) + [None] * 5)[:5]
            font = font or 'F1'
            color = (0, 0, 0) if color is None else color
            ops.append(('%.3f %.3f %.3f rg /%s %.2f Tf %.2f Ts' % (*color, font, sz or size, rise or 0)).encode())
            ops.append(_esc(txt) + b' Tj')
        ops.append(b'0 Ts ET')
        self.ops.append(b' '.join(ops))

    def text_rot(self, x, y, s, size=12, font='F1'):
        """Texte pivote de 90 degres (lecture de bas en haut)."""
        self.ops.append(b'BT /' + font.encode() + (' %.2f Tf 0 1 -1 0 %.2f %.2f Tm ' % (size, x, y)).encode() + _esc(s) + b' Tj ET')

    # --- formes --------------------------------------------------------------
    def fill_rect(self, x, y, w, h, color, wrap_q=True):
        s = '%.3f %.3f %.3f rg %.2f %.2f %.2f %.2f re f' % (*color, x, y, w, h)
        self.raw('q ' + s + ' Q' if wrap_q else s)

    def stroke_rect(self, x, y, w, h, color=(0, 0, 0), width=1):
        self.raw('q %.3f %.3f %.3f RG %.2f w %.2f %.2f %.2f %.2f re S Q' % (*color, width, x, y, w, h))

    def line(self, x0, y0, x1, y1, color=(0, 0, 0), width=0.75, dash=None):
        d = ('[%s] 0 d ' % ' '.join('%g' % v for v in dash)) if dash else ''
        self.raw('q %.3f %.3f %.3f RG %.2f w %s%.2f %.2f m %.2f %.2f l S Q' % (*color, width, d, x0, y0, x1, y1))

    def dashes(self, x0, x1, y, dash=4, gap=3, color=(0, 0, 0), width=0.75):
        """Pointille dessine en SEGMENTS SEPARES (un trace par tiret), autre
        facon courante de dessiner une ligne de decoupe."""
        x = x0
        while x < x1:
            self.line(x, y, min(x + dash, x1), y, color=color, width=width)
            x += dash + gap

    def circle(self, cx, cy, r, color):
        k = 0.5523 * r
        self.raw('q %.3f %.3f %.3f rg %.2f %.2f m %.2f %.2f %.2f %.2f %.2f %.2f c %.2f %.2f %.2f %.2f %.2f %.2f c '
                 '%.2f %.2f %.2f %.2f %.2f %.2f c %.2f %.2f %.2f %.2f %.2f %.2f c f Q' % (
                     *color, cx + r, cy,
                     cx + r, cy + k, cx + k, cy + r, cx, cy + r,
                     cx - k, cy + r, cx - r, cy + k, cx - r, cy,
                     cx - r, cy - k, cx - k, cy - r, cx, cy - r,
                     cx + k, cy - r, cx + r, cy - k, cx + r, cy))

    # --- sortie --------------------------------------------------------------
    def save(self, path):
        objs = []

        def add(body):
            objs.append(body)
            return len(objs)

        # ZapfDingbats : ToUnicode explicite (comme le font les PDF reels a
        # polices embarquees), sinon pdf.js rend le code brut ("V" pour
        # l'etoile) au lieu du caractere Unicode.
        cmap = (b'/CIDInit /ProcSet findresource begin 12 dict begin begincmap '
                b'/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def '
                b'/CMapName /Zapf-UCS def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange '
                b'4 beginbfchar <22> <2702> <24> <2704> <56> <2736> <DC> <279C> endbfchar '
                b'endcmap CMapName currentdict /CMap defineresource pop end end')
        tu = add(b'<< /Length %d >>\nstream\n' % len(cmap) + cmap + b'\nendstream')
        font_ids = {}
        for key, base in self.FONTS.items():
            enc = (b' /ToUnicode %d 0 R' % tu) if base == 'ZapfDingbats' else b' /Encoding /WinAnsiEncoding'
            font_ids[key] = add(b'<< /Type /Font /Subtype /Type1 /BaseFont /' + base.encode() + enc + b' >>')
        font_dict = b'<< ' + b' '.join(('/%s %d 0 R' % (k, v)).encode() for k, v in font_ids.items()) + b' >>'
        pages_id_placeholder = len(objs) + 1 + 2 * len(self.pages)
        page_ids = []
        for (w, h), ops in self.pages:
            content = zlib.compress(b'\n'.join(ops))
            cid = add(b'<< /Length %d /Filter /FlateDecode >>\nstream\n' % len(content) + content + b'\nendstream')
            pid = add(('<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %.2f %.2f] /Contents %d 0 R /Resources << /Font '
                       % (pages_id_placeholder, w, h, cid)).encode() + font_dict + b' >> >>')
            page_ids.append(pid)
        pages_id = add(('<< /Type /Pages /Count %d /Kids [%s] >>' % (
            len(page_ids), ' '.join('%d 0 R' % p for p in page_ids))).encode())
        assert pages_id == pages_id_placeholder
        cat = add(('<< /Type /Catalog /Pages %d 0 R >>' % pages_id).encode())

        out = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
        offsets = []
        for i, body in enumerate(objs, start=1):
            offsets.append(len(out))
            out += b'%d 0 obj\n' % i + body + b'\nendobj\n'
        xref = len(out)
        out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objs) + 1)
        for off in offsets:
            out += b'%010d 00000 n \n' % off
        out += b'trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objs) + 1, cat, xref)
        pathlib.Path(path).write_bytes(bytes(out))


PROSE = ("Chaque matin, les enfants traversent la place du marche pour aller a l'ecole. "
         "Ils saluent le boulanger, observent les pigeons et comptent les voitures rouges.")


def paragraphe(pdf, x, y, texte, largeur_car=80, size=12, interligne=15, font='F1', color=(0, 0, 0)):
    """Ecrit un paragraphe en lignes coupees a `largeur_car` caracteres
    (coupure aux espaces). Retourne l'ordonnee sous la derniere ligne."""
    mots = texte.split()
    ligne = ''
    for m in mots:
        if len(ligne) + len(m) + 1 > largeur_car and ligne:
            pdf.text(x, y, ligne, font=font, size=size, color=color)
            y -= interligne
            ligne = m
        else:
            ligne = (ligne + ' ' + m).strip()
    if ligne:
        pdf.text(x, y, ligne, font=font, size=size, color=color)
        y -= interligne
    return y


# ----------------------------------------------------------------------------
# R2 (pile graphique sans couleur) + C1/X1 (contraste des couleurs source)
def f_couleurs(d):
    pdf = PdfBrut(); pdf.add_page()
    pdf.text(56, 780, 'Les couleurs de la fiche', font='F2', size=18, color=(0.57, 0.80, 0.77))  # vert d'eau pale (C1)
    y = paragraphe(pdf, 56, 750, PROSE, color=(0, 0, 0))
    # R2 : case-reponse bleu clair remplie DANS un q...Q, puis texte SANS
    # operateur de couleur : l'etat restaure est le noir, le texte est noir.
    pdf.fill_rect(56, y - 4, 14, 14, (0.85, 0.92, 0.96))
    pdf.text(76, y, 'Cette phrase est ecrite en noir dans la source, a cote de la case bleue.', size=12, color=None)
    y -= 30
    pdf.text(56, y, 'Et celle-ci aussi, elle doit rester parfaitement lisible.', size=12, color=None)
    y -= 30
    # X1 : trou en couleur pale (points de suspension teal pale)
    teal = (0.573, 0.804, 0.773)
    pdf.runs(56, y, [('Complete le mot : la s',), ('\u2026\u2026', None, teal), ('r de mon amie.',)])
    y -= 30
    # X1 : ligne de trous seule (ligne a completer), meme teal pale
    pdf.text(56, y, '\u2026' * 20, size=12, color=teal)
    y -= 30
    # M5 : terminaisons colorees (orange pale, en gras : pdf.js ne coupe ses
    # items qu'aux changements de police, pas de couleur) dans un texte noir
    orange = (0.96, 0.62, 0.25)
    pdf.runs(56, y, [('nous chant',), ('ons', 'F2', orange), (' et vous chant',), ('ez', 'F2', orange),
                     (' souvent le matin.',)])
    pdf.save(d / 'v3-couleurs.pdf')


# R4 : glyphes absents de Luciole (ZapfDingbats : etoile, fleche, ciseaux)
def f_glyphes(d):
    pdf = PdfBrut(); pdf.add_page()
    pdf.text(56, 780, 'Exercices de niveau', font='F2', size=16)
    pdf.text(56, 750, 'Niveau 1 (', size=12)
    pdf.text(56 + 55, 750, '\x56', font='FZ', size=12)      # U+2736 etoile a six branches
    pdf.text(56 + 66, 750, ')', size=12)
    pdf.text(56, 725, 'Niveau 2 (', size=12)
    pdf.text(56 + 55, 725, '\x56\x56', font='FZ', size=12)
    pdf.text(56 + 77, 725, ')', size=12)
    pdf.text(56, 700, 'Le chat', size=12)
    pdf.text(56 + 42, 700, '\xdc', font='FZ', size=12)       # U+279C fleche
    pdf.text(56 + 58, 700, 'les chats', size=12)
    pdf.text(40, 660, '\x22', font='FZ', size=12)            # U+2702 ciseaux
    pdf.dashes(56, 540, 664)
    paragraphe(pdf, 56, 630, PROSE)
    pdf.save(d / 'v3-glyphes.pdf')


# R5 : exposants (1re, 2e) poses plus haut et plus petits
def f_exposants(d):
    pdf = PdfBrut(); pdf.add_page()
    pdf.text(56, 780, 'Les nombres ordinaux', font='F2', size=16)
    y = 740
    pdf.runs(56, y, [('La 1',), ('re', None, None, 4.5, 7), (' personne du singulier et la 2',),
                     ('e', None, None, 4.5, 7), (' personne du pluriel.',)])
    paragraphe(pdf, 56, y - 30, PROSE)
    pdf.save(d / 'v3-exposants.pdf')


# E9 : italique et gras-italique dans la source
def f_italique(d):
    pdf = PdfBrut(); pdf.add_page()
    pdf.text(56, 780, 'Un exemple en italique', font='F2', size=16)
    pdf.text(56, 740, 'Ex. :', font='F2', size=12)
    pdf.text(90, 740, 'le chien court dans le jardin.', font='F3', size=12)
    pdf.text(56, 715, 'Attention :', font='F4', size=12)
    pdf.text(125, 715, 'ceci est important pour la suite.', font='F1', size=12)
    paragraphe(pdf, 56, 690, PROSE, font='F3')
    pdf.save(d / 'v3-italique.pdf')


# R1/W2 : runs et texte desynchronises (espace ajoutee au texte seul, espace
# de fin retiree du texte seul) sur une ligne scindee par des puces
# embarquees -- la cause racine des gels du corpus.
def f_runs(d):
    pdf = PdfBrut(); pdf.add_page()
    # W2 : titre en plusieurs items separes par un ecart, SANS caractere espace
    pdf.runs(56, 780, [('Conjuguer', 'F2'), -280, ('etre,', 'F4'), -280, ('avoir,', 'F2'), -280, ('aller', 'F2')], size=16)
    # R1 : ligne a puces embarquees, items sans espace, derniere espace isolee
    y = 740
    pdf.text(56, y, 'Materiel :', font='F2', size=12)
    pdf.text(120, y, '\u2022', size=12)
    pdf.text(130, y, 'un fouet', size=12, color=(0.2, 0.2, 0.6))
    pdf.text(185, y, '\u2022', size=12)
    pdf.text(195, y, 'un saladier', size=12)
    pdf.text(262, y, '\u2022', size=12)
    pdf.text(272, y, 'deux cuilleres', size=12, color=(0.6, 0.1, 0.1))
    pdf.text(352, y, ' ', size=12)
    # D3 : deux mini-colonnes sur la meme ligne, sans marqueur, espace de fin
    y -= 25
    pdf.text(56, y, 'Farine : 200 g', size=12)
    pdf.text(300, y, 'Sucre : 100 g', size=12, color=(0.1, 0.4, 0.1))
    pdf.text(378, y, ' ', size=12)
    paragraphe(pdf, 56, y - 30, PROSE)
    pdf.save(d / 'v3-runs.pdf')


# W1 : un mot en deux runs de couleurs differentes, sans espace
def f_mot_coupe(d):
    pdf = PdfBrut(); pdf.add_page()
    pdf.text(56, 780, 'Un mot en deux couleurs', font='F2', size=16)
    y = 740
    for i in range(14):
        # Place le mot "Exemple" (E colore + xemple noir) a des positions
        # variees dans la ligne pour que le retour a la ligne tombe dessus.
        avant = 'mot ' * (i % 7 + 3)
        pdf.runs(56, y, [(avant,), ('E', 'F2', (0.8, 0.1, 0.1)), ('xemple : la suite du texte continue ici.',)])
        y -= 16
    pdf.save(d / 'v3-mot-coupe.pdf')


# S6/X3 : faux tableaux (filets d'encadre, lignes d'ecriture pointillees,
# filet de titre) + UN vrai tableau quadrille.
def f_faux_tableaux(d):
    pdf = PdfBrut(); pdf.add_page()
    pdf.text(56, 790, 'Une page sans vrai tableau en haut', font='F2', size=16)
    pdf.line(56, 783, 540, 783, width=1)                                  # filet sous le titre
    paragraphe(pdf, 60, 760, PROSE)
    # Encadre dessine par 4 traits separes (pas un rectangle)
    pdf.line(50, 775, 545, 775); pdf.line(50, 725, 545, 725)
    pdf.line(50, 725, 50, 775); pdf.line(545, 725, 545, 775)
    pdf.text(56, 700, 'Recopie la phrase :', size=12)
    for i in range(4):                                                     # lignes d'ecriture
        pdf.line(56, 675 - i * 24, 540, 675 - i * 24, dash=[1, 2], color=(0.5, 0.5, 0.5))
    paragraphe(pdf, 56, 560, PROSE)
    # Un vrai tableau 3 colonnes x 3 rangees, bien quadrille
    x0, x1, ytop = 56, 440, 480
    cols = [56, 184, 312, 440]
    for r in range(4):
        pdf.line(x0, ytop - r * 22, x1, ytop - r * 22)
    for c in cols:
        pdf.line(c, ytop, c, ytop - 66)
    donnees = [['Noms', 'Verbes', 'Adjectifs'], ['chat', 'courir', 'grand'], ['maison', 'manger', 'petit']]
    for r, rangee in enumerate(donnees):
        for c, txt in enumerate(rangee):
            pdf.text(cols[c] + 6, ytop - r * 22 - 15, txt, size=11, font='F2' if r == 0 else 'F1')
    paragraphe(pdf, 56, 380, PROSE)
    pdf.save(d / 'v3-faux-tableaux.pdf')


# E1/S1/S2 : exemplaires identiques separes par des lignes de decoupe
def f_decoupe(d):
    pdf = PdfBrut(); pdf.add_page()
    pdf.text(56, 800, "Exercices d'entrainement", font='F2', size=14)
    exo1 = ['Exercice A. Souligne le verbe dans chaque phrase.',
            'Le chat dort sur le canape du salon.',
            'Les oiseaux chantent dans le grand arbre.']
    exo2 = ['Exercice B. Ecris le pluriel de chaque nom.',
            'un cheval, un journal, un animal.']
    y = 770
    for k in range(3):
        for i, l in enumerate(exo1):
            pdf.text(56, y, l, size=11, font='F2' if i == 0 else 'F1')
            y -= 16
        y -= 10
        # ligne de decoupe pleine largeur, pointillee (setdash), ciseaux a gauche
        pdf.line(10, y, 585, y, dash=[4, 3])
        pdf.text(14, y - 4, '\x22', font='FZ', size=10)
        y -= 24
    for k in range(2):
        for i, l in enumerate(exo2):
            pdf.text(56, y, l, size=11, font='F2' if i == 0 else 'F1')
            y -= 16
        y -= 10
        if k == 0:
            pdf.dashes(10, 585, y)                     # pointille en segments separes, sans ciseaux
            y -= 24
    pdf.save(d / 'v3-decoupe.pdf')


# E4/T1 : tableau de conjugaison large (colonne des pronoms + 6 verbes)
def f_tableau_large(d):
    pdf = PdfBrut(); pdf.add_page()
    pdf.text(56, 800, "Le futur de l'indicatif", font='F2', size=16)
    verbes = ['chanter', 'finir', 'prendre', 'voir', 'aller', 'faire']
    radicaux = ['chanter', 'finir', 'prendr', 'verr', 'ir', 'fer']
    pronoms = ['je / j\'', 'tu', 'il / elle / on', 'nous', 'vous', 'ils / elles']
    term = ['ai', 'as', 'a', 'ons', 'ez', 'ont']
    cols = [40] + [110 + i * 75 for i in range(7)]
    ytop, h = 760, 20
    for r in range(8):
        pdf.line(cols[0], ytop - r * h, cols[-1], ytop - r * h)
    for c in cols:
        pdf.line(c, ytop, c, ytop - 7 * h)
    for c, v in enumerate(verbes):
        pdf.text(cols[c + 1] + 4, ytop - 14, v, font='F2', size=9)
    for r, p in enumerate(pronoms):
        yy = ytop - (r + 1) * h - 14
        pdf.text(cols[0] + 3, yy, p, size=8)
        for c, rad in enumerate(radicaux):
            pro = p.split(' / ')[0]
            forme = ("j'" if (r == 0 and rad[0] in 'aeiou') else pro + ' ')
            pdf.runs(cols[c + 1] + 4, yy, [(forme + rad,), (term[r], 'F2', (0.85, 0.1, 0.1))], size=8)
    paragraphe(pdf, 56, 560, PROSE)
    pdf.save(d / 'v3-tableau-large.pdf')


# Point 3 du README : liste SANS puce (un item par ligne) + paragraphes
def f_liste_sans_puce(d):
    pdf = PdfBrut(); pdf.add_page()
    pdf.text(56, 790, 'Ma valise pour les vacances', font='F2', size=16)
    y = paragraphe(pdf, 56, 760, PROSE)
    y -= 10
    for item in ['brosse a dents', 'Pyjama', 'deux pulls chauds', 'lampe de poche', 'Livre de contes', 'maillot de bain']:
        pdf.text(56, y, item, size=12)
        y -= 15
    y -= 10
    paragraphe(pdf, 56, y, PROSE)
    pdf.save(d / 'v3-liste-sans-puce.pdf')


# E8/L2 : en-tete de collection + pastille de numero (chiffre blanc dans un
# disque colore)
def f_pastille(d):
    pdf = PdfBrut(); pdf.add_page()
    pdf.text(56, 800, 'Orthographe', font='F2', size=11, color=(0.1, 0.45, 0.45))
    # Chiffre centre dans le disque : sa ligne de base est plus haute que
    # celle de l'en-tete (au-dela du seuil de regroupement en ligne).
    pdf.circle(137, 808, 9, (0.95, 0.55, 0.15))
    pdf.text(134, 804, '7', font='F2', size=11, color=(1, 1, 1))
    pdf.text(56, 760, 'Les mots en -oir', font='F2', size=18)
    paragraphe(pdf, 56, 730, PROSE)
    pdf.save(d / 'v3-pastille.pdf')


# S1 : deux exercices DIFFERENTS cote a cote, separes par une ligne de
# decoupe verticale ; lignes a la meme hauteur des deux cotes.
def f_decoupe_verticale(d):
    pdf = PdfBrut(); pdf.add_page()
    pdf.text(56, 800, "Deux exercices cote a cote", font='F2', size=14)
    gauche = ['Exercice C. Entoure les noms.', 'le velo rouge', 'une petite fleur', 'des gateaux sucres']
    droite = ['Exercice D. Barre les intrus.', 'pomme poire chaise', 'lundi mardi table', 'bleu vert moto']
    for i, (g, dr) in enumerate(zip(gauche, droite)):
        pdf.text(40, 760 - i * 18, g, size=11, font='F2' if i == 0 else 'F1')
        pdf.text(320, 760 - i * 18, dr, size=11, font='F2' if i == 0 else 'F1')
    pdf.line(297, 30, 297, 790, dash=[4, 3])
    pdf.save(d / 'v3-decoupe-verticale.pdf')


# Point 3 / tableaux : une cellule dont le texte est coupe sur deux lignes
# par la largeur de colonne reste UN paragraphe.
def f_cellule_deux_lignes(d):
    pdf = PdfBrut(); pdf.add_page()
    pdf.text(56, 800, 'Une cellule sur deux lignes', font='F2', size=14)
    x0, xm, x1 = 56, 150, 540
    for yy in (770, 730, 690):
        pdf.line(x0, yy, x1, yy)
    for xx in (x0, xm, x1):
        pdf.line(xx, 770, xx, 690)
    pdf.text(62, 755, 'Exemple', font='F2', size=11)
    pdf.text(156, 755, 'Le chat noir dort sur le canape du salon pendant que la pluie', size=11)
    pdf.text(156, 741, 'tombe.', size=11)
    pdf.text(62, 715, 'Autre', font='F2', size=11)
    pdf.text(156, 715, 'Une phrase courte.', size=11)
    paragraphe(pdf, 56, 660, PROSE)
    pdf.save(d / 'v3-cellule-deux-lignes.pdf')


# Ordre de composition des matrices (`cm` imbriques) : une boite remplie
# dessinee sous translation PUIS mise a l'echelle doit etre lue a sa vraie
# place (x 100..300, y 100..200).
def f_matrices(d):
    pdf = PdfBrut(); pdf.add_page()
    pdf.text(56, 780, 'Deux transformations', font='F2', size=16)
    pdf.raw('q 1 0 0 1 100 100 cm 2 0 0 2 0 0 cm 0.85 0.92 0.80 rg 0 0 100 50 re f Q')
    pdf.text(110, 170, 'Texte dans la boite dessinee avec deux', size=11)
    pdf.text(110, 155, 'transformations successives.', size=11)
    paragraphe(pdf, 56, 740, PROSE)
    pdf.save(d / 'v3-matrices.pdf')


def generer(fixdir):
    d = pathlib.Path(fixdir)
    d.mkdir(exist_ok=True)
    for f in (f_couleurs, f_glyphes, f_exposants, f_italique, f_runs, f_mot_coupe,
              f_faux_tableaux, f_decoupe, f_tableau_large, f_liste_sans_puce, f_pastille, f_matrices,
              f_decoupe_verticale, f_cellule_deux_lignes):
        f(d)


if __name__ == '__main__':
    generer(pathlib.Path(__file__).parent / 'fixtures')
    print('Fixtures v0.3 generees.')
