// ENV_SCHEMA — the single source of truth for every DEVSYNC_* variable.
// The CLI validator, the UI form, and the docs are all generated from this.
//
// Conventions:
//   - type: 'string' | 'int' | 'bool' | 'enum' | 'path' | 'secret'
//   - required: true|false
//   - default: literal value
//   - values:   array of allowed values (for enum)
//   - min/max:  range (for int)
//   - secret:   true|false — never logged, masked in UI
//   - help:     one-line explanation shown in the UI
//   - label:    human label shown in the UI
//
// Adding a new variable? Add it here, and the UI form picks it up.

export const ENV_SCHEMA = [
  {
    key: 'DEVSYNC_TRANSPORT',
    type: 'enum',
    values: ['sftp', 'ftp', 'ftps'],
    default: 'sftp',
    required: true,
    label: 'Protocol',
    help: 'sftp is encrypted and supports parallel transfers; ftps is encrypted FTP; ftp is plaintext (avoid)'
  },
  {
    key: 'DEVSYNC_HOST',
    type: 'string',
    required: true,
    label: 'Host',
    help: 'Hostname or IP. For Hostinger SFTP use the host shown in your panel.'
  },
  {
    key: 'DEVSYNC_PORT',
    type: 'int',
    defaultBy: 'transport', // 22 for sftp, 21 for ftp/ftps — see DEFAULTS_BY_TRANSPORT
    required: false,
    min: 1,
    max: 65535,
    label: 'Port',
    help: 'Leave blank to use the protocol default (22 for sftp, 21 for ftp/ftps).'
  },
  {
    key: 'DEVSYNC_USERNAME',
    type: 'string',
    required: true,
    label: 'Username',
    help: 'Your hosting account username.'
  },
  {
    key: 'DEVSYNC_PASSWORD',
    type: 'secret',
    required: true,
    label: 'Password',
    help: 'Or the passphrase for DEVSYNC_PRIVATE_KEY. Stored encrypted with AES-256-GCM.'
  },
  {
    key: 'DEVSYNC_PRIVATE_KEY',
    type: 'path',
    required: false,
    label: 'SSH private key (optional)',
    help: 'Path to an SSH key. SFTP only. Use instead of a password for stronger auth.'
  },
  {
    key: 'DEVSYNC_REMOTE_PATH',
    type: 'path',
    required: true,
    label: 'Remote path',
    help: 'The folder on the server you sync to. Use Browse in the UI to find it.'
  },
  {
    key: 'DEVSYNC_IGNORE_DELETES',
    type: 'bool',
    default: true,
    label: 'Never mirror deletes (one-way push)',
    help: 'Local deletes stay local. Recommended for shared hosting.'
  },
  {
    key: 'DEVSYNC_DRY_RUN',
    type: 'bool',
    default: false,
    label: 'Dry run',
    help: 'Plan and report without uploading.'
  },
  {
    key: 'DEVSYNC_DEBOUNCE_MS',
    type: 'int',
    default: 400,
    min: 100,
    max: 10000,
    label: 'Watcher debounce (ms)',
    help: 'How long to wait after a file change before uploading.'
  }
]

export const DEFAULTS_BY_TRANSPORT = {
  sftp: 22,
  ftp: 21,
  ftps: 21
}

const BY_KEY = new Map(ENV_SCHEMA.map((s) => [s.key, s]))

/** Get a schema entry by key. Throws if the key is unknown — that's a programmer error. */
export function get(key) {
  const s = BY_KEY.get(key)
  if (!s) throw new Error(`unknown envSchema key: ${key}`)
  return s
}

/** Build a default value map, applying transport-aware defaults. */
export function defaultsFor(transport) {
  const out = {}
  for (const s of ENV_SCHEMA) {
    if (s.default !== undefined) {
      out[s.key] = s.default
    } else if (s.defaultBy === 'transport' && s.key === 'DEVSYNC_PORT') {
      out[s.key] = DEFAULTS_BY_TRANSPORT[transport] ?? null
    }
  }
  return out
}

/** Validate a key/value against its schema entry. Returns { ok, message }. */
export function validate(key, value) {
  const s = BY_KEY.get(key)
  if (!s) {
    return { ok: false, message: `unknown key: ${key}` }
  }
  if ((value === '' || value == null) && s.required) {
    return { ok: false, message: `${key} is required` }
  }
  if (value === '' || value == null) {
    return { ok: true }
  }
  switch (s.type) {
    case 'int': {
      const n = Number(value)
      if (!Number.isInteger(n)) return { ok: false, message: `${key} must be an integer` }
      if (s.min != null && n < s.min) return { ok: false, message: `${key} must be >= ${s.min}` }
      if (s.max != null && n > s.max) return { ok: false, message: `${key} must be <= ${s.max}` }
      return { ok: true }
    }
    case 'bool':
      if (value === true || value === false) return { ok: true }
      if (value === 'true' || value === 'false' || value === '1' || value === '0') return { ok: true }
      return { ok: false, message: `${key} must be true or false` }
    case 'enum': {
      if (!s.values.includes(value)) {
        return { ok: false, message: `${key} must be one of: ${s.values.join(', ')}` }
      }
      return { ok: true }
    }
    case 'string':
    case 'path':
    case 'secret':
      return { ok: true }
  }
  return { ok: true }
}
