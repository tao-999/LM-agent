import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = process.cwd()

test('下拉浮层按选项内容自适应宽度，禁止继承窄触发器后竖排文字', () => {
  const component = fs.readFileSync(
    path.join(root, 'src/renderer/src/components/MacSelect.tsx'),
    'utf8'
  )
  const css = fs.readFileSync(path.join(root, 'src/renderer/src/macos.css'), 'utf8')

  assert.match(component, /menuRef\.current\?\.getBoundingClientRect\(\)\.width/)
  assert.match(component, /width: 'max-content'/)
  assert.match(component, /minWidth: position\.minWidth/)
  assert.match(component, /maxWidth: position\.maxWidth/)
  assert.match(css, /\.mac-select-group>button span \{ min-width:max-content;/)
})
