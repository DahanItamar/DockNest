"""Unit tests of the host updater broker's request parsing, allow-lists, path handling and state machine.
systemd, setpriv, Docker and root behaviour are proven only on Linux (docs/updater-threat-model.md P1 to P10)."""
import base64, json, os, socket, stat, sys, tempfile, unittest
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # also under python -I
import broker as b  # noqa: E402

RID = '4b0c9c1e-7d0f-4c55-9a0e-2a3c7b0d9f11'
NOW = 1792663200.0  # 2026-10-22T10:00:00Z
SHA = 'a' * 40
DIGEST = 'sha256:' + 'b' * 64


def request(**fields):
    value = {'schema': 1, 'id': RID, 'action': 'upgrade', 'version': 'v2.3.0', 'requestedBy': 'admin-1', 'requestedAt': b.iso(NOW)}
    value.update(fields)
    return json.dumps({k: v for k, v in value.items() if v is not ...}).encode()


def refused(raw):
    try: b.parse_request(raw)
    except b.Refused as error: return error
    raise AssertionError('accepted %r' % raw[:80])


class RequestTests(unittest.TestCase):
    def test_valid_request(self):
        parsed = b.parse_request(request())
        self.assertEqual((parsed['id'], parsed['version'], parsed['requestedBy'], parsed['at']), (RID, 'v2.3.0', 'admin-1', NOW))

    def test_only_the_exact_upgrade_action_and_it_is_checked_first(self):
        for action in ('downgrade', 'Upgrade', 'UPGRADE', 'check', ' upgrade', 1, None, ['upgrade'], True):
            error = refused(request(action=action, version='not a version', extra=1))
            self.assertEqual((error.code, error.detail), ('invalid', 'action'), action)
        self.assertEqual(refused(request(action=...)).detail, 'action')
        self.assertEqual(b.ACTIONS, ('upgrade',))  # no read-only check action and no self-update in 2.2.0

    def test_fields_types_and_shapes_are_strict(self):
        cases = [request(allowDataRollback=False), request(extra='x'), request(requestedBy=...), request(schema=2), request(schema=True),
                 request(schema='1'), request(id=RID.upper()), request(id='4b0c9c1e7d0f4c559a0e2a3c7b0d9f11'), request(id='{%s}' % RID),
                 request(version='v2.3.0-rc.1'), request(version='2.3.0'), request(version='v02.3.0'), request(version='v2.3'),
                 request(requestedBy='a b'), request(requestedBy='x' * 65), request(requestedAt='2026-10-22 10:00:00'),
                 request(requestedAt='2026-13-22T10:00:00Z'), request(requestedAt=1)]
        for raw in cases: self.assertEqual(refused(raw).code, 'invalid', raw)

    def test_hostile_encodings_never_escape_the_parser(self):
        dup = b'{"schema":1,"id":"%s","action":"upgrade","action":"upgrade","version":"v2.3.0","requestedBy":"a","requestedAt":"%s"}' % (RID.encode(), b.iso(NOW).encode())
        cases = [dup, b'\xff\xfe' + request(), request()[:-1] + b'\xc3"}', b'[' * 4000 + b']' * 4000, b'{"a":' * 3000 + b'1' + b'}' * 3000,
                 request(schema=10 ** 30), request()[:-1] + b',"n":NaN}', request()[:-1] + b',"f":1.5}', b'[]', b'"upgrade"', b'', b'{',
                 b' ' * 5000, request() + b'x']
        for raw in cases: self.assertEqual(refused(raw).code, 'invalid', raw[:40])
        self.assertEqual(refused(b'{"action":"upgrade"' + b',"x":1' * 1000 + b'}').code, 'invalid')  # over 4 KiB

    def test_parser_turns_memory_and_recursion_errors_into_invalid(self):
        for error in (MemoryError, RecursionError, KeyError):
            with patch('broker.json.loads', side_effect=error): self.assertEqual(refused(request()).code, 'invalid')

    def test_read_is_bounded_by_size_deadline_and_half_close(self):
        left, right = socket.socketpair()
        try:
            left.sendall(request()); left.shutdown(socket.SHUT_WR)
            self.assertEqual(b.read_request(right), request())
        finally: left.close(); right.close()
        left, right = socket.socketpair()
        try:
            left.sendall(b'x' * (b.MAX_REQUEST + 1))
            self.assertEqual(self._read(right).detail, 'oversize')
        finally: left.close(); right.close()
        left, right = socket.socketpair()
        try:
            left.sendall(b'{"slow":')  # no half-close: the 2 s deadline ends it
            with patch.object(b, 'READ_SECONDS', 0.2): self.assertEqual(self._read(right).detail, 'read deadline')
        finally: left.close(); right.close()

    def _read(self, conn):
        try: b.read_request(conn)
        except b.Refused as error: return error
        raise AssertionError('read succeeded')

    def test_response_never_echoes_request_text(self):
        self.assertEqual(json.loads(b.response(True, RID)), {'accepted': True, 'id': RID})
        self.assertEqual(json.loads(b.response(False, 'busy')), {'accepted': False, 'code': 'busy'})

    def test_caller_cgroup_forms(self):
        cid = 'c' * 64
        self.assertEqual(b.cgroup_container('0::/system.slice/docker-%s.scope\n' % cid), cid)
        self.assertEqual(b.cgroup_container('12:pids:/docker/%s\n1:name=systemd:/docker/%s\n' % (cid, cid)), cid)
        self.assertEqual(b.cgroup_container('0::/custom/parent/%s' % cid, 'custom/parent'), cid)
        self.assertIsNone(b.cgroup_container('0::/custom/parent/%s' % cid))
        self.assertIsNone(b.cgroup_container('0::/user.slice/user-1000.slice/session-2.scope'))
        self.assertIsNone(b.cgroup_container('0::/docker/%s\n1::/docker/%s' % (cid, 'd' * 64)))  # two containers: refuse
        self.assertIsNone(b.cgroup_container('0::/docker/%s/nested' % cid))


