# Automatic restore tests

A backup is only worth something if it comes back. An automatic restore test checks that for you. It restores the
latest verified backup of a site onto a test server, starts it, runs checks, records the result and removes
everything it created.

Restore tests are a beta feature. Real restores count as proven only after DockNest's Linux Docker test passes, so
treat a pass as a strong hint, not a guarantee. The design is in [restore-tests.md](restore-tests.md).

## What it does

1. Picks the newest backup of the site that is verified and not about to be deleted.
2. Copies it to your test server and restores it there, away from the live site.
3. Starts the containers and checks them.
4. Records the result and shows it on the site.
5. Removes the copy, its networks, its images and its files.

A test never touches your live containers. It runs on a server you choose, with its own names and no published
ports.

## Turn it on

Open **Sites & schedules**, find the site and select **Restore tests** on its row. Only administrators can change
the settings.

- **Auto tests.** The switch that turns scheduled tests on. It is off by default.
- **How often.** Daily, weekly (suggested) or monthly. A test starts about 30 minutes after the site's next backup.
- **Test server.** Choose where the copy runs.
- **Time limit, Memory and CPU.** Limits for each container, with presets or a custom value. Defaults: 30 minutes,
  1 GB, 1 CPU.
- **Health check path (optional).** A page to open inside the copy, under **Advanced settings**.

Select **Save** to keep the settings. **Run test** works for administrators and operators. You can start up to 6 manual tests
per site every 24 hours.

## Choose a test server

The test server gets a full copy of the site, including its passwords. Pick a server you trust as much as the live
one.

Use a different server when you can. Sites that need external storage cannot be tested, because a test cannot attach
it.

### Use the live server (optional)

You can choose the site's own server. Tick **Allow live server**. DockNest asks for your password and code again.

The risks:

- The test runs next to your live sites and uses memory and CPU while it runs.
- Backups on that server wait until the test is done.
- A very fast writer could fill the disk before the next space check.

The test still uses its own container names and never changes live containers.

### Allow internet (optional)

By default a copy has no internet. It cannot send mail, charge cards or call webhooks. Some apps need an outside
service to start. Those tests fail with a message that says so.

You can turn on **Allow internet** under **Advanced settings**. Administrators only, with a fresh password and code.

The risks:

- The copy runs with your live keys and passwords.
- It can call webhooks, payment services and other APIs.
- It can take jobs from shared queues, such as Redis or SQS workers.
- It can run scheduled jobs once.

What DockNest blocks: outgoing mail on ports 25, 465, 587 and 2525, the cloud metadata service and the addresses of
the test server itself. Mail sent through a web API is not blocked. Results then read "Passed (tested with
internet)".

## Limits

- One test per site and one per test server at a time.
- Backups go first. A test waits if a backup, restore, install or move is running there.
- The copy needs free space of three times the backup plus 1 GiB.
- Memory and CPU are capped per container. Disk is not capped. DockNest checks free space before the containers
  start and again after the checks.
- A test stops at its time limit and then cleans up.
- While a test copies and restores, other backups wait for the worker. A very large site can hold it for a while.

## Read the results

| Result | Meaning |
|---|---|
| Passed | The site started from this backup and passed its checks. |
| Failed | The backup did not come back. Look at this one first. |
| Couldn't run | The test server or a test limit stopped it. The backup may be fine. |
| Cancelled | You stopped it. |
| Not tested | No test has run for this backup yet. |

A pass means:

- Every service that ran at backup time is running and healthy.
- They are still running 60 seconds later.
- Configured database checks match.
- The optional web check answered.

A pass does not prove that every page, login, payment, email or background job works. Add a web check and database
checks to cover more.

Each test lists its steps with times: Check space, Copy backup, Restore copy, Start containers, Check health and
Clean up. A failed step shows one plain sentence about why.

Each backup shows its newest test result in the library, and each site shows its **Last test** result. A failed
test also appears as a red alert on the Overview, and every test appears in **Jobs** with its steps.

## Alerts

Administrators turn these on under **Alerts** on the Map page (Telegram or email):

- **Restore test failed.**
- **Restore test couldn’t run.**
- **Restore test passed again,** after an earlier failure.
- **Restore test needs clean-up,** when clean-up did not finish.

Messages contain names and times only.

## Troubleshooting

### "Couldn’t run"

Read the reason on the test. Common ones:

- **Memory limit.** Raise the **Memory** limit.
- **Time limit.** Raise the **Time limit** or use a faster test server.
- **Low disk.** Free space on the test server.
- **Test server unreachable.** Check the server's connection.
- **Needs an outside service.** The app cannot start without internet. Consider **Allow internet** and read the risks
  above.
- **CPU above the server.** Lower the **CPU** limit to what the test server has.

### "Failed"

Restore the backup by hand from the Backups page to see the same problem. The backup may be damaged or incomplete.

### Clean-up did not finish

DockNest retries clean-up after 5, 15 and 60 minutes. If it still fails, the test shows **Needs clean-up** and the test
server stays blocked for new tests. Your sites keep working.

1. Open the test in **Jobs** and select **Retry clean-up**.
2. If that fails, check the test server for containers and networks labelled `docknest.restore-test`.
3. When nothing is left, use **Acknowledge remote recovery** on the job. DockNest only accepts this when the server
   reports nothing left.

A safety timer on the test server removes leftovers if DockNest itself is down. It does not survive a reboot of the
test server. Test containers do not restart on their own, and the next DockNest check cleans up.

## Storage report

The Storage page shows **By site**, **By storage** and **Last 30 days** (growth). A line like
"Incremental backups could save about 60% (estimate)" shows what incremental backups might save.

This is a rough best case. DockNest reads package sizes only and cannot see inside encrypted backups. It treats only
growth as new data, so real savings can differ. Nothing here changes how your backups work today.
