#!/usr/bin/env python3
"""DockNest host updater broker (docs/updater-threat-model.md). Python 3 standard library only.

Root broker behind docknest-updater.socket (D1): reads one JSON request from the api container, applies the upgrade-only
policy, verifies the release as the unprivileged docknest-verify account (D14, I19), runs scripts/upgrade.sh as the
checkout owner (D2) and publishes an allow-listed copy of its status into the docknest_updater volume (F1).

Published files (status/, root:root 0755, files 0644, written only here):
  status.json   allow-listed upgrade.sh status of the current or last request (STATUS_FIELDS)
  current.json  {requestId, target, acceptedAt, events: [{phase, at}] (at most 32), truncated} (A15, I32)
  service.json  {schema, version, protocol, actions, installMode, env, blocked, blockedReason, consecutiveExit4,
                 heartbeatAt, requestId, lastResult: {requestId, exitCode, refusal, reason, finishedAt}} (I31, I35, D23)
Root-owned state in /var/lib/docknest-updater: state.json (block, counts, limits, active run), pins.json (TOFU),
history/<id>.json and <id>.log (authoritative audit, F5), mirror.git and sigstore/ (owned by docknest-verify).
2.2.0 scope: action "upgrade" only; the read-only "check" action (D19) and self-update (D6) arrive in 2.3.0, until then
`sudo scripts/install-updater.sh --repair` reinstalls this file.
"""
import base64, datetime, json, math, os, posixpath, queue, re, signal, socket, stat, struct, subprocess, sys, tempfile, threading, time, uuid
try: import fcntl, pwd
except ImportError: fcntl = pwd = None  # Windows: only the pure functions are unit-tested there

VERSION = '2.2.0'
PROTOCOL = 1
ACTIONS = ('upgrade',)
REPOSITORY = 'DahanItamar/DockNest'
REMOTE = 'https://github.com/DahanItamar/DockNest.git'
IMAGE = 'ghcr.io/dahanitamar/docknest'
# Numeric GitHub ids of the repository and its owner, compared with the Fulcio certificate extensions (F9, P9).
REPOSITORY_ID, OWNER_ID = '1426164448', '125464728'
COSIGN_VERSION = 'v3.0.5'
ISSUER = 'https://token.actions.githubusercontent.com'
ASSET_HOSTS = ('release-assets.githubusercontent.com', 'objects.githubusercontent.com')
CONFIG = '/etc/docknest-updater/config.json'
STATE_DIR = '/var/lib/docknest-updater'
WORK_DIR = '/run/docknest-updater-work'
LIB_DIR = '/usr/local/lib/docknest-updater'
COSIGN = LIB_DIR + '/bin/cosign'
SETPRIV, ENV, DOCKER, GIT = '/usr/bin/setpriv', '/usr/bin/env', '/usr/bin/docker', '/usr/bin/git'
PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
PROJECT = 'docknest'
VOLUME = 'docknest_updater'

MAX_REQUEST, READ_SECONDS, STATUS_CAP, ASSET_CAP = 4096, 2.0, 16384, 65536
RUN_LIMIT, RUN_GRACE = 2 * 3600, 15 * 60          # per-run hard stop, then SIGKILL after the grace (AR2-N3)
COOLDOWN, RUNS_PER_DAY, CONNECTIONS_PER_MINUTE, IDLE_EXIT = 60, 6, 10, 600
# Runs that end before changing anything (exit 2 or 3) give their daily slot back; this wider cap still bounds how
# often verification and the pre-checks can be started in 24 hours.
ATTEMPTS_PER_DAY = 24
CLOCK_SKEW = 300
FLOOR_BYTES = 2 * 1024 ** 3                        # plus the last image size (D10)
POLL = 2.0

CODES = ('busy', 'invalid', 'rate-limited', 'version-refused', 'state-mismatch', 'low-disk', 'duplicate', 'stale', 'needs-host-ack')
PHASES = ('verify', 'preflight', 'fetch', 'idle', 'backup', 'checkout', 'build', 'stop', 'restore-snapshot', 'start', 'health',
          'rollback', 'release', 'cleanup', 'done', 'failed')
# Failure reasons shared with upgrade.sh (section 7.1); the broker adds its verify and refusal reasons. Anything else is "unknown".
REASONS = ('tracked-files-edited', 'secret-missing', 'min-upgrade-from', 'compose-invalid', 'tag-missing', 'not-on-main',
           'signature-invalid', 'jobs-active', 'backup-failed', 'checkout-failed', 'build-failed', 'pull-failed', 'health-timeout',
           'snapshot-restore-failed', 'revert-failed', 'interrupted', 'low-disk', 'state-mismatch', 'tag-moved',
           'verify-unavailable', 'time-limit', 'unknown')
BLOCK_REASONS = ('exit-5', 'exit-6', 'interrupted', 'unexpected-exit', 'repeated-rollback')
# Flags the run step needs; an upgrade.sh whose --capabilities lacks one is refused with state-mismatch (F18, N15).
REQUIRED_FLAGS = ('--non-interactive', '--upgrade-only', '--no-fetch', '--expect-commit', '--request-id', '--status-file', '--version')
FORBIDDEN_FLAGS = ('--force', '--allow-data-rollback', '--wait', '--timeout', '--dry-run', '--no-verify')
# .git/config keys a run accepts (F3d); anything else is refused by name.
GIT_CONFIG_ALLOWED = re.compile(r'(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)'
                                r'|remote\.[^\n=]+\.(url|fetch)|branch\.[^\n=]+\.(remote|merge|rebase)|user\.[^\n=]+|pull\.[^\n=]+|init\.[^\n=]+)\Z')

UUID_RE = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z')
TAG_RE = re.compile(r'v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\Z')  # final releases only (D11)
SEMVER_RE = re.compile(r'v?(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(?:-([0-9A-Za-z.-]{1,32}))?\Z')
ISO_RE = re.compile(r'(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z\Z')
USER_RE = re.compile(r'[A-Za-z0-9_-]{1,64}\Z')
SHA_RE = re.compile(r'[0-9a-f]{40}\Z')
DIGEST_RE = re.compile(r'sha256:[0-9a-f]{64}\Z')
HEX64 = re.compile(r'[0-9a-f]{64}\Z')
NOTES_RE = re.compile(r'docs/releases/\d{4}-\d{2}-\d{2}-v\d+\.\d+(\.\d+)?\.md\Z')
CONTROL = re.compile(r'[\x00-\x08\x0b-\x1f\x7f-\x9f]')  # C0 except tab and newline, DEL and C1
REQUEST_KEYS = frozenset(('schema', 'id', 'action', 'version', 'requestedBy', 'requestedAt'))


class Refused(Exception):
    """A fixed refusal code (CODES) plus a reason kept in the broker's log and history only."""
    def __init__(self, code, detail='', extra=None):
        super().__init__(code); self.code, self.detail, self.extra = code, detail, extra or {}


