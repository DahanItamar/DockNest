// The database engines DockNest captures natively: the one list for the API schema, the infrastructure map and the
// release gate. The remote helper's engine modules (remote/helper/engine_*.py) are the Python side.
// `check` names the field a data check uses for that engine: a table row count or a Redis key digest.
export const DATABASE_ENGINES = Object.freeze([
  { id: 'postgres', label: 'PostgreSQL', check: 'table' },
  { id: 'mysql', label: 'MySQL', check: 'table' },
  { id: 'mariadb', label: 'MariaDB', check: 'table' },
  { id: 'redis', label: 'Redis', check: 'key' },
].map(engine => Object.freeze(engine)));

export const ENGINE_IDS = Object.freeze(DATABASE_ENGINES.map(engine => engine.id));
// The SQL engines: their data checks count table rows.
export const SQL_ENGINE_IDS = Object.freeze(DATABASE_ENGINES.filter(engine => engine.check === 'table').map(engine => engine.id));

const byId = new Map(DATABASE_ENGINES.map(engine => [engine.id, engine]));
export const engineLabel = id => byId.get(id)?.label;
