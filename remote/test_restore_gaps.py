"""The restore check (docs/restore-check.md): host schedules, Docker objects and files outside the app's folder that a
restore on a new server would miss. Run: python3 remote/test_restore_gaps.py
Proves that findings carry a path, line, schedule and what matched but never a command or line text, that reads skip
links out of the scanned folder and protected paths, that bounds mark the result incomplete, and that a failure never
changes readiness."""
import io, json, os, pathlib, sys, tempfile, unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it); see helper_path.py
import helper

SECRET = 'tok-7f3a9c-never-leaves'


def web(name='shop-web', project='', mounts=None, networks=None):
    labels = {'com.docker.compose.project': project} if project else {}
    return {'Id': name, 'Name': '/' + name, 'Config': {'Labels': labels},
            'Mounts': mounts if mounts is not None else [{'Type': 'bind', 'Source': '/srv/shop/data', 'Destination': '/data'}],
            'NetworkSettings': {'Networks': networks or {}}}


def can_link():
    with tempfile.TemporaryDirectory() as d:
        try: os.symlink(os.path.join(d, 'a'), os.path.join(d, 'b')); return True
        except OSError: return False


class Host:
    """A fake /etc (crontab, cron.d, users' crontabs, cron.daily, systemd, letsencrypt, nginx) in a temporary folder."""
    def __init__(self):
        self.directory = tempfile.TemporaryDirectory(); self.base = pathlib.Path(self.directory.name)
        self.roots = {'crontab': str(self.base / 'crontab'), 'cron': str(self.base / 'cron.d'), 'spool': (str(self.base / 'crontabs'),),
                      'periodic': (str(self.base / 'cron.daily'),), 'systemd': str(self.base / 'systemd'),
                      'letsencrypt': str(self.base / 'live'), 'nginx': [str(self.base / 'nginx')]}
        for name in ['cron.d', 'crontabs', 'cron.daily', 'systemd', 'live', 'nginx']: (self.base / name).mkdir()
    def write(self, relative, text):
        path = self.base / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(text); return str(path)
    def check(self, cfg=None, containers=None):
        output = io.StringIO()
        with patch.object(helper, 'EVENT_STREAM', output), patch.object(helper, 'CAPTURE_DIAGNOSTICS', True):
            result = helper.restore_check(cfg or {}, [web()] if containers is None else containers, self.roots)
        self.events = output.getvalue()
        return result
    def close(self): self.directory.cleanup()


class GapTest(unittest.TestCase):
    def setUp(self): self.host = Host(); self.addCleanup(self.host.close)
    def kinds(self, result): return [(f['kind'], f['path'], f['matched']) for f in result['findings']]


