import fs from 'node:fs'

export const { name, version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
