# shared-hosting-sync

Deploy local projects to shared hosting through FTP, FTPS, or SFTP. Install once,
choose a local folder and a server destination, then deploy or keep files in sync.

Use the terminal or a local browser dashboard. Both interfaces control the same
projects, settings, and deployment operations.

> **Release candidate:** Version 0.1.0 is being prepared for npm publication.
> CLI and UI onboarding, previews, deployment, sync, and watching are implemented.
> Registry installation becomes available after publication.

The package name is **shared-hosting-sync**. Run it as `shared-hosting-sync` or
use the shorter `devsync` alias shown in examples below. Both commands run the
same application. Existing `DEVSYNC_*` variables and `~/.devsync/` settings stay
compatible with development versions.

## Why shared-hosting-sync?

Many shared hosting accounts accept file uploads without offering a deployment
pipeline. devsync connects your development machine to that hosting account.
Your source can live in GitHub or any other repository; devsync deploys the files
on your machine without requiring Git or a deployment agent on the server.

- Install globally, outside the projects you deploy.
- Save multiple projects with separate hosting details and destinations.
- Preview uploads before changing server files.
- Deploy once, sync changed files, or watch local changes.
- Exclude local dependencies, secrets, and development files.

The host must support the application you upload. Static build output and PHP
files work with suitable shared hosting; server applications still need their
runtime supported by the hosting provider.

## Installation

Requires **Node.js 24 or newer** and npm. Hosting credentials and access to the
destination folder are also required.

After npm publication:

```sh
npm install -g shared-hosting-sync
shared-hosting-sync --version
shared-hosting-sync ui
```

To install a release tarball before publication:

```sh
npm install -g ./artifacts/shared-hosting-sync-0.1.0.tgz
```

For development, install from this checkout:

```sh
npm install
npm link
devsync help
```

The SQLite database is built into Node.js; a separate database server or SQLite
installation is not required. The dashboard stays on this computer.

If you installed or linked an earlier development version named `devsync`, remove
that global package before installing `shared-hosting-sync` to avoid a command
name conflict:

```sh
npm uninstall -g devsync
npm install -g ./artifacts/shared-hosting-sync-0.1.0.tgz
```

This replaces the old global installation. Saved projects and credentials remain
in `~/.devsync/` (or your configured `DEVSYNC_HOME`). After npm publication, use
`npm install -g shared-hosting-sync` in place of the tarball command.

## Start from a project folder

Define your hosting settings in the project's `.env`:

```dotenv
DEVSYNC_TRANSPORT=ftps
DEVSYNC_HOST=ftp.example.com
DEVSYNC_PORT=21
DEVSYNC_USERNAME=hosting-user
DEVSYNC_PASSWORD="hosting-password"
DEVSYNC_REMOTE_PATH=/public_html/my-site
```

Then run:

```sh
cd my-project
devsync
```

For a new project, devsync:

1. Use the current directory as the local source folder.
2. Read recognized `DEVSYNC_*` values from its `.env`.
3. Ask only for missing required settings or corrections to invalid values.
4. Test the connection and let you browse for a missing server destination.
5. Save the project and show an upload preview.

Complete settings mean no repeated setup questions. Onboarding itself does not
upload files. After reviewing the preview, upload with:

```sh
devsync deploy
```

The new project is named after its local folder. Use `devsync --label=my-site`
to choose a name during first-time onboarding. Duplicate names receive a numeric
suffix automatically.

For a registered project, bare `devsync` previews its upload plan. Use an explicit
sync or deploy command to upload.

### Configure entirely in the terminal

No `.env` is required. Run `devsync setup` in your project folder and enter the
missing details. Password input is hidden; during `--edit`, Enter keeps an existing
password or passphrase. The destination browser lists server
folders: enter a folder number to open it, `..` to go up, an absolute path to open
another folder, `.` to select the current folder, or `q` to cancel. Selecting `/`
requires explicitly choosing `.` at the account root.

```sh
devsync setup                       # configure this folder and preview
devsync add my-site ./dist           # register a different source folder
devsync setup my-site                # configure that saved project and preview
devsync setup my-site --edit         # revisit connection settings
devsync setup my-site --browse       # select a different server destination
devsync deploy my-site               # upload all eligible files
devsync sync my-site                 # upload only changed files
```

