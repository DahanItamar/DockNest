// Pure matcher: components + feed -> findings. Never touches I/O.
// Owner decision (2.12.0): a floating image tag (php:8.3-apache) without a runtime probe never yields `vulnerable`.
// It yields `likely` ("Possibly affected") with the severity capped at TAG_ONLY_MAX, and `unknown` is capped the same way.
import { compareDotted, branchOf, isFullVersion } from './version.js';

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
export const TAG_ONLY_MAX = 'medium';
const cap = (severity, max = TAG_ONLY_MAX) => (SEVERITIES.indexOf(severity) < SEVERITIES.indexOf(max) ? max : severity);
const day = (s) => Date.parse(s);

export function matchComponent(component, feed, { today = new Date() } = {}) {
  const { product, version, source } = component;
  const out = [];
  const branch = branchOf(product, version);
  const make = (advisory, kind, fixedIn, evidence) => out.push({
    advisoryId: advisory.id, severity: kind === 'vulnerable' ? advisory.severity : cap(advisory.severity), kind, component, fixedIn, evidence,
  });

  for (const adv of feed.advisories.filter((a) => a.product === product)) {
    const fixedAll = adv.ranges.flatMap((r) => r.fixed);
    if (branch === null) { make(adv, 'unknown', null, 'version could not be read'); continue; }
    const fixedIn = fixedAll.find((f) => branchOf(product, f) === branch) ?? null;
    if (!fixedIn) {
      const lowest = [...fixedAll].sort((x, y) => compareDotted(x, y))[0];
      // Branch older than every fixed branch: the feed alone cannot tell.
      if (lowest && compareDotted(version, lowest) < 0) make(adv, 'unknown', null, `branch ${branch} has no listed fix`);
      continue;
    }
    if (source === 'image-tag' && !isFullVersion(version)) {
      // Floating tag: the patch level is not visible. An image built after the advisory was published most likely
      // carries the fix (official images rebuild on every patch release), so only older or undated images are flagged.
      const created = component.imageCreated ? day(component.imageCreated) : NaN;
      if (!Number.isNaN(created) && created >= day(adv.publishedAt)) continue;
      make(adv, 'likely', fixedIn, Number.isNaN(created)
        ? `image tag ${version} does not show the patch level`
        : `image tag ${version} was built before this advisory (${adv.publishedAt.slice(0, 10)})`);
      continue;
    }
    const cmp = compareDotted(version, fixedIn);
    if (cmp === null) make(adv, 'unknown', fixedIn, 'version could not be compared');
    else if (cmp < 0) make(adv, 'vulnerable', fixedIn, `${version} is older than ${fixedIn}`);
  }

  if (branch !== null) {
    const e = (feed.eol ?? []).find((x) => x.product === product && x.cycle === branch);
    if (e && day(e.eol) <= today.getTime()) {
      out.push({
        advisoryId: `eol-${product}-${branch}`, severity: 'medium', kind: 'eol', component, fixedIn: null,
        evidence: `${product} ${branch} reached end of life on ${e.eol.slice(0, 10)}`,
      });
    }
  }
  return out;
}

export function matchAll(components, feed, opts) {
  return components.flatMap((c) => matchComponent(c, feed, opts));
}