def iso(epoch):
    return datetime.datetime.fromtimestamp(int(epoch), datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def parse_iso(text):
    match = ISO_RE.match(text) if isinstance(text, str) else None
    if not match: raise ValueError('time')
    return datetime.datetime(*map(int, match.groups()), tzinfo=datetime.timezone.utc).timestamp()


def semver(text):
    match = SEMVER_RE.match(text or '')
    if not match: raise ValueError('version')
    return tuple(int(part) for part in match.groups()[:3]), match.group(4)


def newer(target, current):
    """Full SemVer precedence: a final target is newer than X.Y.Z-pre of the same X.Y.Z, never than itself."""
    (t, t_pre), (c, c_pre) = semver(target), semver(current)
    if t != c: return t > c
    return t_pre is None and c_pre is not None


# ---------------------------------------------------------------- request channel (section 3, R2 to R5, N14)

def _pairs(pairs):
    out = {}
    for key, value in pairs:
        if key in out: raise ValueError('duplicate key')
        out[key] = value
    return out


def _int(text):
    if len(text) > 20: raise ValueError('number too long')
    return int(text)


def _reject(_):
    raise ValueError('constant or float')


def parse_request(raw):
    """One JSON request -> dict. Every failure, including RecursionError and MemoryError, is Refused('invalid')."""
    try:
        if not isinstance(raw, bytes) or len(raw) > MAX_REQUEST: raise ValueError('size')
        value = json.loads(raw.decode('utf-8', 'strict'), object_pairs_hook=_pairs, parse_int=_int, parse_float=_reject, parse_constant=_reject)
        if type(value) is not dict: raise ValueError('not an object')
        # action first: anything but an exact supported string ("downgrade", "Upgrade", "check" before 2.3.0) is invalid.
        if type(value.get('action')) is not str or value['action'] not in ACTIONS: raise Refused('invalid', 'action')
        if set(value) != REQUEST_KEYS: raise ValueError('fields')
        if type(value['schema']) is not int or value['schema'] != 1: raise ValueError('schema')
        if type(value['id']) is not str or not UUID_RE.match(value['id']) or str(uuid.UUID(value['id'])) != value['id']: raise ValueError('id')
        if type(value['version']) is not str or not TAG_RE.match(value['version']): raise ValueError('version')
        if type(value['requestedBy']) is not str or not USER_RE.match(value['requestedBy']): raise ValueError('requestedBy')
        at = parse_iso(value['requestedAt'])
        return {'id': str(uuid.UUID(value['id'])), 'version': value['version'], 'requestedBy': value['requestedBy'], 'at': at}
    except Refused:
        raise
    except (KeyboardInterrupt, SystemExit):
        raise
    except BaseException as error:  # noqa: B036 - the parser never lets anything else escape (N14)
        raise Refused('invalid', type(error).__name__)


def read_request(conn, now=time.monotonic):
    """Read until the client's half-close: at most MAX_REQUEST bytes within READ_SECONDS (R3)."""
    deadline, chunks, size = now() + READ_SECONDS, [], 0
    while True:
        left = deadline - now()
        if left <= 0: raise Refused('invalid', 'read deadline')
        conn.settimeout(left)
        try: chunk = conn.recv(MAX_REQUEST + 1 - size)
        except socket.timeout: raise Refused('invalid', 'read deadline')
        if not chunk: return b''.join(chunks)
        chunks.append(chunk); size += len(chunk)
        if size > MAX_REQUEST: raise Refused('invalid', 'oversize')


def response(accepted, value, extra=None):
    # extra (2.4.1) is additive and only carries the rate-limit detail: {'limit': 'cooldown'|'daily', 'retryAt': ISO time}.
    return json.dumps({'accepted': True, 'id': value} if accepted else {'accepted': False, 'code': value, **(extra or {})}, separators=(',', ':')).encode()


CGROUP_FORMS = (re.compile(r'\A/system\.slice/docker-([0-9a-f]{64})\.scope\Z'), re.compile(r'\A/docker/([0-9a-f]{64})\Z'))


def cgroup_paths(text):
    """The cgroup paths of a peer, printable and bounded, for the refusal log line."""
    paths = ','.join(dict.fromkeys(line.split(':', 2)[2] for line in text.splitlines() if line.count(':') >= 2))
    return ''.join(ch if ch.isprintable() else '?' for ch in paths)[:300] or 'unknown'


def cgroup_container(text, parent=None):
    """The one container id named by /proc/<pid>/cgroup, or None (N2)."""
    found = set()
    for line in text.splitlines():
        parts = line.split(':', 2)
        if len(parts) != 3: continue
        path = parts[2]
        for form in CGROUP_FORMS:
            match = form.search(path)
            if match: found.add(match.group(1))
        if parent:
            prefix = '/' + parent.strip('/') + '/'
            if path.startswith(prefix) and HEX64.match(path[len(prefix):]): found.add(path[len(prefix):])
    return found.pop() if len(found) == 1 else None


# ---------------------------------------------------------------- policy and state machine (sections 6 and 7)

def new_state():
    return {'schema': 1, 'blocked': False, 'blockedReason': None, 'exit4': {}, 'lastAccepted': None, 'runs': [], 'attempts': [], 'lastRunEnd': 0,
            'active': None, 'lastResult': None, 'ids': []}


def admit(state, request, now, current, recorded=lambda request_id: False):
    """The refusal code for a parsed request, or None. Checked before anything is fetched. recorded(id) is true when a
    history record exists, so trimming the id list can never let a request overwrite an audit record."""
    if state['blocked']: return 'needs-host-ack'
    if state['active']: return 'busy'
    if request['id'] in state['ids'] or recorded(request['id']): return 'duplicate'
    last = state['lastAccepted']
    if abs(request['at'] - now) > CLOCK_SKEW or (last and request['at'] <= last['at']): return 'stale'
    try:
        if not newer(request['version'], current): return 'version-refused'
    except ValueError:
        return 'state-mismatch'
    if state['exit4'].get(request['version'], 0) >= 2: return 'needs-host-ack'
    if (now - state['lastRunEnd'] < COOLDOWN or len([t for t in state['runs'] if now - t < 86400]) >= RUNS_PER_DAY
            or len([t for t in state['attempts'] if now - t < 86400]) >= ATTEMPTS_PER_DAY): return 'rate-limited'
    return None


def rate_limit_detail(state, now):
    """Which limit refused a request and the earliest time a new run is allowed, or None when neither applies. The limits
    themselves: 60 s after a run ends, at most RUNS_PER_DAY runs that changed something and ATTEMPTS_PER_DAY accepted runs
    in any 24 hours."""
    cooldown = state['lastRunEnd'] + COOLDOWN if now - state['lastRunEnd'] < COOLDOWN else None
    daily = None
    for times, cap in ((state['runs'], RUNS_PER_DAY), (state['attempts'], ATTEMPTS_PER_DAY)):
        recent = sorted(t for t in times if now - t < 86400)
        if len(recent) >= cap: daily = max(daily or 0, recent[len(recent) - cap] + 86400)
    if cooldown is None and daily is None: return None
    if daily is not None and (cooldown is None or daily >= cooldown): return {'limit': 'daily', 'retryAt': iso(math.ceil(daily))}
    return {'limit': 'cooldown', 'retryAt': iso(math.ceil(cooldown))}


def accept(state, request, now, peer):
    state['ids'] = (state['ids'] + [request['id']])[-1000:]
    state['lastAccepted'] = {'id': request['id'], 'at': request['at']}
    state['runs'] = [t for t in state['runs'] if now - t < 86400] + [now]
    state['attempts'] = [t for t in state['attempts'] if now - t < 86400] + [now]
    state['active'] = {'id': request['id'], 'target': request['version'], 'acceptedAt': now, 'runStepStarted': False, 'peer': peer}


def block(state, reason):
    state['blocked'], state['blockedReason'] = True, reason


def finish(state, code, now, reason=None):
    """Record the end of the active run. code: upgrade.sh exit code, or None for an interrupted run step."""
    active, state['active'], state['lastRunEnd'] = state['active'], None, now
    # Exit 2 (refused before changing anything) and 3 (jobs still busy) changed nothing: give the daily slot back.
    if code in (2, 3) and active and active.get('acceptedAt') in state['runs']: state['runs'].remove(active['acceptedAt'])
    target = active['target'] if active else None
    state['lastResult'] = {'requestId': active and active['id'], 'exitCode': code, 'refusal': None,
                           'reason': reason if reason in REASONS else (None if reason is None else 'unknown'), 'finishedAt': iso(now)}
    # Consecutive exit-4 results per target (D17, D22): only a success or --ack resets the count, so refusals in between
    # cannot be used to keep cycling.
    if code == 0: state['exit4'].pop(target, None)
    elif code == 4:
        state['exit4'][target] = state['exit4'].get(target, 0) + 1
        if state['exit4'][target] >= 2: block(state, 'repeated-rollback')
    # Once the run step started, every end other than 0, 2, 3 or 4 blocks (fail closed); before it, nothing ran.
    elif active and active.get('runStepStarted') and code not in (2, 3):
        block(state, 'exit-%d' % code if code in (5, 6) else 'interrupted' if code is None else 'unexpected-exit')
    return state['lastResult']


def reconcile(state, last_status, now):
    """On start: classify a run the broker did not finish (F8, N5). Returns the recorded result or None."""
    active = state['active']
    if not active: return None
    if not active.get('runStepStarted'): return finish(state, 2, now, 'interrupted')  # stopped in verify: nothing changed
    if last_status and last_status.get('requestId') == active['id'] and last_status.get('phase') in ('cleanup', 'done') and last_status.get('ok') is True:
        return finish(state, 0, now)
    return finish(state, None, now, 'interrupted')


def ack(state):
    """sudo scripts/install-updater.sh --ack (D15, D23): lifts the block and the consecutive exit-4 counts."""
    if state['active']: raise Refused('busy', 'a run is active')
    state['blocked'], state['blockedReason'], state['exit4'] = False, None, {}


def run_deadline(started, now):
    """Per-run limit: None, 'term' at 2 h, 'kill' after 15 min more (AR2-N3, N19)."""
    if now - started >= RUN_LIMIT + RUN_GRACE: return 'kill'
    if now - started >= RUN_LIMIT: return 'term'
    return None


def idle_exit(last_accepted, now, running):
    """Only accepted requests reset the idle timer; refused or malformed chatter never keeps the broker resident."""
    return not running and now - last_accepted >= IDLE_EXIT


class Limiter:
    """At most CONNECTIONS_PER_MINUTE connections; more are closed without reading."""
    def __init__(self): self.times = []
    def allow(self, now):
        self.times = [t for t in self.times if now - t < 60]
        if len(self.times) >= CONNECTIONS_PER_MINUTE: return False
        self.times.append(now); return True


# ---------------------------------------------------------------- status channel (section 4, R9, I18, I32)

STATUS_FIELDS = ('phase', 'from', 'to', 'startedAt', 'updatedAt', 'ok', 'error', 'rollbackHint', 'requestId', 'warning', 'reason', 'schemaFrom', 'schemaTo', 'cleanup')


def clean_text(value, cap):
    return CONTROL.sub('', value)[:cap]


def validate_status(raw, request_id):
    """upgrade.sh status -> (allow-listed dict, dropped field names). None when it belongs to another request.
    Raises ValueError for a known field with an invalid value; the caller then publishes a failed status."""
    if len(raw) > STATUS_CAP: raise ValueError('status larger than 16 KiB')
    value = json.loads(raw.decode('utf-8', 'strict'), object_pairs_hook=_pairs, parse_int=_int, parse_float=_reject, parse_constant=_reject)
    if type(value) is not dict: raise ValueError('status is not an object')
    if value.get('requestId') != request_id: return None  # a stale file from an earlier run is never shown as current
    out, dropped = {}, sorted(key for key in value if key not in STATUS_FIELDS)
    for key in STATUS_FIELDS:
        if key not in value: continue
        item = value[key]
        if key == 'phase':
            if item not in PHASES: raise ValueError('phase')
        elif key in ('from', 'to'):
            if type(item) is not str or (item and not SEMVER_RE.match(item)): raise ValueError(key)
        elif key in ('startedAt', 'updatedAt'): parse_iso(item)
        elif key == 'ok':
            if item not in (True, False, None) or type(item) not in (bool, type(None)): raise ValueError('ok')
        elif key in ('error', 'rollbackHint', 'warning'):
            if item is not None and type(item) is not str: raise ValueError(key)
            if item is not None: item = clean_text(item, 1024 if key == 'warning' else 4096)
            if key == 'warning' and value[key] is not None and len(value[key]) > 1024: raise ValueError('warning longer than 1024')
        elif key == 'cleanup':  # additive (upgrade.sh after 2.4.1): the one-line retention summary of a success
            if item is not None and type(item) is not str: raise ValueError(key)
            if item is not None: item = clean_text(item, 256)
        elif key == 'reason':
            if item is not None: item = item if item in REASONS else 'unknown'
        elif key in ('schemaFrom', 'schemaTo'):
            if item is not None and (type(item) is not int or not 0 <= item <= 100000): raise ValueError(key)
        out[key] = item
    if 'phase' not in out: raise ValueError('phase missing')
    return out, dropped


def failed_status(request_id, current, target, started, now, error, reason='unknown'):
    return {'phase': 'failed', 'from': current or '', 'to': target or '', 'startedAt': iso(started), 'updatedAt': iso(now), 'ok': False,
            'error': error, 'rollbackHint': None, 'requestId': request_id, 'warning': None, 'reason': reason, 'schemaFrom': None, 'schemaTo': None,
            'cleanup': None}


def new_current(request_id, target, accepted):
    return {'requestId': request_id, 'target': target, 'acceptedAt': iso(accepted), 'events': [], 'truncated': False}


def add_event(current, phase, now):
    """Phase events are made here from validated phase changes, never copied (A15): fixed ids, broker time, 32 maximum."""
    if phase not in PHASES: return
    events = current['events']
    if events and events[-1]['phase'] == phase: return
    if len(events) >= 32: current['truncated'] = True; return
    at = iso(now)
    if events and at < events[-1]['at']: at = events[-1]['at']
    events.append({'phase': phase, 'at': at})


def service_doc(state, install_mode, env, now=None):
    active = state['active']
    return {'schema': 1, 'version': VERSION, 'protocol': PROTOCOL, 'actions': list(ACTIONS), 'installMode': install_mode, 'env': env,
            'blocked': bool(state['blocked']), 'blockedReason': state['blockedReason'], 'consecutiveExit4': dict(state['exit4']),
            'heartbeatAt': iso(now) if active and now else None, 'requestId': active['id'] if active else None, 'lastResult': state['lastResult']}


def read_work_status(dir_fd, owner_uid):
    """status.json from the run step's directory: O_NOFOLLOW|O_NONBLOCK relative to a directory descriptor, a regular file
    owned by the checkout owner with one link, at most 16 KiB (I18). None when absent."""
    try: fd = os.open('status.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, 'O_CLOEXEC', 0), dir_fd=dir_fd)
    except FileNotFoundError: return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner_uid or info.st_nlink != 1 or info.st_size > STATUS_CAP:
            raise ValueError('status.json is not a single-link regular file of the checkout owner within 16 KiB')
        data = os.read(fd, STATUS_CAP + 1)
        if len(data) > STATUS_CAP: raise ValueError('status larger than 16 KiB')
        return data
    finally: os.close(fd)


PUBLISHED = ('status.json', 'current.json', 'service.json')


def read_published(dir_fd, name, owner_uid=0):
    """One of the broker's own published files, read back on start (reconcile): O_NOFOLLOW|O_NONBLOCK relative to the
    status/ descriptor, a single-link regular file of root within 16 KiB. None when absent. A planted link or FIFO is
    never followed or read, so a forged file cannot turn an interrupted run into a success."""
    if name not in PUBLISHED: raise ValueError('not a published file')
    try: fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, 'O_CLOEXEC', 0), dir_fd=dir_fd)
    except FileNotFoundError: return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner_uid or info.st_nlink != 1 or info.st_size > STATUS_CAP:
            raise ValueError('%s is not a single-link regular file of root within 16 KiB' % name)
        data = os.read(fd, STATUS_CAP + 1)
        if len(data) > STATUS_CAP: raise ValueError('%s larger than 16 KiB' % name)
        return data
    finally: os.close(fd)


