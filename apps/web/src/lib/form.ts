/** A trimmed text value from a submitted form; empty when absent or a file. */
export function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value.trim() : "";
}
