# Release shared-hosting-sync

The GitHub repository remains `kitaroghope/devsync`. The npm package and primary
command are `shared-hosting-sync`; `devsync` is an equivalent command alias.
Keep existing `DEVSYNC_*` variables and the settings directory compatible.
Machines with the old global `devsync` development package should first run
`npm uninstall -g devsync`, then install the new tarball/package. This avoids
conflicting command shims and preserves the external settings directory.

## Prepare and validate

Use Node.js 24 or newer. Update package.json, package-lock.json, and CHANGELOG.md
for each version. Then run:

```sh
npm ci
npm run release:check
npm audit --omit=dev
```

The check runs the full test suite while packing, audits package contents, and
tests an isolated global installation with production dependencies. Both command
aliases, SQLite storage, environment onboarding, real FTP deploy/sync, dashboard
startup, API identity, and UI assets must pass. Nothing is installed into the
developer's usual global prefix. Generated files are under `artifacts/`:

- `shared-hosting-sync-0.1.0.tgz` (version follows package.json)
- `release.json`, including the complete package file list
- `SHA256SUMS`

The GitHub Release checks workflow runs this on Windows, Linux, and macOS with
Node.js 24 and uploads each platform's candidate as an artifact. Require all
three jobs to succeed before publication. A local Windows pass alone is not
evidence of Linux/macOS compatibility.

No tests, test TLS keys, fixtures, scripts, Git metadata, or runtime settings
belong in the npm package. `prepack` also enforces tests for ordinary `npm pack`
and source-directory publication. Avoid bypassing lifecycle checks when building.

## Authenticate and publish the checked tarball

```sh
npm login
npm whoami
npm view shared-hosting-sync name version
```

The registry returned no published record for `shared-hosting-sync` on 21 October
2026. A 404 does not reserve the name or guarantee publication rights. Confirm
the signed-in account is the intended maintainer. Use npm's browser sign-in and
complete any account/2FA requirements personally; do not put tokens into source
files or chat.

Once the account, version, passing CI, package manifest, and checksum are reviewed,
publish the exact checked archive:

```sh
npm publish ./artifacts/shared-hosting-sync-0.1.0.tgz --access public
```

The npm package is public even while the GitHub repository is private. Publishing
an existing tarball does not rebuild it or rerun the source lifecycle scripts;
the release check must have passed for this archive beforehand. Never replace a
published version; fix issues in a new version.

## Verify publication

```sh
npm view shared-hosting-sync@0.1.0 name version dist.integrity
npm install -g shared-hosting-sync@0.1.0
shared-hosting-sync --version
devsync --version
shared-hosting-sync ui
```

Confirm the registry version matches and the installed dashboard opens. Record
the release commit, archive checksum, and registry integrity. Only then mark
Phase 6 published and create the corresponding Git tag/release. Provider-specific
hosting validation remains necessary; tests use local protocol servers.