def publish(dir_fd, name, document):
    """Exclusive temporary name, explicit 0644, fsync, rename. Only the three allow-listed names."""
    if name not in PUBLISHED: raise ValueError('not a published file')
    data = json.dumps(document, separators=(',', ':'), sort_keys=True).encode()
    temp = '.%s.%s' % (name, os.urandom(6).hex())
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | getattr(os, 'O_CLOEXEC', 0), 0o600, dir_fd=dir_fd)
    try:
        os.write(fd, data)
        if hasattr(os, 'fchmod'): os.fchmod(fd, 0o644)
        os.fsync(fd)
    finally: os.close(fd)
    os.rename(temp, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)


def check_volume_dir(path, sock_name='updater.sock'):
    """Before binding or publishing: _data is root:root 0755, no link, no mount point, and the socket path fits sun_path."""
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode): raise ValueError('%s is not a directory' % path)
    if (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (0, 0, 0o755): raise ValueError('%s must be root:root 0755' % path)
    if os.lstat(os.path.dirname(path.rstrip('/'))).st_dev != info.st_dev: raise ValueError('%s is a mount point' % path)
    if len(os.fsencode(os.path.join(path, sock_name))) > 107: raise ValueError('socket path longer than 107 bytes')


# ---------------------------------------------------------------- host state, checkout and Docker checks

def check_tree(root, owner_uid, lstat=os.lstat, walk=os.walk):
    """N1 (I11): the checkout, .git (recursively), .env, compose.override.yaml and data/ belong to the owner or root and
    have no group or other write bit. Returns the first offending path or None. Links are never followed."""
    def bad(path):
        try: info = lstat(path)
        except FileNotFoundError: return False
        return info.st_uid not in (owner_uid, 0) or info.st_mode & 0o022 and not stat.S_ISLNK(info.st_mode)
    for name in ('', '.git', '.env', 'compose.override.yaml', 'data'):
        path = posixpath.join(root, name) if name else root
        if bad(path): return path
    for top, dirs, files in walk(posixpath.join(root, '.git'), followlinks=False):
        for name in dirs + files:
            if bad(posixpath.join(top, name)): return posixpath.join(top, name)
    return None


def git_config_refusal(listing):
    """`git config --file .git/config --list -z` output -> the first key outside the allow-list, or None (F3d)."""
    for entry in listing.split('\0'):
        if not entry: continue
        key = entry.split('\n', 1)[0].lower()
        if not GIT_CONFIG_ALLOWED.match(key): return key
    return None


def tracked_change_refusal(porcelain):
    """F10, I15: a modified tracked file refuses the run. Untracked and ignored files (compose.override.yaml, .env, data/)
    are the operator's and stay allowed: with --expect-commit, upgrade.sh builds from `git archive <sha>`."""
    for entry in porcelain.split('\0'):
        if len(entry) > 3 and entry[2] == ' ' and entry[:2] not in ('??', '!!'): return entry[3:]
    return None


def host_state_refusal(mode, current, exact_tag, head, pinned, label=None, repo_digests=()):
    """F2, F18, N12: package.json at HEAD, the exact tag at HEAD and the pinned commit of the current release agree; image
    mode also needs the running api image's version label and RepoDigest. Returns a reason or None."""
    if not current or exact_tag != 'v' + current: return 'package.json and the tag at HEAD disagree'
    if not pinned or pinned.get('commit') != head: return 'HEAD is not the verified commit of v%s' % current
    if mode == 'image':
        if label != current: return 'the running api image is not %s' % current
        if not pinned.get('digest') or '%s@%s' % (IMAGE, pinned['digest']) not in repo_digests: return 'the running api image digest is not the verified one'
    return None


def mount_refusal(containers, api_id):
    """F15, section 4: the api container mounts the volume read-only and no container mounts it read-write."""
    api_ro = False
    for container in containers:
        for mount in container.get('Mounts') or []:
            if mount.get('Type') != 'volume' or mount.get('Name') != VOLUME: continue
            if mount.get('RW') is not False: return 'container %s mounts %s read-write' % (str(container.get('Id'))[:12], VOLUME)
            if container.get('Id') == api_id: api_ro = True
    return None if api_ro else 'the api container does not mount %s read-only' % VOLUME


def install_mode(config_image):
    return 'image' if re.match(re.escape(IMAGE) + r'[:@]', config_image or '') else 'source'


def capabilities_refusal(output, mode):
    """F18: every required flag appears in `upgrade.sh --capabilities` (text or JSON)."""
    flags = set(re.findall(r'--[a-z][a-z-]*', output or ''))
    needed = REQUIRED_FLAGS + (('--expect-image-digest',) if mode == 'image' else ())
    missing = [flag for flag in needed if flag not in flags]
    return 'upgrade.sh lacks %s' % ' '.join(missing) if missing else None


def run_argv(target, commit, request_id, digest=None):
    """F17: the exact argv of the run step. No shell, no value from the request except the validated tag and UUID."""
    if not TAG_RE.match(target) or not SHA_RE.match(commit) or not UUID_RE.match(request_id): raise ValueError('argv')
    argv = ['/bin/sh', 'scripts/upgrade.sh', '--non-interactive', '--upgrade-only', '--no-fetch', '--expect-commit', commit,
            '--version', target, '--request-id', str(uuid.UUID(request_id)), '--status-file', WORK_DIR + '/status.json']
    if digest is not None:
        if not DIGEST_RE.match(digest): raise ValueError('digest')
        argv += ['--expect-image-digest', digest]
    return argv


def git_env(home):
    """Clean git environment (F3, F3a): no system or global config, no replace objects, hooks off for every git call."""
    return {'PATH': PATH, 'HOME': home, 'LANG': 'C.UTF-8', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
            'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_TERMINAL_PROMPT': '0', 'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'core.hooksPath',
            'GIT_CONFIG_VALUE_0': '/dev/null'}


def as_user(uid, gid, env, argv):
    """setpriv drop (D2, I12): no --bounding-set (no CAP_SETPCAP), no inheritable caps, clean env, parent-death SIGTERM."""
    return [SETPRIV, '--reuid=%d' % uid, '--regid=%d' % gid, '--init-groups', '--inh-caps=-all', '--reset-env', '--pdeathsig=SIGTERM',
            '--', ENV, '-i'] + ['%s=%s' % item for item in sorted(env.items())] + list(argv)


def disk_refusal(free_checkout, free_docker, image_size):
    floor = FLOOR_BYTES + max(0, int(image_size or 0))
    return None if min(free_checkout, free_docker) >= floor else 'free space below %d MiB' % (floor // 1048576)


def coarse_version(text):
    match = re.search(r'(\d{1,3})\.(\d{1,3})', text or '')
    return '%s.%s' % match.groups() if match else None


def os_family(text):
    values = dict(re.findall(r'^([A-Z_]+)=["\']?([^"\'\n]*)["\']?$', text or '', re.M))
    family = values.get('ID') if values.get('ID') in ('debian', 'ubuntu') else 'other'
    major = re.match(r'(\d{1,3})', values.get('VERSION_ID', ''))
    return family, major.group(1) if major else None


def disk_bucket(free):
    gib = free / 1024 ** 3
    return '<2' if gib < 2 else '2-10' if gib < 10 else '10-50' if gib < 50 else '>50'


def coarse_env(docker_text, compose_text, os_release, release, machine, git_text, free):
    """I35: coarse values only, each checked before it is written, never from owner configuration."""
    family, major = os_family(os_release)
    env = {'docker': coarse_version(docker_text), 'compose': coarse_version(compose_text), 'os': family, 'osVersion': major,
           'kernel': coarse_version(release), 'arch': machine if re.match(r'[a-z0-9_]{1,16}\Z', machine or '') else None,
           'git': coarse_version(git_text), 'cosign': COSIGN_VERSION, 'disk': disk_bucket(free)}
    return {key: value for key, value in env.items() if value is not None}


def journal_fields(fields):
    """Native journald datagram (F5): KEY=value lines; values with a newline use the length-prefixed form."""
    out = b''
    for key, value in fields.items():
        if not re.match(r'[A-Z][A-Z0-9_]{0,63}\Z', key): continue
        data = str(value).encode('utf-8', 'replace')
        out += key.encode() + (b'\n' + struct.pack('<Q', len(data)) + data + b'\n' if b'\n' in data else b'=' + data + b'\n')
    return out


def escape_log(data, prefix):
    """Run-step output for the history log: control characters escaped, each line prefixed (F5)."""
    text = data.decode('utf-8', 'replace')
    return ''.join('%s%s\n' % (prefix, CONTROL.sub(lambda m: '\\x%02x' % ord(m.group()), line)) for line in text.splitlines())


# ---------------------------------------------------------------- version trust (section 5)

def oid_der(dotted):
    parts = [int(p) for p in dotted.split('.')]
    out = bytearray([parts[0] * 40 + parts[1]])
    for part in parts[2:]:
        chunk = [part & 0x7f]; part >>= 7
        while part: chunk.insert(0, 0x80 | (part & 0x7f)); part >>= 7
        out += bytes(chunk)
    return bytes(out)


FULCIO = {oid_der('1.3.6.1.4.1.57264.1.15'): 'repositoryId', oid_der('1.3.6.1.4.1.57264.1.17'): 'ownerId'}


def der_items(data):
    i = 0
    while i < len(data):
        tag = data[i]; i += 1
        if tag & 0x1f == 0x1f or i >= len(data): raise ValueError('unsupported DER')
        length = data[i]; i += 1
        if length & 0x80:
            n = length & 0x7f
            if not 0 < n <= 4: raise ValueError('DER length')
            length = int.from_bytes(data[i:i + n], 'big'); i += n
        if i + length > len(data): raise ValueError('DER overrun')
        yield tag, data[i:i + length]; i += length


def fulcio_ids(der, depth=0):
    """The Fulcio source repository and owner id extensions (.15 and .17) of a certificate (F9, P9)."""
    found = {}
    if depth > 16: raise ValueError('DER too deep')
    for tag, value in der_items(der):
        if tag == 0x30:
            items = list(der_items(value))
            if items and items[0][0] == 0x06 and items[0][1] in FULCIO and items[-1][0] == 0x04:
                inner = list(der_items(items[-1][1]))
                if len(inner) == 1 and inner[0][0] in (0x0c, 0x13, 0x16): found[FULCIO[items[0][1]]] = inner[0][1].decode('utf-8')
                continue
        if tag & 0x20: found.update(fulcio_ids(value, depth + 1))
    return found


def bundle_certificate(bundle):
    material = bundle.get('verificationMaterial') or {}
    raw = (material.get('certificate') or {}).get('rawBytes') or ((material.get('x509CertificateChain') or {}).get('certificates') or [{}])[0].get('rawBytes')
    if not isinstance(raw, str): raise ValueError('bundle has no certificate')
    return base64.b64decode(raw, validate=True)


def redirect_allowed(location):
    """Section 8: one redirect, https, port 443 or none, exact asset host, no credentials."""
    from urllib.parse import urlsplit
    try: url = urlsplit(location)
    except ValueError: return False
    try: port = url.port
    except ValueError: return False
    return url.scheme == 'https' and url.hostname in ASSET_HOSTS and port in (None, 443) and url.username is None and url.password is None \
        and url.netloc.lower() in (url.hostname, url.hostname + ':443')


def identity_flags(tag, commit):
    return ['--certificate-identity', 'https://github.com/%s/.github/workflows/release.yml@refs/tags/%s' % (REPOSITORY, tag),
            '--certificate-oidc-issuer', ISSUER, '--certificate-github-workflow-repository', REPOSITORY,
            '--certificate-github-workflow-trigger', 'push', '--certificate-github-workflow-ref', 'refs/tags/' + tag,
            '--certificate-github-workflow-sha', commit]


def verification_refusal(result, target, mode, pins, ids=(REPOSITORY_ID, OWNER_ID)):
    """Root re-checks the verifier's result (section 5 steps 2 to 5). Returns (reason, pin) - reason None when it passes."""
    if not isinstance(result, dict) or result.get('ok') is not True: return (result or {}).get('reason') if (result or {}).get('reason') in REASONS else 'verify-unavailable', None
    manifest, tag_commit = result.get('manifest') or {}, result.get('tagCommit')
    if not SHA_RE.match(tag_commit or ''): return 'tag-missing', None
    if result.get('ancestor') is not True: return 'not-on-main', None
    if (result.get('repositoryId'), result.get('ownerId')) != tuple(ids): return 'signature-invalid', None
    if manifest.get('version') != target[1:] or manifest.get('tag') != target or manifest.get('repository') != REPOSITORY \
            or manifest.get('prerelease') is not False or manifest.get('commit') != tag_commit: return 'signature-invalid', None
    digest = None
    if mode == 'image':
        image = manifest.get('image') or {}
        if image.get('name') != IMAGE or not DIGEST_RE.match(image.get('digest') or '') or result.get('imageVerified') is not True: return 'signature-invalid', None
        digest = image['digest']
    pin = pins.get(target)
    if pin and (pin.get('commit') != tag_commit or (digest and pin.get('digest') and pin['digest'] != digest)): return 'tag-moved', None
    return None, {'commit': tag_commit, 'digest': digest or (pin or {}).get('digest')}


# ---------------------------------------------------------------- process helpers (Linux only)

def load_json(path, default):
    try:
        with open(path, 'rb') as handle: return json.loads(handle.read(1048576))
    except FileNotFoundError: return default


def save_json(path, value, mode=0o600):
    temp = '%s.%s' % (path, os.urandom(6).hex())
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try: os.write(fd, json.dumps(value, sort_keys=True).encode()); os.fsync(fd)
    finally: os.close(fd)
    os.rename(temp, path)
    dfd = os.open(os.path.dirname(path), os.O_RDONLY)
    try: os.fsync(dfd)
    finally: os.close(dfd)


class StateFile:
    """Load-modify-save of state.json under flock(state.lock), shared by the service and the installer commands."""
    def __init__(self, directory=STATE_DIR): self.directory = directory
    def __enter__(self):
        self.fd = os.open(os.path.join(self.directory, 'state.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        self.state = {**new_state(), **load_json(os.path.join(self.directory, 'state.json'), {})}
        return self.state
    def __exit__(self, kind, *_):
        try:
            if kind is None: save_json(os.path.join(self.directory, 'state.json'), self.state)
        finally: os.close(self.fd)


def run(argv, timeout=60, env=None, stdin=None, cwd='/'):
    result = subprocess.run(argv, input=stdin, capture_output=True, timeout=timeout, env=env or {'PATH': PATH, 'HOME': '/root', 'LANG': 'C.UTF-8'}, cwd=cwd)
    return result.returncode, result.stdout, result.stderr


def journal(message, **fields):
    data = {'MESSAGE': message, 'MESSAGE_ID': '5f0c6d1ad1b04f4f9b8a2c4e7d2b9a11', 'SYSLOG_IDENTIFIER': 'docknest-updater', 'PRIORITY': 5}
    data.update({'DOCKNEST_' + key.upper(): value for key, value in fields.items() if value is not None})
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock: sock.sendto(journal_fields(data), '/run/systemd/journal/socket')
    except OSError:
        print('docknest-updater: %s %s' % (message, json.dumps(fields, default=str)), file=sys.stderr, flush=True)


class Host:
    """Everything that touches the host. Kept thin so the policy above stays unit-testable."""
    def __init__(self, config):
        self.cfg = config
        self.checkout, self.uid, self.gid = config['checkout'], int(config['ownerUid']), int(config['ownerGid'])
        self.home = config.get('ownerHome') or '/nonexistent'
        self.status_dir = os.path.join(config['volume'], 'status')

    def docker_json(self, *args):
        code, out, _ = run([DOCKER] + list(args), timeout=30)
        if code: raise RuntimeError('docker %s failed' % args[0])
        return json.loads(out)

    def api_container(self):
        code, out, _ = run([DOCKER, 'ps', '-q', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + PROJECT,
                            '--filter', 'label=com.docker.compose.service=api'], timeout=30)
        ids = out.decode().split()
        if code or len(ids) != 1 or not HEX64.match(ids[0]): raise RuntimeError('expected one running api container')
        return self.docker_json('inspect', ids[0])[0]

    def owner(self, argv, timeout=120):
        env = git_env(self.home); env['DOCKNEST_DIR'] = self.checkout
        return run(as_user(self.uid, self.gid, env, argv), timeout=timeout, cwd=self.checkout)

    def owner_git(self, *args, timeout=60):
        return self.owner([GIT, '-c', 'safe.directory=' + self.checkout, '-c', 'core.fsmonitor=false', '-C', self.checkout] + list(args), timeout)

    def verifier(self, payload, timeout=900):
        account = pwd.getpwnam('docknest-verify')
        env = git_env(os.path.join(STATE_DIR, 'verify-home')); env['TUF_ROOT'] = os.path.join(STATE_DIR, 'sigstore')
        code, out, err = run(as_user(account.pw_uid, account.pw_gid, env, ['/usr/bin/python3', '-I', '-B', os.path.abspath(__file__), 'verify']),
                             timeout=timeout, stdin=json.dumps(payload).encode())
        try: result = json.loads(out[-65536:] or b'null')
        except ValueError: result = None
        if isinstance(result, dict): return result
        # the verifier never started or crashed: keep its last stderr line (printable, 200 characters) for the host
        last = (err.strip().splitlines() or [b''])[-1].decode('ascii', 'replace')
        journal('verifier did not answer', exit_code=code, detail=re.sub(r'[^ -~]', '?', last)[:200] or None, result='verify-unavailable')
        return {'ok': False, 'reason': 'verify-unavailable'}

    def environment(self):
        def text(argv):
            try: return run(argv, timeout=20)[1].decode('utf-8', 'replace')
            except (OSError, subprocess.SubprocessError): return ''
        try:
            with open('/etc/os-release', encoding='utf-8', errors='replace') as handle: release = handle.read(8192)
        except OSError: release = ''
        disk = os.statvfs(self.checkout)
        return coarse_env(text([DOCKER, 'version', '--format', '{{.Server.Version}}']), text([DOCKER, 'compose', 'version', '--short']),
                          release, os.uname().release, os.uname().machine, text([GIT, '--version']), disk.f_bavail * disk.f_frsize)


# ---------------------------------------------------------------- the service

class Broker:
    def __init__(self, config, host=None):
        self.cfg, self.host = config, host or Host(config)
        self.lock, self.runs, self.limiter = threading.Lock(), queue.Queue(), Limiter()
        self.stop, self.running, self.last_accepted = threading.Event(), False, time.time()
        self.mode, self.env, self.status_fd = 'source', {}, None

    # -- publishing
    def open_status(self):
        check_volume_dir(self.cfg['volume'])
        if self.status_fd is None:
            path = self.host.status_dir
            try: os.mkdir(path, 0o755)
            except FileExistsError: pass
            fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            info = os.fstat(fd)
            if (info.st_uid, stat.S_IMODE(info.st_mode)) != (0, 0o755): os.close(fd); raise ValueError('status/ must be root 0755')
            self.status_fd = fd
        return self.status_fd

    def publish(self, name, document):
        try: publish(self.open_status(), name, document)
        except (OSError, ValueError) as error: journal('could not publish %s: %s' % (name, error), result='publish-failed')

    def publish_service(self, state, now=None):
        self.publish('service.json', service_doc(state, self.mode, self.env, now))

    def refresh(self):
        try:
            api = self.host.api_container(); self.mode = install_mode(api['Config']['Image'])
        except (RuntimeError, KeyError, ValueError, OSError, subprocess.SubprocessError): pass
        try: self.env = self.host.environment()
        except (OSError, subprocess.SubprocessError): pass

    # -- request handling
    def peer(self, conn):
        pid, uid, _ = struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != int(self.cfg.get('apiUid', 1000)): raise Refused('invalid', 'peer uid %d' % uid)
        pidfd = None
        try: pidfd = conn.getsockopt(socket.SOL_SOCKET, 77)  # SO_PEERPIDFD, Linux 6.5+
        except OSError: pass
        try:
            with open('/proc/%d/cgroup' % pid, encoding='utf-8') as handle: cgroups = handle.read(65536)
            container = cgroup_container(cgroups, self.cfg.get('cgroupParent'))
            if pidfd is not None: signal.pidfd_send_signal(pidfd, 0)
        except OSError: raise Refused('invalid', 'peer process gone')
        finally:
            if pidfd is not None: os.close(pidfd)
        api = self.host.api_container()
        # The cgroup path is not secret and shows why a caller was refused (for example a cgroup_parent or nested LXC).
        if container != api['Id']: raise Refused('invalid', 'peer is not the api container (cgroup %s)' % cgroup_paths(cgroups))
        return {'pid': pid, 'uid': uid, 'container': container}, api

    def handle(self, conn):
        code, request, extra = None, None, None
        try:
            peer, api = self.peer(conn)
            request = parse_request(read_request(conn))
            if not self.lock.acquire(blocking=False): raise Refused('busy', 'another request is being checked')
            try: code = self.admit(request, peer, api)
            finally: self.lock.release()
        except Refused as refused:
            code, extra = refused.code, refused.extra
            journal('request refused: %s' % refused.detail, request_id=request and request['id'], result=code)
        except Exception as error:  # noqa: BLE001 - every unexpected error is a refusal, never a crash of the broker
            code = 'invalid'; journal('request failed: %s' % type(error).__name__, result=code)
        try: conn.settimeout(READ_SECONDS); conn.sendall(response(code is None, request['id'] if code is None else code, extra))
        except OSError: pass
        finally: conn.close()

    def admit(self, request, peer, api):
        now = time.time()
        with StateFile() as state:
            if self.running: raise Refused('busy', 'a run is active')
            current = self.current_version()
            code = admit(state, request, now, current, lambda rid: os.path.lexists(os.path.join(STATE_DIR, 'history', rid + '.json')))
            if code: raise Refused(code, 'policy', rate_limit_detail(state, now) if code == 'rate-limited' else None)
            self.refresh()
            try: reason = self.preconditions(state, current, api)
            except (RuntimeError, OSError, ValueError, KeyError, IndexError, subprocess.SubprocessError) as error: reason = 'host check failed: %s' % type(error).__name__
            if reason: raise Refused('low-disk' if reason.startswith('free space') else 'state-mismatch', reason)
            accept(state, request, now, peer)
            self.history(request['id'], {'requestId': request['id'], 'target': request['version'], 'from': current, 'peer': peer,
                                         'requestedBy': {'claimed': request['requestedBy']}, 'requestedAt': iso(request['at']), 'acceptedAt': iso(now)})
            self.running, self.last_accepted = True, now
            self.publish_service(state, now)
        journal('request accepted', request_id=request['id'], target=request['version'], result='accepted', peer_pid=peer['pid'], container=peer['container'][:12])
        self.runs.put((request, current))
        return None

    def current_version(self):
        code, out, _ = self.host.owner_git('show', 'HEAD:package.json')
        try: version = json.loads(out)['version'] if code == 0 else None
        except (ValueError, KeyError, TypeError): version = None
        if not isinstance(version, str) or not SEMVER_RE.match(version): raise Refused('state-mismatch', 'package.json at HEAD has no version')
        return version

    def preconditions(self, state, current, api):
        """Section 6 and 7 checks before a run: host state, checkout control, mounts, build inputs, capabilities, disk."""
        host, pins = self.host, load_json(os.path.join(STATE_DIR, 'pins.json'), {})
        offending = check_tree(host.checkout, host.uid)
        if offending: return 'checkout path %s is not owned by the checkout owner or is group/other writable' % offending
        code, out, _ = host.owner_git('config', '--file', '.git/config', '--list', '-z')
        key = git_config_refusal(out.decode('utf-8', 'replace')) if code == 0 else '.git/config unreadable'
        if key: return '.git/config key %s is not allowed' % key
        for marker in ('.git/info/grafts', '.git/shallow'):
            if os.path.lexists(os.path.join(host.checkout, marker)): return '%s exists' % marker
        code, out, _ = host.owner_git('for-each-ref', '--format=%(refname)', 'refs/replace/')
        if code or out.strip(): return 'refs/replace exists'
        head = host.owner_git('rev-parse', 'HEAD')[1].decode().strip()
        tag = host.owner_git('describe', '--exact-match', '--tags', 'HEAD')[1].decode().strip()
        image = self.host.docker_json('image', 'inspect', api['Image'])[0]
        labels = (api.get('Config') or {}).get('Labels') or {}
        reason = host_state_refusal(self.mode, current, tag, head, pins.get('v' + current), labels.get('org.opencontainers.image.version'), image.get('RepoDigests') or ())
        if reason: return reason
        containers = [self.host.docker_json('inspect', cid)[0] for cid in run([DOCKER, 'ps', '-aq', '--no-trunc', '--filter', 'volume=' + VOLUME])[1].decode().split()]
        reason = mount_refusal(containers, api['Id'])
        if reason: return reason
        code, out, _ = host.owner_git('status', '--porcelain', '--untracked-files=no', '-z')
        path = tracked_change_refusal(out.decode('utf-8', 'replace')) if code == 0 else 'git status failed'
        if path: return 'tracked file %s is modified' % path
        code, out, _ = host.owner(['/bin/sh', 'scripts/upgrade.sh', '--capabilities'], timeout=30)
        reason = capabilities_refusal(out.decode('utf-8', 'replace') if code == 0 else '', self.mode)
        if reason: return reason
        free = [os.statvfs(p) for p in (host.checkout, self.cfg['dockerRoot'])]
        return disk_refusal(*[s.f_bavail * s.f_frsize for s in free], image.get('Size'))

    def history(self, request_id, update):
        path = os.path.join(STATE_DIR, 'history', request_id + '.json')
        save_json(path, {**load_json(path, {}), **update})

    # -- the run (main thread, so PR_SET_PDEATHSIG follows the broker's lifetime)
    def execute(self, request, current):
        rid, target, started = request['id'], request['version'], time.time()
        cur = new_current(rid, target, started)
        add_event(cur, 'verify', started); self.publish('current.json', cur)
        self.publish('status.json', {'phase': 'verify', 'from': current, 'to': target, 'startedAt': iso(started), 'updatedAt': iso(started), 'ok': None,
                                     'error': None, 'rollbackHint': None, 'requestId': rid, 'warning': None, 'reason': None, 'schemaFrom': None, 'schemaTo': None})
        pins_path = os.path.join(STATE_DIR, 'pins.json')
        result = self.host.verifier({'target': target, 'mode': self.mode})
        reason, pin = verification_refusal(result, target, self.mode, load_json(pins_path, {}))
        self.history(rid, {'verification': {'reason': reason, 'tagCommit': (result or {}).get('tagCommit'), 'ancestor': (result or {}).get('ancestor'),
                                            'imageVerified': (result or {}).get('imageVerified')}})
        if reason: return self.end(rid, current, target, started, cur, 2, reason, 'Release verification failed (%s); nothing was changed.' % reason)
        pins = load_json(pins_path, {}); pins[target] = pin; save_json(pins_path, pins)  # TOFU (section 5 rule 5)
        mirror = os.path.join(STATE_DIR, 'mirror.git')
        code, _, _ = self.host.owner([GIT, '-c', 'safe.directory=' + mirror, '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
                                      '-C', self.host.checkout, 'fetch', '--no-tags', mirror, 'refs/tags/%s:refs/tags/%s' % (target, target)], timeout=600)
        if code: return self.end(rid, current, target, started, cur, 2, 'checkout-failed', 'Could not fetch the verified tag into the checkout; nothing was changed.')
        argv = run_argv(target, pin['commit'], rid, pin['digest'] if self.mode == 'image' else None)
        env = git_env(self.host.home); env['DOCKNEST_DIR'] = self.host.checkout
        try:
            dir_fd = os.open(WORK_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            info = os.fstat(dir_fd)
            if info.st_uid != self.host.uid or info.st_mode & 0o022: os.close(dir_fd); raise ValueError(WORK_DIR)
        except (OSError, ValueError):
            return self.end(rid, current, target, started, cur, 2, 'state-mismatch', '%s is missing or is not the 0750 directory of the checkout owner; run --repair.' % WORK_DIR)
        try: log = os.open(os.path.join(STATE_DIR, 'history', rid + '.out'), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except OSError:
            os.close(dir_fd); return self.end(rid, current, target, started, cur, 2, 'state-mismatch', 'Could not create the run log; nothing was changed.')
        # Parent death (A11, I27): setpriv --pdeathsig=SIGTERM arms it after the uid change (which would clear an earlier
        # one), so no preexec_fn runs in the forked child. If the broker dies in the moments between fork and that prctl,
        # the child gets no signal; systemd's stop (KillMode=mixed) then kills what is left in the unit's cgroup (P10).
        try:
            with StateFile() as state:  # written and fsynced right before the run step exists (F8)
                state['active']['runStepStarted'] = True
            try:
                child = subprocess.Popen(as_user(self.host.uid, self.host.gid, env, argv), cwd=self.host.checkout, stdin=subprocess.DEVNULL, stdout=log,
                                         stderr=log, start_new_session=True, close_fds=True)
            except OSError:  # nothing ran: never an interrupted block
                with StateFile() as state: state['active']['runStepStarted'] = False
                os.close(dir_fd); return self.end(rid, current, target, started, cur, 2, 'state-mismatch', 'The run step could not start; nothing was changed.')
        finally: os.close(log)
        journal('run step started', request_id=rid, target=target, result='running')
        try: code, last = self.follow(child, dir_fd, rid, current, target, started, cur)
        except BaseException:  # never leave a run step unwatched: TERM, its own revert time, then KILL
            for sig, wait in ((signal.SIGTERM, RUN_GRACE - 30), (signal.SIGKILL, 30)):
                try: os.killpg(child.pid, sig); child.wait(wait); break
                except (ProcessLookupError, subprocess.TimeoutExpired): continue
            raise
        finally: os.close(dir_fd)
        if code < 0: code = None  # killed by a signal: interrupted
        if last and last.get('phase') in ('cleanup', 'done') and last.get('ok') is True: code = 0  # a cleanup abort is a success
        reason = None if code == 0 else 'interrupted' if code is None else (last or {}).get('reason')
        return self.end(rid, current, target, started, cur, code, reason, None, last)

    def follow(self, child, dir_fd, rid, current, target, started, cur):
        last, signalled, stop_at = None, None, None
        while True:
            now = time.time()
            if self.stop.is_set() and stop_at is None: stop_at = now
            # On the broker's own SIGTERM: the same TERM, grace and KILL as the time limit, before systemd's 15 min stop timeout.
            action = run_deadline(started, now) or (run_deadline(stop_at - RUN_LIMIT - 30, now) if stop_at else None)
            if action and action != signalled:
                journal('run step %s at the time limit or on stop' % action, request_id=rid, result='time-limit')
                try: os.killpg(child.pid, signal.SIGKILL if action == 'kill' else signal.SIGTERM)
                except ProcessLookupError: pass
                signalled = action
            try:
                raw = read_work_status(dir_fd, self.host.uid)
                checked = validate_status(raw, rid) if raw is not None else None
                if checked:
                    status, dropped = checked
                    if dropped: journal('status fields dropped: %s' % ','.join(dropped)[:200], request_id=rid)
                    if status != last: last = status; self.publish('status.json', status); add_event(cur, status['phase'], now); self.publish('current.json', cur)
            except (OSError, ValueError, RecursionError) as error:
                journal('invalid run-step status: %s' % type(error).__name__, request_id=rid, result='status-invalid')
                self.publish('status.json', failed_status(rid, current, target, started, now, 'The host updater could not read the upgrade status.'))
            with StateFile() as state: self.publish_service(state, now)  # heartbeat
            code = child.poll()
            if code is not None:
                try:  # the final status may land right before exit
                    raw = read_work_status(dir_fd, self.host.uid); checked = validate_status(raw, rid) if raw else None
                    if checked and checked[0] != last: last = checked[0]; self.publish('status.json', last); add_event(cur, last['phase'], time.time())
                except (OSError, ValueError, RecursionError): pass
                return code, last
            time.sleep(POLL)

    def end(self, rid, current, target, started, cur, code, reason, error, last=None):
        """Final event and status: current.json ends with done or failed and status.json carries a boolean ok (the kit guard reads both)."""
        now = time.time()
        add_event(cur, 'done' if code == 0 else 'failed', now); self.publish('current.json', cur)
        if code == 0:
            if not last or last.get('phase') != 'done' or last.get('ok') is not True:
                self.publish('status.json', {**(last or {}), 'phase': 'done', 'ok': True, 'requestId': rid, 'updatedAt': iso(now)})
        elif error or not last or last.get('ok') is not False:
            self.publish('status.json', failed_status(rid, current, target, started, now, error or 'The upgrade ended without a final status (%s); check the host.'
                                                      % ('interrupted' if code is None else 'exit %d' % code), reason or 'unknown'))
        with StateFile() as state:
            result = finish(state, code, now, reason)
            self.publish_service(state)
        self.history(rid, {'exitCode': code, 'reason': result['reason'], 'finishedAt': result['finishedAt'], 'finalStatus': last,
                           'blocked': state['blocked'], 'blockedReason': state['blockedReason']})
        out = os.path.join(STATE_DIR, 'history', rid + '.out')
        if os.path.exists(out):  # attach run-step output escaped and prefixed; never forwarded to the journal (F5)
            with open(out, 'rb') as handle: data = handle.read(1048576)
            save_json(os.path.join(STATE_DIR, 'history', rid + '.log.json'), {'lines': escape_log(data, 'run| ')}); os.unlink(out)
        journal('run finished', request_id=rid, target=target, exit_code=code, reason=result['reason'], result='blocked' if state['blocked'] else 'finished')
        self.running = False

    # -- lifecycle
    def startup(self):
        self.refresh()
        with StateFile() as state:
            last = None
            try: last = json.loads(read_published(self.open_status(), 'status.json') or b'null')
            except (OSError, ValueError, RecursionError): last = None
            if not isinstance(last, dict): last = None
            active = state['active']
            result = reconcile(state, last, time.time())
            if result:
                journal('interrupted run reconciled', request_id=result['requestId'], exit_code=result['exitCode'], result='blocked' if state['blocked'] else 'reconciled')
                if result['exitCode'] != 0:
                    self.publish('status.json', failed_status(result['requestId'], (last or {}).get('from'), active['target'], active['acceptedAt'], time.time(),
                                                              'interrupted; check the host', 'interrupted'))
            self.publish_service(state)

    def serve(self, listener):
        signal.signal(signal.SIGTERM, lambda *_: self.stop.set())
        self.startup()
        def accept_loop():
            while not self.stop.is_set():
                try: conn, _ = listener.accept()
                except OSError: continue
                if not self.limiter.allow(time.time()): conn.close(); continue
                threading.Thread(target=self.handle, args=(conn,), daemon=True).start()
        threading.Thread(target=accept_loop, daemon=True).start()
        while not self.stop.is_set():
            try: request, current = self.runs.get(timeout=5)
            except queue.Empty:
                if self.lock.acquire(blocking=False):  # no admission in flight while deciding to exit
                    if idle_exit(self.last_accepted, time.time(), self.running) and self.runs.empty(): self.stop.set(); return 0
                    self.lock.release()
                continue
            fd = os.open(os.path.join(STATE_DIR, 'lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)  # one run at a time; the installer's --ack and --repair test it
                self.execute(request, current)
            except Exception as error:  # noqa: BLE001
                journal('run failed in the broker: %s' % type(error).__name__, request_id=request['id'], result='broker-error')
                with StateFile() as state:
                    if state['active']:
                        finish(state, None if state['active'].get('runStepStarted') else 2, time.time(), 'interrupted'); self.publish_service(state)
                self.running = False
            finally: os.close(fd)
        return 0


# ---------------------------------------------------------------- verifier (runs as docknest-verify, I19)

def fetch_asset(url, cap=ASSET_CAP, timeout=10):
    import http.client, ssl
    from urllib.parse import urlsplit
    context = ssl.create_default_context()
    for hop in range(2):
        parts = urlsplit(url)
        conn = http.client.HTTPSConnection(parts.hostname, 443, timeout=timeout, context=context)
        try:
            conn.request('GET', parts.path + ('?' + parts.query if parts.query else ''), headers={'User-Agent': 'docknest-updater/' + VERSION, 'Accept': '*/*'})
            reply = conn.getresponse()
            if reply.status in (301, 302, 303, 307, 308) and hop == 0:
                location = reply.getheader('Location') or ''
                if not redirect_allowed(location): raise ValueError('redirect to a host that is not allowed')
                url = location; continue
            if reply.status != 200: raise ValueError('HTTP %d' % reply.status)
            data = reply.read(cap + 1)
            if len(data) > cap: raise ValueError('asset larger than 64 KiB')
            return data
        finally: conn.close()
    raise ValueError('too many redirects')


def verify_main(payload):
    """Fetch into the mirror, check ancestry, download and cosign-verify the manifest (and image), read the numeric ids."""
    os.umask(0o022)  # the checkout owner reads the mirror
    target, mode = payload['target'], payload['mode']
    if not TAG_RE.match(target) or mode not in ('source', 'image'): return {'ok': False, 'reason': 'unknown'}
    mirror = os.path.join(STATE_DIR, 'mirror.git')
    git = [GIT, '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '--git-dir', mirror]
    code, _, _ = run(git + ['fetch', '--no-tags', REMOTE, 'refs/heads/main:refs/heads/main', 'refs/tags/%s:refs/tags/%s' % (target, target)], timeout=600, env=dict(os.environ))
    if code: return {'ok': False, 'reason': 'tag-missing'}  # also a force-moved main or tag: a non-forced fetch refuses
    tag_commit = run(git + ['rev-parse', '--verify', 'refs/tags/%s^{commit}' % target], env=dict(os.environ))[1].decode().strip()
    ancestor = run(git + ['merge-base', '--is-ancestor', tag_commit, 'refs/heads/main'], env=dict(os.environ))[0] == 0
    base = 'https://github.com/%s/releases/download/%s/' % (REPOSITORY, target)
    try: manifest_bytes, bundle_bytes = fetch_asset(base + 'docknest-release.json'), fetch_asset(base + 'docknest-release.json.sigstore.json')
    except (OSError, ValueError): return {'ok': False, 'reason': 'verify-unavailable'}
    work = tempfile.mkdtemp(prefix='verify-')
    try:
        for name, data in (('m.json', manifest_bytes), ('b.json', bundle_bytes)):
            with open(os.path.join(work, name), 'wb') as handle: handle.write(data)
        flags = identity_flags(target, tag_commit)
        code = run([COSIGN, 'verify-blob'] + flags + ['--bundle', os.path.join(work, 'b.json'), os.path.join(work, 'm.json')], timeout=300, env=dict(os.environ))[0]
        if code: return {'ok': False, 'reason': 'signature-invalid'}
        manifest = json.loads(manifest_bytes, object_pairs_hook=_pairs)
        ids = fulcio_ids(bundle_certificate(json.loads(bundle_bytes)))  # the same in-memory bundle cosign verified (F9, I14)
        image_ok = None
        if mode == 'image':
            digest = (manifest.get('image') or {}).get('digest') or ''
            image_ok = bool(DIGEST_RE.match(digest)) and run([COSIGN, 'verify'] + flags + ['%s@%s' % (IMAGE, digest)], timeout=300, env=dict(os.environ))[0] == 0
        keep = ('version', 'tag', 'commit', 'repository', 'prerelease', 'image', 'notes', 'minUpgradeFrom', 'schemaVersion')
        return {'ok': True, 'tagCommit': tag_commit, 'ancestor': ancestor, 'manifest': {k: manifest.get(k) for k in keep},
                'repositoryId': ids.get('repositoryId'), 'ownerId': ids.get('ownerId'), 'imageVerified': image_ok}
    except (ValueError, KeyError, TypeError, OSError):
        return {'ok': False, 'reason': 'signature-invalid'}
    finally:
        for name in os.listdir(work): os.unlink(os.path.join(work, name))
        os.rmdir(work)


# ---------------------------------------------------------------- command line (service and installer helpers)

def load_config(path=CONFIG):
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022: raise SystemExit('%s must be a root-owned file without group or other write' % path)
    config = load_json(path, None)
    for key in ('checkout', 'ownerUid', 'ownerGid', 'volume', 'dockerRoot'):
        if key not in (config or {}): raise SystemExit('%s lacks %s' % (path, key))
    return config


def status_text(state, history):
    lines = ['DockNest host updater %s (protocol %d, actions: %s)' % (VERSION, PROTOCOL, ', '.join(ACTIONS)),
             'Blocked: %s' % ('yes (%s) - after checking the host, run: sudo scripts/install-updater.sh --ack' % state['blockedReason'] if state['blocked'] else 'no'),
             'Run active: %s' % ('yes, request %s to %s' % (state['active']['id'], state['active']['target']) if state['active'] else 'no')]
    if state['exit4']: lines.append('Consecutive automatic rollbacks: %s' % ', '.join('%s: %d' % item for item in sorted(state['exit4'].items())))
    last = state['lastResult']
    if last:
        lines.append('Last result: request %s, exit %s, reason %s, finished %s' % (last['requestId'], last['exitCode'], last['reason'], last['finishedAt']))
        final = (history or {}).get('finalStatus') or {}
        indent = lambda text: '\n'.join('  ' + line for line in clean_text(text, 4096).split('\n'))  # no embedded line can pose as a field
        if final.get('error'): lines.append('Error:\n' + indent(final['error']))
        if final.get('rollbackHint'): lines.append('Rollback:\n' + indent(final['rollbackHint']))
    return '\n'.join(lines)


def main(argv):
    command = argv[1] if len(argv) > 1 else 'serve'
    if command == 'verify': print(json.dumps(verify_main(json.loads(sys.stdin.read(4096))))); return 0
    if command == 'version': print(VERSION); return 0
    config = load_config()
    if command == 'serve':
        if os.environ.get('LISTEN_PID') != str(os.getpid()) or os.environ.get('LISTEN_FDS') != '1': raise SystemExit('start through docknest-updater.socket')
        listener = socket.socket(fileno=3); listener.settimeout(1.0)
        return Broker(config).serve(listener)
    broker = Broker(config)
    if command == 'status':
        with StateFile() as state: pass
        last = state['lastResult'] and load_json(os.path.join(STATE_DIR, 'history', state['lastResult']['requestId'] + '.json'), {})
        print(status_text(state, last)); return 0
    if command in ('ack', 'publish-service'):
        fd = os.open(os.path.join(STATE_DIR, 'lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: print('A run is active; wait for it to end.', file=sys.stderr); return 3
            broker.refresh()
            with StateFile() as state:
                if command == 'ack':
                    try: ack(state)
                    except Refused: print('A run is still recorded as active; restart the updater socket or run --repair first.', file=sys.stderr); return 3
                broker.publish_service(state)
            if command == 'ack': journal('block acknowledged on the host', result='acknowledged')
        finally: os.close(fd)
        return 0
    if command == 'record-current':  # installer: verify the installed release and record its pin (F2, I10, I17)
        current = broker.current_version(); broker.refresh()
        result = broker.host.verifier({'target': 'v' + current, 'mode': broker.mode})
        pins_path = os.path.join(STATE_DIR, 'pins.json'); pins = load_json(pins_path, {})
        reason, pin = verification_refusal(result, 'v' + current, broker.mode, pins)
        if reason: print('The installed release v%s did not verify (%s); the updater is not installed.' % (current, reason), file=sys.stderr); return 2
        head = broker.host.owner_git('rev-parse', 'HEAD')[1].decode().strip()
        if pin['commit'] != head: print('HEAD is not the verified commit of v%s.' % current, file=sys.stderr); return 2
        if broker.mode == 'image':
            api = broker.host.api_container(); image = broker.host.docker_json('image', 'inspect', api['Image'])[0]
            if '%s@%s' % (IMAGE, pin['digest']) not in (image.get('RepoDigests') or ()): print('The running api image is not the verified v%s image.' % current, file=sys.stderr); return 2
        pins['v' + current] = pin; save_json(pins_path, pins); print('Verified and recorded v%s (%s mode).' % (current, broker.mode)); return 0
    if command == 'self-test':
        check_volume_dir(config['volume']); broker.refresh(); print('ok %s %s' % (VERSION, broker.mode)); return 0
    print('usage: broker.py serve|status|ack|publish-service|record-current|self-test|version', file=sys.stderr); return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
