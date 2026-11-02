// Input rules for launches and deploy keys (docs/launch-site.md, "Threat model" and "Security review changes" items 2, 6,
// 7 and 16). Pure: no database, no network. Every value that reaches the helper passes one of these first; the helper
// checks again on the server (argv only, never a shell), so a mistake here can never become an option or a command.
import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';
import { classify, nameRefused } from '../alerts/addresses.js';

export class LaunchInputError extends Error {
  constructor(code, message, field) { super(message); this.status = 400; this.code = code; if (field) this.field = field; }
}
const refuse = (code, message, field) => { throw new LaunchInputError(code, message, field); };
const CONTROL = /[\u0000-\u001f\u007f\s]/;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

// A DNS name in lowercase LDH form (punycode for IDN), at least two labels, no wildcard, at most 253 characters.
function dnsName(text, field) {
  const raw = String(text ?? '').trim().replace(/\.$/, '');
  if (!raw || raw.length > 253 || CONTROL.test(raw)) refuse('INVALID_DOMAIN', 'Enter a domain such as shop.example.com.', field);
  if (raw.includes('*')) refuse('INVALID_DOMAIN', 'Wildcard domains are not supported. Enter one domain.', field);
  const ascii = domainToASCII(raw.toLowerCase());
  if (!ascii || ascii.length > 253) refuse('INVALID_DOMAIN', 'Enter a domain such as shop.example.com.', field);
  const labels = ascii.split('.');
  if (labels.length < 2 || !labels.every(label => LABEL.test(label)) || /^\d+$/.test(labels.at(-1))) refuse('INVALID_DOMAIN', 'Enter a domain such as shop.example.com.', field);
  return ascii;
}

// The launch domain (item 7). `www.` is derived by DockNest, never typed.
export function launchDomain(text) {
  const raw = String(text ?? '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.includes('/') || raw.includes(':') || raw.includes('@')) refuse('INVALID_DOMAIN', 'Enter only the domain, such as shop.example.com, without http:// or a path.', 'domain');
  if (isIP(raw)) refuse('INVALID_DOMAIN', 'Enter a domain name, not an IP address.', 'domain');
  const domain = dnsName(raw, 'domain');
  if (domain.startsWith('www.')) refuse('INVALID_DOMAIN', 'Enter the domain without www. DockNest adds the www. address for you.', 'domain');
  return domain;
}
export const wwwAlias = domain => `www.${domain}`;

// The Compose project name and folder name (/srv/docknest/<slug>): from the domain, lowercase letters, digits and dashes.
export function slugFor(domain) {
  const slug = String(domain).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) refuse('INVALID_DOMAIN', 'DockNest could not make a folder name from this domain.', 'domain');
  return slug;
}

// A Git host as typed for a deploy key: `host`, `host:port` or `[ipv6]:port`.
export function parseGitHost(text, { allowPrivate = false } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw || raw.length > 262 || CONTROL.test(raw) || raw.startsWith('-') || raw.includes('@') || raw.includes('/')) refuse('INVALID_GIT_HOST', 'Enter the Git host, such as github.com or git.example.com:2222.', 'gitHost');
  let host = raw, port = 22;
  const bracket = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(raw), plain = /^([^:]+):(\d{1,5})$/.exec(raw);
  if (bracket) { host = bracket[1]; port = bracket[2] ? Number(bracket[2]) : 22; }
  else if (plain) { host = plain[1]; port = Number(plain[2]); }
  if (!Number.isInteger(port) || port < 1 || port > 65535) refuse('INVALID_GIT_HOST', 'The port must be between 1 and 65535.', 'gitHost');
  host = checkHost(host, allowPrivate, 'gitHost');
  return { host, port, text: port === 22 ? (isIP(host) === 6 ? `[${host}]` : host) : `${isIP(host) === 6 ? `[${host}]` : host}:${port}` };
}
// IP literals are judged here; names are resolved and judged again on the server (item 2), where the answer counts.
function checkHost(host, allowPrivate, field) {
  if (isIP(host)) {
    const kind = classify(host);
    if (kind === 'refused' || (kind === 'private' && !allowPrivate)) refuse('PRIVATE_ADDRESS', kind === 'private' ? 'This is a private address. Tick "Allow private address" for a Git server on your own network.' : 'DockNest does not connect to this address.', field);
    return host.toLowerCase();
  }
  const name = dnsName(host, field);
  if (nameRefused(name)) refuse('PRIVATE_ADDRESS', 'DockNest does not connect to this address.', field);
  return name;
}

