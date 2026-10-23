// Minimal SMTP submission client on node:net / node:tls (docs/alerts.md). One message, one recipient list, text only.
// - Encryption is mandatory: implicit TLS (security 'tls', usually port 465) or STARTTLS (usually 587). Certificates are
//   verified against the configured host name. There is no plaintext mode, so the password never crosses the network clear.
// - The host name is resolved once, the address is checked (no link-local or metadata range) and the connection goes to
//   that address, so a name cannot change between check and connect.
// - Bounded everywhere: connect and total time, reply size, line length, message size. Server replies are never returned
//   to callers or logged; failures are reported as short fixed sentences.
import net, { BlockList, isIP } from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';

export const smtpLimits = Object.freeze({ totalMs: 20_000, replyBytes: 16 * 1024, connectionBytes: 64 * 1024, replyLines: 100, bodyBytes: 4096, lineBytes: 998 });
export class SmtpError extends Error { constructor(message, code = 'smtp') { super(message); this.code = code; } }

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(address, prefix, 'ipv4');
// fd00:ec2::254 is the AWS IPv6 metadata address. Loopback is refused too: the mail relay is never DockNest's own host.
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fe80::', 10], ['ff00::', 8], ['fd00:ec2::254', 128]]) blocked.addSubnet(address, prefix, 'ipv6');
blocked.addSubnet('127.0.0.0', 8, 'ipv4');
// Only the test suite sets this, to reach a fake server on 127.0.0.1. There is no setting or API for it.
export const smtpPolicy = { allowLoopback: false };
const isLoopback = (address, family) => family === 4 ? address.startsWith('127.') : address === '::1';
export const addressAllowed = address => { const family = isIP(address); if (!family) return false; const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address); if (mapped) return addressAllowed(mapped[1]); if (smtpPolicy.allowLoopback && isLoopback(address, family)) return true; return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6'); };
const unreachable = 'The mail server could not be reached.';

// Tests replace these to talk to a local server.
export const smtpIo = {
  resolve: async host => { if (isIP(host)) return host; const found = await dns.lookup(host, { all: false }); return found.address; },
  connect: ({ address, port, host, implicitTls, tlsOptions = {} }) => new Promise((resolve, reject) => {
    const socket = implicitTls ? tls.connect({ host: address, port, servername: isIP(host) ? undefined : host, minVersion: 'TLSv1.2', ...tlsOptions }) : net.connect({ host: address, port });
    socket.once(implicitTls ? 'secureConnect' : 'connect', () => resolve(socket)); socket.once('error', reject);
  }),
  upgrade: (socket, { host, tlsOptions = {} }) => new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: isIP(host) ? undefined : host, minVersion: 'TLSv1.2', ...tlsOptions });
    secure.once('secureConnect', () => resolve(secure)); secure.once('error', reject);
  }),
};

class Connection {
  constructor(socket) { this.total = 0; this.buffer = ''; this.replies = []; this.waiting = null; this.error = null; this.attach(socket); }
  attach(socket) {
    this.socket = socket; this.buffer = ''; socket.setEncoding('utf8');
    socket.on('data', chunk => { this.total += chunk.length; this.buffer += chunk; if (this.error) return; if (this.total > smtpLimits.connectionBytes || this.buffer.length > smtpLimits.replyBytes) return this.fail(new SmtpError(unreachable, 'protocol')); this.parse(); this.wake(); });
    socket.on('error', error => this.fail(error)); socket.on('close', () => this.fail(new SmtpError(unreachable, 'closed')));
  }
  parse() {
    for (;;) {
      const end = this.buffer.indexOf('\r\n'); if (end < 0) return;
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 2);
      const match = /^(\d{3})([ -])(.*)$/.exec(line); if (!match) return this.fail(new SmtpError(unreachable, 'protocol'));
      if ((this.partial ??= []).push(match[3]) > smtpLimits.replyLines) return this.fail(new SmtpError(unreachable, 'protocol'));
      if (match[2] === ' ') { this.replies.push({ code: Number(match[1]), lines: this.partial }); this.partial = null; }
    }
  }
  fail(error) { if (!this.error) this.error = error; this.wake(); }
  wake() { if (this.waiting) { const { resolve, reject } = this.waiting; if (this.replies.length) { this.waiting = null; resolve(this.replies.shift()); } else if (this.error) { this.waiting = null; reject(this.error); } } }
  read() { return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; this.wake(); }); }
  async command(text, expect) {
    if (text !== null) this.socket.write(text + '\r\n');
    const reply = await this.read();
    if (!expect.includes(reply.code)) throw new SmtpError(reply.code === 535 || reply.code === 534 ? 'The mail server refused the user name or password.' : reply.code >= 500 ? 'The mail server refused the message.' : 'The mail server could not take the message right now.', reply.code === 535 ? 'auth' : 'refused');
    return reply;
  }
}

