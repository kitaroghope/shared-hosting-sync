const VALUE_FLAGS = new Set(['transport', 'env-file', 'remote-path', 'host', 'username', 'port', 'label', 'path'])
const BOOL_FLAGS = new Set(['confirm', 'dry-run', 'force', 'plan', 'sync', 'edit', 'browse', 'browser', 'help', 'version'])

export function parseArgs(argv) {
  let command
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h') { flags.help = true; continue }
    if (arg === '-v') { flags.version = true; continue }
    if (!arg.startsWith('--')) {
      if (command === undefined) command = arg
      else positional.push(arg)
      continue
    }
    const index = arg.indexOf('=')
    const key = arg.slice(2, index === -1 ? undefined : index)
    let value = index === -1 ? undefined : arg.slice(index + 1)
    if (VALUE_FLAGS.has(key)) {
      if (value === undefined && argv[i + 1] && !argv[i + 1].startsWith('--')) value = argv[++i]
      if (value === undefined || value === '') throw new Error(`--${key} requires a value`)
    } else if (BOOL_FLAGS.has(key)) {
      if (value !== undefined && !['true', 'false'].includes(value)) throw new Error(`--${key} must be true or false`)
      value = value === undefined || value === 'true'
    } else throw new Error(`Unknown option --${key}`)
    flags[key] = value
  }
  return { command, positional, flags }
}
