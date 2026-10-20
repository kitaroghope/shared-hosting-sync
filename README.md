# devsync

Deploy local projects to shared hosting through FTP, FTPS, or SFTP. Install once,
choose a local folder and a server destination, then deploy or keep files in sync.

Use the terminal or a local browser dashboard. Both interfaces are intended to
control the same projects, settings, and deployment operations.

> **Development status:** This README defines the agreed product experience.
> Automatic `.env` onboarding, complete CLI setup, and UI deployment controls are
> planned. See [Current implementation](#current-implementation) before using this
> checkout. Commands and examples marked **planned** are not available yet.

## Why devsync?

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

For development, install from this checkout:

```sh
npm install
npm link
devsync help
```

The intended installation after publication is:

```sh
npm install -g devsync
```

Use a Node.js version with built-in `node:sqlite` support. This checkout was
inspected with Node.js 25.9.0. The current package metadata still declares an
older minimum and needs updating before release.
You also need hosting credentials and access to the destination folder.

## Start from a project folder — planned

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

For a new project, devsync will:

1. Use the current directory as the local source folder.
2. Read recognized `DEVSYNC_*` values from its `.env`.
3. Ask only for missing required settings or corrections to invalid values.
4. Test the connection and let you browse for a missing server destination.
5. Save the project and show an upload preview.

Complete settings mean no repeated setup questions. Onboarding itself does not
upload files. Choose Deploy after reviewing the preview.

For a registered project, bare `devsync` previews its upload plan. Use an explicit
sync or deploy command to upload.

## Start from anywhere with the UI

```sh
devsync ui
```

The local dashboard opens at `http://127.0.0.1:5180/` by default. Keep the command
running while using it; press Ctrl+C to stop it.

The intended onboarding flow is:

1. Choose **Add project** and browse for a local project folder, or enter its path.
2. Load hosting settings from that folder's `.env`, if present.
3. Enter any missing FTP, FTPS, or SFTP details and test the connection.
4. Browse the server and select the destination folder.
5. Save, preview, and choose **Deploy**, **Sync**, or **Watch**.

You can enter all settings manually without creating an `.env`. The selected
project folder determines which `.env` is read, regardless of where you launched
the dashboard. A project saved in the UI must also work from the CLI.

**Currently:** The UI supports project registration, manual settings, connection
testing, and remote browsing. Local folder browsing, `.env` onboarding, upload
previews, deployment, and watch controls in the UI are planned.

## Environment variables — planned .env contract

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

The intended precedence is explicit command options, project `.env` values, saved
project settings, then defaults. Saved projects read configuration relative to
their source folder, even when operated from another directory. Passwords are
masked in the UI and logs; configuration sources should be visible.

## CLI controls

| Command | Purpose | Status |
| --- | --- | --- |
| `devsync` | Preview the current registered project; onboard an unknown folder | Preview available; onboarding planned |
| `devsync ui` | Open the local browser dashboard from any directory | Available |
| `devsync add <label> <localPath>` | Register a local source folder | Available; hosting setup currently uses the UI |
| `devsync projects` | List saved projects | Available |
| `devsync test [label]` | Test a project's hosting connection | Available |
| `devsync ls [label] [remotePath]` | List server files and folders | Available |
| `devsync plan [label]` | Preview uploads without writing to the server | Available |
| `devsync deploy [label]` | Upload eligible files for a deployment | Planned |
| `devsync sync [label]` | Upload files selected by change detection | Available; see current limitations below |
| `devsync watch [label]` | Upload eligible changes as you save | Available |
| `devsync remove <label>` | Remove local project registration | Available |
| `devsync doctor` | Check local setup | Available |
| `devsync help` | Show command help | Available |

Omit a project label to use the project registered for the current directory.
Use a label to operate on a saved project from elsewhere.

For the existing plan and sync commands, `--force` includes files even when their
sizes match. `sync --dry-run` previews without uploading. Watch also supports
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
- Settings and encrypted saved credentials live in `~/.devsync/`; set
  `DEVSYNC_HOME` to use another location.
- The UI runs locally and uses the same saved project store as the CLI.

Prefer FTPS or SFTP when your host supports them. Plain FTP sends credentials and
file contents without encryption.

## Current implementation

The package is in development. Before relying on it for deployments:

- `.env` discovery and missing-setting prompts described above are not implemented.
  The existing resolver reads `.devsync.env` from the launch directory or a file
  selected by `DEVSYNC_ENV_FILE`.
- CLI-only credential onboarding and the `deploy` command are planned.
- UI deployment and watch controls are planned.
- The CLI accepts an optional destination argument to `add` but currently does
  not save it. Destination settings are entered through the UI.
- The current CLI deployment path does not pass the saved destination into the
  uploader. This must be corrected before relying on a selected server folder.
- Sync currently compares file sizes. An edit that preserves size can be skipped;
  `--force` uploads it again. Stronger change detection is planned.
- The package's repository links still contain placeholders. Publication and the
  public npm package name must be verified before release.

See [PRODUCT.md](PRODUCT.md) for product requirements and [ROADMAP.md](ROADMAP.md)
for the existing implementation roadmap.

## Development

```sh
npm install
npm test
```

The default test command covers ignore rules, uploads, and FTP transport tests.
Additional suites live in `test/`.

## License

MIT. See [LICENSE](LICENSE).


