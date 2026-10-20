# Mtime-aware sync — discussion

**Date:** 14 October 2026 · **Status:** design discussion

---

## The intuition, validated

You said: *we can query the local file and the server file side by side, and use the timestamp difference to know what's actually changed.*

That's exactly right, and it's the gap in v1. Today the `buildPlan` in `src/uploader.js` only checks **size**:

```js
if (remoteStat && remoteStat.size === localStat.size && !remoteStat.isDir) {
  skipped.push({ rel, bytes: localStat.size, reason: 'same size' })
  continue
}
```

This has a known false-negative: a file that was modified but happened to land at the same byte count (think: a config file with a version bump from `"1.0"` to `"1.0.0"`, or a code change that deleted as many bytes as it added). It also can't tell the difference between a file you touched and one you didn't.

Adding mtime to the comparison fixes both, *and* it's how rsync, Dropbox, Syncthing, and every serious file-sync tool work.

## The framing correction

> "have a sink between the local time zone machine and then the server local time machine"

Timezones aren't the actual problem. The actual problem is **clock skew** — the host's clock isn't synchronised with yours. NTP normally keeps the drift under a second, but shared-hosting servers are not always well-managed, and FTP servers often return local time without a timezone. Clock skew of 30 seconds to several minutes is not unusual.

**The standard fix is not to synchronise clocks. It's to compare in UTC and apply a tolerance window.**

```
always work in Unix epoch milliseconds (UTC)
mtime tolerance: |local_mtime - remote_mtime| ≤ DEVSYNC_MTIME_TOLERANCE_MS
default tolerance: 2 seconds (SFTP), 5 seconds (FTP)
```

A 2-second window absorbs:
- NTP-grade clock skew
- Second-precision mtime on FAT/some FTP servers (rounding error ≤ 1 s)
- Sub-second upload latency (the remote mtime is set when the server *finishes* writing, not when the local `put` started)

5 seconds for FTP is the right dial-up because FTP's `MDTM` command is second-precision and FTP servers more often have clock issues. Adjustable per project.

## The decision tree

For each eligible local file:

```
size differs from remote?         → upload
size matches, mtime within tol?   → skip
size matches, mtime missing?      → fall back to size-only; log once per host
size matches, mtime differs?      → upload
remote has it, local doesn't?     → leave it (one-way push, no mirror delete)
```

That middle row is the win. After an upload, if we set the remote mtime to the local mtime (next section), the next sync sees mtime within tolerance and skips — same as rsync.

## The two subtle issues

### 1. mtime preservation on upload

**SFTP** — `ssh2-sftp-client`'s `fastPut` does not preserve the local mtime. The remote file's mtime becomes "now" (when the upload finished). After a sync, the next run will see `local_mtime=1234` and `remote_mtime=5678` and treat every uploaded file as changed.

The fix is one extra call after each upload:

```js
// SFTP
const localMtimeMs = localStat.mtimeMs
await this.client.utimes(remotePath, localMtimeMs, localMtimeMs) // atime, mtime
```

`ssh2-sftp-client` exposes `.utimes(path, atime, mtime)`. SFTP is one of the few protocols where this is built into the wire protocol — it's reliable, atomic, and supported on every standard server.

**FTP** — there is no standard FTP command to set mtime. RFC 3659 defines `MFMT` (modify fact) but support is patchy. The pragmatic options:

| Option | Trade-off |
|---|---|
| `client.send('MFMT', `${mtimeYmd} ${remotePath}`)` — best-effort | Works on vsftpd, ProFTPD, FileZilla Server. Ignored elsewhere. |
| Skip mtime preservation, document the limitation | Always works, but mtime diff is unreliable on FTP |
| Switch to FTPS or SFTP | Out of scope for v1, but the v2 default is already SFTP |

**My pick:** try `MFMT`, ignore the failure, log a one-time warning per host. Document in the README that FTP hosts without `MFMT` support fall back to size-only and may re-upload unchanged files.

### 2. Clock skew detection

This is the quality-of-life feature. After every upload, we know both:

- `localMtimeMs` — what we asked the server to set
- `serverObservedMtimeMs` — what the server reports back on the next sync

If `serverObserved - localMtime` is consistently large (say, > 30 seconds across many files), the host's clock is skewed. We can't fix that, but we can warn:

```
⚠ Host sftp.example.com clock is 47s ahead of local time. Consider:
  - File a support ticket asking them to enable NTP
  - Increase DEVSYNC_MTIME_TOLERANCE_MS to 50000 for this project
```

`devsync doctor` should show this. Stored as a derived stat, not as a column on `projects` — it's recomputed from the events table.

## Transport interface change

One method added to the `Transport` interface:

```js
interface Transport {
  // ... existing methods ...

  /** Best-effort: set the remote mtime. May throw on FTP without MFMT. */
  utimes(remotePath, mtimeMs: number): Promise<void>
}
```

Implementation:
- **SFTP**: delegates to `ssh2-sftp-client.utimes(path, mtime, mtime)` — both atime and mtime
- **FTP**: sends `MFMT 20251014153022 /path/to/file` (the timestamp in `YYYYMMDDHHMMSS` format the spec wants)
- **No-op** for any transport that doesn't support it, with a warning logged

The transport must also expose mtime in `stat(remotePath)`:

```js
interface RemoteStat {
  size: number
  mtime: number | null  // epoch ms, or null if unknown
  isDir: boolean
}
```

Both `ssh2-sftp-client.stat` and `basic-ftp.lastMod` (via `send('MDTM', path)`) can produce this. The SFTP path is one call; the FTP path is two (`SIZE` then `MDTM`).