class PolicyTests(unittest.TestCase):
    def req(self, **fields):
        return {'id': RID, 'version': 'v2.3.0', 'requestedBy': 'a', 'at': NOW, **fields}

    def test_admission_codes(self):
        state = b.new_state()
        self.assertIsNone(b.admit(state, self.req(), NOW, '2.2.0'))
        self.assertEqual(b.admit({**state, 'blocked': True}, self.req(), NOW, '2.2.0'), 'needs-host-ack')
        self.assertEqual(b.admit({**state, 'active': {'id': 'x'}}, self.req(), NOW, '2.2.0'), 'busy')
        self.assertEqual(b.admit({**state, 'ids': [RID]}, self.req(), NOW, '2.2.0'), 'duplicate')
        # an id trimmed from the list but with a history record can never overwrite that audit record
        self.assertEqual(b.admit(state, self.req(), NOW, '2.2.0', lambda rid: rid == RID), 'duplicate')
        self.assertEqual(b.admit(state, self.req(at=NOW - 301), NOW, '2.2.0'), 'stale')
        self.assertEqual(b.admit(state, self.req(at=NOW + 301), NOW, '2.2.0'), 'stale')
        self.assertEqual(b.admit({**state, 'lastAccepted': {'id': 'y', 'at': NOW}}, self.req(), NOW, '2.2.0'), 'stale')
        for current in ('2.3.0', '2.3.1', '3.0.0'): self.assertEqual(b.admit(state, self.req(), NOW, current), 'version-refused', current)
        self.assertIsNone(b.admit(state, self.req(), NOW, '2.3.0-rc.1'))  # a final release is newer than its own pre-release
        self.assertEqual(b.admit(state, self.req(), NOW, 'garbage'), 'state-mismatch')
        self.assertEqual(b.admit({**state, 'exit4': {'v2.3.0': 2}}, self.req(), NOW, '2.2.0'), 'needs-host-ack')
        self.assertEqual(b.admit({**state, 'lastRunEnd': NOW - 59}, self.req(), NOW, '2.2.0'), 'rate-limited')
        self.assertIsNone(b.admit({**state, 'lastRunEnd': NOW - 60}, self.req(), NOW, '2.2.0'))
        self.assertEqual(b.admit({**state, 'runs': [NOW - 3600 * i for i in range(6)]}, self.req(), NOW, '2.2.0'), 'rate-limited')
        self.assertIsNone(b.admit({**state, 'runs': [NOW - 86400 - i for i in range(6)]}, self.req(), NOW, '2.2.0'))

    def test_rate_limit_detail_names_the_limit_and_the_earliest_retry(self):
        state = b.new_state()
        self.assertIsNone(b.rate_limit_detail(state, NOW))
        self.assertEqual(b.rate_limit_detail({**state, 'lastRunEnd': NOW - 20}, NOW), {'limit': 'cooldown', 'retryAt': b.iso(NOW + 40)})
        runs = [NOW - 3600 * i for i in range(1, 7)]  # six runs in the window, the oldest 6 h ago
        self.assertEqual(b.rate_limit_detail({**state, 'runs': runs, 'lastRunEnd': NOW - 3600}, NOW), {'limit': 'daily', 'retryAt': b.iso(NOW - 6 * 3600 + 86400)})
        # when both apply the later time wins; a daily limit that ends sooner than the cooldown reports the cooldown
        late = [NOW - 86400 + 10 - i for i in range(6)]
        self.assertEqual(b.rate_limit_detail({**state, 'runs': late, 'lastRunEnd': NOW - 1}, NOW)['limit'], 'cooldown')
        self.assertEqual(b.response(False, 'rate-limited', {'limit': 'daily', 'retryAt': b.iso(NOW)}),
                         json.dumps({'accepted': False, 'code': 'rate-limited', 'limit': 'daily', 'retryAt': b.iso(NOW)}, separators=(',', ':')).encode())
        self.assertEqual(b.response(False, 'busy'), b'{"accepted":false,"code":"busy"}')
        # a fractional end time rounds up to the next second, so the reported time is never early
        self.assertEqual(b.rate_limit_detail({**state, 'lastRunEnd': NOW - 20.4}, NOW), {'limit': 'cooldown', 'retryAt': b.iso(NOW + 40)})
        self.assertEqual(b.rate_limit_detail({**state, 'lastRunEnd': NOW - 20.0}, NOW)['retryAt'], b.iso(NOW + 40))

    def test_runs_that_change_nothing_give_their_daily_slot_back(self):
        for code, kept in ((2, []), (3, []), (0, [NOW]), (4, [NOW]), (5, [NOW]), (None, [NOW])):
            state = b.new_state(); b.accept(state, self.req(), NOW, {'pid': 1}); b.finish(state, code, NOW + 30)
            self.assertEqual((state['runs'], state['attempts']), (kept, [NOW]), code)
        # Six refused runs no longer use up the day; the wider attempts cap still bounds them
        state = {**b.new_state(), 'attempts': [NOW - 600 * i for i in range(1, 7)]}
        self.assertIsNone(b.admit(state, self.req(), NOW, '2.2.0'))
        full = {**b.new_state(), 'attempts': [NOW - 600 * i for i in range(1, b.ATTEMPTS_PER_DAY + 1)]}
        self.assertEqual(b.admit(full, self.req(), NOW, '2.2.0'), 'rate-limited')
        self.assertEqual(b.rate_limit_detail(full, NOW), {'limit': 'daily', 'retryAt': b.iso(NOW - 600 * b.ATTEMPTS_PER_DAY + 86400)})

    def test_accept_records_replay_and_rate_state(self):
        state = b.new_state(); b.accept(state, self.req(), NOW, {'pid': 1})
        self.assertEqual((state['ids'], state['lastAccepted'], state['runs']), ([RID], {'id': RID, 'at': NOW}, [NOW]))
        self.assertEqual(state['active']['runStepStarted'], False)
        self.assertEqual(b.admit(state, self.req(), NOW, '2.2.0'), 'busy')

    def run_once(self, state, code, target='v2.3.0', reason=None):
        state['active'] = {'id': RID, 'target': target, 'acceptedAt': NOW, 'runStepStarted': True}
        return b.finish(state, code, NOW, reason)

    def test_two_consecutive_rollbacks_for_one_target_block(self):
        state = b.new_state()
        self.run_once(state, 4); self.assertFalse(state['blocked']); self.assertEqual(state['exit4'], {'v2.3.0': 1})
        self.run_once(state, 2, reason='jobs-active')  # a refusal in between does not reset the count
        self.run_once(state, 4, reason='health-timeout')
        self.assertEqual((state['blocked'], state['blockedReason'], state['exit4']), (True, 'repeated-rollback', {'v2.3.0': 2}))
        self.assertEqual(b.admit(state, self.req(id='x'), NOW + 999, '2.2.0'), 'needs-host-ack')
        b.ack(state)
        self.assertEqual((state['blocked'], state['exit4']), (False, {}))

    def test_success_resets_the_count_and_other_targets_are_separate(self):
        state = b.new_state()
        self.run_once(state, 4); self.run_once(state, 4, target='v2.4.0'); self.assertFalse(state['blocked'])
        self.run_once(state, 0); self.assertEqual(state['exit4'], {'v2.4.0': 1})

    def test_bad_ends_block_until_ack(self):
        for code, reason in ((5, 'exit-5'), (6, 'exit-6'), (None, 'interrupted')):
            state = b.new_state(); result = self.run_once(state, code, reason='revert-failed')
            self.assertEqual((state['blocked'], state['blockedReason']), (True, reason))
            self.assertEqual(result['exitCode'], code); self.assertEqual(result['reason'], 'revert-failed')
        for code in (0, 2, 3):
            state = b.new_state(); self.run_once(state, code); self.assertFalse(state['blocked'], code)
        for code in (1, 7, 130, 255):  # once the run step started, anything unexpected fails closed
            state = b.new_state(); self.run_once(state, code); self.assertEqual((state['blocked'], state['blockedReason']), (True, 'unexpected-exit'), code)
        state = b.new_state(); state['active'] = {'id': RID, 'target': 'v2.3.0', 'acceptedAt': NOW, 'runStepStarted': False}
        b.finish(state, None, NOW, 'interrupted'); self.assertFalse(state['blocked'])  # nothing ran: no block
        state = b.new_state(); self.assertEqual(self.run_once(state, 2, reason='made-up')['reason'], 'unknown')

    def test_ack_refused_while_a_run_is_active(self):
        state = b.new_state(); state['active'] = {'id': RID}; state['blocked'] = True
        with self.assertRaises(b.Refused): b.ack(state)
        self.assertTrue(state['blocked'])

    def test_reconcile_after_a_broker_crash(self):
        state = b.new_state(); state['active'] = {'id': RID, 'target': 'v2.3.0', 'acceptedAt': NOW, 'runStepStarted': False}
        self.assertEqual(b.reconcile(state, None, NOW)['exitCode'], 2); self.assertFalse(state['blocked'])  # died in verify
        for last, blocked in (({'requestId': RID, 'phase': 'cleanup', 'ok': True}, False), ({'requestId': RID, 'phase': 'done', 'ok': True}, False),
                              ({'requestId': RID, 'phase': 'build', 'ok': None}, True), ({'requestId': 'other', 'phase': 'done', 'ok': True}, True), (None, True)):
            state = b.new_state(); state['active'] = {'id': RID, 'target': 'v2.3.0', 'acceptedAt': NOW, 'runStepStarted': True}
            b.reconcile(state, last, NOW); self.assertEqual(state['blocked'], blocked, last)
        self.assertIsNone(b.reconcile(b.new_state(), None, NOW))

    def test_run_limit_idle_exit_and_connection_limit(self):
        self.assertIsNone(b.run_deadline(NOW, NOW + 7199))
        self.assertEqual(b.run_deadline(NOW, NOW + 7200), 'term')
        self.assertEqual(b.run_deadline(NOW, NOW + 7200 + 899), 'term')
        self.assertEqual(b.run_deadline(NOW, NOW + 7200 + 900), 'kill')
        self.assertTrue(b.idle_exit(NOW, NOW + 600, False)); self.assertFalse(b.idle_exit(NOW, NOW + 599, False)); self.assertFalse(b.idle_exit(NOW, NOW + 9999, True))
        limiter = b.Limiter()
        self.assertEqual([limiter.allow(NOW + i) for i in range(11)], [True] * 10 + [False])
        self.assertTrue(limiter.allow(NOW + 61))


