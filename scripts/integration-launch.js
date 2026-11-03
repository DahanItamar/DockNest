// Launch a new site on a real Linux Docker host (docs/launch-site.md, "Test plan" and "Security review changes" item 18).
// Called by scripts/integration-linux.js. Drives the real launch engine and worker claim, the real helper
// (remote/helper/launch.py) over SSH, real Docker, Compose, BuildKit, nginx and git, and real backups.
//
// Fixture: a dedicated Docker-in-Docker host (the "launch host") with nginx, certbot and git installed, bystander things
// that no launch may touch, and a Git server on the second QA host: HTTPS (smart HTTP, a CA made at run time) on 8443 and
// SSH (a host key made with ssh-keygen at run time) on 2222. DNS is /etc/hosts on the launch host. Certificates come from
// Pebble where its images can be pulled; otherwise certbot is replaced by a recorded test double and that part is
// reported as PARTIAL, never as passed (see evidence.partial).
//
// The privilege gate (edit_gate, Safe Edit, 2.15) is in the bundled helper. If it were ever missing, every launch would be
// refused with GATE_UNAVAILABLE, so this script fails at once with a clear message. It never skips a scenario and calls it passed.
// Keys, certificates and passwords are generated at run time; nothing secret is written to this file. Seeded
// timestamps are in the past. Not runnable on Windows (needs the Docker-in-Docker hosts).
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeHelperBundle } from '../src/helper-bundle.js';

export const GATE_MISSING = '2.15 gate missing; merge main first';
const GIT_HOST = 'git.docknest.test';
const PAST = () => new Date(Date.now() - 3 * 3600_000).toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const lines = text => String(text).split('\n').map(line => line.trim()).filter(Boolean);

// ---------- fixture files (written to the hosts at run time) ----------
const GIT_HTTP_SERVER = String.raw`import http.server, os, ssl, subprocess, sys
ROOT, CERT, KEY, TRAP = sys.argv[1:5]
class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'
    def log_message(self, *args): pass
    def serve(self):
        path, _, query = self.path.partition('?')
        if path.startswith('/redirect.git/'):
            self.send_response(302); self.send_header('Location', TRAP + '/trap.git/info/refs?' + query)
            self.send_header('Content-Length', '0'); self.end_headers(); return
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'GIT_PROJECT_ROOT': ROOT, 'GIT_HTTP_EXPORT_ALL': '1',
               'REQUEST_METHOD': self.command, 'PATH_INFO': path, 'QUERY_STRING': query,
               'CONTENT_TYPE': self.headers.get('Content-Type', ''), 'REMOTE_USER': 'qa', 'REMOTE_ADDR': self.client_address[0]}
        for header, name in (('Git-Protocol', 'GIT_PROTOCOL'), ('Content-Encoding', 'HTTP_CONTENT_ENCODING')):
            if self.headers.get(header): env[name] = self.headers[header]
        body = b''
        if self.headers.get('Transfer-Encoding', '').lower() == 'chunked':
            while True:
                size = int(self.rfile.readline().split(b';')[0].strip() or b'0', 16)
                if size == 0: self.rfile.readline(); break
                body += self.rfile.read(size); self.rfile.readline()
        else:
            body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        env['CONTENT_LENGTH'] = str(len(body))
        done = subprocess.run(['git', 'http-backend'], input=body, env=env, capture_output=True)
        head, _, payload = done.stdout.partition(b'\r\n\r\n')
        status, headers = 200, []
        for line in head.decode('latin-1').split('\r\n'):
            key, _, value = line.partition(': ')
            if key.lower() == 'status': status = int(value.split()[0])
            elif key: headers.append((key, value))
        self.send_response(status)
        for key, value in headers: self.send_header(key, value)
        self.send_header('Content-Length', str(len(payload))); self.end_headers(); self.wfile.write(payload)
    do_GET = do_POST = serve
server = http.server.ThreadingHTTPServer(('0.0.0.0', 8443), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.load_cert_chain(CERT, KEY)
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
`;

// Repositories. Every commit is dated in the past. busybox httpd serves a page; the Dockerfile is built by the launch.
const GIT_REPOS = String.raw`set -eu
export GIT_AUTHOR_DATE='2020-01-01T00:00:00+0000' GIT_COMMITTER_DATE='2020-01-01T00:00:00+0000'
export GIT_AUTHOR_NAME=qa GIT_AUTHOR_EMAIL=qa@example.invalid GIT_COMMITTER_NAME=qa GIT_COMMITTER_EMAIL=qa@example.invalid
rm -rf /srv/git /tmp/work; mkdir -p /srv/git /tmp/work
publish() { (cd /tmp/work/$1 && git init -q -b main . && git add -A && git commit -q -m seed); }
bare() { git clone -q --bare /tmp/work/$1 /srv/git/$1.git && git -C /srv/git/$1.git update-server-info; }
web() { mkdir -p /tmp/work/$1; printf 'launch-git-ok\n' > /tmp/work/$1/index.html
  # busybox httpd as PID 1 ignores SIGTERM, so Docker would kill it (exit 137) and DockNest rightly refuses that as a clean
  # shutdown. A well-behaved app exits 0 on SIGTERM; this small wrapper does that.
  printf '#!/bin/sh\ntrap "exit 0" TERM INT\nhttpd -f -p 8080 -h /www &\nwait $!\n' > /tmp/work/$1/run.sh
  printf 'FROM busybox:1.36\nCOPY index.html /www/index.html\nCOPY run.sh /run.sh\nHEALTHCHECK --interval=2s --timeout=2s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1\nCMD ["sh","/run.sh"]\n' > /tmp/work/$1/Dockerfile
  printf 'services:\n  web:\n    build: .\n    expose:\n      - "8080"\n' > /tmp/work/$1/compose.yaml; }
plain() { mkdir -p /tmp/work/$1; printf 'services:\n  web:\n    image: busybox:1.36\n    command: ["httpd","-f","-p","8080","-h","/tmp"]\n    expose:\n      - "8080"\n%b' "${'$'}{2:-}" > /tmp/work/$1/compose.yaml; }
# public: builds and runs
web site; publish site; bare site
# private (SSH): main is healthy, branch unhealthy never becomes healthy
web private; publish private
(cd /tmp/work/private && git checkout -q -b unhealthy && sed -i 's/--retries=3 CMD wget.*/--retries=1 CMD exit 1/' Dockerfile && git commit -q -am unhealthy && git checkout -q main)
bare private
# Dockerfile asking for the host network
web netrun; sed -i 's/^COPY /RUN --network=host true\nCOPY /' /tmp/work/netrun/Dockerfile; publish netrun; bare netrun
# a repository .env that tries to steer Compose to a privileged service
plain envfile; printf 'COMPOSE_FILE=evil.yaml\nCOMPOSE_PROJECT_NAME=hijack\n' > /tmp/work/envfile/.env
printf 'services:\n  evil:\n    image: busybox:1.36\n    privileged: true\n    command: ["sleep","3600"]\n' > /tmp/work/envfile/evil.yaml; publish envfile; bare envfile
# a symbolic link that leaves the repository
plain escape; ln -s /etc /tmp/work/escape/link; publish escape; bare escape
# a real data folder that the test later swaps for a link to /etc (bind source resolved at start)
plain swap '    volumes:\n      - ./data:/data:ro\n'; mkdir /tmp/work/swap/data; printf 'x\n' > /tmp/work/swap/data/file; publish swap; bare swap
chown -R git:git /srv/git
`;

