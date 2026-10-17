"""Regenerates the verify-pdf fixture corpus. Run from the repo root:

    python3 fixtures/pdfs/generate.py

Needs reportlab, pypdf and Pillow. The committed PDFs are the source of truth;
rerun this only to add or change a fixture, then update expectations.json.
"""
import io
import os
import random
import subprocess

from PIL import Image, ImageDraw, ImageFilter
from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import A4, letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

OUT = os.path.dirname(os.path.abspath(__file__))


def path(name):
    return os.path.join(OUT, name)


def text_pdf(pages, size=A4, label="Inkly fixture"):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=size, invariant=1)
    w, h = size
    for n in range(1, pages + 1):
        c.setFont("Helvetica-Bold", 24)
        c.drawString(72, h - 108, label)
        c.setFont("Helvetica", 14)
        c.drawString(72, h - 140, f"Page {n} of {pages}")
        c.rect(72, 72, w - 144, h - 260)
        c.showPage()
    c.save()
    return buf.getvalue()


def write(name, data):
    with open(path(name), "wb") as f:
        f.write(data)


def tiny():
    write("tiny.pdf", text_pdf(1, letter, "Inkly tiny fixture"))


def multi(n):
    write(f"{n}p.pdf", text_pdf(n, A4, f"Inkly {n}-page fixture"))


def scanned():
    rng = random.Random(42)
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter, invariant=1)
    w, h = letter
    for n in range(1, 3):
        img = Image.new("L", (1275, 1650), 245)  # 150 dpi letter
        d = ImageDraw.Draw(img)
        for line in range(30):
            y = 150 + line * 45
            d.text((150, y), f"Scanned page {n}, line {line + 1}: the quick brown fox", fill=30)
        for _ in range(4000):
            d.point((rng.randrange(1275), rng.randrange(1650)), fill=rng.randrange(120, 230))
        img = img.rotate(0.6, fillcolor=245).filter(ImageFilter.GaussianBlur(0.6))
        jpg = io.BytesIO()
        img.save(jpg, "JPEG", quality=60)
        jpg.seek(0)
        c.drawImage(ImageReader(jpg), 0, 0, w, h)
        c.showPage()
    c.save()
    write("scanned.pdf", buf.getvalue())


def encrypted():
    reader = PdfReader(io.BytesIO(text_pdf(2, A4, "Inkly encrypted fixture")))
    writer = PdfWriter(clone_from=reader)
    # Empty user password: opens without a prompt, but edits need the owner password.
    writer.encrypt(user_password="", owner_password="inkly-owner", algorithm="AES-256")
    buf = io.BytesIO()
    writer.write(buf)
    write("encrypted.pdf", buf.getvalue())


def encrypted_objstm():
    # Like most real-world protected PDFs (government forms, statements): AES-256 with an
    # empty user password and the page tree inside encrypted object streams.
    subprocess.run(
        ["qpdf", "--object-streams=generate", "--encrypt", "", "inkly-owner", "256",
         "--modify=none", "--", path("tiny.pdf"), path("encrypted-objstm.pdf")],
        check=True,
    )


def forms():
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter, invariant=1)
    c.setFont("Helvetica-Bold", 20)
    c.drawString(72, 700, "Inkly forms fixture")
    c.setFont("Helvetica", 12)
    c.drawString(72, 650, "Full name")
    c.acroForm.textfield(name="full_name", x=180, y=640, width=300, height=22, value="")
    c.drawString(72, 600, "Email")
    c.acroForm.textfield(name="email", x=180, y=590, width=300, height=22, value="")
    c.drawString(72, 550, "I agree")
    c.acroForm.checkbox(name="agree", x=180, y=545, size=18, checked=False)
    c.showPage()
    c.save()
    write("forms.pdf", buf.getvalue())


def rotated():
    reader = PdfReader(io.BytesIO(text_pdf(3, A4, "Inkly rotated fixture")))
    writer = PdfWriter()
    for page, angle in zip(reader.pages, [0, 90, 270]):
        writer.add_page(page)
        if angle:
            writer.pages[-1].rotate(angle)
    buf = io.BytesIO()
    writer.write(buf)
    write("rotated.pdf", buf.getvalue())


def huge_image():
    # 8000x6000 px image on one page: stresses render and memory, stays under 5 MB.
    w, h = 8000, 6000
    img = Image.linear_gradient("L").resize((w, h)).convert("RGB")
    d = ImageDraw.Draw(img)
    for i in range(0, w, 400):
        d.line([(i, 0), (w - i, h)], fill=(200, 60, 60), width=12)
    jpg = io.BytesIO()
    img.save(jpg, "JPEG", quality=75)
    jpg.seek(0)
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(w * 72 / 600, h * 72 / 600), invariant=1)
    c.drawImage(ImageReader(jpg), 0, 0, w * 72 / 600, h * 72 / 600)
    c.showPage()
    c.save()
    write("huge-image.pdf", buf.getvalue())


def malformed():
    data = bytearray(text_pdf(1, letter, "Inkly malformed fixture"))
    # Corrupt the page content stream length and drop the xref table and trailer.
    i = data.index(b"/Length ")
    data[i : i + 8] = b"/Lxngth "
    cut = data.rindex(b"xref")
    write("malformed.pdf", bytes(data[:cut]) + b"%%EOF\n")


if __name__ == "__main__":
    tiny()
    multi(10)
    multi(50)
    scanned()
    encrypted()
    encrypted_objstm()
    forms()
    rotated()
    huge_image()
    malformed()
    for f in sorted(os.listdir(OUT)):
        if f.endswith(".pdf"):
            print(f"{f:16} {os.path.getsize(path(f)):>9} bytes")
