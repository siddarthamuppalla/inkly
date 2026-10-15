// lint-fixture target: packages/pdf/src/__lint_fixture__pdf_node_import.ts
// lint-fixture expect: no-restricted-imports
import { readFileSync } from "node:fs";
export const bytes = readFileSync("x.pdf");
