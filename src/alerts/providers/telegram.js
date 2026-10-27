// Telegram (docs/alert-channels.md, "Providers"). The bot token is the secret; the chat ID is the destination. The sealed
// value is `{ token }`, the 2.8 credential shape, so migrated Connections reuse the 2.8 sealed bytes as they are.
// A provider is data plus small pure functions: it never opens a socket. The core (delivery.js) makes the request
// through the guarded client (outbound.js), which only ever reaches api.telegram.org on a public address.
import { z } from 'zod';
import { plainText, cut } from './common.js';

const token = z.string().trim().regex(/^\d{5,15}:[A-Za-z0-9_-]{30,64}$/, 'Paste the bot token exactly as BotFather shows it.');
const chatId = z.string().trim().regex(/^(?:-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/, 'Enter the chat ID (a number) or the @name of a public channel.');

export default Object.freeze({
  id: 'telegram', label: 'Telegram', icon: 'brand-telegram', group: 'common',
  fields: Object.freeze([
    Object.freeze({ key: 'token', label: 'Bot token', type: 'password', secret: true, required: true, help: 'From BotFather in Telegram.' }),
    Object.freeze({ key: 'chatId', label: 'Chat ID', type: 'text', required: true, help: 'The chat, group or channel that gets the alerts.' }),
  ]),
  secretSchema: z.object({ token }).strict(),
  settingsSchema: z.object({ chatId }).strict(),
  destination: Object.freeze(['chatId']),
  host: Object.freeze([]),
  target: () => ({ hosts: ['api.telegram.org'], base: 'https://api.telegram.org' }),
  // Plain text (no parse mode, so nothing in a site name is read as markup) and no link preview, cut to Telegram's 4096.
  format: (message, values) => ({ method: 'POST', path: `/bot${values.token}/sendMessage`, json: { chat_id: values.chatId, text: cut(plainText(message), 4096), link_preview_options: { is_disabled: true } } }),
  // Checks the login without sending anything.
  verify: values => ({ method: 'GET', path: `/bot${values.token}/getMe` }),
  // One fixed sentence per failure, never the provider's own text. A `final` failure is not worth retrying.
  explain: (status, body = {}, { verifying = false } = {}) => {
    if (status >= 200 && status < 300 && body?.ok !== false) return null;
    if (status === 401 || status === 404) return { message: 'Telegram does not accept this bot token.', final: true };
    if (verifying) return { message: 'Telegram refused the check.', final: false };
    // 403: the bot was blocked, removed from the group or never started. Retrying cannot help, so it is final at once.
    if (status === 403) return { message: 'Telegram could not deliver to this chat. Open the bot in Telegram and press Start, or add it to the group.', final: true };
    if (status === 400) return { message: 'Telegram could not deliver to this chat. Open the bot in Telegram and press Start, or add it to the group.', final: false };
    if (status === 429) return { message: 'Telegram asked DockNest to slow down.', final: false };
    return { message: 'Telegram refused the message.', final: false };
  },
  unreachable: 'Telegram could not be reached.',
});
