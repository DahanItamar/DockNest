// Accent colour choice (Settings > Appearance). Teal is the default. Only the accent scale changes; neutrals stay slate and
// status colours (green, amber, red) never follow the accent. The tokens live in web/tokens.css under html[data-accent].
export const ACCENTS = Object.freeze([
  { id: 'teal', label: 'Teal' },
  { id: 'blue', label: 'Blue' },
  { id: 'indigo', label: 'Indigo' },
  { id: 'orange', label: 'Orange' },
]);
export const DEFAULT_ACCENT = 'teal';
export const validAccent = value => (ACCENTS.some(accent => accent.id === value) ? value : DEFAULT_ACCENT);
// Browser storage keys: the same pattern as the theme choice (per account in this browser, plus a device-wide fallback).
export const ACCENT_KEY = 'docknest-accent';
export const accentKeyFor = id => (id ? ACCENT_KEY + ':user:' + id : ACCENT_KEY);