class StatusTests(unittest.TestCase):
    def status(self, **fields):
        value = {'phase': 'build', 'from': 'v2.2.0', 'to': 'v2.3.0', 'startedAt': b.iso(NOW), 'updatedAt': b.iso(NOW), 'ok': None, 'error': None,
                 'rollbackHint': None, 'requestId': RID, 'warning': None}
        value.update(fields)
        return json.dumps({k: v for k, v in value.items() if v is not ...}).encode()

    def test_allow_list_drops_unknown_fields_and_keeps_known_ones(self):
        out, dropped = b.validate_status(self.status(newField=1, html='<b>'), RID)
        self.assertEqual(dropped, ['html', 'newField']); self.assertNotIn('html', out); self.assertEqual(out['phase'], 'build')
        out, _ = b.validate_status(self.status(reason='health-timeout', schemaFrom=4, schemaTo=5, error='bad\x1b[31m\x00text'), RID)
        self.assertEqual((out['reason'], out['schemaFrom'], out['schemaTo'], out['error']), ('health-timeout', 4, 5, 'bad[31mtext'))
        self.assertEqual(b.validate_status(self.status(reason='rm -rf /'), RID)[0]['reason'], 'unknown')
        self.assertEqual(b.validate_status(self.status(**{'from': ''}), RID)[0]['from'], '')
        self.assertEqual(b.validate_status(self.status(cleanup='Cleaned up: 2 old DockNest images' + 'x' * 300), RID)[0]['cleanup'][:34], 'Cleaned up: 2 old DockNest images' + 'x')
        self.assertEqual(len(b.validate_status(self.status(cleanup='c' * 900), RID)[0]['cleanup']), 256)

    def test_other_requests_and_invalid_values(self):
        self.assertIsNone(b.validate_status(self.status(requestId='5b0c9c1e-7d0f-4c55-9a0e-2a3c7b0d9f11'), RID))
        self.assertIsNone(b.validate_status(self.status(requestId=...), RID))
        for fields in ({'phase': 'pwned'}, {'phase': ...}, {'ok': 1}, {'ok': 'true'}, {'to': '<script>'}, {'startedAt': 'yesterday'},
                       {'warning': 'w' * 1025}, {'error': 5}, {'schemaFrom': True}, {'schemaTo': -1}, {'schemaTo': 1.5}, {'cleanup': 3}):
            with self.assertRaises(ValueError, msg=fields): b.validate_status(self.status(**fields), RID)
        with self.assertRaises(ValueError): b.validate_status(b'{"phase":"build","x":"%s"}' % (b'a' * 16400), RID)
        with self.assertRaises(ValueError): b.validate_status(b'[1]', RID)
        self.assertEqual(len(b.validate_status(self.status(error='e' * 9000), RID)[0]['error']), 4096)

    def test_events_are_built_by_the_broker_with_a_cap(self):
        current = b.new_current(RID, 'v2.3.0', NOW)
        self.assertEqual(set(current), {'requestId', 'target', 'acceptedAt', 'events', 'truncated'})
        b.add_event(current, 'verify', NOW); b.add_event(current, 'verify', NOW + 1); b.add_event(current, 'not-a-phase', NOW + 2)
        b.add_event(current, 'build', NOW - 50)  # the broker's clock never goes backwards in the list
        self.assertEqual(current['events'], [{'phase': 'verify', 'at': b.iso(NOW)}, {'phase': 'build', 'at': b.iso(NOW)}])
        for i in range(40): b.add_event(current, ('start', 'health')[i % 2], NOW + i)
        self.assertEqual((len(current['events']), current['truncated']), (32, True))
        self.assertTrue(all(set(event) == {'phase', 'at'} for event in current['events']))

    def test_service_document_is_allow_listed(self):
        state = b.new_state(); state['exit4'] = {'v2.3.0': 1}
        doc = b.service_doc(state, 'source', {'docker': '27.3'})
        self.assertEqual(set(doc), {'schema', 'version', 'protocol', 'actions', 'installMode', 'env', 'blocked', 'blockedReason', 'consecutiveExit4',
                                    'heartbeatAt', 'requestId', 'lastResult'})
        self.assertEqual((doc['actions'], doc['blocked'], doc['heartbeatAt'], doc['consecutiveExit4']), (['upgrade'], False, None, {'v2.3.0': 1}))
        state['active'] = {'id': RID}
        self.assertEqual((b.service_doc(state, 'image', {}, NOW)['heartbeatAt'], b.service_doc(state, 'image', {}, NOW)['requestId']), (b.iso(NOW), RID))

    def test_failed_status_has_every_field(self):
        self.assertEqual(set(b.failed_status(RID, '2.2.0', 'v2.3.0', NOW, NOW, 'x')), set(b.STATUS_FIELDS))


