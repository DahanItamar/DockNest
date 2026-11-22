// Recovery kit check: "Kit from <date>" is shown only when a kit was actually found. A check that never reached a kit
// (no kit in storage, unreadable, no passphrase saved, an error) has no kit to date, whatever date the record carries.
const NOT_FOUND = new Set(['no_kit', 'unreadable', 'no_passphrase', 'error']);
export const kitDateOf = last => {
  if (!last?.kitDate) return null;
  if (last.result === 'failed' && (!last.reason || NOT_FOUND.has(last.reason))) return null;
  return last.kitDate;
};
