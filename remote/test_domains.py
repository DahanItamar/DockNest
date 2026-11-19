"""Proxy routes for the domain path (docs/domains.md). Run: python3 remote/test_domains.py
Proves each adapter (nginx, Nginx Proxy Manager, Caddy JSON and Caddyfile, Traefik labels) returns only hosts, ports,
upstreams and certificate file names, that the shared matcher finds the right container, that the Caddy admin call is a
loopback GET with a 1 MB limit, and that a secret written in any configuration never reaches the output."""
import json, pathlib, shutil, sys, tempfile, unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it); see helper_path.py
import helper

FIXTURES = pathlib.Path(__file__).parent / 'fixtures' / 'domains'
SECRET = 'fixture-secret-do-not-leak'


def container(name, image='fixture/app:1', ports=None, exposed=None, networks=None, labels=None, mounts=None, running=True, health=None):
    state = {'Running': running, **({'Health': {'Status': health}} if health else {})}
    return {'Name': '/' + name, 'Config': {'Image': image, 'Labels': labels or {}, 'ExposedPorts': exposed or {}}, 'State': state,
            'NetworkSettings': {'Ports': ports or {}, 'Networks': networks or {}}, 'Mounts': mounts or []}


class NginxTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(); shutil.copy(FIXTURES / 'nginx-sites.conf', self.folder.name)
        self.routes = {route['domains'][0]: route for route in helper.nginx_routes('nginx', [self.folder.name])}

    def tearDown(self): self.folder.cleanup()

    def test_listen_ports_and_certificate_names(self):
        shop = self.routes['shop.example.com']
        self.assertEqual(shop['domains'], ['shop.example.com', 'www.shop.example.com'])
        self.assertEqual(shop['listen'], [80, 443])
        self.assertEqual(shop['certificates'], ['shop.example.com'])
        self.assertEqual(self.routes['pool.example.com']['listen'], [8443])
        self.assertEqual(self.routes['pool.example.com']['certificates'], ['custom-chain.pem'])
        self.assertEqual(self.routes['blog.example.net']['listen'], [80])

    def test_upstreams_keep_scheme_host_and_port_only(self):
        self.assertEqual(self.routes['shop.example.com']['upstreams'], ['http://127.0.0.1:8080'])
        self.assertEqual(self.routes['pool.example.com']['upstreams'], ['http://127.0.0.1:8081'])
        self.assertEqual(self.routes['blog.example.net']['upstreams'], ['http://blog-web:2368'])
        self.assertTrue(self.routes['shop.example.com']['understood'])

    def test_a_variable_upstream_is_not_understood_and_never_guessed(self):
        dynamic = self.routes['dynamic.example.net']
        self.assertEqual(dynamic['upstreams'], []); self.assertFalse(dynamic['understood'])

    def test_no_secret_or_path_leaves(self):
        text = json.dumps(list(self.routes.values()))
        for value in (SECRET, 'htpasswd', 'privkey', '/etc/', 'X-Api-Key'): self.assertNotIn(value, text)

    def test_listen_directive_forms(self):
        self.assertEqual([helper.nginx_listen_port(args) for args in (['80'], ['[::]:443', 'ssl'], ['127.0.0.1:8080'], ['unix:/run/x.sock'], ['localhost'], [])], [80, 443, 8080, None, 80, 80])


class NpmTests(unittest.TestCase):
    def test_generated_proxy_host_files_are_read_with_the_nginx_parser(self):
        with tempfile.TemporaryDirectory() as data:
            hosts = pathlib.Path(data) / 'nginx' / 'proxy_host'; hosts.mkdir(parents=True)
            shutil.copy(FIXTURES / 'npm-proxy-host.conf', hosts / '1.conf')
            (pathlib.Path(data) / 'database.sqlite').write_text(SECRET)
            npm = container('npm', 'jc21/nginx-proxy-manager:2', mounts=[{'Type': 'bind', 'Source': str(pathlib.Path(data).resolve()), 'Destination': '/data'}])
            routes = helper.npm_routes(npm)
            self.assertEqual(len(routes), 1)
            self.assertEqual(routes[0]['domains'], ['app.example.com'])
            self.assertEqual(routes[0]['upstreams'], ['http://app-web:3000'])
            self.assertEqual(routes[0]['listen'], [80, 443])
            self.assertEqual(routes[0]['certificates'], ['npm-7'])
            self.assertEqual(routes[0]['proxy'], 'npm'); self.assertEqual(routes[0]['container'], 'npm')
            self.assertNotIn(SECRET, json.dumps(routes))

    def test_no_data_mount_means_no_routes(self):
        self.assertEqual(helper.npm_routes(container('npm', 'jc21/nginx-proxy-manager:2')), [])


