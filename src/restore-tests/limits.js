// Restore test limits (docs/restore-tests.md, "Resource limits"). Each limit offers presets and a custom number the
// administrator types; DockNest stores the number, never a preset name. The same ranges are enforced by the database
// CHECKs (migration 9) and by the helper (remote/helper.py test_limits). The CPU limit is also refused above the test
// server's nproc, which only the test server knows, at "Check space".
export const LIMIT_PRESETS = Object.freeze({
  timeLimitMinutes: Object.freeze([15, 30, 60, 120]),
  memoryMb: Object.freeze([512, 1024, 2048, 4096, 8192]),
  cpus: Object.freeze([0.5, 1, 2, 4]),
});
export const LIMIT_DEFAULTS = Object.freeze({ timeLimitMinutes: 30, memoryMb: 1024, cpus: 1 });
export const LIMIT_RANGES = Object.freeze({
  timeLimitMinutes: Object.freeze({ min: 10, max: 120, step: 1 }),
  memoryMb: Object.freeze({ min: 256, max: 16384, step: 1 }),
  cpus: Object.freeze({ min: 0.5, max: 16, step: 0.25 }),
});
const MESSAGES = {
  timeLimitMinutes: 'The time limit must be a whole number of minutes from 10 to 120.',
  memoryMb: 'The memory limit must be a whole number of MB from 256 to 16384 per container.',
  cpus: 'The CPU limit must be from 0.5 to 16 per container, in steps of 0.25.',
};
export class LimitError extends Error {
  constructor(field) { super(MESSAGES[field]); this.status = 400; this.code = 'INVALID'; this.field = field; }
}
const valid = (field, value) => {
  const { min, max, step } = LIMIT_RANGES[field];
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && Number.isInteger(value / step);
};
// Missing fields take the defaults; anything present must be a number inside its range (strings are refused).
export function validateLimits(input = {}) {
  const limits = { ...LIMIT_DEFAULTS };
  for (const field of Object.keys(LIMIT_DEFAULTS)) {
    if (input[field] === undefined) continue;
    if (!valid(field, input[field])) throw new LimitError(field);
    limits[field] = input[field];
  }
  return limits;
}
export const isPreset = (field, value) => LIMIT_PRESETS[field].includes(value);
// The test server's CPU count caps the per-container CPU limit.
export function cpuProblem(cpus, nproc) {
  if (!Number.isInteger(nproc) || nproc < 1 || cpus <= nproc) return null;
  return `The test server has ${nproc} CPU${nproc === 1 ? '' : 's'}, so it cannot give each container ${cpus}. Lower the CPU limit.`;
}