## The plan change

```js
// src/uploader.js — before
if (remoteStat && remoteStat.size === localStat.size && !remoteStat.isDir) {
  skipped.push({ rel, bytes: localStat.size, reason: 'same size' })
  continue
}

// after
const localMtime = localStat.mtimeMs
const remoteMtime = remoteStat?.mtime ?? null
const sizeMatches = remoteStat && remoteStat.size === localStat.size
const mtimeMatches = remoteMtime !== null &&
  Math.abs(remoteMtime - localMtime) <= toleranceMs

if (sizeMatches && mtimeMatches) {
  skipped.push({ rel, bytes: localStat.size, reason: 'unchanged' })
  continue
}
// ... upload
```

After the upload succeeds, `uploadOne()` calls `transport.utimes(remotePath, localStat.mtimeMs)` and falls back gracefully if the transport doesn't support it.

## Where the timezone & clock-sync code lives

A single small file: `src/sync/clock.js`

```js
export const TOLERANCE_DEFAULT_SFTP_MS = 2000
export const TOLERANCE_DEFAULT_FTP_MS  = 5000

export function isUnchanged(localStat, remoteStat, toleranceMs) {
  if (!remoteStat) return false
  if (remoteStat.size !== localStat.size) return false
  if (remoteStat.mtime == null) return null  // unknown — caller decides
  return Math.abs(remoteStat.mtime - localStat.mtimeMs) <= toleranceMs
}

export function detectSkew(uploadedPairs) {
  // uploadedPairs: [{ localMtime, remoteMtime }] — gathered from events
  if (uploadedPairs.length < 5) return null
  const skews = uploadedPairs.map(p => p.remoteMtime - p.localMtime)
  const median = medianOf(skews)
  if (Math.abs(median) > 30_000) return { medianSkewMs: median, samples: skews.length }
  return null
}
```

Pure functions, no I/O. Trivially testable.

## Tests to add

| Test | What it proves |
|---|---|
| `size differs → upload` | the original behaviour still works |
| `size matches, mtime within tolerance → skip` | the new fast path |
| `size matches, mtime differs by 0.5s → skip` | the tolerance is small but real |
| `size matches, mtime differs by 5s → upload` | the tolerance is a hard limit, not a hint |
| `size matches, mtime missing → fall back to size-only` | FTP and weird SFTP servers don't break sync |
| `after upload, remote mtime equals local mtime` (SFTP) | the mtime-preservation works |
| `after upload, MFMT failure is logged, not fatal` (FTP) | the transport is honest about its limits |
| `clock skew > 30s flagged in doctor` | the quality-of-life signal works |

These are added to `test/ignore.test.js`'s sister, `test/sync.test.js`, with the in-process SFTP/FTP server from Phase 1.

## Configuration

`ENV_SCHEMA` adds two keys:

```js
DEVSYNC_MTIME_TOLERANCE_MS: {
  type: 'int',
  default: 2000,           // SFTP
  min: 0,
  max: 60000,
  help: 'Treat local and remote mtimes as equal if within this many ms'
}
DEVSYNC_USE_MTIME: {
  type: 'bool',
  default: true,
  help: 'Compare mtime (in addition to size) before uploading. Disable on hosts with broken mtime.'
}
```

The default is on. Disable is for the FTP-without-`MFMT` host where re-uploads are cheap and the false-positive (re-upload) is preferred over the false-negative (skip a touched file).

## Why not go all the way to content hashing

rsync's algorithm goes further: it breaks the file into blocks and only sends the changed blocks. For a 50 MB binary with a one-line change, rsync might send 4 KB instead of 50 MB.

**We're not doing that in v2.** Reasons:

- rsync's algorithm needs server-side support (the `rsync` binary, or a compatible SFTP extension)
- Both our transports are blocking, request-response — no streaming block verification
- The mtime + size change is the dominant 80/20 — it gets you out of the "I touched a file and re-uploaded the whole 50 MB" trap
- The block-level diff can come later if profiling shows it's needed

The `stat → upload` step now produces, for each file, a 4-tuple: `{ size, mtime, sizeChanged, mtimeChanged }`. We can persist these and use them later for a smarter diff without changing the wire protocol.

## What I would not do

- **Don't add a hash of the content to the events table.** It bloats the DB and the false-negative rate is already small after the mtime change.
- **Don't auto-adjust the tolerance based on observed skew.** A misconfigured host is the user's problem to fix. We warn, they act.
- **Don't add a "verify" mode that downloads the file and hashes it.** That's `rsync -c` and it doubles every transfer. Out of scope.

## What ships in which phase

| Phase | Mtime work |
|---|---|
| **Phase 1** (v1 hardening) | Replace the size-only check with size + mtime + tolerance. Add `MFMT` best-effort. SFTP must call `utimes` after upload. Tests in `test/sync.test.js`. |
| **Phase 3** (v2 core) | `src/sync/clock.js`. New `DEVSYNC_MTIME_TOLERANCE_MS` and `DEVSYNC_USE_MTIME` env keys. Events table starts recording both mtimes. |
| **Phase 4** (v2 server) | `/api/projects/:id/doctor` returns the skew warning. |
| **Phase 5** (v2 UI) | Status panel shows "host clock is 47s ahead" if skew is detected. |
| **Phase 7** (v3 deferred) | Content-hash diff if profiling justifies it. |

## The single-sentence summary

> *Compare mtime, not just size, with a UTC tolerance window that absorbs clock skew and resolution rounding; preserve the local mtime on upload via SFTP `utimes` and FTP `MFMT` best-effort; the timezone never enters the comparison.*

That's the rule. The implementation is small.