const CERTBOT_DOUBLE = String.raw`#!/bin/sh
# Test double for certbot, installed only when Pebble is unavailable (scripts/integration-launch.js).
echo "$@" >> /var/log/docknest-qa-certbot.log
case "$1" in
 certonly)
  name=""; domain=""
  while [ $# -gt 0 ]; do case "$1" in --cert-name) name="$2"; shift;; -d) [ -n "$domain" ] || domain="$2"; shift;; esac; shift; done
  dir=/etc/letsencrypt/live/$name; mkdir -p "$dir" /etc/letsencrypt/renewal /etc/letsencrypt/accounts
  # Signed by a CA made at run time and trusted by this host (see the install step), so the helper's HTTPS probe verifies it.
  openssl req -newkey rsa:2048 -nodes -keyout "$dir/privkey.pem" -out "$dir/req.csr" -subj "/CN=$domain" >/dev/null 2>&1 || exit 1
  printf 'subjectAltName=DNS:%s\n' "$domain" > "$dir/ext.cnf"
  openssl x509 -req -in "$dir/req.csr" -CA /etc/docknest-qa-ca/ca.pem -CAkey /etc/docknest-qa-ca/ca.key -CAcreateserial -out "$dir/cert.pem" -days 2 -extfile "$dir/ext.cnf" >/dev/null 2>&1 || exit 1
  rm -f "$dir/req.csr" "$dir/ext.cnf"; cp "$dir/cert.pem" "$dir/fullchain.pem"; cp /etc/docknest-qa-ca/ca.pem "$dir/chain.pem"; echo "# test double" > "/etc/letsencrypt/renewal/$name.conf"; exit 0;;
 delete)
  name=""; while [ $# -gt 0 ]; do case "$1" in --cert-name) name="$2"; shift;; esac; shift; done
  rm -rf "/etc/letsencrypt/live/$name" "/etc/letsencrypt/archive/$name" "/etc/letsencrypt/renewal/$name.conf"; exit 0;;
esac
exit 1
`;

const BASE_COMPOSE = 'services:\n  web:\n    image: nginx:1.27-alpine\n    expose:\n      - "80"\n';
const NGINX_MARK = 'Welcome to nginx!';

