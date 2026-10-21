import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'

/** Create prompts lazily so complete configuration also works without a TTY. */
export function createPrompter(input = process.stdin, output = process.stdout) {
  let rl
  let muted = false
  let closing
  const interactive = !!input.isTTY && !!output.isTTY
  const terminalOutput = new Writable({
    write(chunk, encoding, callback) {
      output.write(chunk, encoding, callback)
    }
  })
  // Decide visibility when readline enqueues output. Checking inside _write
  // drops an already queued prompt when the destination applies backpressure.
  const enqueue = terminalOutput.write.bind(terminalOutput)
  terminalOutput.write = (chunk, encoding, callback) => {
    if (!muted) return enqueue(chunk, encoding, callback)
    if (typeof encoding === 'function') encoding()
    else callback?.()
    return true
  }
  return {
    interactive,
    async ask({ key, label = key, secret = false, defaultValue }) {
      if (!interactive) throw new Error(`Missing or invalid ${key}. Set it in the project .env, or run devsync setup in an interactive terminal.`)
      rl ||= createInterface({ input, output: terminalOutput, terminal: true })
      const suffix = defaultValue !== undefined && !secret ? ` [${defaultValue}]` : ''
      try {
        const value = await new Promise((resolve, reject) => {
          const cancel = () => { cleanup(); reject(new Error('Setup cancelled')) }
          const cleanup = () => { rl.off('close', cancel); rl.off('SIGINT', interrupt) }
          const interrupt = () => { cancel(); rl.close() }
          rl.once('close', cancel)
          rl.once('SIGINT', interrupt)
          rl.question(`${label}${suffix}: `, (answer) => { cleanup(); resolve(answer) })
          muted = secret
        })
        return value === '' && defaultValue !== undefined ? String(defaultValue) : value
      } finally {
        muted = false
        if (secret) terminalOutput.write('\n')
      }
    },
    close() {
      if (!closing) {
        if (rl) rl.close()
        closing = new Promise((resolve) => terminalOutput.end(resolve))
      }
      return closing
    }
  }
}
