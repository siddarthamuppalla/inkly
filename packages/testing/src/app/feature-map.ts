import { readFileSync } from "node:fs";

/** Journey IDs listed in feature-map.md, in order. */
export function featureMapIds(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => /^\|\s*(J-\d{3})\s*\|/.exec(l)?.[1])
    .filter((id): id is string => id !== undefined);
}
