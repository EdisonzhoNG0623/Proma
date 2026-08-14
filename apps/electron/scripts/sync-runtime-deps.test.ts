import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { EXTERNAL_RUNTIME_PACKAGES, syncRuntimeDeps } from './sync-runtime-deps'

function writeFixturePackage(
  nodeModulesDir: string,
  name: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): void {
  const packageDir = join(nodeModulesDir, name)
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }))
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(packageDir, relativePath)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, content)
  }
}

test('Given Hermes SSH external runtime When syncing dependencies Then native SSH closure is copied', () => {
  const root = mkdtempSync(join(tmpdir(), 'proma-runtime-deps-'))
  const sourceNodeModules = join(root, 'source', 'node_modules')
  const targetNodeModules = join(root, 'target', 'node_modules')

  try {
    writeFixturePackage(
      sourceNodeModules,
      'ssh2',
      { optionalDependencies: { 'cpu-features': '0.0.10' } },
      { 'lib/protocol/crypto/build/Release/sshcrypto.node': 'ssh-native' },
    )
    writeFixturePackage(
      sourceNodeModules,
      'cpu-features',
      {},
      { 'build/Release/cpufeatures.node': 'cpu-native' },
    )

    const result = syncRuntimeDeps({
      sourceNodeModules,
      targetNodeModules,
      externalRuntimePackages: ['ssh2'],
    })

    expect(EXTERNAL_RUNTIME_PACKAGES).toContain('ssh2')
    expect(result.copiedPackageCount).toBe(2)
    expect(existsSync(join(targetNodeModules, 'ssh2', 'lib/protocol/crypto/build/Release/sshcrypto.node'))).toBe(true)
    expect(existsSync(join(targetNodeModules, 'cpu-features', 'build/Release/cpufeatures.node'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
