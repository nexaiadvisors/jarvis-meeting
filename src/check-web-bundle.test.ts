import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isBundleStale } from '../scripts/check-web-bundle.mjs'

// isBundleStale() decides whether public/agent-frame.js or public/panel.js needs a
// rebuild by comparing their mtimes against the newest file under web/agent-frame/,
// web/panel/ and src/.
// These fixtures build a throwaway root so the assertions never depend on the
// real repo tree's mtimes (which drift with every edit).

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'check-web-bundle-'))
  mkdirSync(join(root, 'web', 'agent-frame'), { recursive: true })
  mkdirSync(join(root, 'web', 'panel'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'public'), { recursive: true })
  writeFileSync(join(root, 'web', 'agent-frame', 'main.tsx'), '// fixture\n')
  writeFileSync(join(root, 'web', 'panel', 'main.tsx'), '// fixture\n')
  writeFileSync(join(root, 'src', 'index.ts'), '// fixture\n')
  return root
}

function setMtime(path: string, ms: number): void {
  const seconds = ms / 1000
  utimesSync(path, seconds, seconds)
}

describe('isBundleStale', () => {
  it('reports stale when the bundle is missing', () => {
    const root = makeRoot()

    const result = isBundleStale(root)

    expect(result.stale).toBe(true)
    expect(result.reason).toMatch(/missing/)
  })

  it('reports stale when the bundle is older than a source file', () => {
    const root = makeRoot()
    const bundlePath = join(root, 'public', 'agent-frame.js')
    writeFileSync(bundlePath, '// old bundle\n')
    setMtime(bundlePath, Date.now() - 60_000)
    setMtime(join(root, 'web', 'agent-frame', 'main.tsx'), Date.now())

    const result = isBundleStale(root)

    expect(result.stale).toBe(true)
    expect(result.reason).toMatch(/older than/)
  })

  it('reports fresh when every bundle is newer than all source files', () => {
    const root = makeRoot()
    for (const source of [['web', 'agent-frame', 'main.tsx'], ['web', 'panel', 'main.tsx'], ['src', 'index.ts']]) {
      setMtime(join(root, ...source), Date.now() - 60_000)
    }
    mkdirSync(join(root, 'public', 'artifact'), { recursive: true })
    for (const bundle of ['agent-frame.js', 'panel.js', join('artifact', 'main.js'), 'meeting-page.js']) {
      const bundlePath = join(root, 'public', bundle)
      writeFileSync(bundlePath, '// fresh bundle\n')
      setMtime(bundlePath, Date.now())
    }

    const result = isBundleStale(root)

    expect(result.stale).toBe(false)
  })

  it('reports stale when only the artifact page bundle is missing', () => {
    const root = makeRoot()
    setMtime(join(root, 'src', 'index.ts'), Date.now() - 60_000)
    for (const bundle of ['agent-frame.js', 'panel.js', 'meeting-page.js']) {
      writeFileSync(join(root, 'public', bundle), '// fresh bundle\n')
    }

    const result = isBundleStale(root)

    expect(result.stale).toBe(true)
    expect(result.reason).toMatch(/artifact/)
  })

  it('reports stale when only the panel bundle is missing', () => {
    const root = makeRoot()
    setMtime(join(root, 'web', 'agent-frame', 'main.tsx'), Date.now() - 60_000)
    setMtime(join(root, 'web', 'panel', 'main.tsx'), Date.now() - 60_000)
    setMtime(join(root, 'src', 'index.ts'), Date.now() - 60_000)
    const agentFrame = join(root, 'public', 'agent-frame.js')
    writeFileSync(agentFrame, '// fresh bundle\n')
    setMtime(agentFrame, Date.now())

    const result = isBundleStale(root)

    expect(result.stale).toBe(true)
    expect(result.reason).toMatch(/panel\.js is missing/)
  })

  it('reports stale when the panel source is newer than the panel bundle', () => {
    const root = makeRoot()
    setMtime(join(root, 'web', 'agent-frame', 'main.tsx'), Date.now() - 60_000)
    setMtime(join(root, 'src', 'index.ts'), Date.now() - 60_000)
    for (const bundle of ['agent-frame.js', 'panel.js']) {
      const bundlePath = join(root, 'public', bundle)
      writeFileSync(bundlePath, '// bundle\n')
      setMtime(bundlePath, Date.now() - 30_000)
    }
    setMtime(join(root, 'web', 'panel', 'main.tsx'), Date.now())

    const result = isBundleStale(root)

    expect(result.stale).toBe(true)
    expect(result.reason).toMatch(/older than/)
  })
})
