import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HermesConfigCorruptError,
  readJsonWithBackup,
  writeJsonAtomic,
} from './hermes-atomic-json-store'

interface Fixture {
  version: number
  values: string[]
}

const decode = (value: unknown): Fixture => {
  if (!value || typeof value !== 'object') throw new Error('invalid fixture')
  const item = value as { version?: unknown; values?: unknown }
  if (typeof item.version !== 'number' || !Array.isArray(item.values)) throw new Error('invalid fixture')
  return { version: item.version, values: item.values.filter((entry): entry is string => typeof entry === 'string') }
}

describe('Hermes atomic JSON store', () => {
  test('Given 已有配置 When 原子写入 Then 更新主文件并保留 backup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proma-hermes-json-'))
    const file = join(dir, 'config.json')
    try {
      writeFileSync(file, JSON.stringify({ version: 1, values: ['old'] }), 'utf8')
      writeJsonAtomic(file, { version: 2, values: ['new'] })
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 2, values: ['new'] })
      expect(JSON.parse(readFileSync(`${file}.bak`, 'utf8'))).toEqual({ version: 1, values: ['old'] })
      expect(existsSync(`${file}.tmp`)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('Given 主文件损坏且 backup 正常 When 读取 Then 从 backup 恢复', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proma-hermes-json-'))
    const file = join(dir, 'config.json')
    try {
      writeFileSync(file, '{broken', 'utf8')
      writeFileSync(`${file}.bak`, JSON.stringify({ version: 1, values: ['safe'] }), 'utf8')
      expect(readJsonWithBackup(file, decode)).toEqual({ version: 1, values: ['safe'] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('Given 主文件与 backup 都损坏 When 读取 Then fail closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proma-hermes-json-'))
    const file = join(dir, 'config.json')
    try {
      writeFileSync(file, '{broken', 'utf8')
      writeFileSync(`${file}.bak`, '{also broken', 'utf8')
      expect(() => readJsonWithBackup(file, decode)).toThrow(HermesConfigCorruptError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
