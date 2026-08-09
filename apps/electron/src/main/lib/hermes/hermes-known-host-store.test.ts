import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HermesKnownHostStore } from './hermes-known-host-store'

function setup(now = 1_000): { store: HermesKnownHostStore; dir: string; advance(ms: number): void } {
  const dir = mkdtempSync(join(tmpdir(), 'proma-hermes-host-'))
  let clock = now
  return {
    store: new HermesKnownHostStore(join(dir, 'known-hosts.json'), { now: () => clock, challengeTtlMs: 500 }),
    dir,
    advance: (ms) => { clock += ms },
  }
}

describe('HermesKnownHostStore trust flow', () => {
  test('Given 首次 key When 检查 Then 返回 opaque challenge 与 SHA256 指纹并拒绝本次握手', () => {
    const { store, dir } = setup()
    try {
      const result = store.check('vps.example.com', 22, Buffer.from('key-a'))
      expect(result.status).toBe('unknown')
      expect(result.fingerprint).toStartWith('SHA256:')
      expect(result.challenge).toBeTruthy()
      expect(result.challenge).not.toContain('key-a')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('Given 用户按 challenge 确认 When 重连相同 key Then trusted', () => {
    const { store, dir } = setup()
    try {
      const first = store.check('vps.example.com', 22, Buffer.from('key-a'))
      store.confirm(first.challenge!)
      expect(store.check('vps.example.com', 22, Buffer.from('key-a')).status).toBe('trusted')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('Given 已信任 key 发生变化 When 检查 Then changed 且不给普通 challenge', () => {
    const { store, dir } = setup()
    try {
      const first = store.check('vps.example.com', 22, Buffer.from('key-a'))
      store.confirm(first.challenge!)
      const changed = store.check('vps.example.com', 22, Buffer.from('key-b'))
      expect(changed.status).toBe('changed')
      expect(changed.challenge).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('Given challenge 超时或 host 不匹配 When 确认 Then 拒绝', () => {
    const { store, dir, advance } = setup()
    try {
      const first = store.check('vps.example.com', 22, Buffer.from('key-a'))
      expect(() => store.confirm(first.challenge!, { host: 'other.example.com', port: 22 })).toThrow('不匹配')
      advance(501)
      expect(() => store.confirm(first.challenge!)).toThrow('过期')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
