# Open questions for the owner

Date: 2026-10-21. Owner: Product Manager.
These decisions belong to the owner. Each has a PM recommendation, the date by which it blocks work, and what would change the recommendation. None of them changes tools, permissions or licensing until the owner decides.

| # | Question | Decide by | PM recommendation (short) |
| --- | --- | --- | --- |
| Q1 | Offer a hosted DockNest? | Before 2.6.0 | **No** in 2.x |
| Q2 | Prioritize online (no-pause) database capture? | Before 2.5.0 planning | **Defer** past 2.5.0 |
| Q3 | Licensing and money: AGPL only, dual license, or services? | **Before 2.3.0** (contributor policy) | AGPL only + DCO; earn from support/sponsors |
| Q4 | Telemetry and outbound-call stance, including the 2.2.0 update check | **Before 2.2.0** | No telemetry ever; outbound only when an admin opts in |
| Q5 | Supported OS / architecture matrix | Before 2.2.0 (updater depends on it) | Debian/Ubuntu LTS x86_64 advertised; arm64 next with evidence |
| Q6 | Storage efficiency: accept full packages, own dedup, or a restic/Kopia layer? | After the PM-19 benchmark | Accept full packages; prototype a restic layer only if cost blocks adoption |
| Q7 | Unattended automatic updates? | Before 2.2.0 | Never by default |
| Q8 | Confirm the primary persona (agency owner) | Before 2.4.0 planning | Yes, agency owner |
| Q9 | Where do scheduled restore drills run by default? | Before PM-22 (2.5.0) | A dedicated drill server; source server only with an explicit opt-in |
| Q10 | Ever support in-place replacement restore / production cutover? | Before 2.7 planning | Not in 2.x; guided migration checklist at most |
| Q11 | When does DockNest drop the "beta" label? | Before 2.5.0 | After explicit, evidence-based exit criteria are met |
| Q12 | Keep root SSH as a requirement on source servers? | Revisit after 2.4.0 install reports | Keep it, documented; revisit with data |

---

### Q1 — Hosted DockNest?
- **Why it matters:** a hosted manager would hold root SSH keys and the encryption master key for customers' servers. That is a very attractive target and a different trust, support and compliance business from a self-hosted AGPL tool.
- **Options:** (a) self-hosted only; (b) hosted manager; (c) "managed self-hosted" setup service on the customer's own VPS.
- **Recommendation: (a), with (c) as an optional paid service later.** It keeps the security model (principle 3), the no-phone-home stance and maintainer scope intact.
- **Would change if:** several agencies ask to pay for hosting *and* accept a documented key-custody model.

### Q2 — Online (no-pause) database capture priority?
- **Why it matters:** cold capture pauses writers. P3 (small ops teams) may reject that, but P1/P2 sites usually tolerate short pauses (assumption). Native online adapters are high effort and engine-specific ([architecture review §5](../research/public-release-architecture-review.md)).
- **Recommendation: defer past 2.5.0.** Proof on a schedule serves the primary persona better. Keep showing measured pause time honestly.
- **Would change if:** install reports or interviews show the pause blocking adoption for more than a third of reporters.

### Q3 — Licensing and money
- **Why it matters:** dual licensing later requires contributors to have granted the rights now (a CLA). This is hard to fix after outside contributions arrive. Open-core would split the trust story.
- **Options:** (a) AGPL only with the Developer Certificate of Origin (DCO), funded by sponsors, paid onboarding/support or agency setup services; (b) AGPL + CLA to keep a commercial license option open; (c) open-core with paid features.
- **Recommendation: (a).** Keep everything AGPL. Add DCO sign-off to CONTRIBUTING before the 2.3.0 restructure invites contributors. Offer GitHub Sponsors and paid setup/support. No pricing page until install reports show real agency usage.
- **Would change if:** a company asks for a non-AGPL license. Then choose (b) *before* merging significant outside code.

