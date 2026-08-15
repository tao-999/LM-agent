import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = process.cwd()

test('About 弹窗从 Electron 读取真实应用版本，禁止硬编码版本号', () => {
  const main = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')
  const app = fs.readFileSync(path.join(root, 'src/renderer/src/App.tsx'), 'utf8')

  assert.match(main, /ipcMain\.handle\('app:getVersion', \(\) => app\.getVersion\(\)\)/)
  assert.match(preload, /getVersion: \(\) => ipcRenderer\.invoke\('app:getVersion'\)/)
  assert.match(app, /window\.localAgent\.app\.getVersion\(\)/)
  assert.match(app, /<dd>\{appVersion \|\| '读取中…'\}<\/dd>/)
  assert.doesNotMatch(app, /<dt>版本<\/dt><dd>\d+\.\d+\.\d+<\/dd>/)
})
