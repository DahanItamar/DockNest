// Dotted version comparison for the vulnerability radar. Pure, no I/O.
export function parseVersion(input) {
  if (typeof input !== 'string') return null;
  const m = /^v?(\d{1,6}(?:\.\d{1,6}){0,5})([-+~_.a-zA-Z][\x21-\x7e]{0,63})?$/.exec(input.trim());
  if (!m) return null;
  return { nums: m[1].split('.').map(Number), suffix: m[2] ?? '' };
}

// Returns -1, 0, 1, or null when either side is unreadable.
export function compareDotted(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  const len = Math.max(x.nums.length, y.nums.length);
  for (let i = 0; i < len; i += 1) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (x.suffix === y.suffix) return 0;
  if (!x.suffix) return -1;
  if (!y.suffix) return 1;
  return x.suffix < y.suffix ? -1 : 1;
}

// php -> "8.3", node -> "22"; null when the version is unreadable or too short.
export function branchOf(product, version) {
  const p = parseVersion(version);
  if (!p) return null;
  if (product === 'php') return p.nums.length >= 2 ? `${p.nums[0]}.${p.nums[1]}` : null;
  return String(p.nums[0]);
}

// True when the patch level is known (three or more numeric segments).
export function isFullVersion(version) {
  const p = parseVersion(version);
  return Boolean(p) && p.nums.length >= 3;
}

// A version with a packaging suffix (8.1.2-1ubuntu2.18, 8.2.7-1~deb12u1, 18.19.1+dfsg-6) comes from a distribution
// package. Distributions backport security fixes without changing the upstream number, so the number alone is not proof.
// Upstream pre-release suffixes (-dev, RC1, alpha, beta) are not distribution builds.
export function isDistroBuild(version) {
  const p = parseVersion(version);
  if (!p || !p.suffix) return false;
  return !/^[-.]?(?:dev|alpha\d*|beta\d*|rc\d*)$/i.test(p.suffix);
}
