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
  be edited or removed there. Cross-process CLI coordination remains Phase 5.

Validation includes real FTP HTTP operations, read-only previews, same-size edits,
dry-run settings, watch readiness/stop behavior, shutdown, concurrent-action guards,
progress, and failed uploads. Browser checks cover deploy, unchanged sync, watching
across refresh, stopping, previews, failure display, and successful retry.

## Phase 5: Reliability and testing — next

Connection recovery, overlapping-upload prevention, exclusion workflows, and
realistic FTP/FTPS/SFTP end-to-end checks.

## Phase 6: npm release — planned

Finalize metadata, documentation, Node requirements, cross-platform global
installation checks, and publish the first usable release.

After release: GitHub Actions integration, deployment history, rollback, and
optional remote deletion.
