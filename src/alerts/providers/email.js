// Email (docs/alert-channels.md, "Email keeps its sealed shape"). The whole SMTP account (server, port, encryption, user
// name, password, from) stays one sealed value, exactly the 2.8 credential shape, so the 2.8 copy needs no decryption.
// Recipients and the subject prefix are plain settings. Email is the one non-HTTP provider: smtp.js does the sending.
import { z } from 'zod';
import { mailbox } from '../smtp.js';

const hostname = z.string().trim().min(1).max(253).regex(/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$|^\[?[0-9A-Fa-f:.]+\]?$/, 'Enter the mail server name, for example smtp.example.com.');
const address = z.string().trim().max(254).refine(value => mailbox(value), 'Enter a plain email address, for example alerts@example.com.');
const prefix = z.string().trim().max(40).regex(/^[^\r\n\u0000-\u001f\u007f]*$/, 'The subject prefix must be one line.');
const field = value => Object.freeze(value);

export default Object.freeze({
  id: 'email', label: 'Email', icon: 'mail', group: 'common',
  fields: Object.freeze([
    field({ key: 'host', label: 'Mail server', type: 'text', sealed: true, required: true }),
    field({ key: 'port', label: 'Port', type: 'number', sealed: true, required: true }),
    field({ key: 'security', label: 'Encryption', type: 'select', options: Object.freeze(['starttls', 'tls']), sealed: true, required: true }),
    field({ key: 'username', label: 'User name', type: 'text', sealed: true }),
    field({ key: 'password', label: 'Password', type: 'password', secret: true }),
    field({ key: 'from', label: 'From address', type: 'email', sealed: true, required: true }),
    field({ key: 'to', label: 'Recipients', type: 'email-list', max: 5, required: true }),
    field({ key: 'subjectPrefix', label: 'Subject prefix', type: 'text', more: true }),
  ]),
  secretSchema: z.object({
    host: hostname, port: z.number().int().min(1).max(65535), security: z.enum(['starttls', 'tls']),
    username: z.string().max(254).default(''), password: z.string().max(512).default(''), from: address,
  }).strict().refine(value => !value.username === !value.password, { message: 'Enter both the user name and the password, or leave both empty.', path: ['password'] }),
  settingsSchema: z.object({ to: z.array(address).min(1).max(5), subjectPrefix: prefix.default('') }).strict(),
  destination: Object.freeze(['to', 'host', 'port']),
  // Changing where the password goes needs it typed again, so a saved password can never be redirected.
  host: Object.freeze(['host', 'port', 'security', 'username']),
  target: values => ({ hosts: [values.host] }),
  // The sealed members a view may show (everything but the password), as the 2.8 credential view did.
  view: secret => ({ host: secret.host, port: secret.port, security: secret.security, username: secret.username, passwordSet: Boolean(secret.password), from: secret.from }),
  unreachable: 'The mail server could not be reached.',
});