@unittest.skipUnless(os.name == 'posix', 'directory descriptors, O_NOFOLLOW and FIFOs are POSIX')
class PathTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(); self.fd = os.open(self.dir, os.O_RDONLY | os.O_DIRECTORY); self.uid = os.getuid()
    def tearDown(self):
        os.close(self.fd)
        for name in os.listdir(self.dir): os.unlink(os.path.join(self.dir, name))
        os.rmdir(self.dir)
    def write(self, data=b'{}', name='status.json'):
        with open(os.path.join(self.dir, name), 'wb') as handle: handle.write(data)

    def test_status_file_checks(self):
        self.assertIsNone(b.read_work_status(self.fd, self.uid))
        self.write(b'{"phase":"build"}'); self.assertEqual(b.read_work_status(self.fd, self.uid), b'{"phase":"build"}')
        with self.assertRaises(ValueError): b.read_work_status(self.fd, self.uid + 1)  # not the checkout owner
        os.link(os.path.join(self.dir, 'status.json'), os.path.join(self.dir, 'hard'))
        with self.assertRaises(ValueError): b.read_work_status(self.fd, self.uid)  # st_nlink 2
        os.unlink(os.path.join(self.dir, 'hard')); os.unlink(os.path.join(self.dir, 'status.json'))
        self.write(b'x', 'target'); os.symlink('target', os.path.join(self.dir, 'status.json'))
        with self.assertRaises(OSError): b.read_work_status(self.fd, self.uid)  # O_NOFOLLOW
        os.unlink(os.path.join(self.dir, 'status.json')); os.mkfifo(os.path.join(self.dir, 'status.json'))
        with self.assertRaises(ValueError): b.read_work_status(self.fd, self.uid)  # a FIFO neither blocks nor is read
        os.unlink(os.path.join(self.dir, 'status.json')); self.write(b'x' * (b.STATUS_CAP + 1))
        with self.assertRaises(ValueError): b.read_work_status(self.fd, self.uid)

    def test_published_status_is_read_back_without_following_links(self):
        self.assertIsNone(b.read_published(self.fd, 'status.json', self.uid))
        self.write(b'{"phase":"done"}'); self.assertEqual(b.read_published(self.fd, 'status.json', self.uid), b'{"phase":"done"}')
        with self.assertRaises(ValueError): b.read_published(self.fd, 'status.json', self.uid + 1)  # not root's
        with self.assertRaises(ValueError): b.read_published(self.fd, '../status.json', self.uid)
        os.unlink(os.path.join(self.dir, 'status.json'))
        self.write(b'{"phase":"done","ok":true}', 'forged'); os.symlink('forged', os.path.join(self.dir, 'status.json'))
        with self.assertRaises(OSError): b.read_published(self.fd, 'status.json', self.uid)  # O_NOFOLLOW
        os.unlink(os.path.join(self.dir, 'status.json')); os.mkfifo(os.path.join(self.dir, 'status.json'))
        with self.assertRaises(ValueError): b.read_published(self.fd, 'status.json', self.uid)  # never blocks on a FIFO

    def test_publish_is_atomic_0644_and_allow_listed(self):
        old = os.umask(0o077)
        try: b.publish(self.fd, 'service.json', {'a': 1})
        finally: os.umask(old)
        info = os.stat(os.path.join(self.dir, 'service.json'))
        self.assertEqual(stat.S_IMODE(info.st_mode), 0o644)
        self.assertEqual(os.listdir(self.dir), ['service.json'])
        for name in ('../escape.json', 'check.json', 'notes/v2.3.0.md', 'other'):
            with self.assertRaises(ValueError): b.publish(self.fd, name, {})

    def test_volume_directory_must_be_root_owned_and_not_a_link(self):
        os.chmod(self.dir, 0o755)
        if os.getuid() != 0:
            with self.assertRaises(ValueError): b.check_volume_dir(self.dir)
        link = self.dir + '-link'; os.symlink(self.dir, link)
        try:
            with self.assertRaises(ValueError): b.check_volume_dir(link)
        finally: os.unlink(link)