// Header values: one line, no control characters, so a name or address can never add a header or a command.
const oneLine = value => String(value).replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').trim();
export const mailbox = value => { const match = /^[^\s<>"',;:\\()[\]@]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.exec(String(value).trim()); return match && match[0].length <= 254 ? match[0] : null; };
const encodeHeader = value => /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;

export function buildMessage({ from, to, subject, text, date = new Date(), id }) {
  const body = String(text).replace(/\r\n?|\n/g, '\r\n').slice(0, smtpLimits.bodyBytes).split('\r\n').map(line => line.length > smtpLimits.lineBytes ? line.slice(0, smtpLimits.lineBytes) : line).join('\r\n');
  const headers = [`From: ${oneLine(from)}`, `To: ${to.map(oneLine).join(', ')}`, `Subject: ${encodeHeader(oneLine(subject).slice(0, 200))}`, `Date: ${date.toUTCString()}`, `Message-ID: <${id}@docknest.invalid>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', 'X-Auto-Response-Suppress: All'];
  const encoded = Buffer.from(body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return headers.join('\r\n') + '\r\n\r\n' + encoded + '\r\n';
}

// config: { host, port, security: 'starttls' | 'tls', username, password, from, to: [address] }
export async function sendMail(config, { subject, text }, { id = String(Date.now()), tlsOptions = {} } = {}) {
  const from = mailbox(config.from), recipients = config.to.map(mailbox);
  if (!from || !recipients.length || recipients.some(item => !item)) throw new SmtpError('The sender or recipient address is not valid.', 'config');
  let connection, timer;
  const run = async () => {
    const address = await smtpIo.resolve(config.host);
    if (!addressAllowed(address)) throw new SmtpError(unreachable, 'blocked');
    const implicitTls = config.security === 'tls';
    const socket = await smtpIo.connect({ address, port: config.port, host: config.host, implicitTls, tlsOptions });
    connection = new Connection(socket);
    await connection.command(null, [220]);
    let features = (await connection.command('EHLO docknest.invalid', [250])).lines.map(line => line.toUpperCase());
    if (!implicitTls) {
      if (!features.some(line => line === 'STARTTLS')) throw new SmtpError('The mail server does not offer encryption (STARTTLS). DockNest never sends mail unencrypted.', 'no-tls');
      await connection.command('STARTTLS', [220]);
      // Bytes queued behind the 220 would be read as if they came from the encrypted server: refuse.
      if (connection.buffer.length || connection.replies.length) throw new SmtpError(unreachable, 'protocol');
      const plain = connection.socket; plain.removeAllListeners('data'); plain.removeAllListeners('close'); plain.removeAllListeners('error'); plain.on('error', () => {});
      const secure = await smtpIo.upgrade(plain, { host: config.host, tlsOptions });
      connection.attach(secure);
      features = (await connection.command('EHLO docknest.invalid', [250])).lines.map(line => line.toUpperCase());
    }
    if (config.username) {
      const mechanisms = features.find(line => line.startsWith('AUTH '))?.split(/\s+/).slice(1) ?? [];
      if (mechanisms.includes('PLAIN')) await connection.command('AUTH PLAIN ' + Buffer.from(`\0${config.username}\0${config.password}`, 'utf8').toString('base64'), [235]);
      else if (mechanisms.includes('LOGIN')) {
        await connection.command('AUTH LOGIN', [334]);
        await connection.command(Buffer.from(config.username).toString('base64'), [334]);
        await connection.command(Buffer.from(config.password).toString('base64'), [235]);
      } else throw new SmtpError('The mail server does not offer a sign-in method DockNest supports (PLAIN or LOGIN).', 'auth');
    }
    await connection.command(`MAIL FROM:<${from}>`, [250]);
    for (const recipient of recipients) await connection.command(`RCPT TO:<${recipient}>`, [250, 251]);
    await connection.command('DATA', [354]);
    await connection.command(buildMessage({ from, to: recipients, subject, text, id }) + '.', [250]);
    try { connection.socket.write('QUIT\r\n'); } catch { /* The message is already accepted. */ }
  };
  try {
    await Promise.race([run(), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new SmtpError(unreachable, 'timeout')), smtpLimits.totalMs); })]);
  } catch (error) {
    if (error instanceof SmtpError) throw error;
    const tlsProblem = /certificate|self.signed|hostname|altnames|ssl|tls/i.test(`${error?.code} ${error?.message}`);
    throw new SmtpError(tlsProblem ? 'The mail server certificate could not be verified.' : unreachable, tlsProblem ? 'tls' : 'network');
  } finally { clearTimeout(timer); try { connection?.socket.destroy(); } catch { /* Already closed. */ } }
}