Setup tests the connection before saving. It stores a configuration snapshot and
encrypted credentials outside the project, without rewriting `.env`. Corrections
to invalid file values apply during that invocation; fix the file too, because
file values take precedence again on the next run.

Without an interactive terminal, supply every required setting through `.env`,
an explicit environment file, saved settings, or supported options. Incomplete
setup exits with the missing variable names instead of waiting for input.

## Start from anywhere with the UI

```sh
devsync ui
```

The local dashboard opens at `http://127.0.0.1:5180/` by default. Keep the command
running while using it; press Ctrl+C to stop it.

The onboarding flow is:

1. Choose **Add project** and browse for a local project folder, or enter its path.
2. Load hosting settings from that folder's `.env`, if present.
3. Enter any missing FTP, FTPS, or SFTP details and test the connection.
4. Browse the server and select the destination folder.
5. Review the source and destination, name the project, and choose **Save project**.

You can enter all settings manually without creating an `.env`. The selected
project folder determines which `.env` is read, regardless of where you launched
the dashboard. Saved projects are immediately available to CLI commands too.

The local picker starts at your home folder and offers parent navigation, drive
or filesystem roots, and a path field. The server picker uses the hosting details
you just entered, so there is no need to save an incomplete project to browse.
Select an existing server folder with **Use server folder**; `/` is selected only
when you explicitly choose the account root or supply it in `.env`.

Imported passwords are never returned to the browser. Their presence is shown
beside an empty password field; leave it blank to keep them or enter a replacement.
Connection testing and browsing use temporary server-side settings. A project is
saved only after the connection and destination are checked. Cancelled setups
create no project, and saving performs no upload or remote deletion.

Use **Edit setup** on a saved project to revisit its details. Settings loaded from
`.env` retain precedence on later runs; the dashboard warns when you edit one of
those settings. The file itself is never changed.

After saving, use **Preview uploads** to inspect changed files or all eligible
files, including their server destinations and exclusions. **Deploy all files**
uploads every eligible file; **Sync changes** uploads only changed content.
Enable **Preview only for deploy, sync and watch** to inspect without uploading.
A saved `DEVSYNC_DRY_RUN=true` setting keeps this option enabled and locked.

**Start watching** syncs current files first, then follows local saves.
**Stop watching** waits for the current batch to finish. Closing the browser tab
does not stop operations; stopping the `devsync ui` command drains uploads and
stops its watchers. Restart watching after changing `.env` or `.deployignore`,
because each watch session uses the settings and exclusions loaded at its start.

The dashboard shows file progress, failed files, the last successful sync, and
the latest 100 activity entries. File lists show up to 200 entries per category;
excluded directories represent their contents. Activity is held in memory rather
than a persistent deployment history. A project cannot be edited or run twice
at once. Shared locks also prevent competing CLI processes or other dashboards
from operating on that project or overlapping destinations for the same server
account. The dashboard explains when an operation must be stopped elsewhere.

## Environment variables

Only recognized devsync keys are read. Unrelated application variables are ignored.
Blank values count as missing. devsync does not rewrite your application's `.env`.

| Variable | Purpose | If omitted |
| --- | --- | --- |
| `DEVSYNC_TRANSPORT` | `ftp`, `ftps`, or `sftp` | Ask during setup; FTPS is recommended when supported |
| `DEVSYNC_HOST` | Hosting hostname or IP, without a URL scheme | Ask during setup |
| `DEVSYNC_PORT` | Connection port | `21` for FTP/FTPS; `22` for SFTP |
| `DEVSYNC_USERNAME` | Hosting account username | Ask during setup |
| `DEVSYNC_PASSWORD` | Hosting password | Ask unless valid SFTP key authentication is configured |
| `DEVSYNC_PRIVATE_KEY` | Optional local SSH private key path, SFTP only | Use password authentication |
| `DEVSYNC_REMOTE_PATH` | Destination folder visible to the hosting account | Browse/select during setup; never silently choose `/` |