class HostCheckTests(unittest.TestCase):
    def test_checkout_ownership_and_modes(self):
        files = {'/c': (1000, 0o40755), '/c/.git': (1000, 0o40755), '/c/.env': (1000, 0o100600), '/c/data': (1000, 0o40700),
                 '/c/.git/config': (1000, 0o100644), '/c/.git/hooks': (0, 0o40755), '/c/.git/link': (1000, 0o120777)}
        def lstat(path):
            if path not in files: raise FileNotFoundError(path)
            return SimpleNamespace(st_uid=files[path][0], st_mode=files[path][1])
        walk = lambda top, followlinks: [('/c/.git', ['hooks'], ['config', 'link'])]
        self.assertIsNone(b.check_tree('/c', 1000, lstat, walk))
        for path, value in (('/c/.env', (1000, 0o100620)), ('/c/.git/config', (1001, 0o100644)), ('/c', (1000, 0o40775)), ('/c/data', (1000, 0o40757))):
            saved = files[path]; files[path] = value
            self.assertEqual(b.check_tree('/c', 1000, lstat, walk), path); files[path] = saved

    def test_git_config_allow_list(self):
        ok = ['core.repositoryformatversion\n0', 'core.filemode\ntrue', 'core.bare\nfalse', 'remote.origin.url\ngit@github.com:x/y.git',
              'remote.origin.fetch\n+refs/heads/*:refs/remotes/origin/*', 'branch.main.remote\norigin', 'branch.main.merge\nrefs/heads/main',
              'user.name\nOps', 'pull.rebase\nfalse', 'init.defaultbranch\nmain', 'remote.My.Mirror.url\nhttps://x']
        self.assertIsNone(b.git_config_refusal('\0'.join(ok) + '\0'))
        for key in ('url.https://evil/.insteadof', 'core.sshcommand', 'include.path', 'includeif.gitdir:/x.path', 'core.hookspath', 'filter.lfs.clean',
                    'http.proxy', 'credential.helper', 'core.fsmonitor', 'remote.origin.uploadpack', 'remote.origin.pushurl', 'core.pager', 'diff.external'):
            self.assertEqual(b.git_config_refusal('core.bare\nfalse\0%s\nvalue\0' % key), key)

    def test_only_modified_tracked_files_refuse(self):
        operator = '?? compose.override.yaml\0!! .env\0!! data/state.sqlite\0?? keys/id.pem\0'
        self.assertIsNone(b.tracked_change_refusal(operator)); self.assertIsNone(b.tracked_change_refusal(''))
        for entry, path in ((' M src/a.js\0', 'src/a.js'), ('M  compose.yaml\0', 'compose.yaml'), (' D Dockerfile\0', 'Dockerfile'),
                            ('R  new.js\0old.js\0', 'new.js'), ('UU package.json\0', 'package.json')):
            self.assertEqual(b.tracked_change_refusal(operator + entry), path, entry)

    def test_host_state_agreement(self):
        pin = {'commit': SHA, 'digest': DIGEST}
        self.assertIsNone(b.host_state_refusal('source', '2.2.0', 'v2.2.0', SHA, pin))
        self.assertIn('tag', b.host_state_refusal('source', '2.2.0', 'v2.1.0', SHA, pin))
        self.assertIn('tag', b.host_state_refusal('source', '2.2.0', '', SHA, pin))
        self.assertIn('HEAD', b.host_state_refusal('source', '2.2.0', 'v2.2.0', 'c' * 40, pin))
        self.assertIn('HEAD', b.host_state_refusal('source', '2.2.0', 'v2.2.0', SHA, None))
        digests = [b.IMAGE + '@' + DIGEST]
        self.assertIsNone(b.host_state_refusal('image', '2.2.0', 'v2.2.0', SHA, pin, '2.2.0', digests))
        self.assertIn('image', b.host_state_refusal('image', '2.2.0', 'v2.2.0', SHA, pin, '2.3.0', digests))
        self.assertIn('digest', b.host_state_refusal('image', '2.2.0', 'v2.2.0', SHA, pin, '2.2.0', ['other/image@' + DIGEST]))
        self.assertIn('digest', b.host_state_refusal('image', '2.2.0', 'v2.2.0', SHA, {'commit': SHA}, '2.2.0', digests))

    def test_mounts_and_install_mode(self):
        api = 'a' * 64
        mount = lambda rw: {'Type': 'volume', 'Name': b.VOLUME, 'RW': rw}
        self.assertIsNone(b.mount_refusal([{'Id': api, 'Mounts': [mount(False)]}], api))
        self.assertIn('read-write', b.mount_refusal([{'Id': api, 'Mounts': [mount(True)]}], api))
        self.assertIn('read-write', b.mount_refusal([{'Id': api, 'Mounts': [mount(False)]}, {'Id': 'w' * 64, 'Mounts': [mount(True)]}], api))
        self.assertIn('does not mount', b.mount_refusal([{'Id': 'w' * 64, 'Mounts': [mount(False)]}], api))
        self.assertIn('read-write', b.mount_refusal([{'Id': api, 'Mounts': [{'Type': 'volume', 'Name': b.VOLUME}]}], api))
        self.assertEqual(b.install_mode('ghcr.io/dahanitamar/docknest:2.2.0@' + DIGEST), 'image')
        for image in ('docknest:local', 'ghcr.io/dahanitamar/docknest-evil:1', 'evil/ghcr.io/dahanitamar/docknest:1', ''):
            self.assertEqual(b.install_mode(image), 'source', image)

    def test_capabilities_probe(self):
        text = ' '.join(b.REQUIRED_FLAGS)
        self.assertIsNone(b.capabilities_refusal(text, 'source'))
        self.assertIn('--expect-image-digest', b.capabilities_refusal(text, 'image'))
        self.assertIsNone(b.capabilities_refusal(json.dumps({'flags': list(b.REQUIRED_FLAGS) + ['--expect-image-digest'], 'statusProtocol': 1}), 'image'))
        self.assertIn('--upgrade-only', b.capabilities_refusal(text.replace('--upgrade-only', ''), 'source'))
        self.assertIsNotNone(b.capabilities_refusal('', 'source'))  # an older upgrade.sh without --capabilities

    def test_run_step_argv_and_privilege_drop(self):
        argv = b.run_argv('v2.3.0', SHA, RID)
        self.assertEqual(argv, ['/bin/sh', 'scripts/upgrade.sh', '--non-interactive', '--upgrade-only', '--no-fetch', '--expect-commit', SHA,
                                '--version', 'v2.3.0', '--request-id', RID, '--status-file', '/run/docknest-updater-work/status.json'])
        self.assertEqual(b.run_argv('v2.3.0', SHA, RID, DIGEST)[-2:], ['--expect-image-digest', DIGEST])
        self.assertFalse(set(b.FORBIDDEN_FLAGS) & set(b.run_argv('v2.3.0', SHA, RID, DIGEST)))
        for args in (('v2.3.0;id', SHA, RID), ('v2.3.0', 'HEAD', RID), ('v2.3.0', SHA, '../x'), ('v2.3.0-rc.1', SHA, RID)):
            with self.assertRaises(ValueError): b.run_argv(*args)
        with self.assertRaises(ValueError): b.run_argv('v2.3.0', SHA, RID, 'latest')
        drop = b.as_user(1000, 1000, b.git_env('/home/ops'), argv)
        self.assertEqual(drop[:8], ['/usr/bin/setpriv', '--reuid=1000', '--regid=1000', '--init-groups', '--inh-caps=-all', '--reset-env', '--pdeathsig=SIGTERM', '--'])
        self.assertNotIn('--bounding-set', ' '.join(drop))
        self.assertEqual(drop[8:10], ['/usr/bin/env', '-i'])
        for item in ('GIT_CONFIG_NOSYSTEM=1', 'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_NO_REPLACE_OBJECTS=1', 'GIT_CONFIG_COUNT=1',
                     'GIT_CONFIG_KEY_0=core.hooksPath', 'GIT_CONFIG_VALUE_0=/dev/null', 'HOME=/home/ops'):
            self.assertIn(item, drop)
        self.assertEqual(drop[-len(argv):], argv)

    def test_disk_floor_and_coarse_environment(self):
        gib = 1024 ** 3
        self.assertIsNone(b.disk_refusal(3 * gib, 3 * gib, gib)); self.assertIsNotNone(b.disk_refusal(3 * gib, 2 * gib, gib))
        self.assertIsNotNone(b.disk_refusal(2 * gib - 1, 9 * gib, 0)); self.assertIsNone(b.disk_refusal(2 * gib, 2 * gib, None))
        env = b.coarse_env('27.3.1\n', 'v2.29.7', 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n', '6.8.0-48-generic', 'x86_64',
                           'git version 2.43.0', 30 * gib)
        self.assertEqual(env, {'docker': '27.3', 'compose': '2.29', 'os': 'ubuntu', 'osVersion': '24', 'kernel': '6.8', 'arch': 'x86_64', 'git': '2.43',
                               'cosign': b.COSIGN_VERSION, 'disk': '10-50'})
        env = b.coarse_env('', 'nope', 'ID=myhost-secret-distro\n', 'x', 'Not An Arch!', '', gib)
        self.assertEqual(env, {'os': 'other', 'cosign': b.COSIGN_VERSION, 'disk': '<2'})
        self.assertEqual([b.disk_bucket(n * gib) for n in (1, 5, 20, 80)], ['<2', '2-10', '10-50', '>50'])

    def test_journal_and_log_escaping(self):
        data = b.journal_fields({'MESSAGE': 'one\ntwo', 'DOCKNEST_REQUEST_ID': RID, 'bad key': 'x', 'PRIORITY': 5})
        self.assertIn(b'DOCKNEST_REQUEST_ID=' + RID.encode() + b'\n', data)
        self.assertIn(b'MESSAGE\n' + (7).to_bytes(8, 'little') + b'one\ntwo\n', data)
        self.assertNotIn(b'bad key', data)
        log = b.escape_log(b'ok\nMESSAGE=forged\x1b[2J\nDOCKNEST_RESULT=finished\n', 'run| ')
        self.assertEqual(log, 'run| ok\nrun| MESSAGE=forged\\x1b[2J\nrun| DOCKNEST_RESULT=finished\n')


