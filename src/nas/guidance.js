// Connect-wizard text for NAS systems (ADR section 5). Plain strings only: the screens come in a later change.
export const SYNOLOGY_RESET_HINT = 'Synology may have reset SSH after an update. Open Control Panel > Terminal & SNMP, make sure the SSH service is on, and check that your key is still in the user\'s authorized keys.';
export const NAS_WIZARD = Object.freeze({
  unraid: Object.freeze({
    identity: 'Connect as root with a key. Unraid keeps /root in memory, so the key is also written to /boot/config/ssh/root/authorized_keys to survive a reboot.',
    steps: Object.freeze(['Use the Unraid command below as root in the Unraid terminal.', 'Check that Settings > Management Access has SSH on.']),
  }),
  synology: Object.freeze({
    identity: 'Connect as an administrator user with passwordless sudo, or as root. Root login is off by default and a DSM update can reset the SSH settings.',
    steps: Object.freeze(['In Control Panel > Terminal & SNMP, turn on the SSH service.', 'Log in as an administrator, run "sudo -i", then add the key to the account you will connect with.', 'For a non-root account, add a NOPASSWD sudo rule for it. DockNest never edits sudoers.']),
  }),
  truenas: Object.freeze({
    identity: 'TrueNAS turns root SSH off. Connect as the admin user (for example truenas_admin) with key-only login and passwordless sudo, or turn on root key login in System > Services > SSH.',
    steps: Object.freeze(['In System > Services, start SSH and allow key login for the admin user.', 'Add the key to that user in Credentials > Local Users.', 'Make sure the user may run sudo without a password. DockNest never edits sudoers.']),
  }),
});
// The command shown for Unraid: the same key install, written to the persistent folder first and copied to /root/.ssh.
export function unraidInstallCommand(publicKey) {
  if (typeof publicKey !== 'string' || !/^ssh-rsa [A-Za-z0-9+/=]+ docknest$/.test(publicKey)) throw new Error('Not a DockNest public key.');
  return String.raw`set -eu
umask 077
mkdir -p /boot/config/ssh/root /root/.ssh
touch /boot/config/ssh/root/authorized_keys
grep -qxF '${publicKey}' /boot/config/ssh/root/authorized_keys || printf '%s\n' '${publicKey}' >> /boot/config/ssh/root/authorized_keys
cp /boot/config/ssh/root/authorized_keys /root/.ssh/authorized_keys
chmod 700 /root/.ssh
chmod 600 /root/.ssh/authorized_keys`;
}
// Only a Synology login failure gets the reset hint: it is a known cause there, not a guess for other systems.
export function loginHint(server, error) {
  let kind = null;
  try { const facts = typeof server?.capabilities === 'string' ? JSON.parse(server.capabilities) : server?.capabilities; kind = facts?.nas?.kind ?? null; } catch { kind = null; }
  return kind === 'synology' && (error?.level === 'client-authentication' || error?.code === 'ECONNREFUSED') ? SYNOLOGY_RESET_HINT : null;
}
