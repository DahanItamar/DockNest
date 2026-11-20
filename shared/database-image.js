// Whether a container is a database, for screens and checks that run without a server. The image rule matches the remote
// helper's image_looks_like_database (remote/helper/backup.py); tests/fixtures/database-images.json holds the names both
// must agree on. It fails closed: any image that mentions a database word is one, unless its own name is clearly a tool.
const DATABASE_WORDS = ['postgres', 'mysql', 'mariadb', 'mongo', 'redis', 'cockroach', 'cassandra', 'elasticsearch'];
const TOOL_WORDS = new Set(['exporter', 'commander', 'express', 'backup', 'backups', 'dump', 'dumper', 'restore', 'sidecar', 'insight', 'redisinsight']);
const mentionsDatabase = text => DATABASE_WORDS.some(word => text.includes(word));

export function imageLooksLikeDatabase(image) {
  const whole = String(image || '').toLowerCase();
  if (!mentionsDatabase(whole)) return false;
  const name = whole.split('@')[0].split('/').at(-1).split(':')[0];
  return !(mentionsDatabase(name) && name.split(/[-_.]+/).some(word => TOOL_WORDS.has(word)));
}

// An engine chosen in the app's settings decides; 'auto' or no setting falls back to the image name.
export const containerIsDatabase = (engine, image) => engine && engine !== 'auto' ? engine !== 'generic' : imageLooksLikeDatabase(image);