class CaddyTests(unittest.TestCase):
    def test_admin_json_is_reduced_to_hosts_and_upstreams(self):
        routes = helper.caddy_json_routes(json.loads((FIXTURES / 'caddy-config.json').read_text()))
        self.assertEqual([(r['domains'], r['upstreams'], r['listen']) for r in routes], [
            (['notes.example.com'], ['http://notes-web:8080'], [443]),
            (['files.example.com'], ['http://localhost:9000'], [443])])
        self.assertNotIn(SECRET, json.dumps(routes)); self.assertNotIn('fixture-secret-root', json.dumps(routes))

    def test_caddyfile_site_addresses_and_reverse_proxy_targets(self):
        routes, understood = helper.caddyfile_routes((FIXTURES / 'Caddyfile').read_text())
        self.assertEqual([(r['domains'], r['upstreams'], r['listen']) for r in routes], [
            (['wiki.example.com', 'www.wiki.example.com'], ['http://wiki-web:3000'], [80, 443]),
            (['plain.example.net'], ['http://127.0.0.1:7000'], [8088])])
        self.assertTrue(understood)
        self.assertNotIn(SECRET, json.dumps(routes)); self.assertNotIn('snippet-only', json.dumps(routes))

    def test_an_import_makes_the_list_partial(self):
        self.assertFalse(helper.caddyfile_routes('import sites/*\nexample.com {\n reverse_proxy app:80\n}\n')[1])

    def test_admin_call_is_a_loopback_get_on_a_fixed_path_with_a_limit(self):
        calls = []
        class Response:
            status = 200
            def __init__(self, body): self.body = body
            def read(self, limit): calls.append(('read', limit)); return self.body[:limit]
        class Connection:
            body = b'{"apps":{}}'
            def __init__(self, host, port, timeout): calls.append(('connect', host, port))
            def request(self, method, path, headers): calls.append(('request', method, path))
            def getresponse(self): return Response(Connection.body)
            def close(self): pass
        with patch('helper.http.client.HTTPConnection', Connection):
            self.assertEqual(helper.caddy_admin_config(), {'apps': {}})
            Connection.body = b' ' * (helper.CONFIG_LIMIT + 1)
            self.assertIsNone(helper.caddy_admin_config())
        self.assertEqual(calls[:3], [('connect', '127.0.0.1', 2019), ('request', 'GET', '/config/'), ('read', helper.CONFIG_LIMIT + 1)])

    def test_the_mounted_caddyfile_is_read_when_the_admin_api_is_off(self):
        with tempfile.TemporaryDirectory() as folder:
            shutil.copy(FIXTURES / 'Caddyfile', pathlib.Path(folder) / 'Caddyfile')
            caddy = container('caddy', 'caddy:2', mounts=[{'Type': 'bind', 'Source': str(pathlib.Path(folder).resolve()), 'Destination': '/etc/caddy'}])
            with patch('helper.caddy_admin_config', side_effect=ConnectionRefusedError()):
                routes, understood = helper.caddy_routes(caddy)
        self.assertEqual(routes[0]['container'], 'caddy'); self.assertEqual(len(routes), 2); self.assertTrue(understood)


class TraefikTests(unittest.TestCase):
    def setUp(self): self.containers = json.loads((FIXTURES / 'traefik-containers.json').read_text())

    def test_host_rules_become_routes_and_other_matchers_are_not_understood(self):
        routes, unparsed = helper.traefik_routes(self.containers)
        self.assertEqual([(r['domains'], r['upstreams'], r['containers']) for r in routes], [
            (['forum.example.com', 'www.forum.example.com'], ['http://forum-web:4567'], ['forum-web']),
            (['db.example.com'], ['tcp://forum-web'], ['forum-web'])])
        self.assertEqual(sorted(item['router'] for item in unparsed), ['forum-api', 'regex'])
        self.assertNotIn(SECRET, json.dumps([routes, unparsed])); self.assertNotIn('ignored.example.com', json.dumps(routes))

    def test_rule_parser(self):
        self.assertEqual(helper.traefik_rule_hosts('Host(`a.example.com`, "b.example.com")'), ['a.example.com', 'b.example.com'])
        for rule in ('HostRegexp(`x`)', 'Host(`a.example.com`) && Path(`/`)', 'Host(`*`)', 'HostSNI(`*`)', 'Host(`a.example.com`) || PathPrefix(`/x`)', ''):
            self.assertIsNone(helper.traefik_rule_hosts(rule), rule)


