/**
 * bun test 预加载：mock electron（Windows bun 无法解析 electron 具名导出）。
 * 0.16.10 官方新增 conversation-manager → attachment-service → electron import 链，
 * 使 Hermes IPC 等测试在 Windows bun 下加载失败；此 preload 统一 mock electron。
 */
import { mock } from 'bun:test'

mock.module('electron', () => ({
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showMessageBox: async () => ({ response: 0 }),
  },
  BrowserWindow: class {},
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  webContents: { fromId: () => null },
  app: { getPath: () => '', quit: () => {} },
  shell: { openExternal: async () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plain: string) => Buffer.from(plain),
    decryptString: (buf: Buffer) => buf.toString('utf-8'),
  },
}))