Use the server folder as shown through your FTP account. For some accounts the
website folder is `/public_html`; others already start inside it. Browse to verify.

The precedence is explicit command options, project `.env`, legacy `.devsync.env`,
saved project settings, then defaults. Only nonblank recognized values override
lower-priority settings. Ports follow the protocol unless explicitly supplied.
Relative SFTP key paths are resolved from the selected project folder; `~/` is
also supported.

`--env-file <path>` selects a specific file instead of automatic discovery. It
overrides the file selected by `DEVSYNC_ENV_FILE`. Relative explicit-file paths
are resolved from the command's working directory. Files inside the project must
be named `.env`, `.env.*`, or `.devsync.env` so their credentials remain excluded;
files outside the project can use any name. See [.env.example](.env.example).

These explicit-file options apply to the CLI. UI onboarding always discovers
settings from the folder selected in the dashboard and ignores `DEVSYNC_ENV_FILE`
from the process that launched it.

Saved projects read automatic configuration relative to their source folder,
even when operated from another directory. Setup shows each setting's source and
masks passwords. Supplied invalid values require correction; unrelated app keys
are never imported into the saved configuration.

## CLI controls

| Command | Purpose | Status |
| --- | --- | --- |
| `devsync` | Onboard an unknown folder, or preview the current registered project | Available |
| `devsync setup [label]` | Fill missing hosting settings, test the connection, save and preview | Available |
| `devsync ui` | Open the local browser dashboard from any directory | Available |
| `devsync add <label> <localPath> [remotePath]` | Register a local source folder and optional destination | Available; run `setup` next |
| `devsync projects` | List saved projects | Available |
| `devsync test [label]` | Test a project's hosting connection | Available |
| `devsync ls [label] [remotePath]` | List server files and folders | Available |
| `devsync plan [label]` | Preview uploads without writing to the server | Available |
| `devsync deploy [label]` | Upload all eligible files, including unchanged ones | Available |
| `devsync sync [label]` | Upload files selected by content comparison | Available |
| `devsync watch [label]` | Upload eligible changes as you save | Available |
| `devsync remove <label>` | Remove local project registration | Available |
| `devsync doctor` | Check local setup | Available |
| `devsync help` | Show command help | Available |

Omit a project label to use the project registered for the current directory.
Use a label to operate on a saved project from elsewhere.

Value options accept both `--name=value` and `--name value` forms. Boolean options
use `--dry-run` or `--dry-run=false`. Connection/destination
overrides are `--transport`, `--host`, `--username`, `--port`, and `--remote-path`.
They apply to the current operation; setup saves the completed configuration.
Use `.env` or the hidden setup prompt for passwords rather than command arguments.
Run `devsync help` for all options.

For plan and sync commands, `--force` includes files even when their
contents match. `sync --dry-run` previews without uploading. Watch also supports
`--dry-run`. Watch observes subsequent changes; run a sync first for an initial
upload. Stop CLI watching with Ctrl+C.

## Choose what to deploy

For a frontend application, build locally and select its output folder, such as
`dist/` or `build/`, as the local source. devsync uploads files; it does not currently
run builds or install dependencies on the server.

For PHP applications, include the application files and required production
libraries, such as `vendor/`, where appropriate for your hosting layout.

**All `node_modules/` folders are currently excluded**, including production
packages. This is not selective removal of `devDependencies`. Applications that
need Node.js dependencies on the server require a suitable hosting and dependency
installation workflow.

### .deployignore

Registering or scanning a source folder creates `.deployignore` if it is missing.
It uses gitignore-style patterns:

```gitignore
# Development-only files
/test/
/coverage/
*.log

# Local output that should not be deployed
/backups/
/scratch/
```

`.gitignore` is not applied by default: files ignored by Git may still be needed
on the host. Deployment exclusions should describe the files your server needs.

The hard blocklist always wins over `.deployignore`, including negation rules:

```text
.env and .env.*
.devsync.env
*.pem, *.key, *.p12, *.pfx
id_rsa, id_rsa.pub, id_ed25519
.git/, .svn/, .hg/
node_modules/
```

A local `.env` can configure deployment without becoming part of the upload.
Provision any server-side application secrets separately.

## Deployment behavior and local storage

