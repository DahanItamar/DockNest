# Repository privacy

Source control contains generic configuration examples, application code, documentation, licensed assets and mock-data screenshots. Production operations, addresses, identities, release manifests, credentials, metadata databases and recovery material belong outside Git.

`.env`, runtime data, backups, SSH/cloud configuration, local tooling and logs are ignored. The public examples use reserved domains and documentation IP ranges. Documentation captures use synthetic API fixtures rather than production sessions.

Run `npm run audit:repo` before publishing. CI scans published Git history with Gitleaks and checks tracked content for private infrastructure markers and credential file types. The single explicitly excluded TOTP value is the published RFC 6238 test vector; other test files are scanned normally.

Sanitization preserves milestone commits while removing private operations/evidence, anonymizing author metadata and replacing real deployment examples. Rewritten history changes commit hashes. Other clones should be recreated or rebased onto the clean history; merging an old branch can reintroduce removed data.

History cleanup cannot retract copies already cloned or downloaded, and GitHub may retain unreachable commit URLs or cached views. If an actual secret is exposed, revoke/rotate it first and follow [GitHub's sensitive-data removal process](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository). Keep the repository private unless a separate publication review is completed.

Never include production credentials, customer data or private screenshots in issues or security reports. Report vulnerabilities privately to the repository owner.
