# Development phases

## Phase 1: Deployment foundation — implemented 21 October 2026

- Plan, sync, and watch pass the resolved destination to the uploader.
- `add` persists its optional destination argument.
- Missing destinations fail instead of implicitly uploading to `/`; explicitly
  configured `/` remains valid. Relative destinations, traversal, control
  characters, and local sources outside the selected folder are rejected.
- Same-size files require matching SHA-256 contents before they are skipped.
  Remote files are streamed for comparison, with no full-file buffering or
  remote shell requirement. This adds inbound network traffic.
- Directory creation and file inspection errors are surfaced. Failed syncs keep
  an error status and return a nonzero exit code; watch reports failed cycles.
- Project `.devsync.env` resolution follows the selected project rather than the
  launch directory. The file is always excluded from deployment.
- SFTP stat, directory creation, and deletion calls match the installed library.

Validation includes a real local FTP server and CLI subprocesses for destination
selection, previews, first upload, same-size edits, unchanged files, and failed
uploads. Uploader, watch, SFTP adapter, configuration, database, and secret tests
are also included in `npm test`. Real SFTP/FTPS server validation is still pending;
no production hosting account was used.

## Phase 2: Complete CLI — implemented 21 October 2026

- Bare `devsync` onboards unknown folders from `.env` and previews without upload.
- `setup [label]` fills missing/invalid details, hides password input, tests the
  connection, browses for an unspecified destination, saves, and previews.
- `setup --edit` revisits connection settings; `setup --browse` selects a new
  destination. The folder browser supports numbered directories, parent
  navigation, absolute paths, explicit current-folder selection, and cancellation.
- `deploy` uploads all eligible files; `sync` uploads changed content. Both support
  previews and operate on saved projects from any working directory.
- Shared resolution applies command overrides, project `.env`, legacy
  `.devsync.env`, saved settings, and defaults. Explicit files replace automatic
  discovery. Relative SFTP keys follow the selected project folder.
- Setup saves a shared snapshot atomically, encrypts credentials, ignores unrelated
  app values, and never rewrites `.env`. File values remain authoritative on later
  invocations. Failed or cancelled new setup leaves no project registration.
- Complete settings work noninteractively. Missing settings fail promptly with
  variable names. The environment example and command documentation are current.

Validation includes prompt/browsing tests, configuration precedence, atomic saved
settings, and real FTP CLI onboarding, previews, deploy/sync behavior, failed
authentication, saved credentials, and operation from another directory.

## Phase 3: UI onboarding — implemented 21 October 2026

- The dashboard guides users through local folder, hosting, destination, and
  review steps. Local browsing supports home, drives/roots, parent navigation,
  and manual absolute paths, independent of the launch directory.
- Selecting a source folder loads its `.env` and legacy `.devsync.env`; the UI
  ignores the launch environment's `DEVSYNC_ENV_FILE`. Missing settings are entered
  manually, and supplied secrets are represented only by presence flags.
- New projects remain temporary drafts until a successful connection test, valid
  existing destination, and final review/save. Cancellation, failed login, missing
  destinations, duplicate names, and invalid settings leave no new registration.
- The server folder picker uses unsaved hosting details. Changes to connection
  details invalidate the test. Save rechecks the destination without uploading
  or deleting remote files, then stores the shared encrypted configuration.
- Saved projects can be viewed, edited, connection-tested, removed locally, and
  used immediately through CLI commands. Configuration sources and file precedence
  are visible; application `.env` files remain untouched.
- The loopback service checks request hosts/origins and requires a session token
  for local browsing and draft APIs. Static assets are explicitly whitelisted.

Validation covers HTTP onboarding against a real local FTP server, directory
navigation, secret redaction, manual settings, cancellation, invalid/authentication
failures, CLI compatibility, draft expiry, and origin/host checks. The actual
browser flow was exercised for imported credentials, folder selection, review,
save, editing, manual entry, and cancellation.

## Phase 4: UI deployment — implemented 21 October 2026

- Saved projects offer changed/all-file previews, deploy, sync, and watch controls
  through the same configuration, exclusions, and uploader used by the CLI.
