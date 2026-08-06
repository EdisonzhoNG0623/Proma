/**
 * 验收辅助：启动本地 mock Hermes 服务器（临时，不进仓库）
 *
 * 供 Proma 设置页验收使用：
 * - Dashboard：http://127.0.0.1:<port>/
 * - 登录：admin / correct-password
 * - API Server Bearer：mock-api-key
 */
import { writeFileSync } from 'node:fs'
import { startMockHermesServer } from './apps/electron/src/main/lib/hermes/testing/hermes-mock-server'

const server = await startMockHermesServer()
const info = {
  dashboardUrl: `http://127.0.0.1:${server.port}/`,
  username: 'admin',
  password: 'correct-password',
  apiServerKey: 'mock-api-key',
  port: server.port,
}
writeFileSync('./hermes-mock-port.json', JSON.stringify(info, null, 2), 'utf-8')
console.log('[验收] mock Hermes 服务器已启动:')
console.log(`  Dashboard URL: ${info.dashboardUrl}`)
console.log(`  用户名/密码: ${info.username} / ${info.password}`)
console.log(`  API Server Key: ${info.apiServerKey}`)
console.log('  端口信息已写入 ./hermes-mock-port.json')

// 保持进程运行
process.on('SIGINT', async () => {
  await server.stop()
  process.exit(0)
})
setInterval(() => undefined, 1000)
