const UNITS = ["bytes", "KB", "MB", "GB"] as const;

/** Binary sizes with the familiar unit names, matching how Plan Limits are counted. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit] ?? "bytes"}`;
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function formatDateTime(ms: number): string {
  return dateTime.format(new Date(ms));
}

export function formatPages(pages: number): string {
  return pages === 1 ? "1 page" : `${String(pages)} pages`;
}
