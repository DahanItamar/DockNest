# Authentication and access

The system uses one shared system password plus a separate authenticator identity for each authorized person. Login asks for the shared password and a six-digit TOTP code together, or an unused personal recovery code. The second factor identifies the person's account and role. Knowing the shared password alone does not grant access.

## Enrollment and account lifetime

The first administrator is provisioned through the local PowerShell setup command. It prompts for the selected password, opens a temporary local QR/recovery page, and requires a valid authenticator code before activating the administrator. The QR file is deleted after confirmation. The web login only shows Password and 2FA code. The legacy API setup route still requires the local setup token; it cannot expose a pending administrator authenticator with the shared password alone. Administrators create named operator invitations in Access management. An invitation expires after 15 minutes and can be used once. Its enrollment URL places the opaque token in a browser fragment; the browser submits it only to the enrollment endpoints.

The invited person opens the link, enters the shared password, scans the locally generated authenticator QR, and confirms a code. Password verification produces a short-lived enrollment proof required for confirmation. An account awaiting enrollment cannot log in. Save the resulting personal recovery codes privately; each works once. The administrator distributes the invitation and shared password through their chosen private channels: this application does not send email invitations automatically.

The 15-minute expiry applies to enrollment, not to the account or authenticator. An enrolled account remains authorized until revoked. Regenerating an invitation invalidates the earlier link. Resetting an active operator’s authenticator requires confirming their name and signs them out; they must complete the new invitation before logging in again. Administrators cannot revoke or reset administrator accounts through these operator controls. Treat QR images, authenticator secrets, invitation links, and recovery codes as credentials; do not publish them.

## Permissions and revocation

Administrators manage invitations, revoke access, and rotate the system password. Operators cannot use those administrator routes. Removing a person immediately disables their account and invalidates their sessions. Neither the shared password nor their previous authenticator/recovery codes can reactivate a disabled account.

Sensitive administration requires password plus that administrator's personal factor verified within the previous five minutes. The server returns REAUTH_REQUIRED when another verification is needed. Rotating the shared password signs everyone out and invalidates pending login/enrollment challenges and invitations. Tell authorized people the replacement password privately.

## Session expiry

The server rejects sessions after 30 minutes without reported user interaction and after eight hours from login, even with continued activity. Dashboard polling and ordinary reads do not renew the idle timer. The UI reports trusted keyboard/pointer interaction through the protected activity endpoint; that endpoint cannot revive an expired session.

These limits are checked on the server, independently of browser countdowns. A client possessing a session can submit activity reports, so the idle timer is not proof a human remains present. Logout invalidates the session immediately. HTTPS deployments use Secure, HttpOnly, SameSite=Strict cookies and CSRF/origin checks.

Server-side idle and absolute expiry follow the principles in [OWASP's Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#automatic-session-expiration). The configured 30-minute/eight-hour limits are this project's choices.

## Secret handling and migration

Password hashes use the project's password-hashing routine. Authenticator and SSH secrets remain encrypted using the external master key; invitation/session/challenge tokens are stored as hashes. TOTP replay counters and one-use recovery hashes prevent successful factor replay. Ambiguous factor matches fail closed rather than selecting an arbitrary identity.

Existing installations migrate the earliest account to administrator and preserve its password as the shared system password. Keep a protected state/key backup before upgrades. Shared passwords have operational tradeoffs: rotate when membership changes, retain personal-factor separation, and review the per-person audit trail.

Run `npm run check` for regression checks. Verify HTTPS, browser interaction/idle logout, authenticators, and revoke behavior on the actual deployment before granting access.

New shared passwords must be 4-16 characters, including numeric passwords. Login still accepts previously configured longer passwords so the policy change does not lock out existing users. Password-only login never grants a session. Every private API route requires an enabled, enrolled account and a valid session; API data responses are never cached. Login/enrollment screens and static frontend assets remain public. Short passwords reduce resistance to guessing; mandatory personal MFA, rate limits, replay checks, and session revocation remain enforced.
