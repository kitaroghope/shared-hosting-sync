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

## Current gaps (20 October 2026)

The CLI has deployment and watch commands, but credential setup directs users to
the UI. The UI configures projects, tests connections, and browses remote folders,
but does not yet expose deployment or watch controls. Full parity is required but
not yet implemented.

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

These setup paths are requirements. The current resolver reads `.devsync.env`
from the working directory and does not yet implement this `.env` onboarding.
