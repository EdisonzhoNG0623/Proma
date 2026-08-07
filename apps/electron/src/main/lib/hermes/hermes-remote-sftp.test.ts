/**
 * Hermes Remote SFTP BDD 测试
 *
 * 覆盖：增量上传判断（shouldUploadFile）、SFTP 连接参数映射。
 * （真实 SFTP 传输需真实 SSH 服务器，由端到端验收覆盖）
 */

import { describe, expect, test } from 'bun:test'
import { HermesRemoteSftp, shouldUploadFile, type HermesRemoteFileEntry } from './hermes-remote-sftp'

describe('shouldUploadFile 增量上传判断', () => {
  const local = { size: 100, mtimeMs: 1_700_000_000_000 }

  test('Given 远端不存在 When 判断 Then 需要上传', () => {
    expect(shouldUploadFile(null, local)).toBe(true)
  })

  test('Given 大小相同且 mtime 接近 When 判断 Then 跳过', () => {
    const remote: HermesRemoteFileEntry = {
      name: 'a.txt',
      path: '/a.txt',
      isDirectory: false,
      size: 100,
      mtimeMs: 1_700_000_000_500, // 差 500ms < 1s
    }
    expect(shouldUploadFile(remote, local)).toBe(false)
  })

  test('Given 大小不同 When 判断 Then 需要上传', () => {
    const remote: HermesRemoteFileEntry = {
      name: 'a.txt',
      path: '/a.txt',
      isDirectory: false,
      size: 200,
      mtimeMs: 1_700_000_000_000,
    }
    expect(shouldUploadFile(remote, local)).toBe(true)
  })

  test('Given mtime 差异大 When 判断 Then 需要上传', () => {
    const remote: HermesRemoteFileEntry = {
      name: 'a.txt',
      path: '/a.txt',
      isDirectory: false,
      size: 100,
      mtimeMs: 1_700_000_000_000 - 5_000, // 差 5s > 1s
    }
    expect(shouldUploadFile(remote, local)).toBe(true)
  })
})

describe('HermesRemoteSftp 构造', () => {
  test('Given 未连接 When 使用 Then 抛错', async () => {
    const sftp = new HermesRemoteSftp()
    expect(() => sftp.stat('/x')).toThrow('未连接')
  })

  test('Given 重复 close When 调用 Then 不抛错', () => {
    const sftp = new HermesRemoteSftp()
    sftp.close()
    sftp.close()
  })
})