class HostScheduleTests(GapTest):
    def test_cron_lines_that_use_the_app_folder_are_found_with_line_and_schedule_but_never_the_command(self):
        system = self.host.write('crontab', 'SHELL=/bin/sh\n# 0 1 * * * root /srv/shop/data/old.sh\n17 * * * * root cd / && run-parts /etc/cron.hourly\n'
                                 '*/5 * * * * root API_TOKEN=%s /srv/shop/data/sync.sh --token=%s\n' % (SECRET, SECRET))
        dropin = self.host.write('cron.d/shop', '@daily root curl -H "Authorization: Bearer %s" -o /srv/shop/data/feed.json https://x\n' % SECRET)
        user = self.host.write('crontabs/deploy', '30 2 * * 1 /srv/shop/data/report --password=%s\n' % SECRET)
        daily = self.host.write('cron.daily/shop', '#!/bin/sh\nexport KEY=%s\ntar -czf /backups/shop.tgz /srv/shop/data\n' % SECRET)
        result = self.host.check()
        self.assertTrue(result['complete'])
        found = {f['path']: f for f in result['findings']}
        self.assertEqual(sorted(found), sorted([system, dropin, user, daily]))
        self.assertEqual((found[system]['line'], found[system]['schedule'], found[system]['matched']), (4, '*/5 * * * *', '/srv/shop/data'))
        self.assertEqual((found[dropin]['line'], found[dropin]['schedule']), (1, '@daily'))
        self.assertEqual((found[user]['line'], found[user]['schedule']), (1, '30 2 * * 1'))
        self.assertEqual((found[daily]['line'], found[daily]['schedule']), (3, 'daily'))
        for finding in result['findings']:
            self.assertEqual(finding['kind'], 'host-schedule'); self.assertRegex(finding['key'], r'^[0-9a-f]{64}$')
            self.assertEqual(set(finding) - {'includePaths'}, {'key', 'kind', 'path', 'line', 'schedule', 'matched', 'includable', 'included', 'message'})
        output = json.dumps(result) + self.host.events
        for text in [SECRET, 'sync.sh', 'Bearer', 'curl', '--password', 'tar -czf']: self.assertNotIn(text, output)

    def test_docker_commands_naming_the_app_containers_or_project_are_found(self):
        path = self.host.write('cron.d/shop', '0 3 * * * root docker exec shop-web php artisan backup\n'
                               '0 4 * * * root sh -c "docker compose -p shop restart"\n'
                               '0 5 * * * root /usr/local/bin/notify shop-web\n0 6 * * * root docker cp shop-web:/var/log/app.log /tmp\n')
        result = self.host.check(containers=[web(project='shop')])
        self.assertEqual([(f['line'], f['matched']) for f in result['findings']], [(1, 'shop-web'), (2, 'shop')])
        self.assertIn('container shop-web', result['findings'][0]['message']); self.assertIn('Compose project shop', result['findings'][1]['message'])
        self.assertTrue(all(f['path'] == path for f in result['findings']))

    def test_relative_paths_shared_folders_and_other_apps_do_not_match(self):
        self.host.write('cron.d/other', '* * * * * root cd ~/srv/shop/data && ./srv/shop/data/x\n* * * * * root ${BASE}/srv/shop/data/y\n'
                        '* * * * * root /srv/shopping/data/z\n* * * * * root /srv/other/run\n* * * * * root docker restart shop-web-2\nnot a cron line /srv/shop/data\n')
        cfg = {'configFiles': ['/etc/hosts'], 'composeFiles': ['/srv/compose.yaml']}
        self.assertEqual(self.host.check(cfg)['findings'], [])

    def test_timer_services_are_matched_by_exec_working_folder_writable_paths_and_environment_file(self):
        self.host.write('systemd/shop-backup.timer', '[Timer]\nOnCalendar=*-*-* 02:00:00\nPersistent=true\n')
        service = self.host.write('systemd/shop-backup.service', '[Service]\nType=oneshot\nExecStartPre=-/usr/bin/true\n'
                                  'ExecStart=/usr/bin/env TOKEN=%s /srv/shop/data/backup.sh\n' % SECRET)
        self.host.write('systemd/sync@.service', '[Service]\nEnvironmentFile=-/srv/shop/data/sync.env\n')
        self.host.write('systemd/sync@nightly.timer', '[Timer]\nOnCalendar=daily\n')
        self.host.write('systemd/rotate.timer', '[Timer]\nOnCalendar=weekly\nUnit=rotate-logs.service\n')
        rotate = self.host.write('systemd/rotate-logs.service', '[Service]\nWorkingDirectory=/srv/shop/data\nExecStart=/usr/sbin/logrotate x\n')
        self.host.write('systemd/unrelated.timer', '[Timer]\nOnCalendar=hourly\n')
        self.host.write('systemd/unrelated.service', '[Service]\nExecStart=/usr/bin/docker system prune -f\nExecStop=/srv/shop/data/stop\n')
        result = self.host.check()
        found = {f['path']: f for f in result['findings']}
        self.assertEqual(sorted(found), sorted([service, rotate, os.path.join(self.host.roots['systemd'], 'sync@.service')]))
        self.assertEqual((found[service]['line'], found[service]['schedule']), (4, '*-*-* 02:00:00'))
        self.assertEqual((found[rotate]['line'], found[rotate]['schedule']), (2, 'weekly'))
        self.assertIn('shop-backup.timer', found[service]['message'])
        self.assertNotIn(SECRET, json.dumps(result) + self.host.events)

    def test_the_key_survives_line_moves_and_names_kind_path_and_match(self):
        path = self.host.write('cron.d/shop', '0 1 * * * root /srv/shop/data/a\n')
        first = self.host.check()['findings'][0]
        pathlib.Path(path).write_text('# moved\n\n0 9 * * * root /srv/shop/data/b\n')
        second = self.host.check()['findings'][0]
        self.assertEqual(first['key'], second['key']); self.assertEqual((first['line'], second['line']), (1, 3))
        self.assertEqual(first['key'], helper.hashlib.sha256('\0'.join(('host-schedule', path, '/srv/shop/data')).encode()).hexdigest())


