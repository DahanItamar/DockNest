# Connect an Ubuntu or Linux Docker server

In the dashboard choose **Add server**. This wizard is available only to the administrator.

1. Select Ubuntu, Debian, or another Linux distribution. Enter its address, SSH port, and a recognizable name. The current backup engine requires root SSH access to preserve file ownership and read Docker volume data.
2. Select an existing private key file from your PC, or create a dedicated backup key. Existing keys are commonly under `%USERPROFILE%\.ssh`; select the file without `.pub`. SSH agents and passphrase-encrypted private keys are not yet supported. The dedicated-key option generates a separate RSA 3072-bit key for the backup system.
3. Open the server console or use the displayed `ssh` command in PowerShell on your PC. Run the supplied Linux command in the server's root shell. If needed, use `sudo -i` in your existing session first. Do not paste Linux shell commands directly into local PowerShell.
4. Copy the JSON report back into the wizard and choose the verified SSH host key. Obtain the report through your server console or a previously trusted SSH connection. If SSH negotiates a different host-key algorithm, choose its fingerprint from the same trusted report and retry.
5. Choose **Test connection & save**. The API verifies the pinned SSH host key, authenticates, runs the Python helper's read-only Docker/system test, and checks root access before storing the server. Failed tests do not create a server record. The private key is encrypted using the project's master key; state responses never return it.

The existing-key command only reads public host-key fingerprints and prerequisites. The dedicated-key command additionally appends its public key to the root account's `authorized_keys`, preserving existing entries and avoiding duplicate copies. It does not install packages, change SSH daemon policy, or alter containers. Docker, Python 3.9 or newer, a reachable SSH service, and an SSH policy permitting the selected account must already exist. Cloud consoles and provider SSH restrictions vary; the wizard reports connection failures rather than rewriting those policies.

Canceling closes the dialog without saving its private key. If you already installed a dedicated public key on the server and decide not to use it, remove its `docknest` entry from that account's `authorized_keys` through your trusted server console. Do not publish private keys or screenshot a filled private-key field.

The platform selector covers Linux hosts supported by the Python/Linux backup helper. Windows Docker hosts require another adapter. This is independent of the operating system running the dashboard or your browser.

Automated checks cover generated key consistency, public-only installation commands, authorization, and both browser wizard paths with isolated fixtures. A live Ubuntu host still needs a real connection test and the backup/restore acceptance checks before production use.
