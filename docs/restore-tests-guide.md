# Automatic restore tests

A backup is only worth something if it comes back. An automatic restore test checks that for you. It restores the
latest verified backup of an app onto a test server, starts it, runs checks, records the result and removes
everything it created.

Restore tests left beta in 2.13.1: they pass DockNest's Linux Docker test on every release and were validated on real
production apps (see [acceptance.md](acceptance.md)). A pass shows the backup restores and the app starts in isolation;
it does not test every business workflow of your application. The design is in [restore-tests.md](restore-tests.md).

## What it does

1. Picks the newest backup of the app that is verified and not about to be deleted.
2. Copies it to your test server and restores it there, away from the live app.
3. Starts the containers and checks them.
4. Records the result and shows it on the app.
5. Removes the copy, its networks, its images and its files.

A test never touches your live containers. It runs on a server you choose, with its own names and no published
ports.

## Turn it on

Open **Apps & schedules**, find the app and select **Restore tests** on its row. Only administrators can change
the settings.

- **Auto tests.** The switch that turns scheduled tests on. It is off by default.
- **How often.** Daily, weekly (suggested) or monthly. A test starts about 30 minutes after the app's next backup.
- **Test server.** Choose where the copy runs.
- **Time limit, Memory and CPU.** Limits for each container, with presets or a custom value. Defaults: 30 minutes,
  1 GB, 1 CPU.
- **Health check path (optional).** A page to open inside the copy, under **Advanced settings**.

Select **Save** to keep the settings. **Run test** works for administrators and operators. You can start up to 6 manual tests
per app every 24 hours.

## Choose a test server

The test server gets a full copy of the app, including its passwords. Pick a server you trust as much as the live
one.

Use a different server when you can. Apps that need external storage cannot be tested, because a test cannot attach
it.

### Use the live server (optional)

You can choose the app's own server. Tick **Allow live server**. DockNest asks for your password and code again.

The risks:

- The test runs next to your live apps and uses memory and CPU while it runs.
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

## Test a backup copy (optional)

If the app keeps copies on other storage (an SFTP server or an S3 bucket, see
[backup copies](backup-copies.md)), **Test from** picks what the test restores:

- **Main storage** (the default) restores the main backup, as before.
- **Copy on <storage>** restores the newest backup that has a verified copy there, and reads every part of it from
  that storage only. If the copy, or a backup it builds on, is missing or damaged there, the test shows
  **Couldn't run** with the reason. It never uses the main backup instead, so a pass means the copy itself restores.

The test details show **Tested from** with the storage that was read.

## Limits

- One test per app and one per test server at a time.
- Backups go first. A test waits if a backup, restore, install or move is running there.
- The copy needs free space of three times the backup plus 1 GiB.
- Memory and CPU are capped per container. Disk is not capped. DockNest checks free space before the containers
  start and again after the checks.
- A test stops at its time limit and then cleans up.
- While a test copies and restores, other backups wait for the worker. A very large app can hold it for a while.

## Read the results

| Result | Meaning |
|---|---|
| Passed | The app started from this backup and passed its checks. |
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

Each backup shows its newest test result in the library, and each app shows its **Last test** result. A failed
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
- **No verified copy there.** The test reads a copy, and the copy (or a backup it builds on) is missing, not verified
  yet or damaged on that storage. Check the copy on the app's storage settings, or set **Test from** to Main storage.

### "Failed"

Restore the backup by hand from the Backups page to see the same problem. The backup may be damaged or incomplete.

### Clean-up did not finish

DockNest retries clean-up after 5, 15 and 60 minutes. If it still fails, the test shows **Needs clean-up** and the test
server stays blocked for new tests. Your apps keep working.

1. Open the test in **Jobs** and select **Retry clean-up**.
2. If that fails, check the test server for containers and networks labelled `docknest.restore-test`.
3. When nothing is left, use **Acknowledge remote recovery** on the job. DockNest only accepts this when the server
   reports nothing left.

A safety timer on the test server removes leftovers if DockNest itself is down. It does not survive a reboot of the
test server. Test containers do not restart on their own, and the next DockNest check cleans up.

## Storage report

The Storage page shows **By app**, **By storage** and **Last 30 days** (growth). A line like
"Incremental backups could save about 60% (estimate)" shows what incremental backups might save.

This is a rough best case. DockNest reads package sizes only and cannot see inside encrypted backups. It treats only
growth as new data, so real savings can differ. Nothing here changes how your backups work today.