export async function runLaunchScenario({ run, until, hosts, servers, db, record, evidence, directory }) {
  // ---------- 0. the privilege gate must be in the helper this test ships ----------
  const bundle = await readFile(writeHelperBundle(), 'utf8');
  if (!/^\s*def edit_gate\s*\(/m.test(bundle)) throw new Error(GATE_MISSING);
  const partial = text => { evidence.partial.push(text); console.log('PARTIAL ' + text); };

  const { enqueueBackup, claimJob, executeJob, testServer, verifyEncrypted } = await import('../src/engine.js');
  const { prepareServerKey } = await import('../src/server-onboarding.js');
  const { seal } = await import('../src/crypto.js');
  const { remote } = await import('../src/ssh.js');
  const launches = await import('../src/launches/engine.js');
  const { claimLaunch } = await import('../src/launches/claim.js');
  const { launchHeld } = await import('../src/launches/hold.js');
  const deployKeys = await import('../src/launches/deploy-keys.js');
  const moves = await import('../src/moves/engine.js');
  const restoreTests = await import('../src/restore-tests/engine.js');

  const token = hosts[0].split('-').at(-1);
  const gitHost = hosts[1], lhost = `docknest-qa-launch-${token}`, net = `docknest-qa-launch-net-${token}`;
  const sh = (host, script) => run('exec', host, 'sh', '-c', script);
  const writeTo = async (host, path, text, mode) => {
    const temporary = join(directory, 'launch-' + randomUUID());
    await writeFile(temporary, text); await run('cp', temporary, host + ':' + path); await rm(temporary, { force: true });
    if (mode) await run('exec', host, 'chmod', mode, path);
  };
  const listening = async (host, port) => new RegExp(`:${port.toString(16).toUpperCase().padStart(4, '0')} [0-9A-F:]+ 0A`).test(await sh(host, 'cat /proc/net/tcp /proc/net/tcp6'));
  const ipOf = container => run('inspect', '--format', `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`, container);

  let lserver, pebble = false, trigger = false;
  try {
    // ---------- fixture: network, launch host, Git server ----------
    await run('network', 'create', '--subnet', '10.213.0.0/24', net);
    await run('run', '-d', '--privileged', '--name', lhost, '--network', net, '-e', 'DOCKER_TLS_CERTDIR=', '-p', '127.0.0.1::22', 'docknest-qa-host:local');
    await run('network', 'connect', net, gitHost);
    await until(async () => (await run('exec', lhost, 'docker', 'info', '--format', '{{.OSType}}')) === 'linux', 'The launch host Docker engine did not start');
    const key = await prepareServerKey(), publicFile = join(directory, lhost + '.pub');
    await writeFile(publicFile, key.publicKey + '\n');
    await run('cp', publicFile, lhost + ':/root/.ssh/authorized_keys');
    await rm(publicFile, { force: true });
    await run('exec', lhost, 'chown', 'root:root', '/root/.ssh/authorized_keys'); await run('exec', lhost, 'chmod', '600', '/root/.ssh/authorized_keys');
    const hostPublic = await run('exec', lhost, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub');
    lserver = { id: randomUUID(), name: lhost, host: '127.0.0.1', port: Number((await run('port', lhost, '22/tcp')).split(':').at(-1)), username: 'root', private_key: seal(key.privateKey), host_key: createHash('sha256').update(Buffer.from(hostPublic.split(' ')[1], 'base64')).digest('hex') };
    const capabilities = await testServer(lserver);
    db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,capabilities,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(lserver.id, lhost, lserver.host, lserver.port, 'root', lserver.private_key, lserver.host_key, JSON.stringify(capabilities), 'connected', PAST());
    const lip = await ipOf(lhost), gip = await ipOf(gitHost);
    const call = request => remote(lserver, request);

    // Launch host: the tools a launch needs (the install offer itself is covered elsewhere), nginx including conf.d.
    await sh(lhost, 'apk add --no-cache git openssl util-linux certbot ca-certificates >/dev/null');
    await sh(lhost, 'unshare --mount --propagation private -- true').catch(() => { throw new Error('The launch host has no unshare with mount namespaces (the Compose config sandbox needs it)'); });
    await sh(lhost, "mkdir -p /etc/nginx/conf.d /run/nginx && printf 'events {}\\nhttp {\\n include /etc/nginx/conf.d/*.conf;\\n}\\n' > /etc/nginx/nginx.conf && nginx");
    await run('cp', 'tests/integration/site', lhost + ':/fixture-site');
    await run('exec', lhost, 'docker', 'build', '-q', '-t', 'docknest-fixture:local', '/fixture-site');
    for (const image of ['nginx:1.27-alpine', 'busybox:1.36']) await run('exec', lhost, 'docker', 'pull', '-q', image);

    // Git server (second QA host): HTTPS with a CA made now, SSH with a host key made now, repositories, trap.
    await sh(gitHost, 'apk add --no-cache git git-daemon openssl >/dev/null && git config --system safe.directory "*"');
    await sh(gitHost, 'test -x "$(git --exec-path)/git-http-backend"').catch(() => { throw new Error('The Git server host has no git-http-backend'); });
    await sh(gitHost, "(id git >/dev/null 2>&1 || adduser -D -s /bin/sh git) && sed -i 's/^git:!:/git:*:/' /etc/shadow && mkdir -p /home/git/.ssh && chmod 700 /home/git/.ssh && touch /home/git/.ssh/authorized_keys && chmod 600 /home/git/.ssh/authorized_keys && chown -R git:git /home/git");
    await sh(gitHost, `mkdir -p /opt/pki && cd /opt/pki && openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -subj /CN=docknest-qa-ca -days 2 -addext basicConstraints=critical,CA:TRUE >/dev/null 2>&1 && openssl req -newkey rsa:2048 -nodes -keyout srv.key -out srv.csr -subj /CN=${GIT_HOST} >/dev/null 2>&1 && printf 'subjectAltName=DNS:${GIT_HOST}\\n' > ext.cnf && openssl x509 -req -in srv.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out srv.pem -days 2 -extfile ext.cnf >/dev/null 2>&1`);
    await writeTo(gitHost, '/git-http.py', GIT_HTTP_SERVER); await writeTo(gitHost, '/git-repos.sh', GIT_REPOS);
    await sh(gitHost, 'sh /git-repos.sh');
    await sh(gitHost, 'mkdir -p /tmp/trap && ssh-keygen -q -t ed25519 -N "" -f /etc/ssh/git_host_ed25519');
    await writeTo(gitHost, '/etc/ssh/sshd_config_git', 'Port 2222\nHostKey /etc/ssh/git_host_ed25519\nPermitRootLogin no\nPasswordAuthentication no\nPubkeyAuthentication yes\nAllowUsers git\nAuthorizedKeysFile /home/git/.ssh/authorized_keys\nPidFile /run/sshd-git.pid\n');
    await run('exec', '-d', gitHost, '/usr/sbin/sshd', '-D', '-e', '-f', '/etc/ssh/sshd_config_git');
    await run('exec', '-d', gitHost, 'sh', '-c', `exec python3 /git-http.py /srv/git /opt/pki/srv.pem /opt/pki/srv.key http://${gip}:8099 > /tmp/git-http.log 2>&1`);
    await run('exec', '-d', gitHost, 'sh', '-c', 'cd /tmp/trap && exec python3 -m http.server 8099 --bind 0.0.0.0 > /tmp/trap.log 2>&1');
    for (const port of [2222, 8443, 8099]) await until(() => listening(gitHost, port), `The Git server did not listen on ${port}`, 60);
    // The launch host trusts the run-time CA and finds the Git server by name (the helper resolves it like any server).
    await sh(lhost, 'mkdir -p /usr/local/share/ca-certificates');
    await run('cp', gitHost + ':/opt/pki/ca.pem', join(directory, 'qa-ca.pem'));
    await run('cp', join(directory, 'qa-ca.pem'), lhost + ':/usr/local/share/ca-certificates/docknest-qa-ca.crt');
    await rm(join(directory, 'qa-ca.pem'), { force: true });
    await sh(lhost, 'update-ca-certificates >/dev/null 2>&1');
    const mapName = (name, ip) => sh(lhost, `grep -v ' ${name}$' /etc/hosts > /tmp/hosts.new || true; ${ip ? `echo '${ip} ${name}' >> /tmp/hosts.new;` : ''} cat /tmp/hosts.new > /etc/hosts`);
    await mapName(GIT_HOST, gip);
    const gitRepo = (name, extra = {}) => ({ url: `https://${GIT_HOST}:8443/${name}.git`, ref: 'main', composePath: 'compose.yaml', allowPrivate: true, ...extra });

    // Certificates: Pebble where its images can be pulled, otherwise a recorded certbot double (reported as PARTIAL).
    try {
      const tag = process.env.DOCKNEST_PEBBLE_TAG || 'v2.7.0';
      const image = name => `ghcr.io/letsencrypt/${name}:${tag}`;
      await run('exec', lhost, 'docker', 'pull', '-q', image('pebble')); await run('exec', lhost, 'docker', 'pull', '-q', image('pebble-challtestsrv'));
      await writeTo(lhost, '/pebble-config.json', JSON.stringify({ pebble: { listenAddress: '0.0.0.0:14000', managementListenAddress: '0.0.0.0:15000', certificate: 'test/certs/localhost/cert.pem', privateKey: 'test/certs/localhost/key.pem', httpPort: 80, tlsPort: 443, ocspResponderURL: '', externalAccountBindingRequired: false } }));
      await run('exec', lhost, 'docker', 'network', 'create', 'qa-pebble');
      await run('exec', lhost, 'docker', 'run', '-d', '--name', 'qa-pebble-chall', '--network', 'qa-pebble', image('pebble-challtestsrv'), 'pebble-challtestsrv', '-defaultIPv4', lip, '-defaultIPv6', '', '-http01', '', '-https01', '', '-tlsalpn01', '', '-doh', '');
      await run('exec', lhost, 'docker', 'run', '-d', '--name', 'qa-pebble', '--network', 'qa-pebble', '-p', '127.0.0.1:14000:14000', '-e', 'PEBBLE_VA_NOSLEEP=1', '-v', '/pebble-config.json:/test/config/pebble-config.json:ro', image('pebble'), 'pebble', '-config', '/test/config/pebble-config.json', '-dnsserver', 'qa-pebble-chall:8053');
      await until(async () => (await sh(lhost, 'curl -sk https://127.0.0.1:14000/dir')).includes('newAccount'), 'Pebble did not start', 60);
      await sh(lhost, 'mkdir -p /etc/letsencrypt');
      await writeTo(lhost, '/etc/letsencrypt/cli.ini', 'server = https://127.0.0.1:14000/dir\nno-verify-ssl = true\nemail = qa@example.invalid\nagree-tos = true\nno-eff-email = true\n');
      await sh(lhost, 'certbot register --non-interactive >/dev/null 2>&1');
      pebble = true;
    } catch (error) {
      await sh(lhost, 'docker rm -f qa-pebble qa-pebble-chall >/dev/null 2>&1; docker network rm qa-pebble >/dev/null 2>&1; rm -f /etc/letsencrypt/cli.ini; true');
      await writeTo(lhost, '/usr/local/bin/certbot', CERTBOT_DOUBLE, '755');
      await sh(lhost, 'mkdir -p /etc/letsencrypt/accounts && : > /var/log/docknest-qa-certbot.log');
      await sh(lhost, "mkdir -p /etc/docknest-qa-ca && cd /etc/docknest-qa-ca && openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -subj /CN=docknest-qa-launch-ca -days 2 -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign >/dev/null 2>&1 && cp ca.pem /usr/local/share/ca-certificates/docknest-qa-launch-ca.crt && update-ca-certificates >/dev/null 2>&1");
      partial(`Pebble was not available (${String(error.message).split('\n')[0].slice(0, 120)}): certificates are asserted up to the certbot call; the issuance itself was a test double`);
    }
    const certLog = () => sh(lhost, 'cat /var/log/docknest-qa-certbot.log 2>/dev/null || true');

    // Bystanders: things on the launch host that no launch created and none may change.
    await sh(lhost, "docker network create bystander-net >/dev/null && docker tag busybox:1.36 bystander-img:1 && docker volume create bystander-data >/dev/null && docker run -d --name bystander-plain --network bystander-net busybox:1.36 sleep 100000 >/dev/null");
    await sh(lhost, "docker run -d --name bystander-web -p 127.0.0.1:8070:8080 -v bystander-data:/site docknest-fixture:local >/dev/null");
    await until(async () => (await run('exec', lhost, 'docker', 'inspect', '--format', '{{.State.Health.Status}}', 'bystander-web')) === 'healthy', 'Bystander site is not healthy');
    await sh(lhost, "printf 'server { listen 8099; server_name bystander.docknest.test; location / { return 200 bystander; } }\\n' > /etc/nginx/conf.d/bystander.conf && nginx -s reload");
    await sh(lhost, "mkdir -p /etc/letsencrypt/live/bystander /etc/letsencrypt/renewal /srv/docknest/bystander && cd /etc/letsencrypt/live/bystander && openssl req -x509 -newkey rsa:2048 -nodes -keyout privkey.pem -out fullchain.pem -subj /CN=bystander.docknest.test -addext subjectAltName=DNS:bystander.docknest.test -days 2 >/dev/null 2>&1 && cp fullchain.pem cert.pem && cp fullchain.pem chain.pem && printf bystander > /srv/docknest/bystander/file && printf '# bystander\\n' > /etc/letsencrypt/renewal/bystander.conf");
    const bystander = randomUUID();
    db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(bystander, lserver.id, 'bystander-web', JSON.stringify({ containers: ['bystander-web'], domains: ['bystander.docknest.test'], healthUrl: 'http://127.0.0.1:8070/', stagingRoot: '/var/lib/docknest', exclusiveSourcesConfirmed: true, cleanShutdownConfirmed: true, shutdownProfile: 'generic', maintenanceRequired: false }), PAST());

    // ---------- helpers ----------
    async function snapshot() {
      const list = async command => lines(await sh(lhost, command)).sort();
      return {
        containers: await list("docker ps -a --no-trunc --format '{{.ID}} {{.Names}} {{.State}}'"), images: await list("docker images --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}'"),
        networks: await list("docker network ls --format '{{.Name}}'"), volumes: await list('docker volume ls -q'), builders: await list("docker buildx ls | awk 'NR>1 {print $1}'"),
        conf: await list('ls -A /etc/nginx/conf.d'), live: await list('ls -A /etc/letsencrypt/live 2>/dev/null || true'), renewal: await list('ls -A /etc/letsencrypt/renewal 2>/dev/null || true'),
        archive: await list('ls -A /etc/letsencrypt/archive 2>/dev/null || true'), sites: await list('ls -A /srv/docknest 2>/dev/null || true'), acme: await list('ls -A /var/lib/docknest/acme 2>/dev/null || true'),
        journals: await list('ls -A /var/lib/docknest/launches 2>/dev/null || true'), keyFiles: await list("find /var/lib/docknest /srv/docknest /tmp -name 'key-*' -o -name 'known-hosts-*' 2>/dev/null || true"),
      };
    }
    const assertBystanders = async () => {
      assert.equal(await sh(lhost, 'curl -s -H "Host: bystander.docknest.test" http://127.0.0.1:8099/'), 'bystander');
      assert.equal(await run('exec', lhost, 'docker', 'inspect', '--format', '{{.State.Running}}', 'bystander-web'), 'true');
      assert.equal(await sh(lhost, 'cat /srv/docknest/bystander/file'), 'bystander');
      assert.ok((await sh(lhost, 'ls /etc/letsencrypt/live')).includes('bystander'));
      await sh(lhost, 'nginx -t');
    };
    const steps = launchId => Object.fromEntries(launches.loadSteps(launchId).map(step => [step.step, step]));
    async function drive(condition, what, minutes = 25) {
      const end = Date.now() + minutes * 60_000;
      while (Date.now() < end) {
        launches.tickLaunches();
        if (await condition()) return;
        const step = claimLaunch();
        if (step) { await launches.executeLaunchStep(step); continue; }
        const job = claimJob();
        if (job) { await executeJob(job); continue; }
        await sleep(500);  // nothing to claim: look at the database again
      }
      throw new Error(`${what} did not finish in time: ` + JSON.stringify(db.prepare("SELECT s.step,s.state,s.detail FROM site_launch_steps s JOIN site_launches l ON l.id=s.launch_id WHERE l.state IN ('queued','running','waiting_dns','needs_attention') AND s.state NOT IN ('pending','skipped','done')").all()));
    }
    const ended = launchId => () => ['done', 'waiting_dns', 'failed', 'cancelled', 'removed', 'needs_attention'].includes(launches.loadLaunch(launchId).state);
    async function start(body) {
      db.prepare('UPDATE site_launches SET created_at=? WHERE server_id=?').run(PAST(), lserver.id);  // three launches per hour: age the earlier ones
      return (await launches.startLaunch(lserver.id, { cleanShutdownConfirmed: true, ...body }, 'qa')).launch.id;
    }
    const domainOf = tag => `${tag}.docknest.test`, slugOf = tag => `${tag}-docknest-test`;
    const composeBody = (tag, compose, extra = {}) => ({ source: 'compose', domain: domainOf(tag), compose, webService: 'web', webPort: 80, ...extra });
    const check = (tag, compose, extra = {}) => launches.checkLaunch(lserver.id, { source: 'compose', domain: domainOf(tag), compose, webService: 'web', webPort: 80, ...extra });
    const refusalOf = result => {
      const gate = result.gate.refusals[0], failed = result.checks.find(item => !item.ok && item.id === 'compose-file');
      return gate ? { from: 'gate', code: gate.code, field: gate.field } : failed ? { from: 'check', code: failed.code } : null;
    };
    async function assertLaunched(launchId, tag, { dnsMapped }) {
      const launch = launches.loadLaunch(launchId), done = steps(launchId);
      assert.equal(launch.state, dnsMapped ? 'done' : 'waiting_dns', JSON.stringify([launch.reason, Object.values(done).map(s => [s.step, s.state, s.detail])]));
      console.error('TEMPDEBUG jobs: '+JSON.stringify(db.prepare('SELECT status,stage,error,details FROM jobs ORDER BY created_at DESC LIMIT 2').all()).slice(0,1500));
      for (const name of ['check', 'fetch', 'start', 'check_health', 'web', 'save', 'maintenance', 'first_backup']) assert.equal(done[name].state, 'done', `${name}: ${done[name].detail}`);
      assert.equal(done.certificate.state, dnsMapped ? 'done' : 'waiting');
      assert.ok(launch.site_id, 'the site is saved');
      const backup = db.prepare('SELECT * FROM backups WHERE site_id=?').get(launch.site_id);
      assert.ok(backup && backup.verified === 1, 'the first backup exists and is verified');
      assert.equal(await verifyEncrypted(backup.path), backup.checksum);
      assert.equal(db.prepare('SELECT enabled FROM policies WHERE site_id=?').get(launch.site_id).enabled, 1, 'daily backup is on');
      return { launch, backup };
    }
    const containerOf = tag => `${slugOf(tag)}-web-1`;
    const pageOf = (tag, port = 80) => sh(lhost, `curl -s -H 'Host: ${domainOf(tag)}' http://127.0.0.1:${port}/`);
    const httpsOf = tag => sh(lhost, `curl -sk --resolve ${domainOf(tag)}:443:127.0.0.1 https://${domainOf(tag)}/`);
    const trapHits = () => sh(gitHost, "grep -c trap.git /tmp/trap.log || true");

    // ---------- probe: the helper's gate works, so a clean pasted file passes ----------
    const control = await check('control', BASE_COMPOSE);
    if (control.gate.refusals.some(item => item.code === 'GATE_UNAVAILABLE')) throw new Error(GATE_MISSING);
    assert.equal(control.ok, true, JSON.stringify([control.blockers, control.gate]));
    assert.deepEqual(control.services.map(service => service.name), ['web']);
    record('Launch fixture: launch host with nginx, certbot and git; HTTPS and SSH Git servers with run-time keys; bystanders; the privilege gate is in the bundled helper');

    // ---------- 4. allow-list refusals (pasted Compose, at Check) ----------
    // The exact code and field edit_gate (remote/helper/edit.py) returns for each: the service and setting only, no value.
    const unsafe = [
      ['privileged', BASE_COMPOSE + '    privileged: true\n', 'PRIVILEGE_ADDED', 'services.web.privileged'],
      ['host network', BASE_COMPOSE + '    network_mode: host\n', 'PRIVILEGE_ADDED', 'services.web.network_mode'],
      ['docker.sock', BASE_COMPOSE + '    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n', 'PATH_REFUSED', 'services.web.volumes'],
      ['an /etc bind', BASE_COMPOSE + '    volumes:\n      - /etc:/host-etc\n', 'PATH_REFUSED', 'services.web.volumes'],
      ['cap_add', BASE_COMPOSE + '    cap_add:\n      - SYS_ADMIN\n', 'PRIVILEGE_ADDED', 'services.web.cap_add'],
    ];
    for (const [what, compose, code, field] of unsafe) {
      const result = await check('refuse', compose), refusal = refusalOf(result);
      assert.equal(result.ok, false, `${what} is refused`);
      assert.deepEqual(refusal, { from: 'gate', code, field }, `${what} is refused for its own setting: ${JSON.stringify(refusal)}`);
    }
    let result = await check('refuse', 'services:\n  web:\n    image: nginx:1.27-alpine\n    build:\n      context: .\n      network: host\n');
    assert.deepEqual([result.ok, refusalOf(result).code, /build\.network/.test(refusalOf(result).field)], [false, 'BUILD_SETTING_REFUSED', true]);
    result = await check('refuse', BASE_COMPOSE + '    volumes:\n      - data:/data\nvolumes:\n  data:\n    name: bystander-data\n');
    assert.deepEqual([result.ok, refusalOf(result)?.code, refusalOf(result)?.field], [false, 'NAME_COLLISION', 'volumes.bystander-data'], 'a volume name that belongs to something else is refused');
    result = await check('refuse', BASE_COMPOSE + '    container_name: bystander-plain\n');
    assert.deepEqual([result.ok, refusalOf(result)?.code], [false, 'NAME_COLLISION']);
    result = await check('refuse', 'include:\n  - /root/qa-other.yaml\n' + BASE_COMPOSE);
    assert.deepEqual([result.ok, refusalOf(result)?.code], [false, 'COMPOSE_INCLUDE_REFUSED']);
    result = await check('refuse', 'services:\n  web:\n    extends:\n      file: /root/qa-other.yaml\n      service: x\n');
    assert.deepEqual([result.ok, refusalOf(result)?.code], [false, 'COMPOSE_EXTENDS_REFUSED']);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM site_launches WHERE server_id=?").get(lserver.id).n, 0, 'a refused Check starts nothing');
    await assertBystanders();
    record('Pasted Compose refusals at Check: privileged, network_mode host, docker.sock, /etc bind, cap_add, build.network host, volume and container name collisions, include and extends; the clean file passes');

    // ---------- 11. compose config sandbox ----------
    await sh(lhost, "printf 'QA_OUTSIDE=1\\n' > /root/qa-outside.env && printf 'services:\\n  web:\\n    image: nginx:1.27-alpine\\n    env_file: /root/qa-outside.env\\n' > /tmp/qa-env.yaml && docker compose -f /tmp/qa-env.yaml config -q");
    result = await check('sandbox', 'services:\n  web:\n    image: nginx:1.27-alpine\n    env_file: /root/qa-outside.env\n');
    assert.deepEqual([result.ok, refusalOf(result)?.from, refusalOf(result)?.code], [false, 'check', 'COMPOSE_INVALID'], 'a file outside the launch folder is not visible to Compose (it reads fine without the sandbox)');
    const plugin = await sh(lhost, `docker info --format '{{range .ClientInfo.Plugins}}{{if eq .Name "compose"}}{{.Path}}{{end}}{{end}}'`);
    assert.match(plugin, /docker-compose$/);
    await sh(lhost, `mkdir -p /root/.docker/cli-plugins && mv '${plugin}' /root/.docker/cli-plugins/docker-compose`);
    try {
      await sh(lhost, 'docker compose version');
      const moved = await check('sandbox', BASE_COMPOSE);
      assert.equal(moved.ok, true, 'the Compose plugin under the hidden home folder is still found: ' + JSON.stringify(moved.blockers));
    } finally { await sh(lhost, `mv /root/.docker/cli-plugins/docker-compose '${plugin}' && rmdir /root/.docker/cli-plugins`); }
    await sh(lhost, 'rm -f /root/qa-outside.env /tmp/qa-env.yaml');
    record('Compose config sandbox: a file outside the launch folder cannot be read (COMPOSE_INVALID), an include of one is refused, and the Compose plugin in the hidden home folder is still found');

    // ---------- 10. Git redirect and DNS rebinding ----------
    const facts = (repo, extra = {}) => call({ operation: 'launch-facts', launchId: randomUUID(), slug: 'ssrf-docknest-test', domain: domainOf('ssrf'), source: 'git', repo, ...extra });
    const repoCheck = answer => answer.checks.find(item => item.id === 'repo');
    let answer = await facts(gitRepo('site'));
    assert.equal(repoCheck(answer).ok, true, 'the control repository is reachable: ' + JSON.stringify(repoCheck(answer)));
    assert.match(answer.refHead, /^[0-9a-f]{40}$/);
    assert.equal(repoCheck(await facts(gitRepo('site', { allowPrivate: false }))).code, 'URL_PRIVATE');
    assert.equal(repoCheck(await facts({ url: 'https://169.254.169.254/x.git', ref: 'main', composePath: 'compose.yaml', allowPrivate: true })).code, 'URL_METADATA');
    const hitsBefore = await trapHits();
    answer = await facts(gitRepo('redirect'));
    assert.equal(repoCheck(answer).ok, false);
    assert.equal(repoCheck(answer).code, 'REDIRECT_REFUSED');
    assert.equal(await trapHits(), hitsBefore, 'the private address a redirect pointed at was never contacted');
    // Rebinding: Check resolves the Git host to the real server, then the name moves to the metadata address before fetch.
    const rebindId = randomUUID(), rebindSlug = 'rebind-docknest-test';
    assert.equal(repoCheck(await facts(gitRepo('site'))).ok, true);
    await mapName(GIT_HOST, '169.254.169.254');
    try {
      answer = await call({ operation: 'launch-fetch', launchId: rebindId, slug: rebindSlug, domain: domainOf('rebind'), source: 'git', repo: gitRepo('site'), env: {}, webService: 'web' });
      assert.deepEqual([answer.ok, answer.code], [false, 'URL_METADATA']);
      assert.equal(await sh(lhost, `ls -d /srv/docknest/${rebindSlug} /var/lib/docknest/launches/${rebindId} 2>/dev/null || true`), '', 'nothing was created');
    } finally { await mapName(GIT_HOST, gip); }
    record('Git hardening: a redirect is not followed (the private target is never contacted), private and metadata addresses are refused, and DNS that changes between Check and fetch is refused at fetch with nothing created');

    // ---------- direct helper runs (fetch, start, teardown) for repository content refusals ----------
    async function direct(tag, repo, body = async () => {}) {
      const launchId = randomUUID(), slug = slugOf(tag), before = await snapshot();
      const base = { launchId, slug, domain: domainOf(tag), source: 'git' };
      try { return await body({ base, slug, launchId, fetched: await call({ ...base, operation: 'launch-fetch', repo, env: {}, webService: 'web' }) }); }
      finally {
        const torn = await call({ ...base, operation: 'launch-teardown', keepBackup: true });
        assert.deepEqual(torn.left ?? [], [], 'teardown leaves nothing');
        assert.deepEqual(await snapshot(), before, 'the server is as it was');
      }
    }
    await direct('netrun', gitRepo('netrun'), async ({ fetched }) => {
      assert.deepEqual([fetched.ok, fetched.code], [false, 'GATE_REFUSED']);
      assert.ok(fetched.gate.refusals.some(item => item.code === 'DOCKERFILE_REFUSED'), JSON.stringify(fetched.gate));
    });
    await direct('escape', gitRepo('escape'), async ({ slug, fetched }) => {
      // The clone runs with core.symlinks=false, so a link arrives as a plain file; either way nothing in the site
      // folder may be a link that leaves the repository.
      if (fetched.ok === false) assert.equal(fetched.code, 'SYMLINK_ESCAPE');
      assert.equal(await sh(lhost, `find /srv/docknest/${slug} -type l 2>/dev/null || true`), '', 'no symbolic link survives in the site folder');
    });
    await direct('envfile', gitRepo('envfile'), async ({ base, slug, fetched }) => {
      assert.equal(fetched.ok, true, JSON.stringify(fetched));
      assert.deepEqual(fetched.services.map(service => service.name), ['web'], 'COMPOSE_FILE in the repository .env is not read');
      const started = await call({ ...base, operation: 'launch-start', webService: 'web', webPort: 8080, loopbackPort: 29101 });
      assert.equal(started.ok, true, JSON.stringify(started));
      assert.equal(await sh(lhost, `docker ps -a --filter label=com.docker.compose.project=${slug} --format '{{.Names}}'`), `${slug}-web-1`, 'only the declared service exists; the evil service and the hijacked project name were ignored');
      assert.equal(await sh(lhost, `docker inspect --format '{{.HostConfig.Privileged}}' ${slug}-web-1`), 'false');
    });
    await direct('swap', gitRepo('swap'), async ({ base, slug, fetched }) => {
      assert.equal(fetched.ok, true, JSON.stringify(fetched));
      await sh(lhost, `rm -rf /srv/docknest/${slug}/app/data && ln -s /etc /srv/docknest/${slug}/app/data`);
      const started = await call({ ...base, operation: 'launch-start', webService: 'web', webPort: 8080, loopbackPort: 29102 });
      assert.deepEqual([started.ok, started.code], [false, 'GATE_REFUSED'], 'a bind source that became a link to /etc is refused at start');
      assert.equal(await sh(lhost, `docker ps -aq --filter label=com.docker.compose.project=${slug}`), '');
    });
    record('Repository content: RUN --network=host, a symlink leaving the repository, and a .env with COMPOSE_FILE are refused or ignored; a bind source swapped for a link to /etc is refused at start; teardown restores the server exactly. Limit: the clone runs with core.symlinks=false, so the helper SYMLINK_ESCAPE branch cannot be reached from a repository or a pasted file; the swap case covers the link-as-bind-source risk');

    // ---------- 1 and 12. pasted Compose launch with nginx, certificate, first backup ----------
    const composeSite = BASE_COMPOSE + '    volumes:\n      - data:/data\nvolumes:\n  data: {}\n';
    await mapName(domainOf('shop'), lip);
    const shop = await start(composeBody('shop', composeSite));
    await drive(ended(shop), 'The pasted Compose launch');
    const { launch: shopLaunch, backup: shopBackup } = await assertLaunched(shop, 'shop', { dnsMapped: true });
    assert.equal(await run('exec', lhost, 'docker', 'inspect', '--format', '{{.State.Running}}', containerOf('shop')), 'true', 'the container runs');
    const bindings = JSON.parse(await run('exec', lhost, 'docker', 'inspect', '--format', '{{json .HostConfig.PortBindings}}', containerOf('shop')));
    assert.ok(Object.values(bindings).flat().every(item => item.HostIp === '127.0.0.1'), 'published ports are on 127.0.0.1 only');
    assert.match(await sh(lhost, `head -1 /etc/nginx/conf.d/docknest-${slugOf('shop')}.conf`), new RegExp(`^# Managed by DockNest launch ${shop}`));
    assert.match(await httpsOf('shop'), new RegExp(NGINX_MARK));
    if (pebble) {
      assert.match(await sh(lhost, `openssl x509 -in /etc/letsencrypt/live/docknest-${slugOf('shop')}/cert.pem -noout -issuer`), /pebble/i);
      record('Certificate from Pebble: the launch issued docknest-<slug>, nginx serves it on 443');
    } else {
      const logged = await certLog();
      assert.ok(logged.includes(`certonly --webroot -w /var/lib/docknest/acme/launch-${shop} --non-interactive --keep-until-expiring --cert-name docknest-${slugOf('shop')} -d ${domainOf('shop')}`), logged);
      partial('Certificate: asserted up to the certbot call (exact argv, lineage name, webroot); the issuance was a test double');
    }
    assert.equal(JSON.parse(db.prepare('SELECT config FROM sites WHERE id=?').get(shopLaunch.site_id).config).healthUrl, `https://${domainOf('shop')}/`, 'the health URL follows the certificate');
    record('Launch from a pasted Compose file (nginx image): deployed, nginx file written, HTTP and HTTPS answer, ports on 127.0.0.1, site saved, daily backup on, first backup verified');
    await assertBystanders();

    // ---------- 2. public HTTPS repository with build: ----------
    const site = await start({ source: 'git', domain: domainOf('built'), repo: { url: `https://${GIT_HOST}:8443/site.git`, ref: 'main', composePath: 'compose.yaml' }, allowPrivate: true, trustConfirmed: true, webPort: 8080 });
    await drive(ended(site), 'The public repository launch');
    const built = await assertLaunched(site, 'built', { dnsMapped: false });
    assert.equal(steps(site).build.state, 'done');
    const image = `${slugOf('built')}-web`;
    assert.equal(await sh(lhost, `docker image inspect --format '{{index .Config.Labels "docknest.launch"}}' ${image}`), site, 'the built image carries the launch label');
    assert.equal(await sh(lhost, `docker run --rm --entrypoint cat ${image} /www/index.html`), 'launch-git-ok', 'the built image is runnable');
    assert.equal(await sh(lhost, `curl -s http://127.0.0.1:${built.launch.loopback_port}/`), 'launch-git-ok');
    assert.equal(built.launch.commit_sha, await sh(gitHost, 'git -C /srv/git/site.git rev-parse HEAD'));
    assert.equal(await sh(lhost, `test -e /srv/docknest/${slugOf('built')}/app/.git && echo present || echo gone`), 'gone', '.git is removed after the commit is recorded');
    assert.equal(await sh(lhost, "docker buildx ls | awk 'NR>1 {print $1}' | grep -c docknest-launch- || true"), '0', 'the launch builder is removed');
    assert.equal(await pageOf('built'), 'launch-git-ok');
    record('Launch from a public HTTPS Git repository with build: image built by BuildKit and runnable, labelled, commit recorded, .git removed, builder removed, site served through nginx, first backup verified');

    // ---------- 3. private repository over SSH with a deploy key and a pinned host key ----------
    const sshHost = `${GIT_HOST}:2222`, sshRepo = ref => ({ url: `ssh://git@${GIT_HOST}:2222/srv/git/private.git`, ref, composePath: 'compose.yaml' });
    const preview = await deployKeys.previewHostKey({ gitHost: sshHost, serverId: lserver.id, allowPrivate: true });
    assert.equal(preview.fingerprint, (await sh(gitHost, 'ssh-keygen -lf /etc/ssh/git_host_ed25519.pub')).split(/\s+/)[1], 'the host key read from the server matches the Git host');
    const created = await deployKeys.createDeployKey({ name: 'QA deploy key', gitHost: sshHost, serverId: lserver.id, allowPrivate: true, fingerprint: preview.fingerprint }, 'qa');
    const keyId = created.key.id;
    await writeTo(gitHost, '/opt/deploy.pub', created.key.publicKey + '\n');
    await sh(gitHost, 'cat /opt/deploy.pub >> /home/git/.ssh/authorized_keys && rm /opt/deploy.pub');
    // A wrong pinned host key is refused, and no key file is left behind.
    const pinned = db.prepare('SELECT host_key_line,host_key_sha256 FROM deploy_keys WHERE id=?').get(keyId);
    await sh(gitHost, 'rm -f /tmp/wrong /tmp/wrong.pub && ssh-keygen -q -t ed25519 -N "" -f /tmp/wrong');
    const wrongBlob = (await sh(gitHost, 'cat /tmp/wrong.pub')).split(' ')[1];
    db.prepare('UPDATE deploy_keys SET host_key_line=? WHERE id=?').run(`[${GIT_HOST}]:2222 ssh-ed25519 ${wrongBlob}`, keyId);
    try {
      const wrong = await launches.checkLaunch(lserver.id, { source: 'git', domain: domainOf('private'), repo: sshRepo('main'), deployKeyId: keyId, allowPrivate: true });
      assert.deepEqual([wrong.ok, wrong.checks.find(item => item.id === 'repo').code], [false, 'HOST_KEY_MISMATCH']);
      await assert.rejects(start({ source: 'git', domain: domainOf('private'), repo: sshRepo('main'), deployKeyId: keyId, allowPrivate: true, trustConfirmed: true, webPort: 8080 }), error => error.code === 'HOST_KEY_MISMATCH');
      assert.equal((await snapshot()).keyFiles.length, 0, 'no key file is left after a refused host key');
    } finally { db.prepare('UPDATE deploy_keys SET host_key_line=? WHERE id=?').run(pinned.host_key_line, keyId); }
    const privateId = await start({ source: 'git', domain: domainOf('private'), repo: sshRepo('main'), deployKeyId: keyId, allowPrivate: true, trustConfirmed: true, webPort: 8080 });
    await drive(ended(privateId), 'The private repository launch');
    const privateRun = await assertLaunched(privateId, 'private', { dnsMapped: false });
    assert.equal(privateRun.launch.commit_sha, await sh(gitHost, 'git -C /srv/git/private.git rev-parse main'));
    assert.deepEqual((await snapshot()).keyFiles, [], 'the key file and the known_hosts file are gone after the clone');
    const marker = ['PRIVATE', 'KEY'].join(' ');
    assert.equal(await sh(lhost, `grep -rl '${marker}' /var/lib/docknest /srv/docknest 2>/dev/null || true`), '', 'the deploy key is on no disk path of the server');
    record('Private Git repository over SSH: host key read and confirmed by fingerprint, deploy key authorised, a wrong pinned host key is refused (HOST_KEY_MISMATCH), the clone works with the right one, and the key file is gone afterwards');

    // ---------- 5. waiting for DNS, then Check again ----------
    assert.equal(built.launch.state, 'waiting_dns');
    assert.equal(launches.launchView(site).actions.checkDns, true);
    assert.equal(await sh(lhost, `ls /etc/letsencrypt/live | grep -c docknest-${slugOf('built')} || true`), '0', 'no certificate was asked for while DNS does not point here');
    assert.equal(JSON.parse(db.prepare('SELECT config FROM sites WHERE id=?').get(built.launch.site_id).config).healthUrl, '', 'the health URL stays off until the domain points here');
    launches.checkDnsAgain(site, 'qa');
    await drive(() => { const state = steps(site).certificate.state; return state === 'waiting'; }, 'Check again without DNS');
    assert.equal(launches.loadLaunch(site).state, 'waiting_dns', 'still waiting when DNS still does not point here');
    await mapName(domainOf('built'), lip);
    launches.checkDnsAgain(site, 'qa');
    await drive(() => launches.loadLaunch(site).state === 'done', 'Check again with DNS');
    assert.equal(steps(site).certificate.state, 'done');
    assert.match(await httpsOf('built'), /launch-git-ok/);
    assert.equal(JSON.parse(db.prepare('SELECT config FROM sites WHERE id=?').get(built.launch.site_id).config).healthUrl, `https://${domainOf('built')}/`);
    record('Waiting for DNS: the site works on HTTP, no certificate is asked for, Check again with DNS still missing waits, and Check again once the domain points here issues the certificate and switches the site to https');

    // ---------- 6. port 443 already in use ----------
    await sh(lhost, 'mkdir -p /tmp/foreign && printf foreign-443 > /tmp/foreign/index.html');
    await run('exec', '-d', lhost, 'python3', '-m', 'http.server', '443', '--bind', '0.0.0.0', '--directory', '/tmp/foreign');
    await until(() => listening(lhost, 443), 'The foreign 443 listener did not start', 30);
    await mapName(domainOf('busy'), lip);
    answer = await call({ operation: 'launch-facts', launchId: randomUUID(), slug: slugOf('busy'), domain: domainOf('busy'), source: 'compose' });
    assert.equal(answer.ports['443'].holder, 'other', JSON.stringify(answer.ports));
    assert.match(answer.ports['443'].process ?? '', /^python/, 'the holder is named by its process name only');
    assert.equal(answer.ports['80'].holder, 'nginx', 'the server nginx on port 80 is fine');
    const busyCheck = await check('busy', BASE_COMPOSE);
    assert.equal(busyCheck.ok, false);
    assert.equal(busyCheck.checks.find(item => item.id === 'port443')?.code, 'PORT_IN_USE', JSON.stringify(busyCheck.checks));
    await assert.rejects(start(composeBody('busy', BASE_COMPOSE)), error => error.code === 'PORT_IN_USE', 'Launch is refused while 443 is taken');
    assert.equal(await sh(lhost, 'curl -s http://127.0.0.1:443/'), 'foreign-443', 'the other program on 443 is untouched and still answers');
    await sh(lhost, 'nginx -t');
    await assertBystanders();
    await sh(lhost, "pkill -f 'http.server 443' || true");
    await until(async () => !(await listening(lhost, 443)), 'The foreign 443 listener did not stop', 30);
    record('Port 443 held by another program: Check blocks with PORT_IN_USE naming the process, Launch is refused, the other program keeps answering and nginx stays valid');

    // ---------- 9. other jobs queue behind a launch ----------
    { const queued = enqueueBackup(bystander, 'qa'), job = claimJob(); assert.equal(job.id, queued.id); await executeJob(job); assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id).status, 'completed', db.prepare('SELECT error FROM jobs WHERE id=?').get(job.id).error); }
    const holdCompose = BASE_COMPOSE + '    healthcheck:\n      test: ["CMD-SHELL", "test -f /tmp/go"]\n      interval: 2s\n      timeout: 2s\n      retries: 3\n      start_period: 300s\n';
    const hold = await start(composeBody('hold', holdCompose));
    await drive(() => steps(hold).check_health.state === 'waiting', 'The launch to reach its health check');
    assert.equal(launches.loadLaunch(hold).state, 'running');
    assert.equal(launchHeld(lserver.id), true, 'the launch holds its server');
    const waitingBackup = enqueueBackup(bystander, 'qa');
    const restoreTest = restoreTests.createRestoreTest({ siteId: bystander, serverId: lserver.id, liveServer: true, actor: 'qa' }).id;
    const movePreview = await moves.previewMove({ siteId: bystander, targetServerId: servers[1].id, options: {} }, 'qa');
    assert.ok(movePreview.id, 'a draft move exists');
    for (let round = 0; round < 4; round++) {
      launches.tickLaunches(); restoreTests.tickRestoreTests();
      assert.equal(claimJob(), null, 'no backup is claimed while the launch holds the server');
      await sleep(250);
    }
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(waitingBackup.id).status, 'queued', 'the backup waits');
    assert.equal(restoreTests.loadTest(restoreTest).started_at, null, 'the restore test does not start');
    await assert.rejects(moves.startMove(movePreview.id, { preflightHash: movePreview.preflightHash }, 'qa'), error => error.code === 'LAUNCH_RUNNING');
    moves.cancelMove(movePreview.id, 'qa'); restoreTests.cancelRestoreTest(restoreTest, 'qa');
    await run('exec', lhost, 'docker', 'exec', containerOf('hold'), 'touch', '/tmp/go');
    await drive(() => ['completed', 'failed'].includes(db.prepare('SELECT status FROM jobs WHERE id=?').get(waitingBackup.id).status) && ended(hold)(), 'The queued backup after the launch');
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(waitingBackup.id).status, 'completed', 'the backup ran once the launch released the server');
    assert.ok(['done', 'waiting_dns'].includes(launches.loadLaunch(hold).state));
    record('A backup, a restore test and a move wait behind a running launch (nothing is claimed or started, the move is refused with LAUNCH_RUNNING) and the backup runs after the launch releases the server');

    // ---------- 7. failure teardown ----------
    // 7a: build from a private repository whose container never becomes healthy.
    const beforeHealth = await snapshot();
    const sick = await start({ source: 'git', domain: domainOf('sick'), repo: sshRepo('unhealthy'), deployKeyId: keyId, allowPrivate: true, trustConfirmed: true, webPort: 8080 });
    await drive(ended(sick), 'The launch with a health check that never passes');
    const sickLaunch = launches.loadLaunch(sick);
    assert.deepEqual([sickLaunch.state, sickLaunch.failed_step], ['failed', 'check_health'], sickLaunch.reason);
    assert.match(sickLaunch.reason, /unhealthy/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sites WHERE name=?').get(domainOf('sick')).n, 0, 'no site was saved');
    assert.deepEqual(await snapshot(), beforeHealth, 'no container, image, builder, network, volume, folder, nginx file, key file or certificate lineage is left, and nothing else changed');
    await assertBystanders();
    // 7b: everything exists (nginx file, certificate lineage) when saving the site fails.
    const beforeSave = await snapshot();
    await mapName(domainOf('late'), lip);
    db.exec(`CREATE TRIGGER qa_block_launch_site BEFORE INSERT ON sites WHEN NEW.name='${domainOf('late')}' BEGIN SELECT RAISE(ABORT,'qa'); END;`); trigger = true;
    const late = await start(composeBody('late', composeSite));
    await drive(ended(late), 'The launch that fails when saving');
    db.exec('DROP TRIGGER qa_block_launch_site'); trigger = false;
    const lateLaunch = launches.loadLaunch(late);
    assert.deepEqual([lateLaunch.state, lateLaunch.failed_step], ['failed', 'save'], lateLaunch.reason);
    assert.equal(steps(late).certificate.state, 'done', 'the nginx file and the certificate had been made');
    assert.deepEqual(await snapshot(), beforeSave, 'teardown removed the container, volume, network, folder, nginx file and its own certbot lineage; the bystander lineage and everything else is untouched');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM backups b JOIN sites s ON s.id=b.site_id WHERE s.name=?").get(domainOf('late')).n, 0);
    await assertBystanders();
    record('Failure teardown: a launch that fails at its health check (private repo, build, deploy key) and one that fails at Save after nginx and the certificate were made both leave the server exactly as before; bystanders and their certificate lineage are untouched');

    // ---------- 8. Remove launch within 24 hours ----------
    const removeBefore = launches.launchView(shop);
    assert.equal(removeBefore.actions.remove, true);
    const shopData = await sh(lhost, `docker volume ls -q --filter label=docknest.launch=${shop}`);
    assert.ok(shopData.includes('data'), 'the launch labelled its volume');
    launches.removeLaunch(shop, 'qa');
    await drive(() => launches.loadLaunch(shop).state === 'removed', 'Remove launch');
    assert.equal(await sh(lhost, `docker ps -aq --filter label=docknest.launch=${shop}`), '');
    assert.equal(await sh(lhost, `docker volume ls -q --filter label=docknest.launch=${shop}`), '');
    assert.equal(await sh(lhost, `ls /srv/docknest | grep -c ${slugOf('shop')} || true`), '0');
    assert.equal(await sh(lhost, `ls /etc/nginx/conf.d | grep -c ${slugOf('shop')} || true`), '0');
    assert.equal(await sh(lhost, `ls /etc/letsencrypt/live | grep -c docknest-${slugOf('shop')} || true`), '0', 'its certbot lineage is removed');
    assert.ok(db.prepare('SELECT 1 FROM site_archives WHERE site_id=?').get(shopLaunch.site_id), 'the site is archived');
    assert.equal(db.prepare('SELECT enabled FROM policies WHERE site_id=?').get(shopLaunch.site_id).enabled, 0, 'schedules are off');
    assert.equal(await verifyEncrypted(shopBackup.path), shopBackup.checksum, 'the first backup is kept and still verifies');
    await sh(lhost, 'nginx -t'); await assertBystanders();
    // After 24 hours the offer is gone.
    db.prepare('UPDATE site_launches SET remove_until=? WHERE id=?').run(new Date(Date.now() - 60_000).toISOString(), privateId);
    assert.throws(() => launches.removeLaunch(privateId, 'qa'), error => error.code === 'REMOVE_EXPIRED');
    record('Remove launch within 24 hours: containers, volume, folder, nginx file and certbot lineage removed, site archived with schedules off, first backup kept and verified; after 24 hours the removal is refused');

    evidence.launch = { certificates: pebble ? 'pebble' : 'test double', launches: db.prepare('SELECT COUNT(*) AS n FROM site_launches WHERE server_id=?').get(lserver.id).n };
  } finally {
    await sh(gitHost, "pkill -f git-http.py; pkill -f 'http.server 8099'; pkill -f sshd_config_git; true").catch(() => {});
    if (trigger) { try { db.exec('DROP TRIGGER qa_block_launch_site'); } catch {} }
    await run('rm', '-f', '-v', lhost).catch(() => {});
    await run('network', 'disconnect', '-f', net, gitHost).catch(() => {});
    await run('network', 'rm', net).catch(() => {});
  }
}
