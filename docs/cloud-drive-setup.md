# Connecting a cloud drive

DockNest can keep backups on Google Drive, OneDrive or Dropbox. Every backup is encrypted on your DockNest server before it
is uploaded, so the provider stores only ciphertext. The sign-in token is sealed with your master key and stays on your server.

This page covers what you prepare on the provider's side. For how it works inside DockNest, see [Cloud drives](cloud-drives.md).

## Before you start

- DockNest 3.0.0 or newer, running from the official `linux/amd64` image (it includes rclone). Other CPU architectures cannot
  use cloud drives.
- An admin account on DockNest with your authenticator app at hand. Connecting a drive asks you to verify again.
- An account with the provider. The free plans are enough to start: Google Drive 15 GB, OneDrive 5 GB, Dropbox 2 GB.

## How signing in works

1. In DockNest, open **Storage**, press **Add storage destination**, choose the provider and start the sign-in.
2. Sign in on the provider's page and allow access.
3. Your browser then shows **"This site can't be reached"** for an address that starts with `http://127.0.0.1:53682/` or
   `http://localhost:53682/`. **This is expected.** Copy the whole address from the address bar and paste it into DockNest.
4. Finish within 10 minutes. After that the sign-in expires and you start again.

The address holds a one-time code. Paste it only into your own DockNest, never into a chat or a ticket.

**Alternative:** run `rclone authorize "drive"` (or `"onedrive"`, `"dropbox"`) on your own computer with rclone 1.70 or newer,
and paste the token it prints instead of the address.

## Google Drive

Use **your own Google app** (client ID). With rclone's shared app, Google limits requests for everyone who uses it, and backups
and tests become slow or fail with "Google is limiting the shared sign-in app". Your own app has its own quota. It is free and takes
about five minutes.

1. Create a project: [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate). No billing is needed.
2. Enable the Drive API: [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) → **Enable**.
3. Set up the consent screen: [Google Auth Platform](https://console.cloud.google.com/auth/overview) → **Get started**.
   Choose **External** and enter an app name and your email.
4. Under [Audience](https://console.cloud.google.com/auth/audience), do one of these:
   - **Publish app** (recommended). DockNest asks only for access to files it creates itself (`drive.file`), so Google does
     not need to review the app.
   - Or stay in **Testing** and add your Google account under **Test users**. Without this, Google answers
     `403 access_denied`. In Testing mode Google ends the sign-in after 7 days, and you will need to reconnect.
5. Create the client: [Clients](https://console.cloud.google.com/auth/clients) → **Create client** → type **Desktop app**.
6. In DockNest, before you start the Google Drive sign-in, press **Use your own app ID**, enter the **Client ID** and **Client secret**, and press **Use this app**.

DockNest only sees the files and folders it creates in your Drive, not the rest of it.

Set up your own Google app before the first backup. Changing it later hides earlier backups from DockNest.

## OneDrive

- Works with a personal Microsoft account and with a work or school account.
- New personal accounts: open [onedrive.live.com](https://onedrive.live.com) once after sign-up so the drive is created.
- Some personal accounts sign in with a code sent by email instead of a password. Keep that inbox open.
- After you sign in, choose the drive that should hold the backups.

## Dropbox

- The free Basic plan is enough. Skip any paid trial offer during sign-up.
- After you sign in, allow access. Nothing else is needed.

## When a drive needs you to sign in again

Access can end without anything changing in DockNest. For example, you change your password, you remove the app's access,
the provider expires the sign-in, or (Google, Testing mode) seven days pass. DockNest then:

- marks the destination **Needs sign-in**,
- stops backups to it with a plain message, and
- sends one alert (not one per backup).

Open the destination and press **Reconnect**, then sign in as above. Your backups and settings stay as they are.

## Removing DockNest's access

Remove the destination in DockNest first. Then revoke the access at the provider:

| Provider | Where |
|---|---|
| Google | [myaccount.google.com/connections](https://myaccount.google.com/connections) |
| Microsoft | [account.live.com/consent/Manage](https://account.live.com/consent/Manage) (work or school: [myapps.microsoft.com](https://myapps.microsoft.com)) |
| Dropbox | [dropbox.com/account/connected_apps](https://www.dropbox.com/account/connected_apps) |

The access is listed under your own app's name if you created one, otherwise under **rclone**.

## Troubleshooting

| You see | What to do |
|---|---|
| `403 access_denied` from Google | Your app is in Testing. Add your account under **Test users**, or publish the app. |
| "Google is limiting the shared sign-in app" or a slow Test | Use your own Google app (above). |
| "This site can't be reached" after allowing access | Expected. Copy that address and paste it into DockNest. |
| "This sign-in expired" | More than 10 minutes passed. Start the sign-in again. |
| **Needs sign-in** on a destination | Press **Reconnect** and sign in again. |
| Cloud drives are not offered | Your server is not `linux/amd64`, or rclone is missing from a source install. |
