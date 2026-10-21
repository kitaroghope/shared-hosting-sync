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

## Phase 2: Complete CLI — next

Read `.env`, prompt for missing settings, test connections, browse/select server
destinations, and provide `deploy` without requiring the UI.

## Phase 3: UI onboarding — planned

Launch anywhere, select a local folder, load its settings, fill missing hosting
details, and browse/select the server destination.

## Phase 4: UI deployment — planned

Preview, deploy, sync, start/stop watching, progress, and actionable errors using
the same deployment operations as the CLI.

## Phase 5: Reliability and testing — planned

Connection recovery, overlapping-upload prevention, exclusion workflows, and
realistic FTP/FTPS/SFTP end-to-end checks.

## Phase 6: npm release — planned

Finalize metadata, documentation, Node requirements, cross-platform global
installation checks, and publish the first usable release.

After release: GitHub Actions integration, deployment history, rollback, and
optional remote deletion.