class SafeReadingTests(GapTest):
    def test_files_in_protected_folders_are_never_read(self):
        self.host.roots['crontab'] = self.host.write('.ssh/crontab', '* * * * * root /srv/shop/data/x\n')
        result = self.host.check()
        self.assertEqual((result['findings'], result['limits']['filesRead']), ([], 0))

    @unittest.skipUnless(can_link(), 'symbolic links need extra rights on this Windows workstation')
    def test_links_out_of_the_scanned_folder_are_not_followed_and_mark_the_check_incomplete(self):
        outside = self.host.write('elsewhere/shop', '* * * * * root /srv/shop/data/x\n')
        os.symlink(outside, os.path.join(self.host.roots['cron'], 'shop'))
        result = self.host.check()
        self.assertEqual(result['findings'], []); self.assertFalse(result['complete'])

    @unittest.skipUnless(can_link(), 'symbolic links need extra rights on this Windows workstation')
    def test_links_inside_the_folder_are_read_and_masked_units_are_skipped_quietly(self):
        inside = self.host.write('cron.d/real', '* * * * * root /srv/shop/data/x\n')
        os.symlink(inside, os.path.join(self.host.roots['cron'], 'alias'))
        if os.path.exists('/dev/null'): os.symlink('/dev/null', os.path.join(self.host.roots['systemd'], 'masked.timer'))
        result = self.host.check()
        self.assertTrue(result['complete'])
        self.assertEqual(len(result['findings']), 2)

    def test_file_count_size_and_finding_bounds_mark_the_check_incomplete(self):
        for index in range(5): self.host.write('cron.d/job%d' % index, '* * * * * root /srv/shop/data/%d\n' % index)
        with patch.object(helper, 'GAP_FILES', 2):
            result = self.host.check()
        self.assertEqual((result['limits']['filesRead'], result['complete']), (2, False))
        with patch.object(helper, 'GAP_FINDINGS', 3):
            result = self.host.check()
        self.assertEqual((len(result['findings']), result['complete']), (3, False))
        self.host.write('cron.d/big', '#' * 64 + '\n* * * * * root /srv/shop/data/late\n')
        with patch.object(helper, 'GAP_BYTES', 40):
            result = self.host.check()
        self.assertFalse(result['complete'])
        self.assertNotIn(os.path.join(self.host.roots['cron'], 'big'), [f['path'] for f in result['findings']])

    def test_unchecked_containers_and_failures_become_one_plain_error_and_readiness_is_unchanged(self):
        self.assertEqual(helper.restore_check({'containers': ['--format=x']}), {'error': helper.GAP_ERROR})
        with patch('helper.restore_gaps', side_effect=RuntimeError('/srv/shop/data ' + SECRET)):
            failed = helper.restore_check({}, [])
        self.assertEqual(failed, {'error': helper.GAP_ERROR})
        with patch.multiple('helper', preflight=Mock(return_value=[]), backup_plan=Mock(), health=Mock(return_value=True)):
            with patch('helper.restore_check', return_value={'findings': [{'kind': 'host-schedule'}], 'complete': False, 'limits': {}}):
                found = helper.readiness({'containers': ['web'], 'maintenance': {}})
            with patch('helper.restore_gaps', side_effect=RuntimeError('boom')):
                broken = helper.readiness({'containers': ['web'], 'maintenance': {}})
        self.assertEqual(found['ready'], broken['ready']); self.assertEqual(found['checks'], broken['checks'])
        self.assertEqual(broken['restoreGaps'], {'error': helper.GAP_ERROR}); self.assertEqual(found['restoreGaps']['complete'], False)

    @unittest.skipIf(sys.platform == 'win32', 'Linux paths')
    def test_only_regular_unlinked_unprotected_files_the_capture_path_accepts_are_includable(self):
        path = self.host.write('cron.d/shop', '* * * * * root /srv/shop/data/x\n')
        link = os.path.join(self.host.roots['cron'], 'alias'); os.symlink(path, link)
        with patch('helper.classify_source', return_value={}):
            self.assertTrue(helper.gap_includable(path))
            for value in [link, self.host.roots['cron'], path + '.missing', '/etc/shadow', '/root/.ssh/authorized_keys', '//' + path.lstrip('/')]:
                self.assertFalse(helper.gap_includable(value), value)
        with patch('helper.classify_source', side_effect=ValueError('nfs')): self.assertFalse(helper.gap_includable(path))
        with patch('helper.classify_source', return_value={}):
            finding = {f['path']: f for f in self.host.check({'configFiles': [path]})['findings']}[path]
        self.assertEqual((finding['includable'], finding['included'], finding['includePaths']), (True, True, [path]))


