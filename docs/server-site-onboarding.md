# Connect a server and add a site

1. Choose **Add server** and enter its name and IP address or hostname. SSH defaults to root on port 22; expand SSH settings if needed. The Linux server needs SSH, Python 3 and Docker.
2. Create a dedicated backup key, or choose an existing unencrypted private key. With the dedicated key, copy the provided installation command into a trusted root shell on that server. Only its public key is installed there.
3. Paste the JSON result into DockNest. The report is read automatically; verify its host fingerprint through the trusted server console/connection. Choose **Test connection & save**. DockNest checks access before saving the connection and encrypts the private key.
4. Choose **Add a site** on the success screen, or use **Sites → Add site** later. Select a source server: DockNest automatically discovers its Docker containers. Select the site's container from the dropdown. Optionally include associated database/services in the same backup unit.
5. Confirm the site name, health URL and shutdown profile. Expand advanced settings for source staging, Compose files and configuration files. Review dependencies and mounted-data ownership before adding the site. Connect backup storage and configure the maintenance proxy before running a backup; creating a site does not start one.

Changing servers clears the selected containers and discovery errors can be retried. Empty or failed discovery cannot save a site. Wizard navigation preserves entered settings. Discovery reads container information without stopping containers.

Verification: `npm run check` and `npm run test:browser`. Browser tests use isolated API fixtures for connection/discovery/site creation, covering both key options, the connection-to-site handoff, dropdown selection and grouping, settings preservation, discovery failure/retry, empty results, and desktop/mobile rendering. They do not validate a real server connection or Linux Docker backup/restore.
