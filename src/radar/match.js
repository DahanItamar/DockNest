// Pure matcher: components + feed -> findings. Never touches I/O.
import { compareDotted, branchOf, isFullVersion } from './version.js';

const day = (s) => Date.parse(s);

export function matchComponent(component, feed, { today = new Date() } = {}) {
  const { product, version, source } = component;
  const out = [];
  const branch = branchOf(product, version);
  const make = (advisory, kind, fixedIn, evidence) => out.push({
    advisoryId: advisory.id, severity: advisory.severity, kind, component, fixedIn, evidence,
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
      const created = component.imageCreated ? day(component.imageCreated) : NaN;
      if (!Number.isNaN(created) && created < day(adv.publishedAt)) {
        make(adv, 'likely', fixedIn, `image tag ${version} was built before this advisory (${adv.publishedAt.slice(0, 10)})`);
      } else make(adv, 'unknown', fixedIn, `image tag ${version} does not show the patch level`);
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