class DockerAndComposeTests(GapTest):
    def inspect(self, labels):
        def docker(kind, _verb, name):
            if name not in labels: raise helper.subprocess.CalledProcessError(1, ['docker'])
            return json.dumps([{'Name': name, 'Labels': labels[name]}]).encode()
        return patch('helper.docker', side_effect=docker)

    def test_networks_and_volumes_the_app_does_not_create_itself_are_found(self):
        owned = {'com.docker.compose.project': 'shop'}
        compose = web(project='shop', networks={'shop_default': {}, 'proxy': {}, 'bridge': {}},
                      mounts=[{'Type': 'volume', 'Name': 'shop_data'}, {'Type': 'volume', 'Name': 'media'}, {'Type': 'volume', 'Name': 'a' * 64}])
        plain = web('worker', networks={'mynet': {}}, mounts=[{'Type': 'volume', 'Name': 'worker-data'}])
        with patch('helper.compose_gaps'), self.inspect({'shop_default': owned, 'proxy': {'com.docker.compose.project': 'edge'}, 'shop_data': owned, 'media': None, 'mynet': {}, 'worker-data': {}}):
            result = self.host.check(containers=[compose, plain])
        self.assertTrue(result['complete'])
        self.assertEqual(self.kinds(result), [('external-network', 'mynet', 'worker'), ('external-network', 'proxy', 'shop'), ('external-volume', 'media', 'shop')])
        self.assertTrue(all(f['includable'] is False for f in result['findings']))
        with self.inspect({}):
            self.assertFalse(self.host.check(containers=[plain])['complete'])

    def test_bind_mounts_outside_the_project_folder_are_listed_once(self):
        mounts = [{'Type': 'bind', 'Source': '/srv/shop/data'}, {'Type': 'bind', 'Source': '/mnt/media'}, {'Type': 'bind', 'Source': '/var/run/docker.sock'},
                  {'Type': 'bind', 'Source': '/root/.ssh'}]
        with patch('helper.project_roots', return_value=['/srv/shop']), patch('helper.compose_invocation', return_value=None), self.inspect({}):
            result = self.host.check(containers=[web(project='shop', mounts=mounts), web('shop-db', project='shop', mounts=mounts)])
        self.assertEqual([k for k in self.kinds(result) if k[0] == 'bind-outside'], [('bind-outside', '/mnt/media', 'shop')])

    def test_compose_env_files_secrets_and_configs_outside_the_project_folder(self):
        model = {'services': {'web': {'env_file': ['.env', '/etc/shop/prod.env', {'path': '../shared/common.env', 'required': False}, '${X}/a.env']}},
                 'secrets': {'db': {'file': '/etc/shop/db_password'}, 'api': {'external': True, 'name': 'shop_api_key'}, 'local': {'file': './secrets/key'}, 'env': {'environment': 'TOKEN'}},
                 'configs': {'nginx': {'file': '/opt/shared/nginx.conf'}}}
        invocation = {'project': 'shop', 'files': ['/srv/shop/compose.yaml'], 'projectDirectory': '/srv/shop', 'envFiles': []}
        with patch('helper.compose_invocation', return_value=invocation), patch('helper.edit_config', return_value=model) as config, self.inspect({}):
            result = self.host.check(containers=[web(project='shop', mounts=[])])
        config.assert_called_once_with(invocation, ['/srv/shop/compose.yaml'], [], True)
        self.assertEqual(self.kinds(result), [('env-file', '/etc/shop/prod.env', 'shop'), ('env-file', '/srv/shared/common.env', 'shop'),
                                              ('secret-or-config', '/etc/shop/db_password', 'shop'), ('secret-or-config', '/opt/shared/nginx.conf', 'shop'),
                                              ('secret-or-config', 'shop_api_key', 'shop')])
        self.assertIn('external Compose secret shop_api_key', result['findings'][-1]['message'])
        with patch('helper.compose_invocation', return_value=invocation), patch('helper.edit_config', side_effect=helper.EditRefused('COMPOSE_INVALID')), self.inspect({}):
            self.assertFalse(self.host.check(containers=[web(project='shop', mounts=[])])['complete'])

    def test_compose_labels_that_are_relative_protected_or_odd_are_not_run(self):
        labels = {'com.docker.compose.project': 'shop', 'com.docker.compose.project.working_dir': '/srv/shop', 'com.docker.compose.project.config_files': '/srv/shop/compose.yaml'}
        with patch('os.path.isfile', return_value=True):
            self.assertEqual(helper.compose_invocation(labels)['files'], ['/srv/shop/compose.yaml'])
            for change in [{'com.docker.compose.project': 'Shop!'}, {'com.docker.compose.project.working_dir': 'srv/shop'},
                           {'com.docker.compose.project.config_files': '/root/.ssh/compose.yaml'}, {'com.docker.compose.project.config_files': '/srv/shop/../x.yaml'},
                           {'com.docker.compose.project.config_files': ''}]:
                self.assertIsNone(helper.compose_invocation({**labels, **change}), change)


