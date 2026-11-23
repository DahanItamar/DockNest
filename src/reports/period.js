// Report periods (docs/client-reports.md, decisions 2 and 7): a calendar month or a custom range of whole days up to 92,
// and the day-1 08:00 schedule, all in the client's IANA time zone. Pure: no database, no clock of its own.
export const MAX_DAYS = 92;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT = MONTHS.map(name => name.slice(0, 3));
const DAY = 86_400_000;

export const validZone = zone => { try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }); return typeof zone === 'string' && zone.length <= 64; } catch { return false; } };
const parts = (ms, timeZone) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
// The instant of a local wall-clock time in a zone (the first one when a daylight-saving change repeats it).
export function zonedInstant(year, month, day, hour = 0, minute = 0, timeZone = 'UTC') {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = at => { const p = parts(at, timeZone); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000; };
  let at = guess - offsetAt(guess);
  at = guess - offsetAt(at);
  return at;
}
export const dateText = (year, month, day) => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
export const localDate = (ms, timeZone = 'UTC') => { const p = parts(ms, timeZone); return dateText(p.year, p.month, p.day); };
const dayParts = text => { const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text)); if (!match) return null; const [year, month, day] = match.slice(1).map(Number); const check = new Date(Date.UTC(year, month - 1, day)); return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day ? { year, month, day } : null; };

// The previous calendar month at `now`: { from, to } as local dates (both days included).
export function previousMonth(now, timeZone = 'UTC') {
  const p = parts(now, timeZone), year = p.month === 1 ? p.year - 1 : p.year, month = p.month === 1 ? 12 : p.month - 1;
  return { from: dateText(year, month, 1), to: dateText(year, month, new Date(Date.UTC(year, month, 0)).getUTCDate()) };
}
// First day 1 at 08:00 local time strictly after `now`, as an ISO instant.
export function nextDueAt(now, timeZone = 'UTC') {
  const p = parts(now, timeZone);
  let year = p.year, month = p.month;
  let at = zonedInstant(year, month, 1, 8, 0, timeZone);
  if (at <= now) { month += 1; if (month > 12) { month = 1; year += 1; } at = zonedInstant(year, month, 1, 8, 0, timeZone); }
  return new Date(at).toISOString();
}
// A requested range: whole local days, from <= to, at most 92 days, not in the future. Throws a short sentence.
export function resolvePeriod(from, to, { timeZone = 'UTC', now = Date.now() } = {}) {
  const a = dayParts(from), b = dayParts(to);
  if (!a || !b) throw Object.assign(new Error('Choose the first and last day of the report.'), { status: 400 });
  const start = zonedInstant(a.year, a.month, a.day, 0, 0, timeZone), end = zonedInstant(b.year, b.month, b.day + 1, 0, 0, timeZone);
  if (end <= start) throw Object.assign(new Error('The last day cannot be before the first day.'), { status: 400 });
  if (Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY) + 1 > MAX_DAYS) throw Object.assign(new Error(`A report covers at most ${MAX_DAYS} days.`), { status: 400 });
  if (start > now) throw Object.assign(new Error('A report cannot start in the future.'), { status: 400 });
  return { from, to, start: new Date(start).toISOString(), end: new Date(end).toISOString(), label: periodLabel(from, to) };
}
export function periodLabel(from, to) {
  const a = dayParts(from), b = dayParts(to);
  if (!a || !b) return '';
  const last = new Date(Date.UTC(b.year, b.month, 0)).getUTCDate();
  if (a.year === b.year && a.month === b.month && a.day === 1 && b.day === last) return `${MONTHS[a.month - 1]} ${a.year}`;
  const text = part => `${part.day} ${SHORT[part.month - 1]} ${part.year}`;
  return `${text(a)} to ${text(b)}`;
}
export const longDate = (ms, timeZone = 'UTC') => { const p = parts(ms, timeZone); return `${p.day} ${SHORT[p.month - 1]} ${p.year}`; };
