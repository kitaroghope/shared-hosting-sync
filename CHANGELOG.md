# Changelog

## 0.1.4 — 27 October 2026

- Use persistent per-file sync records for fast local size and timestamp checks.
  Unchanged syncs and previews no longer connect to the server.
- Add a confirmed, read-only Scan server / Initial sync action to seed matching
  files before the first sync, with baseline status and setup guidance.
- Share sync records across CLI, dashboard, and watch; record successful uploads
  individually, and keep failed uploads and in-flight edits pending for retry.

- Add a DevSync SVG logo to the dashboard header, About & Help, and browser tab.
- Show the running app version beside the logo in About & Help, loaded from package
  metadata on startup and refreshed whenever Help opens.

## 0.1.3 — 27 October 2026

- Add a styled console startup banner with app version and creator contact details,
  terminal-aware colors, and a compact layout for narrow terminals.
- Add a dedicated dashboard About & Help section with creator details, the running
  version, setup guidance, troubleshooting, and documentation links.
- Keep unfinished project setup intact while About & Help is open.

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
