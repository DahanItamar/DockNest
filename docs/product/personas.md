# Personas

Date: 2026-10-21. Owner: Product Manager.

## Evidence base and its limits

DockNest has no user research yet. The public repository was created on 2026-10-19 and, when checked on 2026-10-21, had 3 stars, 0 forks and no issues (`gh repo view`). The personas below come from:

- **E1, the original requirements** ([docker-backup-spec.md](../docker-backup-spec.md)). It describes one owner running several Docker sites on several servers, with downtime accepted during capture, a "last X backups" retention model, a maintenance page and restore to another server.
- **E2, the owner's own production use.** Release notes and acceptance evidence record four configured sites, static nginx and Docker application sites, an SFTP storage target and manager upgrades with drain and rollback ([acceptance.md](../acceptance.md), [release notes](../releases/2026-10-03-health-privacy.md)).
- **E3, an external positioning review** passed on by the coordinator. It recommends targeting small web agencies and developers who manage several VPSs, and names on-demand-only restore tests as the main gap.
- **E4, the adjacent market.** Mature tools such as restic, Backrest, Kopia and offen/docker-volume-backup exist, which shows that self-hosters back up Docker data themselves. It says nothing about willingness to adopt a site-level tool.

Every line marked **[A]** is an assumption to validate. Lines marked **[E1]**–**[E4]** cite the evidence above. Validation methods are listed at the end.

---

## P1 — "Dana", owner of a small web agency

Runs about 5–40 client sites (WordPress, Laravel, Node or static) as Docker Compose projects across 2–8 VPSs from one or two hosting providers. Has 1–5 staff, with no dedicated ops person. **[A, E3]**

**Jobs to be done**
- When a client's site breaks or a VPS is lost, I want to bring that one site back quickly, so I keep the client and my reputation. **[E1, E3]**
- When a client asks "are we backed up?", I want to show proof, not a promise, so I can justify my maintenance retainer. **[A]**
- When I move a client to a new server, I want to rebuild the site from a known-good capture, so the move is predictable. **[E1: restore to another server; A: migration use]**

**Pains**
- Provider snapshots restore the whole VM, not one client's site, and are tied to that provider. **[README comparison table]**
- Hand-written restic or cron scripts differ per server. Nobody tests restores until the day they are needed. **[A, E3]**
- Database backups are inconsistent: some sites dump, some copy files and some do nothing. **[A]**
- Staff turnover. The person who wrote the scripts leaves. **[A]**

**What success looks like**
- Every client site shows a recent restore that passed within a target window, at a glance. **[A]**
- Can produce a short recovery report for a client without exposing other clients' data. **[A]** (no such feature yet; see the roadmap)
- Gets told about a failed backup within hours, not weeks. **[A]** DockNest has no outbound notifications today (no notification code in `src/`); the bell in the top bar lists active jobs only (`web/shell.jsx`).
- Recovery time for one site is measured, not guessed. **[A]**

**Fit with DockNest today:** strong on whole-site capture, isolated restore and per-person accounts (shared password plus personal TOTP, admin and operator roles; [security.md](../security.md)). Weak on alerting, scheduled restore proof and client-facing reporting.

---

## P2 — "Sam", solo developer or indie hacker

Runs 1–6 personal or side-business projects on 1–2 cheap VPSs, often a mix of Docker Compose apps and a static site. **[A]** This is closest to the owner's own setup. **[E2]**

**Jobs to be done**
- When I deploy something risky or my VPS provider has an incident, I want a recent full-site copy I can trust, so I don't lose users' data. **[A]**
- When I set up backups, I want it done in an evening and then forgotten until something breaks, so it doesn't take time from building. **[A]**

**Pains**
- Docker sites are more than volumes. Writable layers, Compose files, `.env` files and image versions also matter, and volume-only tools miss them. **[E1 §6]**
- Has little time and tolerance for configuration. Readiness blockers in the setup flow have to explain the fix. **[A]**
- Cost sensitivity. Full packages without dedup use more storage than restic or Kopia. **[A; format fact in [backup-format.md](../backup-format.md)]**

**What success looks like**
- Gets from install to a first passed isolated restore in under one hour. **[A; becomes a tested metric in [metrics.md](metrics.md)]**
- Upgrading DockNest never costs a weekend. **[owner rule]**
- Storage spend stays predictable. **[A]**

**Fit with DockNest today:** good security defaults and a guided first-run path (README "Your first backup"). The friction points are prerequisites (root SSH on sources, Python 3, a separate SFTP server; README "Requirements") and no in-app update path until 2.2.0.

---

## P3 — "Ops team of 2–4" at a small SaaS or e-commerce company

Runs 10–60 containers in Compose across a handful of servers. Has PostgreSQL, MySQL/MariaDB or Redis behind the application, an audit or compliance customer asking about DR, and on-call shared between developers. **[A]**

**Jobs to be done**
- When an auditor or customer asks for our recovery point and recovery time objectives (RPO/RTO), I want measured evidence per service, so the answer is defensible. **[A; RPO/RTO discussed in [architecture review §4](../research/public-release-architecture-review.md)]**
- When ransomware or a stolen credential hits the backup manager, I want at least one copy it cannot delete, so we can still recover. **[E1 §9; [independent-recovery.md](../independent-recovery.md)]**
- When a database backup is taken, I want proof it was taken after a clean shutdown, so restored data is not corrupt. **[support matrix]**

**Pains**
- Downtime during capture. Cold capture pauses writers, and this persona may not accept that for every service. **[A; online adapters are not implemented]**
- Needs alerting into existing tooling (webhook, email, on-call). **[A]**
- Single-worker throughput. DockNest runs one active job per server (`claimJob` in `src/engine.js`) and one worker process. **[code]**

**What success looks like**
- An RPO/RTO report per site, with dates and evidence. **[A]**
- Independent copy with separate deletion authority, verified on a schedule. **[A]**
- Alerts reach the team's existing channel. **[A]**

**Fit with DockNest today:** partial. The verification model and independent recovery kit are ahead of volume tools. Online database capture, alerting and scale are gaps. This is a **secondary** persona: do not design 2.x around it.

---

## Primary persona decision

**Primary: P1 (agency owner).** P2 is the early-adopter path (the owner's own setup, lowest support cost). P3 is a stretch segment.
Rationale: P1 has the clearest site-level job ("bring back one client's site"). The pain has a business cost (client trust). The differentiator, recorded restore evidence, can be shown to a third party. **[A, to validate]**

## Validation plan (assumptions to test)

| Assumption | How to validate | Signal that confirms it |
| --- | --- | --- |
| Agencies run several client sites as Compose projects per VPS | 5+ short interviews with agency owners or freelancers. Optionally an opt-in GitHub Discussions poll | 3 of 5 interviewees describe that setup |
| Restore testing is skipped today | The same interviews: "When did you last restore a site to check?" | Most cannot name a date |
| A client-facing recovery report has value | Show a mock report to interviewees | 2+ ask when it ships, or say they would use it in sales |
| Downtime during capture is acceptable for most agency sites | Ask about acceptable pause per site. Compare with the downtime DockNest shows on the recovery-history rows | Under 60 s is acceptable for most sites |
| Root SSH on sources is acceptable | Count install drop-offs that mention root in issues or discussions | Few or no objections |
| Solo devs reach a first passed restore in under 1 hour | Timed walkthrough on a clean VPS (see metrics) | Median under 60 min |

Interviews must be opt-in and anonymized, with no customer names or domains in Git ([repository privacy](../repository-privacy.md)).
