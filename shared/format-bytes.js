// The one byte formatter for every screen, message and email. Decimal units: 1 KB = 1,000 bytes, 1 GB = 10^9, 1 TB = 10^12.
// Capacities are configured in TB, so 2 TB reads as 2 TB. Values under 100 of a unit show one decimal, and a whole value drops it.
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1000) return Math.round(bytes) + ' B';
  let unit = Math.min(4, Math.floor(Math.log10(bytes) / 3));
  let scaled = bytes / 1000 ** unit;
  const digits = () => (scaled >= 99.95 ? 0 : 1);
  let text = scaled.toFixed(digits());
  if (Number(text) >= 1000 && unit < 4) { unit++; scaled = bytes / 1000 ** unit; text = scaled.toFixed(digits()); }
  return text.replace(/\.0$/, '') + ' ' + UNITS[unit];
}
