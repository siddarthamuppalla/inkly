---
name: verify-pdf
description: Check that a PDF is structurally valid and has the expected pages, sizes, rotation and appearance. Use after any change that produces or edits PDFs, and in CI on the fixture corpus.
---

# verify-pdf

Correctness gate for every PDF-producing feature (`docs/factory/04_VERIFICATION.md`).
Paste its output into the PR's Verification Evidence block.

## When to run it
- After building or changing anything that writes PDF bytes (merge, split, rotate,
  compress, fill, sign, export): run it on the output with `--expect-pages`, and with
  `--golden` when the visual result matters.
- After changing `fixtures/pdfs/`: run `--corpus fixtures/pdfs`.
- CI runs `--corpus fixtures/pdfs` on every PR.

## Requirements
`qpdf` and `poppler-utils` (`pdfinfo`, `pdftoppm`) on PATH, Node 22, and `pnpm i`
already run. On Ubuntu: `sudo apt-get install -y qpdf poppler-utils`.

## Usage
```
.claude/skills/verify-pdf/run.sh <file.pdf> [--expect-pages N] [--golden DIR [--threshold PCT] [--update-golden]]
.claude/skills/verify-pdf/run.sh --corpus DIR
```

For a single file it runs `qpdf --check` and prints `qpdf ok`, the page count, and each
page's size in points and its rotation. Any qpdf error **or warning** fails, and the
qpdf messages are printed.

| Flag | Meaning |
|------|---------|
| `--expect-pages N` | Fail unless the document has exactly N pages. |
| `--golden DIR` | Render every page with `pdftoppm -r 72 -png` and compare each to `DIR/page-*.png` with pixelmatch. Fails when a page differs by more than the threshold, or when the page counts differ. |
| `--threshold PCT` | Largest allowed share of differing pixels per page, in percent. Default `0.1` (0.1%). |
| `--update-golden` | With `--golden`, replace `DIR` with the current render instead of comparing. Commit goldens only after looking at them. |
| `--corpus DIR` | Check every PDF in `DIR` against `DIR/expectations.json` (`valid`, `pages`, `rotation`, `encrypted`, `form`) and print a table. A PDF with no expectation fails. `valid: false` files must fail qpdf, and count as a pass when they do. |
| `-h`, `--help` | Print usage. |

Exit codes: `0` pass, `1` a check failed, `2` bad arguments.

## Implementation
The logic lives in `packages/testing` (`src/pdf/`), with tests in
`packages/testing/test/` (`pnpm --filter @inkly/testing test`). `run.sh` runs
`packages/testing/bin/verify-pdf.ts` with Node's built-in TypeScript type stripping.
