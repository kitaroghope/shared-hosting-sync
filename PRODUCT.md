# devsync product requirements

devsync is a global npm package for deploying local projects to shared hosting.
The CLI and local browser UI are first-class alternative controls. Users must be
able to complete the workflow through either interface.

## Required in both interfaces

- Register, configure, list, and remove projects.
- Enter hosting credentials and choose FTP, FTPS, or SFTP.
- Select a local source folder and browse/select a remote destination.
- Test connections and preview uploads and exclusions.
- Deploy once, sync changed files, and start/stop continuous watching.
- View progress, completion, and actionable errors.

Both interfaces must share project settings, credential handling, ignore rules,
and deployment operations. A project created through one must work in the other.
CLI setup must not require the UI. Once `devsync ui` is launched, the UI workflow
must not require further terminal commands.

## Current gaps (21 October 2026)

As of 21 October 2026, the CLI supports `.env` onboarding, terminal-only credential
setup, destination browsing, preview, deploy, sync, and watch. The UI now supports
complete folder selection, `.env` discovery, hosting details, connection testing,
server browsing, review, and project saving, plus upload previews, deployment,
changed-file sync, watch start/stop, progress, and file errors. Both interfaces
support the core workflow. Connection recovery, cross-process coordination,
cross-protocol server validation, and release preparation remain pending.

## Setup paths

### Automatic setup from a project's .env

Running `devsync` in an unregistered project directory must detect documented
`DEVSYNC_*` keys in that directory's `.env`, use the current directory as the
local source, and ask only for missing required settings. With complete valid
settings, setup needs no repeated questions. Show an upload preview before the
first deployment; launching onboarding must not itself upload files.

Supported connection and destination variables:

```dotenv
DEVSYNC_TRANSPORT=ftps
DEVSYNC_HOST=ftp.example.com
DEVSYNC_PORT=21
DEVSYNC_USERNAME=hosting-user
DEVSYNC_PASSWORD="hosting-password"
# Optional during discovery: select this in onboarding if omitted.
DEVSYNC_REMOTE_PATH=/public_html/my-site
```

Only read recognized devsync keys; do not import unrelated application secrets.
Blank values count as missing. Derive an omitted port from the chosen protocol.
A missing remote destination must trigger a selection step rather than silently
targeting `/`. Supplied invalid values require correction rather than repeated
entry of valid settings. Document these variables and defaults in README.md when
the behavior ships.

For a saved project, resolve files relative to its local source folder rather
than whichever directory the user later launches devsync from. Explicit options
take precedence over project environment values, which take precedence over
saved settings and then defaults. Show configuration sources, mask passwords,
and keep `.env` excluded from deployment. Read configuration without rewriting
the application's `.env`.

### UI onboarding from any directory

`devsync ui` must launch the local dashboard regardless of the current directory.
The Add Project flow must let the user:

1. Browse and select a local project folder, with manual path entry available.
2. Load recognized settings from that selected folder's `.env`, when present.
3. Enter only missing hosting details and test the connection.
4. Browse the server and select the destination folder.
5. Save the project, preview uploads, and deploy or start watching.

The selected project folder determines configuration discovery; the directory
used to launch the dashboard must not supply credentials for a different project.
Users may also enter all hosting details manually without creating an `.env`.
Projects onboarded in the UI must immediately work through the CLI and vice versa.

The CLI setup path is implemented. Resolution reads `.env` and legacy `.devsync.env`
from the selected project folder; explicit files and command options are supported.
UI onboarding and deployment controls are implemented. See PHASES.md for
implementation milestones and remaining reliability work.
