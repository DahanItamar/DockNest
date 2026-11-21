// App encryption keys DockNest looks for (docs/keys-safe.md). Plain data: adding an app is one entry plus its test.
// DockNest is the single source: the helper receives this list in each request and keeps no copy of its own.
// - kind 'env': a container environment variable, an env file or an inline Compose `environment:` entry (`name`).
// - kind 'ini': `name` in `[section]` of a file whose path ends with `file`.
// - kind 'php-array': the `'name' => '...'` entry of a file whose path ends with `file`.
// - kind 'file': the file whose path ends with `path` must exist; its bytes are the key.
// - `image` (optional): words of the image name that narrow a generic name such as SECRET_KEY to known apps.
export const KEY_KINDS = Object.freeze(['env', 'ini', 'php-array', 'file']);

const DJANGO_IMAGES = ['django', 'netbox', 'healthchecks', 'baserow', 'tandoor', 'recipes', 'wger'];
export const KEY_RULES = Object.freeze([
  { id: 'laravel-app-key', app: 'Laravel or Firefly III', kind: 'env', name: 'APP_KEY' },
  { id: 'n8n-encryption-key', app: 'n8n', kind: 'env', name: 'N8N_ENCRYPTION_KEY' },
  { id: 'rails-secret-key-base', app: 'Rails apps (Mastodon, GitLab)', kind: 'env', name: 'SECRET_KEY_BASE' },
  { id: 'rails-otp-secret', app: 'Mastodon or GitLab', kind: 'env', name: 'OTP_SECRET' },
  { id: 'authentik-secret-key', app: 'authentik', kind: 'env', name: 'AUTHENTIK_SECRET_KEY' },
  { id: 'paperless-secret-key', app: 'Paperless-ngx', kind: 'env', name: 'PAPERLESS_SECRET_KEY' },
  { id: 'nextauth-secret', app: 'NextAuth apps', kind: 'env', name: 'NEXTAUTH_SECRET' },
  { id: 'outline-secret-key', app: 'Outline', kind: 'env', name: 'SECRET_KEY', image: ['outline'] },
  { id: 'outline-utils-secret', app: 'Outline', kind: 'env', name: 'UTILS_SECRET', image: ['outline'] },
  { id: 'django-secret-key', app: 'Django apps', kind: 'env', name: 'SECRET_KEY', image: DJANGO_IMAGES },
  { id: 'gitea-secret-key', app: 'Gitea', kind: 'ini', file: 'app.ini', section: 'security', name: 'SECRET_KEY' },
  { id: 'nextcloud-secret', app: 'Nextcloud', kind: 'php-array', file: 'config/config.php', name: 'secret' },
  { id: 'vaultwarden-rsa', app: 'Vaultwarden', kind: 'file', path: 'rsa_key.pem' },
].map(rule => Object.freeze({ ...rule, ...(rule.image ? { image: Object.freeze([...rule.image]) } : {}) })));

const RULE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/, NAME = /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/;
const RELATIVE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, IMAGE_WORD = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FIELDS = { env: ['name'], ini: ['file', 'section', 'name'], 'php-array': ['file', 'name'], file: ['path'] };
const relative = value => typeof value === 'string' && value.length <= 256 && RELATIVE.test(value) && !value.split('/').includes('..');
// Problems with one rule, as short sentences; an empty list means the rule is valid. remote/helper/keys.py applies
// the same checks to every rule it receives.
export function keyRuleProblems(rule) {
  if (!rule || typeof rule !== 'object') return ['A rule must be an object.'];
  const problems = [], fields = FIELDS[rule.kind];
  if (typeof rule.id !== 'string' || rule.id.length > 64 || !RULE_ID.test(rule.id)) problems.push('The id must be lowercase words joined by hyphens.');
  if (typeof rule.app !== 'string' || !rule.app.trim() || rule.app.length > 80) problems.push('The app name is required.');
  if (!fields) return [...problems, 'The kind must be env, ini, php-array or file.'];
  const allowed = new Set(['id', 'app', 'kind', 'image', ...fields]);
  for (const field of Object.keys(rule)) if (!allowed.has(field)) problems.push(`The field ${field} does not belong to kind ${rule.kind}.`);
  if (fields.includes('name') && !(typeof rule.name === 'string' && NAME.test(rule.name))) problems.push('The name must be a variable or option name.');
  if (fields.includes('section') && !(typeof rule.section === 'string' && NAME.test(rule.section))) problems.push('The section must be an ini section name.');
  for (const field of ['file', 'path']) if (fields.includes(field) && !relative(rule[field])) problems.push(`The ${field} must be a relative path without "..".`);
  if (rule.image !== undefined && !(Array.isArray(rule.image) && rule.image.length > 0 && rule.image.length <= 20 && rule.image.every(word => typeof word === 'string' && IMAGE_WORD.test(word)))) problems.push('Image hints must be lowercase image name words.');
  return problems;
}
export const keyRule = ruleId => KEY_RULES.find(rule => rule.id === ruleId) ?? null;