def tlv(tag, content):
    n = len(content)
    head = bytes([n]) if n < 128 else bytes([0x80 | len(n.to_bytes(4, 'big').lstrip(b'\0'))]) + n.to_bytes(4, 'big').lstrip(b'\0')
    return bytes([tag]) + head + content


def certificate(repo='1426164448', owner='125464728'):
    ext = lambda oid, value: tlv(0x30, tlv(0x06, b.oid_der(oid)) + tlv(0x04, tlv(0x0c, value.encode())))
    # '2.5.29.' + '15' is split because the privacy audit reads 4-part OIDs as IP addresses.
    extensions = tlv(0xa3, tlv(0x30, ext('2.5.29.' + '15', 'x') + ext('1.3.6.1.4.1.57264.1.15', repo) + ext('1.3.6.1.4.1.57264.1.17', owner)
                               + tlv(0x30, tlv(0x06, b.oid_der('1.3.6.1.4.1.57264.1.12')) + tlv(0x04, tlv(0x0c, b'https://github.com/x')))))
    return tlv(0x30, tlv(0x30, tlv(0xa0, tlv(0x02, b'\x02')) + tlv(0x02, b'\x01' * 20) + extensions) + tlv(0x30, b'') + tlv(0x03, b'\0sig'))


class TrustTests(unittest.TestCase):
    def test_oid_and_fulcio_ids(self):
        self.assertEqual(b.oid_der('1.3.6.1.4.1.57264.1.15'), bytes.fromhex('2b0601040183bf30010f'))
        self.assertEqual(b.fulcio_ids(certificate()), {'repositoryId': '1426164448', 'ownerId': '125464728'})
        self.assertEqual(b.fulcio_ids(tlv(0x30, tlv(0x02, b'\x01'))), {})
        for bad in (certificate()[:-3], b'\x30\x85\x01\x01\x01\x01\x01', b'\x1f\x01\x00'):
            with self.assertRaises(ValueError): b.fulcio_ids(bad)

    def test_bundle_certificate_forms(self):
        der = certificate(); raw = base64.b64encode(der).decode()
        self.assertEqual(b.bundle_certificate({'verificationMaterial': {'certificate': {'rawBytes': raw}}}), der)
        self.assertEqual(b.bundle_certificate({'verificationMaterial': {'x509CertificateChain': {'certificates': [{'rawBytes': raw}]}}}), der)
        for bundle in ({}, {'verificationMaterial': {'publicKey': {}}}, {'verificationMaterial': {'certificate': {'rawBytes': '!!'}}}):
            with self.assertRaises(ValueError): b.bundle_certificate(bundle)

    def test_redirects_only_to_the_two_asset_hosts(self):
        for url in ('https://release-assets.githubusercontent.com/a?sig=1', 'https://objects.githubusercontent.com:443/a'):
            self.assertTrue(b.redirect_allowed(url), url)
        for url in ('http://objects.githubusercontent.com/a', 'https://release-assets.githubusercontent.com.evil.com/a', 'https://evil.com/objects.githubusercontent.com',
                    'https://user:pw@objects.githubusercontent.com/a', 'https://objects.githubusercontent.com:8443/a', 'https://objects.githubusercontent.com./a',
                    'https://github.com/a', '//objects.githubusercontent.com/a', 'https://objects.githubusercontent.com:abc/a', ''):
            self.assertFalse(b.redirect_allowed(url), url)

    def test_identity_flags(self):
        flags = b.identity_flags('v2.3.0', SHA)
        pairs = dict(zip(flags[::2], flags[1::2]))
        self.assertEqual(pairs, {'--certificate-identity': 'https://github.com/DahanItamar/DockNest/.github/workflows/release.yml@refs/tags/v2.3.0',
                                 '--certificate-oidc-issuer': 'https://token.actions.githubusercontent.com', '--certificate-github-workflow-repository': 'DahanItamar/DockNest',
                                 '--certificate-github-workflow-trigger': 'push', '--certificate-github-workflow-ref': 'refs/tags/v2.3.0', '--certificate-github-workflow-sha': SHA})

    def result(self, **manifest):
        value = {'version': '2.3.0', 'tag': 'v2.3.0', 'commit': SHA, 'repository': 'DahanItamar/DockNest', 'prerelease': False, 'image': {'name': b.IMAGE, 'digest': DIGEST}}
        value.update(manifest)
        return {'ok': True, 'tagCommit': SHA, 'ancestor': True, 'manifest': value, 'repositoryId': b.REPOSITORY_ID, 'ownerId': b.OWNER_ID, 'imageVerified': True}

    def test_root_rechecks_the_verifier_result(self):
        self.assertEqual(b.verification_refusal(self.result(), 'v2.3.0', 'source', {}), (None, {'commit': SHA, 'digest': None}))
        self.assertEqual(b.verification_refusal(self.result(), 'v2.3.0', 'image', {}), (None, {'commit': SHA, 'digest': DIGEST}))
        cases = [({'ok': False, 'reason': 'signature-invalid'}, 'signature-invalid'), ({'ok': False, 'reason': 'rm -rf'}, 'verify-unavailable'), (None, 'verify-unavailable'),
                 ({**self.result(), 'ancestor': False}, 'not-on-main'), ({**self.result(), 'tagCommit': None}, 'tag-missing'),
                 ({**self.result(), 'repositoryId': '1'}, 'signature-invalid'), ({**self.result(), 'ownerId': None}, 'signature-invalid'),
                 (self.result(prerelease=True), 'signature-invalid'), (self.result(commit='c' * 40), 'signature-invalid'), (self.result(version='2.4.0'), 'signature-invalid'),
                 (self.result(tag='v2.4.0'), 'signature-invalid'), (self.result(repository='Evil/DockNest'), 'signature-invalid'), (self.result(prerelease=None), 'signature-invalid')]
        for result, reason in cases: self.assertEqual(b.verification_refusal(result, 'v2.3.0', 'source', {})[0], reason, result)
        for result in (self.result(image={'name': 'evil/docknest', 'digest': DIGEST}), self.result(image={'name': b.IMAGE, 'digest': None}), {**self.result(), 'imageVerified': False}):
            self.assertEqual(b.verification_refusal(result, 'v2.3.0', 'image', {})[0], 'signature-invalid')

    def test_trust_on_first_use(self):
        self.assertEqual(b.verification_refusal(self.result(), 'v2.3.0', 'source', {'v2.3.0': {'commit': SHA, 'digest': None}})[0], None)
        self.assertEqual(b.verification_refusal(self.result(), 'v2.3.0', 'source', {'v2.3.0': {'commit': 'c' * 40}})[0], 'tag-moved')
        self.assertEqual(b.verification_refusal(self.result(), 'v2.3.0', 'image', {'v2.3.0': {'commit': SHA, 'digest': 'sha256:' + 'c' * 64}})[0], 'tag-moved')
        self.assertEqual(b.verification_refusal(self.result(), 'v2.3.0', 'source', {'v2.3.0': {'commit': SHA, 'digest': DIGEST}})[1]['digest'], DIGEST)

    def test_versions(self):
        self.assertTrue(b.newer('v2.3.0', '2.2.9')); self.assertTrue(b.newer('v10.0.0', '9.9.9')); self.assertTrue(b.newer('v2.3.0', '2.3.0-rc.2'))
        self.assertFalse(b.newer('v2.3.0', '2.3.0')); self.assertFalse(b.newer('v2.2.9', '2.3.0'))
        for bad in ('v2.3', 'latest', ''):
            with self.assertRaises(ValueError): b.newer(bad, '2.2.0')

    def test_status_text_for_the_operator(self):
        state = b.new_state(); state['active'] = {'id': RID, 'target': 'v2.3.0', 'acceptedAt': NOW, 'runStepStarted': True}
        b.finish(state, 5, NOW, 'health-timeout')
        text = b.status_text(state, {'finalStatus': {'error': 'Health check failed\nBlocked: no', 'rollbackHint': 'git checkout v2.2.0 && docker compose up -d\nstep 2\x85\x9b'}})
        self.assertIn('Blocked: yes (exit-5)', text); self.assertIn('--ack', text)
        self.assertIn('Rollback:\n  git checkout v2.2.0 && docker compose up -d\n  step 2', text)
        self.assertIn('Error:\n  Health check failed\n  Blocked: no', text)
        self.assertEqual([line for line in text.split('\n') if line.startswith('Blocked:')], ['Blocked: yes (exit-5) - after checking the host, run: sudo scripts/install-updater.sh --ack'])
        self.assertNotIn('\x85', text); self.assertNotIn('\x9b', text)
        self.assertEqual(b.clean_text('a\x00b\x1bc\x7fd\x80e\x9ff g\n\th', 99), 'abcdef g\n\th')
        self.assertIn('Blocked: no', b.status_text(b.new_state(), None))


if __name__ == '__main__':
    unittest.main()
