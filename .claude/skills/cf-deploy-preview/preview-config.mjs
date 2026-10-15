// Writes workers/api/wrangler.preview.json: the production wrangler.jsonc with the
// name and bindings pointed at one PR's isolated resources and test hooks on (Q9, Q11).
// usage: node preview-config.mjs <name> <d1-uuid> <kv-id>
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [name, d1Id, kvId] = process.argv.slice(2);
if (!name || !d1Id || !kvId) {
  console.error("usage: preview-config.mjs <name> <d1-uuid> <kv-id>");
  process.exit(2);
}

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "../../../workers/api");

/** Strips // and /* comments and trailing commas outside strings. */
export function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const config = parseJsonc(readFileSync(join(apiDir, "wrangler.jsonc"), "utf8"));
delete config.$schema;
config.name = name;
config.workers_dev = true;
config.d1_databases = config.d1_databases.map((d) =>
  d.binding === "DB" ? { ...d, database_name: name, database_id: d1Id } : d,
);
config.r2_buckets = config.r2_buckets.map((b) =>
  b.binding === "FILES" ? { ...b, bucket_name: name } : b,
);
config.kv_namespaces = config.kv_namespaces.map((k) =>
  k.binding === "KV" ? { ...k, id: kvId } : k,
);
// Previews never send real mail: it lands in the Outbox (Q5).
config.vars = { ...config.vars, TEST_HOOKS: "enabled", EMAIL_PROVIDER: "outbox" };

writeFileSync(join(apiDir, "wrangler.preview.json"), `${JSON.stringify(config, null, 2)}\n`);
console.log(join(apiDir, "wrangler.preview.json"));
