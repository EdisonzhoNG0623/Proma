import { describe, expect, test } from 'bun:test'
import type { SFTPWrapper } from 'ssh2'
import type { HermesSshConnection } from './transport/hermes-ssh-connection'
import {
  HERMES_REMOTE_TEXT_MAX_BYTES,
  HermesRemoteSftp,
  assertContainedPosixPath,
  assertSafeProjectName,
  decodeUtf8Text,
} from './hermes-remote-sftp'

function createSftp(files: Record<string, Buffer> = {}): HermesRemoteSftp {
  const wrapper = {
    realpath(remotePath: string, callback: (error: Error | undefined, resolved: string) => void) {
      callback(undefined, remotePath === '~' ? '/home/deploy' : remotePath)
    },
    lstat(remotePath: string, callback: (error: Error | undefined, attrs: { size: number; mtime: number; mode: number }) => void) {
      const file = files[remotePath]
      callback(undefined, file
        ? { size: file.length, mtime: 1, mode: 0o100644 }
        : { size: 0, mtime: 1, mode: 0o040755 })
    },
    readFile(remotePath: string, callback: (error: Error | undefined, data: Buffer) => void) {
      callback(undefined, files[remotePath] ?? Buffer.alloc(0))
    },
    readdir(_remotePath: string, callback: (error: Error | undefined, list: unknown[]) => void) {
      callback(undefined, [
        { filename: 'safe.txt', attrs: { size: 2, mtime: 1, mode: 0o100644 } },
        { filename: 'link', attrs: { size: 0, mtime: 1, mode: 0o120777 } },
      ])
    },
    mkdir(_remotePath: string, callback: (error?: Error) => void) { callback() },
    end() {},
  } as unknown as SFTPWrapper
  const connection = { openSftp: async () => wrapper } as unknown as HermesSshConnection
  return new HermesRemoteSftp(connection)
}

describe('HermesRemoteSftp POSIX containment', () => {
  test('Given 子路径 When resolve Then 使用 POSIX 并保持 root 内', () => {
    expect(assertContainedPosixPath('/home/u/projects', 'demo/src')).toBe('/home/u/projects/demo/src')
    expect(assertContainedPosixPath('/home/u/projects', '/home/u/projects/a')).toBe('/home/u/projects/a')
  })

  test('Given traversal/相邻前缀 When resolve Then 拒绝', () => {
    expect(() => assertContainedPosixPath('/home/u/projects', '../secret')).toThrow('越出')
    expect(() => assertContainedPosixPath('/home/u/projects', '/home/u/projects-evil/x')).toThrow('越出')
  })

  test('Given project 名 When 校验 Then 只接受 sanitized 单层子目录', () => {
    expect(assertSafeProjectName('demo-1')).toBe('demo-1')
    expect(() => assertSafeProjectName('../escape')).toThrow('项目名')
    expect(() => assertSafeProjectName('a/b')).toThrow('项目名')
  })
})

describe('HermesRemoteSftp safe read/list', () => {
  test('Given UTF-8 文本 When read Then 返回文本', async () => {
    const sftp = createSftp({ '/home/deploy/projects/a.txt': Buffer.from('你好') })
    await sftp.connect()
    expect(await sftp.readFile('/home/deploy/projects', 'a.txt')).toBe('你好')
    sftp.close()
  })

  test('Given traversal When read Then 在 remote I/O 前拒绝', async () => {
    const sftp = createSftp()
    await sftp.connect()
    await expect(sftp.readFile('/home/deploy/projects', '../secret')).rejects.toThrow('越出')
    sftp.close()
  })

  test('Given 目录含 symlink When list Then 默认过滤 symlink', async () => {
    const sftp = createSftp()
    await sftp.connect()
    const entries = await sftp.listDir('/home/deploy/projects', '.')
    expect(entries.map((entry) => entry.name)).toEqual(['safe.txt'])
    sftp.close()
  })

  test('Given binary/invalid UTF-8 When decode Then 明确拒绝', () => {
    expect(() => decodeUtf8Text(Buffer.from([0, 1, 2]))).toThrow('二进制')
    expect(() => decodeUtf8Text(Buffer.from([0xff]))).toThrow('UTF-8')
    expect(HERMES_REMOTE_TEXT_MAX_BYTES).toBe(5 * 1024 * 1024)
  })

  test('Given 未连接 When 使用 Then 抛错', async () => {
    const sftp = new HermesRemoteSftp()
    await expect(sftp.listDir('/root', '.')).rejects.toThrow('未连接')
  })
})
