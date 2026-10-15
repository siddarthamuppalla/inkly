# pdf-engine

The Container service for heavy PDF ops (see `GLOSSARY.md`). Node 22 with no
dependencies; it shells out to Ghostscript and qpdf. Only `workers/jobs` calls it.

## HTTP contract

Listens on `PORT` (default `8080`).

### `GET /health`

`200` with `{"status":"ok"}`.

### `POST /compress?level=screen|ebook|printer`

Request body: the PDF bytes. `level` picks Ghostscript's `-dPDFSETTINGS`
(`screen` smallest, `printer` best quality).

The engine checks the input with `qpdf`, runs
`gs -sDEVICE=pdfwrite -dPDFSETTINGS=/<level>`, and checks the output with
`qpdf --check` and the input's page count.

| Status | Body | When |
|-------:|------|------|
| `200` | compressed PDF, `x-inkly-compressed: true` | the output is smaller than the input |
| `200` | the original bytes, `x-inkly-compressed: false` | Ghostscript could not make it smaller |
| `413` | `{"error":"payload_too_large"}` | body larger than `PDF_ENGINE_MAX_BYTES` |
| `422` | `{"error":"invalid_level"}` | `level` missing or not one of the three |
| `422` | `{"error":"pdf_malformed"}` | not a PDF, or `qpdf --check` reports errors or warnings |
| `422` | `{"error":"pdf_encrypted"}` | the input is encrypted |
| `504` | `{"error":"timeout"}` | the request took longer than `PDF_ENGINE_TIMEOUT_MS` |
| `500` | `{"error":"internal"}` | Ghostscript failed or produced an invalid PDF |

Unknown paths answer `404 {"error":"not_found"}`; a wrong method answers
`405 {"error":"method_not_allowed"}`. Success responses have
`content-type: application/pdf`.

## Configuration

| Variable | Default |
|----------|---------|
| `PORT` | `8080` |
| `PDF_ENGINE_MAX_BYTES` | `209715200` (200 MiB) |
| `PDF_ENGINE_TIMEOUT_MS` | `120000` |

## Run and test

```sh
pnpm --filter @inkly/pdf-engine start   # needs gs and qpdf on PATH
pnpm --filter @inkly/pdf-engine test    # starts the service and compresses fixtures
docker build --platform linux/amd64 -t inkly-pdf-engine containers/pdf-engine
```