- Previews show destinations, unchanged files, and excluded entries without
  writing remote files. Request-level and saved dry-run settings prevent uploads.
- Background operations expose file progress, completion, failed files, last
  successful sync, and the latest 100 activity entries. Plan lists are capped at
  200 entries per category; counts remain complete.
- Watching performs an initial sync, then follows saves. Stopping drains the
  current batch and discards pending work; server shutdown also drains operations.
  Closing or refreshing a browser tab leaves the server-side operation running.
- Dashboard actions cannot overlap for one project, and active projects cannot
  be edited or removed there. Phase 5 extends this across CLI/UI processes.

Validation includes real FTP HTTP operations, read-only previews, same-size edits,
dry-run settings, watch readiness/stop behavior, shutdown, concurrent-action guards,
progress, and failed uploads. Browser checks cover deploy, unchanged sync, watching
across refresh, stopping, previews, failure display, and successful retry.

## Phase 5: Reliability and testing — implemented 21 October 2026

- SQLite operation locks coordinate CLI commands and multiple dashboards sharing
  the same local settings store. Watches retain ownership until stopped.
  Overlapping paths for the same protocol/host/port/account are guarded even when
  registered as different projects. Exited owners are reclaimed without expiring
  live transfers. Settings changes/removal also acquire project ownership.
- Transient connection failures receive two bounded reconnect attempts. Read
  operations can be retried; uploads restart the whole temporary-write/rename
  sequence, including when a rename acknowledgement is lost. Permanent login,
  permission, and certificate errors remain visible without repeated attempts.
- Active watchers schedule another cycle after transient failures without another
  save. Stop clears retry work and waits for an in-flight cycle. CLI notices and
  dashboard activity expose reconnect attempts and operation conflicts.
- CLI previews list custom and hard exclusions, matching the dashboard. Existing
  secret and dependency exclusions remain enforced in all upload paths.
- Real local FTPS and SFTP servers cover read-only preview, nested destinations,
  empty and multi-chunk files, same-size edits, unchanged files, exclusions, and
  failed uploads. FTPS now verifies certificates; tests explicitly trust a public
  localhost fixture and prove untrusted certificates are rejected.

Validation also covers dropped real FTP connections, safe replay after lost
rename responses, bounded retries, watcher recovery/stop, separate-process lock
conflicts, crashed owners, and dashboard/CLI coordination. Locks are local to one
machine/settings store and do not detect remote aliases or other deployment tools.
Production-host checks and cross-platform installation remain release work.

## Phase 6: npm release — 0.1.0 published 21 October 2026

- Package and primary command renamed to `shared-hosting-sync`; `devsync` remains
  an alias, with compatible settings and environment variables.
- Repository links, shared CLI/API version information, and Node.js >=24 runtime
  requirements are finalized. The executable reports a clear upgrade message on
  older runtimes before importing SQLite.
- The tarball allowlist contains runtime source, UI assets, migrations, the safe
  environment example, README, changelog, and license. Tests, TLS fixture keys,
  local state, and development scripts are excluded.
- `release:check` packs through the complete test gate, audits contents, installs
  into a disposable global prefix, and checks both aliases plus onboarding,
  real FTP deployment/sync, dashboard startup, assets, and version metadata.
- A Node.js 24 workflow runs release checks on Windows, Linux, and macOS. Generated
  tarballs, manifests, and SHA-256 checksums are saved as CI artifacts.
- Publication requires maintainer authentication, all platform checks, and
  registry acceptance. Registry installation confirms publication; see RELEASING.md
  for the verification steps.

Published [shared-hosting-sync@0.1.0](https://www.npmjs.com/package/shared-hosting-sync/v/0.1.0)
with `latest` pointing to 0.1.0. Windows, Linux, and macOS release checks passed.
The registry tarball matches the validated archive byte for byte (SHA-256
`e2301a79bc1aa64f28262b929c7b57c9447dfba6c82bc2c5b56b0b476f2c6a6e`).
A fresh registry installation verified both command aliases and SQLite startup.

After release: GitHub Actions integration, deployment history, rollback, and
optional remote deletion.
