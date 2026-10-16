# PDF fixture corpus

Inputs for `verify-pdf` (`.claude/skills/verify-pdf/`) and for PDF feature tests.

**Provenance and licence:** every file here is synthetic. They were made by
`generate.py` in this folder with reportlab, pypdf, Pillow and qpdf. No third-party
content is included, and the files are dedicated to the public domain (CC0-1.0).
Each file is at most 5 MB.

| File | Pages | What it exercises |
|------|------:|-------------------|
| `tiny.pdf` | 1 | Smallest valid document (Letter). |
| `10p.pdf` | 10 | Multi-page text (A4), "Page n of 10" on each page. |
| `50p.pdf` | 50 | Larger document for split, merge and performance work. |
| `scanned.pdf` | 2 | Image-only pages (150 dpi JPEG with noise and a slight skew), no text layer. |
| `encrypted.pdf` | 2 | AES-256 with an empty user password and owner password `inkly-owner`. |
| `encrypted-objstm.pdf` | 1 | `tiny.pdf` encrypted by qpdf (AES-256, empty user password) with the page tree in object streams, as most real protected PDFs are. |
| `forms.pdf` | 1 | AcroForm with text fields `full_name` and `email` and the checkbox `agree`. |
| `rotated.pdf` | 3 | Page `/Rotate` values 0, 90 and 270. |
| `huge-image.pdf` | 1 | One 8000×6000 px JPEG on a 960×720 pt page. |
| `malformed.pdf` | n/a | `tiny.pdf` with a corrupted `/Length` key and its xref and trailer removed. `qpdf --check` must flag it. |

`expectations.json` records what `verify-pdf --corpus` checks for each file.
`valid: false` means the file is expected to fail.

To change the corpus, edit `generate.py`, run `python3 fixtures/pdfs/generate.py`,
update `expectations.json` and this table, then run
`.claude/skills/verify-pdf/run.sh --corpus fixtures/pdfs`.
