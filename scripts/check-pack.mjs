#!/usr/bin/env node
// Hard gate for `npm publish`: the tarball must NEVER contain the README's
// static assets (assets/*.gif/png/...). The repo keeps assets/ so GitHub can
// render them; README images point at GitHub raw URLs, so the npm page still
// renders without shipping the bytes. Runs in `prepublishOnly` and in CI.
import { execFileSync } from 'node:child_process'

let raw = ''
try {
  raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
} catch {
  raw = ''
}
// Strip non-JSON prefix if package manager wrapper prints messages (e.g. "prefer pnpm")
const jsonStart = raw.search(/[\[{]/)
const jsonStr = jsonStart >= 0 ? raw.slice(jsonStart) : ''
let parsed = null
if (jsonStr) {
  try {
    parsed = JSON.parse(jsonStr)
  } catch {}
}
if (!parsed) {
  // Fallback to pnpm pack if npm JSON parsing fails
  const pnpmOut = execFileSync('pnpm', ['pack', '--dry-run'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const lines = pnpmOut.split('\n').map((l) => l.trim()).filter(Boolean)
  const tarballFiles = []
  let inContents = false
  for (const line of lines) {
    if (line.includes('Tarball Contents')) { inContents = true; continue }
    if (line.includes('Tarball Details')) { inContents = false; break }
    if (inContents) tarballFiles.push(line)
  }
  parsed = [{ files: tarballFiles.map((path) => ({ path })) }]
}
let pack = Array.isArray(parsed) ? parsed[0] : parsed
if (pack && typeof pack === 'object' && !('files' in pack)) {
  pack = Object.values(pack).find((v) => v && Array.isArray(v.files)) ?? pack
}
const files = (pack.files ?? []).map((f) => f.path)
const offenders = files.filter(
  (p) => p.startsWith('assets/') || /\.(png|jpe?g|gif|webp|svg|mp4|mov|woff2?)$/i.test(p),
)
if (offenders.length) {
  console.error('[check-pack] npm tarball must not include README static assets. Offending files:')
  for (const p of offenders) console.error('  - ' + p)
  process.exit(1)
}
console.log('[check-pack] OK — tarball has no static assets (' + files.length + ' files)')
