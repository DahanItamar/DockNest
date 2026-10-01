# Connect a server and add a site

Server names are optional and default to the address. With the dedicated key option, Continue creates the key automatically; the separate create button is optional.

Each server also has an optional note (up to 200 characters), for a short title or reminder. Add it when connecting, or use **Servers → Edit details** to change the name and note later. Notes appear below the server name and in the site wizard's server dropdown. Clearing the name uses its address. Editing these details preserves the existing SSH settings and connection verification.

Docker group identity uses Compose project labels and Swarm stack namespace labels, including stopped containers returned by discovery. Compose and Swarm identities remain separate even with matching names. Swarm discovery covers only containers on the selected server, not the entire cluster. Containers without group labels require manual selection; names and shared networks are not proof of membership. Detection does not prove backup completeness.

Upstream role reference: [Agency Frontend Developer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-frontend-developer.md), applied to clear defaults, accessible setup controls and responsive group selection. Used as design reference without spawning agents.

1. Choose **Add server** and enter its name and IP address or hostname. SSH defaults to root on port 22; expand SSH settings if needed. The Linux server needs SSH, Python 3 and Docker.
2. Create a dedicated backup key, or choose an existing unencrypted private key. With the dedicated key, copy the provided installation command into a trusted root shell on that server. Only its public key is installed there.
3. Paste the JSON result into DockNest. The report is read automatically; verify its host fingerprint through the trusted server console/connection. Choose **Test connection & save**. DockNest checks access before saving the connection and encrypts the private key.
4. Choose **Add a site** on the success screen, or use **Sites → Add site** later. Select a source server: DockNest automatically discovers its Docker containers. Use **Select site** on the matching project card to include its services. Single containers have their own cards. **Review services** expands individual controls; **My site needs a custom selection** supports sites spread across groups. Selecting a different card replaces the previous selection.
5. Confirm the site name and health URL. Expand advanced settings for domains, shutdown profile, source staging, Compose files and configuration files. These settings may be needed before a backup can run; Generic still requires explicit clean-shutdown confirmation. Review dependencies and mounted-data ownership before adding the site. Connect backup storage and configure the maintenance proxy before running a backup; creating a site does not start one.

Changing servers clears the selected containers and discovery errors can be retried. Empty or failed discovery cannot save a site. Wizard navigation preserves entered settings. Discovery reads container information without stopping containers.

Verification: `npm run check` and `npm run test:browser`. Browser tests use isolated API fixtures for connection/discovery/site creation, covering both key options, the connection-to-site handoff, project and single-container cards, collapsed controls, replacing a selection, custom selection, settings preservation, discovery failure/retry, empty results, and desktop/mobile rendering. `TEST_SCREENSHOT_DIR` can redirect screenshots to a writable folder. They do not validate a real server connection or Linux Docker backup/restore.

Site-selection and server-note refinement: production build and browser smoke passed on Windows, including desktop/mobile rendering. `npm run check` passed all 32 tests with the installed Python available outside the sandbox's PATH. No Linux Docker backup or restore was validated.
