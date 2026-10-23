// Plain-language sentences for findings. Headline and advice avoid jargon; details go in advanced.
const NAMES = { php: 'PHP', node: 'Node.js' };
const WORD = { critical: 'serious', high: 'significant', medium: 'moderate', low: 'minor', info: 'minor' };
const NO_CHANGE = 'DockNest will not change anything for you.';

export function describeFinding(finding, { advisory = null, siteName = null, appName = 'container' } = {}) {
  const c = finding.component;
  const name = NAMES[c.product] ?? c.product;
  const subject = siteName || appName;
  const title = advisory?.title ? ` (${advisory.title})` : '';
  const fix = finding.fixedIn ? `${name} ${finding.fixedIn} or later` : 'a newer version';
  const cves = advisory?.cve?.length ? ` [${advisory.cve.join(', ')}]` : '';
  const advanced = [`${finding.advisoryId}${cves}`, `severity ${finding.severity}`, `found via ${c.source}`, finding.evidence].join('; ');
  let headline;
  let advice;
  switch (finding.kind) {
    case 'vulnerable':
      headline = `${subject} runs ${name} ${c.version}, which has a ${WORD[finding.severity]} flaw${title}.`;
      advice = `Update the ${appName} image to one with ${fix}. ${NO_CHANGE}`; break;
    case 'likely':
      headline = `${subject} probably runs a ${name} version with a ${WORD[finding.severity]} flaw${title}.`;
      advice = `Pull a fresh ${appName} image and rebuild to get ${fix}. ${NO_CHANGE}`; break;
    case 'eol':
      headline = `${subject} runs ${name} ${c.version}, which no longer receives security fixes.`;
      advice = `Move the ${appName} image to a ${name} version that is still supported. ${NO_CHANGE}`; break;
    default:
      headline = `DockNest could not tell whether ${subject} is affected${advisory?.title ? ` by ${advisory.title}` : ''}.`;
      advice = `Check which ${name} version the ${appName} image uses and compare it with ${fix}. ${NO_CHANGE}`;
  }
  return { headline, advice, advanced };
}
