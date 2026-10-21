import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export function hashSink() {
  const hash = createHash('sha256')
  return {
    stream: new Writable({ write(chunk, encoding, callback) { hash.update(chunk); callback() } }),
    digest: () => hash.digest('hex')
  }
}

export async function hashFile(file) {
  const sink = hashSink()
  await pipeline(fs.createReadStream(file), sink.stream)
  return sink.digest()
}