### Q4 — Telemetry and outbound calls
- **Why it matters:** 2.2.0's update check is the manager's first outbound call. 2.4.0 adds heartbeat and notifications. Today the server code makes no outbound HTTP calls of its own, and no document tells operators to expect any.
- **Recommendation:**
  - No telemetry, ever: no install IDs, usage pings or third-party crash reporting.
  - Every outbound call is admin-configured and opt-in.
  - The update check asks the admin once after upgrading to 2.2.0 and stays off until they answer.
  - Document every outbound destination in `docs/security.md`.
  - Metrics come from the sources in [metrics.md](metrics.md).
- **Would change if:** never for telemetry. The default for the update check could become on, with clear disclosure, if the owner prefers faster security-patch uptake.

### Q5 — Supported OS / architecture matrix
- **Why it matters:** the 2.2.0 host-side updater depends on systemd. Many cheap VPSs are arm64. The support matrix currently qualifies rootful Docker on x86_64 only, and `planRestore` blocks architecture mismatches.
- **Recommendation:**
  - **Manager:** systemd-based Linux with Docker Compose (Debian 12/13, Ubuntu 22.04/24.04 advertised). Non-systemd hosts can run the manager without in-app updates.
  - **Sources:** the same distributions on x86_64, Docker 28+ (needed for grouped restores), Python 3.
  - arm64 sources and manager become 2.7+ (R15), and only once arm64 integration evidence exists.
  - Other distributions are "community-reported", not advertised.
- **Would change if:** install reports show a large share on arm64 or RHEL-family hosts.

### Q6 — Storage efficiency
- **Why it matters:** full self-contained packages are simple and portable, and they already work with the recovery kit and `protected-copy.py`. They cost more than dedup engines for frequent backups of large sites.
- **Options:** (a) accept full packages; (b) build our own dedup; (c) optional restic or Kopia storage layer under site-level capture.
- **Recommendation: (a) now, publish the PM-19 benchmark, and consider (c) only if storage cost becomes the top objection.** Never (b): building our own dedup duplicates mature engines and adds dependencies between retained packages that complicate retention (original spec §9).
- **Would change if:** the benchmark shows more than 5× the storage cost on typical fixtures *and* users cite it.

### Q7 — Unattended automatic updates?
- **Recommendation: never by default.** A backup tool must not change under the operator without consent. Possibly later: opt-in "patch releases only" with the same snapshot and rollback gates.

### Q8 — Primary persona
- **Recommendation: confirm the agency owner (P1)** as primary, with the solo developer (P2) as the early-adopter channel ([personas](personas.md)). This decides whether the 2.6.0 Agency pack outranks P3 features such as online capture and scale.
- **Would change if:** interviews (PM-25) show agencies standardize on provider snapshots and do not want site-level tools.

### Q9 — Where scheduled drills run
- **Recommendation:** a designated drill server by default. The source server is allowed only with explicit opt-in, CPU/memory limits and the existing capacity check (`backup.size*3 + 1 GiB` free). This avoids drills competing with production resources.
- **Trade-off:** agencies need one extra (cheap) server. The onboarding flow should explain why.

### Q10 — In-place replacement restore / production cutover
- **Context:** replacement is blocked in `planRestore` until a safety backup and rollback adapter exist. The original spec (§11) describes it as a later step.
- **Recommendation:** not in 2.x. At most, R14 provides a guided migration checklist (isolated restore → review → manual DNS/proxy switch). Revisit only with a dedicated design and real Linux rollback evidence.

### Q11 — Exiting beta
- **Recommendation (proposed exit criteria):**
  1. 2.2.0 safe updates shipped with the PM-10 suite green.
  2. 2.4.0 alerts and scheduled scrubs shipped.
  3. Every advertised support-matrix row has current-release Linux evidence.
  4. Source boot recovery either has a real reboot drill or is labelled experimental.
  5. 90 days with no reported data-loss or upgrade-breakage bug.
- Until all five hold, keep the README's beta note.

### Q12 — Root SSH on source servers
- **Context:** `planRestore` blocks restores without UID 0 ("Root SSH required to restore ownership"). Capture also needs root for ownership and data access ([architecture review §7](../research/public-release-architecture-review.md)).
- **Recommendation:** keep the requirement and state the trust boundary clearly in onboarding (PM-20). Count objections in install reports. Start R16 (a constrained sudo helper) only if it is a frequent blocker, and only with a Security Engineer design review.