class MatcherTests(unittest.TestCase):
    def test_published_ports_network_names_and_own_addresses(self):
        web = container('shop-web', ports={'8080/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '8080'}]}, exposed={'8080/tcp': {}},
                        networks={'shop_default': {'Aliases': ['shop', 'web'], 'DNSNames': ['shop-web', 'web']}})
        open_port = container('open-web', ports={'80/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '8090'}]})
        match = lambda upstream, addresses=(): helper.match_upstream(upstream, [web, open_port], addresses)
        self.assertEqual(match('http://127.0.0.1:8080'), ['shop-web'])
        self.assertEqual(match('http://localhost:8090'), ['open-web'])
        self.assertEqual(match('http://web:8080'), ['shop-web'])
        self.assertEqual(match('http://shop-web:9999'), [], 'a port the container does not expose')
        self.assertEqual(match('http://192.0.2.10:8090', ['192.0.2.10']), ['open-web'], 'an address of this server, published on all interfaces')
        self.assertEqual(match('http://192.0.2.10:8080', ['192.0.2.10']), [], 'published on loopback only')
        self.assertEqual(match('http://203.0.113.9:8090'), [], 'another host')

    def test_upstream_address_drops_login_paths_and_variables(self):
        self.assertEqual(helper.upstream_address('https://user:pw@App.Example.com:8443/x?y=1'), 'https://app.example.com:8443')
        self.assertEqual(helper.upstream_address('[::1]:8080'), 'http://[::1]:8080')
        for value in ('http://$backend', 'unix//run/app.sock', '{http.request.host}', 'http://a:99999'): self.assertIsNone(helper.upstream_address(value), value)


class ProxyRoutesTests(unittest.TestCase):
    def test_all_adapters_together_without_secrets(self):
        with tempfile.TemporaryDirectory() as folder:
            shutil.copy(FIXTURES / 'nginx-sites.conf', folder)
            containers = json.loads((FIXTURES / 'traefik-containers.json').read_text())
            containers.append(container('shop-web', ports={'8080/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '8080'}]}, health='unhealthy'))
            original = helper.nginx_routes
            with patch('helper.nginx_routes', lambda proxy: original(proxy, [folder])), patch('helper.shutil.which', lambda name: '/usr/sbin/nginx' if name == 'nginx' else None), \
                 patch('helper.host_addresses', return_value=['192.0.2.10', '100.100.1.2']), patch('helper.listening_ports', return_value=[22, 443]), \
                 patch('helper.process_running', return_value=True):
                facts = helper.proxy_routes(containers)
        self.assertEqual(facts['format'], 1); self.assertFalse(facts['incomplete']); self.assertFalse(facts['port80'])
        self.assertEqual(facts['addresses'], ['192.0.2.10', '100.100.1.2'])
        shop = next(r for r in facts['routes'] if r['domains'][0] == 'shop.example.com')
        self.assertEqual(shop['containers'], ['shop-web'])
        self.assertEqual({(p['proxy'], p['container'], p['running']) for p in facts['proxies']}, {('nginx', None, True), ('traefik', 'traefik', True)})
        self.assertIn({'name': 'shop-web', 'running': True, 'health': 'unhealthy', 'published': []}, facts['containers'])
        self.assertEqual(len(facts['notUnderstood']), 2)
        self.assertNotIn(SECRET, json.dumps(facts))

    def test_a_docker_failure_makes_the_list_incomplete_never_an_error(self):
        with patch('helper.docker', side_effect=OSError('no docker')), patch('helper.shutil.which', return_value=None), \
             patch('helper.host_addresses', return_value=[]), patch('helper.listening_ports', return_value=[80]), patch('helper.pathlib.Path.is_dir', return_value=False):
            facts = helper.proxy_routes()
        self.assertTrue(facts['incomplete']); self.assertTrue(facts['port80']); self.assertEqual(facts['routes'], [])

    def test_an_adapter_that_fails_is_partial(self):
        caddy = container('caddy', 'caddy:2')
        with patch('helper.caddy_routes', side_effect=RuntimeError('boom')), patch('helper.shutil.which', return_value=None), \
             patch('helper.host_addresses', return_value=[]), patch('helper.listening_ports', return_value=[]), patch('helper.pathlib.Path.is_dir', return_value=False):
            facts = helper.proxy_routes([caddy])
        self.assertTrue(facts['incomplete'])


class RenewalCategoryTests(unittest.TestCase):
    def test_only_the_category_of_a_failed_renewal_is_kept(self):
        with tempfile.TemporaryDirectory() as logs:
            (pathlib.Path(logs) / 'letsencrypt.log').write_text(
                'Processing /etc/letsencrypt/renewal/shop.example.com.conf\n'
                'Detail: 192.0.2.10: Fetching http://shop.example.com/.well-known/acme-challenge/x: Connection refused\n'
                'Failed to renew certificate shop.example.com with error: Some challenges have failed.\n'
                'Processing /etc/letsencrypt/renewal/blog.example.net.conf\n'
                'Failed to renew certificate blog.example.net with error: DNS problem: NXDOMAIN looking up A\n'
                'Processing /etc/letsencrypt/renewal/limit.example.net.conf\n'
                'Failed to renew certificate limit.example.net with error: urn:ietf:params:acme:error:rateLimited\n'
                'Processing /etc/letsencrypt/renewal/other.example.net.conf\n'
                'Failed to renew certificate other.example.net with error: something else\n'
                'All renewals failed. The following certificates could not be renewed:\n'
                '  /etc/letsencrypt/live/shop.example.com/fullchain.pem (failure)\n')
            outcomes = helper.renewal_outcomes(logs)
        self.assertEqual({name: value[2] for name, value in outcomes.items()},
                         {'shop.example.com': 'connection-refused', 'blog.example.net': 'dns', 'limit.example.net': 'rate-limited', 'other.example.net': None})


if __name__ == '__main__':
    unittest.main()
