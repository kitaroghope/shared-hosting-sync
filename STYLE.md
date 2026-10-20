# devsync — code style

> "Vibe coding with discipline." Not strict, but specific. When in doubt, the rule beats the exception.

---

## 1. Variables

| Kind | Convention | Example |
|---|---|---|
| Local | `camelCase` | `const fileSize = 1024` |
| Module-level constant | `UPPER_SNAKE_CASE` | `const HARD_BLOCKLIST = ['.env', '.pem']` |
| Boolean | `is` / `has` / `can` / `should` prefix | `const isWatching = true` |
| Loop counter | `i`, `j` only for `for(let i=0;…)`; otherwise named | `for (const index of items)` |
| Unused placeholder | `_` prefix | `items.filter((_) => true)` |
| Private to module | leading underscore only for *intentionally* private; not for all internals | `const _privateCache = new Map()` |
| Destructured | rename when shadowing | `const { size: fileSize } = stat` |
| Null | `null` only; never `undefined` for "absence" | `if (project === null) return` |
| Optional values | use `null`, document | `findUser(id) → User \| null` |

**Never:**
- `var` (use `const`; `let` only when reassigned)
- One-letter names outside of standard FP context
- `data`, `info`, `obj`, `temp` as variable names
- Hungarian notation
- Names that differ only by case (`user`, `User` in the same file)

---

## 2. Functions

| Kind | Convention |
|---|---|
| Named exports | `camelCase`, verb-led |
| Async | always `async` — never suffix `Async` |
| Boolean return | `is*` / `has*` / `can*` |
| Side-effecting | `do*` / `apply*` / `commit*` / `emit*` |
| Constructor / factory | `create*` or `make*`; never `new` an arbitrary class |
| Multiple args | prefer a single options object after 2 args |
| Default arg | required, not optional, when caller must pass |

```js
// good
export async function ensureDir(transport, remotePath) { … }
export function isBlocked(relPath) { … }
export function createMatcher(projectRoot, opts = {}) { … }

// bad
export async function ensureDirAsync(transport, remotePath) { … }
export function check(relPath) { … } // too vague
export function MakeMatcher(projectRoot, opts) { … } // capitalised but not a class
```

**Function bodies**:
- Aim for 5–30 lines
- One level of abstraction per function
- Return early — guard clauses at the top
- No `else` after `return` (drop the `else`)

```js
// good
function pickStrategy(probe) {
  if (!probe.shell) return 'parallel-files'
  if (probe.tools.tar) return 'tarball-shell'
  if (probe.tools.unzip) return 'zip-shell'
  return 'parallel-files'
}
```

---

## 3. Classes

| Aspect | Rule |
|---|---|
| Naming | `PascalCase`, one per file, file name matches |
| Constructors | never have side effects beyond assigning fields. Connections, I/O, watch starts — all in `start()` or first method call |
| Public methods | the *minimum* surface. Default to private |
| Methods on the class | use `this`, not module-level helpers, when the helper needs the class state |
| Inheritance | prefer composition. Inheritance only for clear is-a |
| Static methods | only for utilities that don't depend on instance state; otherwise it's a module function |

```js
// good
export class ProjectRunner {
  constructor(project, transport, logger) {
    this.project = project
    this.transport = transport
    this.logger = logger
    this.status = 'idle'
  }

  async start() {
    this.status = 'connecting'
    try {
      await this.transport.connect()
      this.status = 'watching'
    } catch (err) {
      this.status = 'error'
      throw new TransportError({ code: 'CONNECT_FAILED', cause: err })
    }
  }

  async stop() { … }
}
```

**Never:**
- `this` in module-level helpers
- Method on a class that's pure — make it a module function
- Calling `super` in a way that hides side effects
- "Manager" / "Handler" / "Helper" class suffixes that mean nothing

---

## 4. Objects

| Aspect | Rule |
|---|---|
| Shape | frozen where possible (`Object.freeze` for config, `as const` for static) |
| Updates | immutable — spread, never mutate in place |
| Field naming | `camelCase` for JS, `snake_case` only at the DB boundary |
| Optional fields | use `?` in JSDoc, not `\| undefined` everywhere |
| Big config | a single `config` object passed down, not 8 args |

```js
// good
const config = Object.freeze({
  transport: 'sftp',
  port: 22,
  host: 'sftp.example.com',
  concurrency: 4
})

// bad
const config = { transport: 'sftp', port: 22, … }
config.port = 21  // mutates; bugs downstream

// bad: too many positional args
function uploadFile(transport, project, item, dryRun, onProgress) { … }

// good
function uploadFile({ transport, project, item, dryRun = false, onProgress = noop }) { … }
```

---

## 5. Methods on the runner pattern

For the things that own state (ProjectManager, Runner, Transport):

- `start()` / `stop()` — the lifecycle. Idempotent.
- `status` — one of a small fixed set of strings, defined as a constant
- Errors thrown are domain errors (e.g. `TransportError`), never raw `Error`
- No `destroy()` — `stop()` is enough
- Don't expose internal collections; expose `list()` / `get(id)` instead