class CertificateTests(GapTest):
    def test_certbot_folders_and_nginx_certificate_files_for_the_app_domains(self):
        (self.host.base / 'live' / 'shop.example').mkdir()
        self.host.write('nginx/shop.conf', 'server { server_name shop.example www.shop.example; ssl_certificate /etc/ssl/shop.pem; '
                        'ssl_certificate_key /etc/ssl/private/shop.key; ssl_certificate $ssl_server_name.pem; }\n'
                        'server { server_name other.example; ssl_certificate /etc/ssl/other.pem; }\n')
        result = self.host.check({'domains': ['Shop.example', 'bad domain']}, containers=[])
        live = helper.lexical(os.path.join(self.host.roots['letsencrypt'], 'shop.example'))
        self.assertEqual(self.kinds(result), [('certificate', '/etc/ssl/private/shop.key', 'shop.example'), ('certificate', '/etc/ssl/shop.pem', 'shop.example'),
                                              ('certificate', live, 'shop.example')])
        self.assertIn('certbot', result['findings'][-1]['message'])

    def test_nginx_paths_inside_certbot_live_name_the_certificate_folder(self):
        self.host.roots['letsencrypt'] = '/etc/letsencrypt/live'
        self.host.write('nginx/shop.conf', 'server { server_name shop.example; ssl_certificate /etc/letsencrypt/live/shop.example-0001/fullchain.pem; '
                        'ssl_certificate_key /etc/letsencrypt/live/shop.example-0001/privkey.pem; }\n')
        result = self.host.check({'domains': ['shop.example']}, containers=[])
        self.assertEqual(self.kinds(result), [('certificate', '/etc/letsencrypt/live/shop.example-0001', 'shop.example')])
        self.assertFalse(result['findings'][0]['includable'])


if __name__ == '__main__': unittest.main()
