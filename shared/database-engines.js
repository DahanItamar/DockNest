// The database engines DockNest captures natively: the one list for the API schema, the infrastructure map and the
// release gate. The remote helper's engine modules (remote/helper/engine_*.py) are the Python side.
// `check` names the field a data check uses for that engine: a table row count, a Redis key digest or a MongoDB
// collection document count. `releaseEvidence` names the Linux integration evidence the release gate requires for it:
// `engines` (one shared record per engine), `redis` or `mongo` (one record per `testedVersions` major).
export const DATABASE_ENGINES = Object.freeze([
  { id: 'postgres', label: 'PostgreSQL', check: 'table', releaseEvidence: 'engines' },
  { id: 'mysql', label: 'MySQL', check: 'table', releaseEvidence: 'engines' },
  { id: 'mariadb', label: 'MariaDB', check: 'table', releaseEvidence: 'engines' },
  { id: 'redis', label: 'Redis', check: 'key', releaseEvidence: 'redis' },
  { id: 'mongo', label: 'MongoDB', check: 'collection', releaseEvidence: 'mongo', testedVersions: Object.freeze(['6.0', '7.0', '8.0']) },
].map(engine => Object.freeze(engine)));

export const ENGINE_IDS = Object.freeze(DATABASE_ENGINES.map(engine => engine.id));
// The SQL engines: their data checks count table rows.
export const SQL_ENGINE_IDS = Object.freeze(DATABASE_ENGINES.filter(engine => engine.check === 'table').map(engine => engine.id));

const byId = new Map(DATABASE_ENGINES.map(engine => [engine.id, engine]));
export const engineLabel = id => byId.get(id)?.label;
export const engineCheckField = id => byId.get(id)?.check;
export const engineTestedVersions = id => byId.get(id)?.testedVersions ?? [];
export const releaseEvidenceIds = kind => DATABASE_ENGINES.filter(engine => engine.releaseEvidence === kind).map(engine => engine.id);