// A repository URL (item 2): https://host[:port]/path or SSH (git@host:path, ssh://git@host[:port]/path). No userinfo
// on https (no passwords in URLs), no leading dash anywhere, no `..`, no query or fragment, nothing a shell would read.
const PATH = /^[A-Za-z0-9._~\/-]{1,400}$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
export function parseRepoUrl(text, { allowPrivate = false } = {}) {
  const raw = String(text ?? '').trim();
  const bad = () => refuse('INVALID_REPOSITORY', 'Enter an https:// address or an SSH address (git@host:owner/repo.git).', 'repo.url');
  if (!raw || raw.length > 512 || CONTROL.test(raw) || raw.startsWith('-') || /[\/:]\.\.?(?=[\/]|$)/.test(raw) || /\/\.\.?(?=\/|$)/.test(raw)) bad();
  let kind, host, port, path, user = null;
  const scp = /^([a-z_][a-z0-9_-]{0,31})@([^:/\[\]]+|\[[0-9a-fA-F:.]+\]):(?!\/)(.+)$/.exec(raw);
  if (scp) { kind = 'ssh'; user = scp[1]; host = scp[2].replace(/^\[|\]$/g, ''); port = 22; path = scp[3]; }
  else {
    let url;
    try { url = new URL(raw); } catch { bad(); }
    if (url.search || url.hash) bad();
    if (url.protocol === 'https:') {
      if (url.username || url.password) refuse('INVALID_REPOSITORY', 'Remove the user name or password from the address. Use a deploy key for private repositories.', 'repo.url');
      kind = 'https'; port = url.port ? Number(url.port) : 443;
    } else if (url.protocol === 'ssh:') {
      if (url.password || !USER.test(decodeURIComponent(url.username || ''))) bad();
      kind = 'ssh'; user = url.username; port = url.port ? Number(url.port) : 22;
    } else bad();
    host = url.hostname.replace(/^\[|\]$/g, '');
    path = decodeURIComponent(url.pathname).replace(/^\//, '');
  }
  if (!PATH.test(path) || path.split('/').some(part => part === '..' || part === '.' || part.startsWith('-')) || path.includes('//')) bad();
  host = checkHost(host, allowPrivate, 'repo.url');
  return { kind, host, port, path, user, url: raw };
}

// A branch or tag name (git check-ref-format rules that matter here), never an option.
export function checkRef(text) {
  const ref = String(text ?? '').trim();
  if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(ref) || ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock') || ref.includes('..') || ref.includes('//') || ref.split('/').some(part => part.startsWith('.') || part.startsWith('-'))) refuse('INVALID_REF', 'Enter a branch or tag name, such as main or v1.4.2.', 'repo.ref');
  return ref;
}

// The Compose file inside the repository: a relative path to a .yml or .yaml file, never outside it.
export function checkComposePath(text) {
  const path = String(text ?? '').trim().replace(/^\.\//, '');
  if (!/^[A-Za-z0-9._\/-]{1,300}$/.test(path) || !/\.ya?ml$/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('-'))) refuse('INVALID_COMPOSE_PATH', 'Enter the Compose file path inside the repository, such as compose.yaml or deploy/compose.yaml.', 'repo.composePath');
  return path;
}

// Environment values (item 6): keys that could steer Compose, Docker or BuildKit are refused, and no value may hold a
// line break or NUL. Values are never logged or stored; only the key names are shown back.
export const ENV_LIMITS = Object.freeze({ keys: 200, valueBytes: 8192 });
export function checkEnv(env) {
  if (env === undefined || env === null) return {};
  if (typeof env !== 'object' || Array.isArray(env)) refuse('INVALID_ENV', 'Environment values must be names with values.', 'env');
  const entries = Object.entries(env);
  if (entries.length > ENV_LIMITS.keys) refuse('INVALID_ENV', `Enter at most ${ENV_LIMITS.keys} environment values.`, 'env');
  const result = {};
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) refuse('INVALID_ENV', `${key.slice(0, 40)} is not a valid environment name.`, 'env');
    if (/^(COMPOSE_|DOCKER_|BUILDKIT_)/i.test(key)) refuse('ENV_KEY_REFUSED', `${key} could change how Docker runs the site, so DockNest does not allow it.`, 'env');
    if (typeof value !== 'string' || /[\r\n\u0000]/.test(value) || Buffer.byteLength(value) > ENV_LIMITS.valueBytes) refuse('INVALID_ENV', `The value of ${key} must be one line of at most 8 KB.`, 'env');
    result[key] = value;
  }
  return result;
}