```js
const STATUS = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  WATCHING: 'watching',
  UPLOADING: 'uploading',
  ERROR: 'error',
  PAUSED: 'paused'
})
```

---

## 6. Error handling

- Throw, don't return null/sentinel
- Use a custom `DevsyncError` hierarchy; never `throw new Error('msg')`
- Chain with `cause`
- Catch only to add context, re-throw, or convert; never swallow

```js
// good
try {
  await transport.put(localPath, remotePath)
} catch (err) {
  throw new UploadError({ code: 'PUT_FAILED', file: relPath, cause: err })
}

// bad: swallow
try { await transport.put(localPath, remotePath) } catch {}

// bad: bare Error
throw new Error(`upload of ${relPath} failed: ${err.message}`)
```

Every error class:
- `code` — string constant, e.g. `'UPLOAD_FAILED'`
- `userMessage` — plain English, shown in UI
- `hint` — actionable suggestion
- `retryable` — boolean

Stack traces never reach the UI. They go to the log file with a correlation id.

---

## 7. Async

- Always return a `Promise` (i.e. always `async` if you `await` anywhere)
- `Promise.all` for parallel, `for…of` for serial — never `.forEach` for either
- Never `await` inside `.map` / `.forEach` (fire-and-forget bug). Use `for…of` if order matters, `Promise.all(arr.map(async …))` if not

```js
// good — parallel
const results = await Promise.all(projects.map(connectTo))

// good — serial
for (const project of projects) {
  await sync(project)
}

// bad — fire and forget
projects.forEach(async (p) => { await sync(p) })
```

---

## 8. Imports

- ESM only
- Group order, separated by blank line:
  1. Node built-ins (`node:fs`, `node:os`)
  2. External packages
  3. Internal modules (relative paths, alphabetical)

```js
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import chokidar from 'chokidar'
import ignore from 'ignore'

import { STATUS } from '../core/status.js'
import { loadConfig } from '../core/config.js'
```

**Never** CommonJS `require`, `__dirname`, `__filename`. Use `import.meta.url`.

---

## 9. Files

| Aspect | Rule |
|---|---|
| Naming | `kebab-case.js` |
| One class per file | the file name matches the class |
| `index.js` | re-exports only; no logic |
| Modules that are not classes | verb-led: `uploader.js`, `matcher.js` |
| Group by domain | `core/`, `transport/`, `project/`, `deploy/`, `server/`, `ui/` |
| Test files | mirror source: `uploader.js` → `uploader.test.js` |
| No `util.js` | if you need one, name it after what it does (`path-mapper.js`) |

---

## 10. Comments

- Why, not what
- No narrating (`// loop through items`)
- JSDoc on the public surface only
- No "I", "we", "this PR"
- TODOs reference an issue or a phase: `// TODO(phase-3): support per-host profiles`

```js
// good
// canonicalise so that 8.3 short names and long paths map to the same row
const real = await fs.promises.realpath(p)

// bad
// get the real path
const real = await fs.promises.realpath(p)
```

---

## 11. Logging

- Module-level `logger = createLogger('modulename')`
- One log call per *event*, not per line of code
- Levels: `debug` `info` `warn` `error`. Use them precisely
- Never `console.log` outside the CLI renderer
- Always include a correlation id for operations that span files

```js
// good
logger.info({ projectId, file: rel, bytes }, 'uploaded')

// bad
console.log('uploaded ' + rel + ' (' + bytes + ' bytes)')
```

---

## 12. Tests

| Aspect | Rule |
|---|---|
| File | `<source>.test.js` next to source |
| One assertion per test, generally | multiple are OK if they prove the same property |
| Name | "does X" / "rejects Y" / "falls back to Z" — describe behaviour, not implementation |
| Fixtures | in `test/fixtures/`, generated in a tempdir for unit tests |
| Network | only behind a feature flag or in tests that spin an in-process server |
| Speed | unit tests under 100 ms; integration under 5 s |

```js
// good
test('hard blocklist refuses .env even when .deployignore allows it', () => {
  const matcher = buildMatcher(fixture, { deployignore: '!.env' })
  expect(matcher.reason('.env')).toBe('blocklist')
})
```

---

## 13. What we are NOT doing

- No build step beyond Vite for the UI
- No transpilation
- No TypeScript in the backend (it pays its way in the UI; the CLI is JS)
- No Lerna, Nx, monorepo
- No `class-validator`, `joi`, `ajv` for env validation — a hand-written `ENV_SCHEMA` is the source of truth
- No class decorators
- No `Optional` / `Maybe` types
- No barrel files except `index.js`

---

## 14. When to break a rule

- When a third-party API forces a different shape — wrap it, don't propagate the shape
- When performance demands it (a hot path can deviate from the structural rules) — comment why
- When an existing file uses the old style — match the file, refactor the file, but never mix in the same line

The discipline: a code review should never get to "what does this mean?" — only to "is this the right thing?"