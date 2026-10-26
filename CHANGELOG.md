# Changelog

## 0.1.1 — 26 October 2026

- Fix dashboard “Edit setup” so saved projects can change their local folder,
  including after the original folder has moved.
- Retain the existing project, saved credentials, and server destination when
  changing folders, and load environment settings from the replacement folder.
- Reject replacement folders already assigned to another project.

## 0.1.0 — 21 October 2026

First release of shared-hosting-sync, developed under the devsync name.

- Global `shared-hosting-sync` command with `devsync` as an alias.
- Terminal and local dashboard onboarding, project-folder environment discovery,
  encrypted saved credentials, and local/server folder selection.
- FTP, verified FTPS, and SFTP previews, deploy, changed-file sync, and watching.
- Content comparison, enforced secret/dependency exclusions, temporary-file
  uploads, progress, activity, and file-level errors.
- Shared local CLI/UI operation locks, bounded connection recovery, and watch retries.

Requires Node.js 24 or newer. Remote deletions, builds, dependency installation,
deployment history, and rollback are not included. See README.md for behavior.
