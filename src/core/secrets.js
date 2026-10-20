// secrets.js — AES-256-GCM secret vault.
//
// The master key is generated on first use and stored at
// ~/.devsync/master.key with mode 0600 (Unix). It is NEVER written to the
// DB, the tarball, or version control. Losing it means losing the
// encrypted secrets — that's documented honestly.
//
// This is obfuscation, not KMS. Anyone with read access to the master.key
// file can decrypt the secrets. The threat model is "casual snooping" +
// "laptop theft while the daemon isn't running", not "skilled attacker
// with our process address space".

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { HOME } from '../config.js'

const KEY_FILE = path.join(HOME, 'master.key')
const ALGO = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

function ensureHome() {
  if (!fs.existsSync(HOME)) fs.mkdirSync(HOME, { recursive: true })
  return HOME
}

/** Read or create the master key file. Mode 0600 on Unix. */
export function loadMasterKey() {
  ensureHome()
  if (fs.existsSync(KEY_FILE)) {
    return fs.readFileSync(KEY_FILE)
  }
  const key = crypto.randomBytes(32)
  fs.writeFileSync(KEY_FILE, key, { mode: 0o600 })
  // chmod to 0600 if it was created with looser perms (Windows ignores mode).
  try {
    fs.chmodSync(KEY_FILE, 0o600)
  } catch {
    // Windows: chmod is a no-op for some filesystems. Acceptable.
  }
  return key
}

/** Encrypt a JS object into the on-disk shape used by the secrets table. */
export function encrypt(plaintextObj) {
  const key = loadMasterKey()
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const json = JSON.stringify(plaintextObj)
  const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    auth_tag: tag.toString('base64')
  }
}

/** Decrypt a row from the secrets table back into a JS object. */
export function decrypt({ ciphertext, iv, auth_tag }) {
  const key = loadMasterKey()
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(auth_tag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final()
  ])
  return JSON.parse(plaintext.toString('utf8'))
}

/** Path to the master key file (for diagnostics / doctor). */
export function masterKeyPath() {
  return KEY_FILE
}