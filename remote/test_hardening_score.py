"""Hardening score facts (docs/hardening-score.md): what discovery and backups read from `docker inspect`, and what never leaves."""
import json, subprocess, unittest
from unittest.mock import patch
import helper_path  # the built helper.py (one file, as servers run it); see helper_path.py
from helper import container_hardening_facts, hardening_report, image_pin, engine_rootless, root_user


def container(**overrides):
    base = {'Id': 'a' * 64, 'Name': '/web',
            'Config': {'Image': 'nginx:1.27', 'User': '', 'Env': ['DB_PASSWORD=hunter2-secret'], 'Labels': {'token': 'label-secret'},
                       'Healthcheck': {'Test': ['CMD', 'curl', '-f', 'http://localhost/']}},
            'HostConfig': {'Privileged': False, 'NetworkMode': 'bridge', 'Memory': 0, 'SecurityOpt': None, 'CapAdd': None,
                           'PortBindings': {'80/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '8080'}]}, 'Binds': None},
            'NetworkSettings': {'Ports': {'80/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '8080'}]}},
            'Mounts': [{'Type': 'bind', 'Source': '/srv/app/data', 'Destination': '/data'}]}
    for key, value in overrides.items():
        section, _, field = key.partition('__')
        if field: base[section] = {**base[section], field: value}
        else: base[section] = value
    return base


class HardeningFactTests(unittest.TestCase):
    def test_safe_container_reports_clean_facts_and_no_secrets(self):
        facts = container_hardening_facts(container(HostConfig__Memory=268435456, HostConfig__SecurityOpt=['no-new-privileges:true'], Config__User='1000:1000'), engine='none')
        self.assertEqual(facts['format'], 1); self.assertEqual(facts['name'], 'web')
        for flag in ['privileged', 'dockerSocket', 'rootUser', 'hostNetwork']: self.assertFalse(facts[flag], flag)
        for flag in ['memoryLimit', 'healthcheck', 'noNewPrivileges']: self.assertTrue(facts[flag], flag)
        self.assertEqual(facts['publicPorts'], []); self.assertEqual(facts['extraCapabilities'], []); self.assertEqual(facts['imagePin'], 'tag')
        self.assertFalse(facts['publishAll']); self.assertIs(facts['rootless'], False)
        text = json.dumps(facts)
        for secret in ['hunter2', 'label-secret', 'DB_PASSWORD', '/srv/app/data']: self.assertNotIn(secret, text)

    def test_privileged_socket_host_network_and_capabilities(self):
        facts = container_hardening_facts(container(HostConfig__Privileged=True, HostConfig__NetworkMode='host', HostConfig__CapAdd=['CAP_NET_ADMIN', 'chown', 'SYS_ADMIN'],
                                          Mounts=[{'Type': 'bind', 'Source': '/var/run/docker.sock', 'Destination': '/var/run/docker.sock'}]))
        self.assertTrue(facts['privileged']); self.assertTrue(facts['dockerSocket']); self.assertTrue(facts['hostNetwork'])
        self.assertEqual(facts['extraCapabilities'], ['NET_ADMIN', 'SYS_ADMIN'], 'Docker default capabilities are not extra')

    def test_socket_by_bind_string_and_run_path(self):
        self.assertTrue(container_hardening_facts(container(Mounts=[], HostConfig__Binds=['/run/docker.sock:/var/run/docker.sock:ro']))['dockerSocket'])
        self.assertFalse(container_hardening_facts(container(Mounts=[{'Type': 'volume', 'Source': '/var/run/docker.sock', 'Destination': '/x'}]))['dockerSocket'])

    def test_ports_on_all_interfaces_versus_loopback(self):
        loopback = container_hardening_facts(container())
        self.assertEqual(loopback['publicPorts'], [])
        ipv4 = container_hardening_facts(container(HostConfig__PortBindings={'80/tcp': [{'HostIp': '', 'HostPort': '8080'}]}, NetworkSettings={'Ports': {'80/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '8080'}]}}))
        self.assertEqual(ipv4['publicPorts'], ['0.0.0.0:8080->80/tcp'])
        ipv6 = container_hardening_facts(container(HostConfig__PortBindings={}, NetworkSettings={'Ports': {'443/tcp': [{'HostIp': '::', 'HostPort': '8443'}]}}))
        self.assertEqual(ipv6['publicPorts'], [':::8443->443/tcp'])
        stopped = container_hardening_facts(container(HostConfig__PortBindings={'53/udp': [{'HostIp': '0.0.0.0', 'HostPort': '53'}]}, NetworkSettings={'Ports': {}}))
        self.assertEqual(stopped['publicPorts'], ['0.0.0.0:53->53/udp'], 'configured bindings count even while the container is stopped')

    def test_root_user_forms(self):
        for user in ['', 'root', '0', '0:0', 'root:wheel']: self.assertTrue(root_user(user), user)
        for user in ['1000', 'node', '1000:1000', 'www-data']: self.assertFalse(root_user(user), user)

    def test_image_pin(self):
        cases = {'nginx': 'untagged', 'nginx:latest': 'latest', 'nginx:1.27': 'tag', 'registry.local:5000/app': 'untagged',
                 'registry.local:5000/app:2.1': 'tag', 'app@sha256:' + 'b' * 64: 'digest', 'app:1.0@sha256:' + 'c' * 64: 'digest',
                 'sha256:' + 'd' * 64: 'untagged', '': 'untagged', None: 'untagged'}
        for image, expected in cases.items(): self.assertEqual(image_pin(image), expected, image)

    def test_healthcheck_and_no_new_privileges_forms(self):
        self.assertFalse(container_hardening_facts(container(Config__Healthcheck={'Test': ['NONE']}))['healthcheck'])
        self.assertFalse(container_hardening_facts(container(Config__Healthcheck=None))['healthcheck'])
        self.assertTrue(container_hardening_facts(container(HostConfig__SecurityOpt=['no-new-privileges']))['noNewPrivileges'])
        self.assertTrue(container_hardening_facts(container(HostConfig__SecurityOpt=['no-new-privileges=true']))['noNewPrivileges'])
        self.assertFalse(container_hardening_facts(container(HostConfig__SecurityOpt=['no-new-privileges:false']))['noNewPrivileges'])

    def test_rootless_engine_detection(self):
        with patch('helper.run', return_value=b'["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]\n') as command:
            self.assertEqual(engine_rootless(), 'rootless')
            self.assertEqual(command.call_args.kwargs.get('timeout'), 15)
        with patch('helper.run', return_value=b'["name=seccomp,profile=builtin","name=userns"]\n'): self.assertEqual(engine_rootless(), 'userns')
        with patch('helper.run', return_value=b'["name=seccomp,profile=builtin"]\n'): self.assertEqual(engine_rootless(), 'none')
        with patch('helper.run', side_effect=subprocess.CalledProcessError(1, 'docker')): self.assertIsNone(engine_rootless())
        with patch('helper.run', side_effect=subprocess.TimeoutExpired('docker', 15)): self.assertIsNone(engine_rootless())

    def test_userns_remap_with_host_userns_is_real_root(self):
        self.assertIs(container_hardening_facts(container(), engine='rootless')['rootless'], True)
        self.assertIs(container_hardening_facts(container(), engine='userns')['rootless'], True)
        self.assertIs(container_hardening_facts(container(HostConfig__UsernsMode='host'), engine='userns')['rootless'], False)
        self.assertIs(container_hardening_facts(container(), engine='none')['rootless'], False)
        self.assertIsNone(container_hardening_facts(container())['rootless'])

    def test_engine_socket_folders_and_destinations(self):
        def bind(source, destination='/x'): return container_hardening_facts(container(Mounts=[{'Type': 'bind', 'Source': source, 'Destination': destination}]))['dockerSocket']
        for source in ['/var/run/docker.sock', '/run/docker.sock', '/srv/custom/docker.sock', '/run/podman/podman.sock', '/', '/var', '/run', '/var/run', '/var/run/', '/run/user/1000', '/run/user/1000/docker.sock']:
            self.assertTrue(bind(source), source)
        for source in ['/srv/app', '/var/lib/app', '/run/secrets', '/home/user/docker.sock.bak']:
            self.assertFalse(bind(source), source)
        self.assertTrue(bind('/srv/odd/engine', '/var/run/docker.sock'), 'destination is where clients look for the engine')
        self.assertTrue(container_hardening_facts(container(Mounts=[{'Type': 'volume', 'Source': '/var/lib/docker/volumes/x/_data', 'Destination': '/var/run/docker.sock'}]))['dockerSocket'])
        self.assertTrue(container_hardening_facts(container(Mounts=[], HostConfig__Binds=['/var/run:/host-run']))['dockerSocket'])
        self.assertTrue(container_hardening_facts(container(Mounts=[], HostConfig__Binds=['/srv/x:/var/run/docker.sock']))['dockerSocket'])

    def test_publish_all_and_specific_addresses(self):
        self.assertTrue(container_hardening_facts(container(HostConfig__PublishAllPorts=True))['publishAll'])
        lan = container_hardening_facts(container(HostConfig__PortBindings={'80/tcp': [{'HostIp': '192.168.1.10', 'HostPort': '8080'}]}, NetworkSettings={'Ports': {}}))
        self.assertEqual(lan['publicPorts'], ['192.168.1.10:8080->80/tcp'], 'a specific non-loopback address is reachable from outside')
        for address in ['127.0.0.1', '127.0.0.2', '::1', '[::1]', 'localhost']:
            self.assertEqual(container_hardening_facts(container(HostConfig__PortBindings={'80/tcp': [{'HostIp': address, 'HostPort': '8080'}]}, NetworkSettings={'Ports': {}}))['publicPorts'], [], address)

    def test_database_ports_survive_a_long_port_list(self):
        many = {'%d/tcp' % port: [{'HostIp': '0.0.0.0', 'HostPort': str(port)}] for port in range(10000, 10100)}
        many['5432/tcp'] = [{'HostIp': '0.0.0.0', 'HostPort': '5432'}]
        facts = container_hardening_facts(container(HostConfig__PortBindings=many, NetworkSettings={'Ports': {}}))
        self.assertEqual(len(facts['publicPorts']), 64); self.assertEqual(facts['publicPorts'][0], '0.0.0.0:5432->5432/tcp')

    def test_user_run_folders_flag_only_the_engine_socket(self):
        from helper import engine_socket
        for source in ['/run/user/1000', '/run/user/1000/docker.sock', '/run/user/0/podman.sock', '/run/podman', '/run/podman/podman.sock']:
            self.assertTrue(engine_socket(source, '/x'), source)
        for source in ['/run/user/1000/pulse', '/run/user/1000/pulse/native', '/run/user/abc', '/run/users/1000', '/run/userdata']:
            self.assertFalse(engine_socket(source, '/x'), source)

    def test_scoped_ipv6_host_address_is_loopback_checked_without_its_zone(self):
        scoped = container(HostConfig__PortBindings={'80/tcp': [{'HostIp': '::1%lo', 'HostPort': '80'}, {'HostIp': 'fe80::1%eth0', 'HostPort': '8080'}]}, NetworkSettings={'Ports': {}})
        self.assertEqual(container_hardening_facts(scoped)['publicPorts'], ['fe80::1:8080->80/tcp'])

    def test_report_never_fails_the_scan(self):
        with patch('helper.run', return_value=b'[]'):
            self.assertEqual(hardening_report([]), [])
            self.assertEqual(len(hardening_report([container(), container(Name='/db')])), 2)
            self.assertIsNone(hardening_report([{'Config': 'broken'}]))


if __name__ == '__main__': unittest.main()