- Sync is a one-way push from the selected local folder to the server.
- Local deletions are not mirrored; existing server files remain in place.
- Uploads use a temporary file followed by a rename to reduce partial-file reads.
- Watch batches rapid changes before uploading.
- Temporary connection failures get two reconnect attempts, with short increasing
  delays. A retry restarts the entire temporary-file upload, including rename;
  it does not retry an uncertain rename by itself. Authentication, certificate,
  and permission failures require correction rather than automatic retries.
- An active watcher retries failed transient cycles after five seconds without
  requiring another save. Stop cancels queued retries and drains current work.
  If the initial connection never opens, correct the problem and start again.
- CLI and UI operations share SQLite locks under `DEVSYNC_HOME`. Watches retain
  their lock until stopped; locks from exited processes are reclaimed on the next
  operation. Separate projects with overlapping paths on the same protocol,
  hostname, port, and username are also blocked. This coordinates one machine and
  one settings store; different stores, machines, hostname aliases, and account
  aliases are not coordinated. Keep `DEVSYNC_HOME` on a local disk.
- Plan, sync, and watch use the resolved server destination. Missing destinations
  fail before connecting; `/` is allowed only when explicitly configured.
- Equal-size files are compared using streamed SHA-256 hashes of local and remote
  contents. This reads matching-size remote files over the connection, increasing
  download traffic during previews and syncs. `--force` bypasses content comparison.
- Upload failures remain visible in the saved project status and make one-time
  sync commands exit unsuccessfully. Directory and inspection errors are surfaced.
- Settings and encrypted saved credentials live in `~/.devsync/`; set
  `DEVSYNC_HOME` to use another location.
- The UI runs locally and uses the same saved project store as the CLI.

Prefer FTPS or SFTP when your host supports them. Plain FTP sends credentials and
file contents without encryption.
FTPS certificates must pass normal certificate verification. Self-signed or
expired hosting certificates need correction or an appropriately trusted CA;
devsync does not silently bypass verification.

## Current implementation

The package is in development. Before relying on it for deployments:

- CLI onboarding, `.env` discovery, hidden password prompts, server-folder
  selection, and `deploy` are implemented in Phase 2.
- Phase 4 adds UI upload previews, deploy/sync, watch start/stop, progress, and
  actionable file errors through the shared deployment engine.
- Phase 5 adds shared CLI/UI locks, transient connection recovery, watch retries,
  exclusion previews in the CLI, and real local FTPS/SFTP integration checks.
- Phase 3 adds complete UI onboarding, local/server folder pickers, secure
  imported settings, and reviewed project saving.
- Phase 1 fixes destination handling, same-size change detection, path validation,
  and failed-sync status. See [PHASES.md](PHASES.md) for the implementation milestones.
- Phase 6 prepares `shared-hosting-sync@0.1.0`, including production-only packaging,
  global installation checks, and Windows/Linux/macOS release checks in CI.
  Publication requires npm account authentication and final registry acceptance.

See [PRODUCT.md](PRODUCT.md) for product requirements and [ROADMAP.md](ROADMAP.md)
for historical design notes. PHASES.md tracks the current release sequence.

## Development

```sh
npm install
npm test
npm run release:check
```

The default test command covers ignore rules, uploads, CLI onboarding/deployments
against a local FTP server, password prompts, server browsing, SFTP adapter
contracts, UI onboarding and deployment APIs, watch cycles, configuration, the project database, and encrypted
credentials. Real local FTP, FTPS, and SFTP servers exercise nested uploads,
same-size edits, empty files, larger transfers, exclusions, and failures.
No production hosting account has been used; provider-specific checks remain
necessary before relying on a particular host.

`release:check` runs the suite through the package's prepack gate, checks the
tarball file list, installs it into a disposable global prefix, and exercises both
command names, onboarding, FTP deploy/sync, and dashboard assets from another
directory. It writes a tarball, manifest, and SHA-256 checksum to `artifacts/`.
Tests, fixtures, development scripts, local state, and credentials are excluded
from the published package. See [RELEASING.md](RELEASING.md) for the release process.

## License

MIT. See [LICENSE](LICENSE).


