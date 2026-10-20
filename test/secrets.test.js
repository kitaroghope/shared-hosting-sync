// test/secrets.test.js — AES-256-GCM round-trip + wrong-key failure
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

if (!process.env.DEVSYNC_HOME) {
  process.env.DEVSYNC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-secrets-'))
}
if (!fs.existsSync(process.env.DEVSYNC_HOME)) fs.mkdirSync(process.env.DEVSYNC_HOME, { recursive: true })

const { encrypt, decrypt, loadMasterKey, masterKeyPath } = await import('../src/core/secrets.js')

test('round-trip preserves object identity for common shapes', () => {
  const obj = { DEVSYNC_PASSWORD: 'p4ssw0rd', DEVSYNC_HOST: 'h.example.com', n: 42 }
  const blob = encrypt(obj)
  assert.equal(typeof blob.ciphertext, 'string')
  assert.equal(typeof blob.iv, 'string')
  assert.equal(typeof blob.auth_tag, 'string')
  assert.deepEqual(decrypt(blob), obj)
})

test('different IVs produce different ciphertexts', () => {
  const obj = { DEVSYNC_PASSWORD: 'same' }
  const a = encrypt(obj)
  const b = encrypt(obj)
  assert.notEqual(a.iv, b.iv)
  assert.notEqual(a.ciphertext, b.ciphertext)
  assert.deepEqual(decrypt(a), obj)
  assert.deepEqual(decrypt(b), obj)
})

test('tampered ciphertext fails the GCM tag check', () => {
  const blob = encrypt({ DEVSYNC_PASSWORD: 'p' })
  // Flip a byte in the ciphertext
  const buf = Buffer.from(blob.ciphertext, 'base64')
  buf[0] = buf[0] ^ 0xff
  const tampered = { ...blob, ciphertext: buf.toString('base64') }
  assert.throws(() => decrypt(tampered), /auth|Unsupported|tag/i)
})

test('master key file is created with restricted mode', () => {
  const k = loadMasterKey()
  assert.equal(k.length, 32)
  assert.ok(fs.existsSync(masterKeyPath()))
  if (process.platform !== 'win32') {
    const st = fs.statSync(masterKeyPath())
    // mode 0o600 → only owner read+write
    assert.equal(st.mode & 0o777, 0o600)
  }
})

test('unicode survives round-trip', () => {
  const obj = { DEVSYNC_PASSWORD: 'pässwörd🔐' }
  const blob = encrypt(obj)
  assert.deepEqual(decrypt(blob), obj)
})