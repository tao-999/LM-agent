import assert from 'node:assert/strict'
import test from 'node:test'
import type { SkillDefinition } from '../src/shared/types.ts'
import {
  enabledSkills,
  selectedEnabledSkills
} from '../src/renderer/src/utils/skill-selection.ts'

const skills: SkillDefinition[] = [
  {
    id: 'writing',
    name: '写作',
    description: '',
    instructions: '保持文风',
    enabled: true
  },
  {
    id: 'coding',
    name: '代码',
    description: '',
    instructions: '检查类型',
    enabled: false
  }
]

test('输入框 Skill 列表只展示全局已启用项', () => {
  assert.deepEqual(enabledSkills(skills).map((skill) => skill.id), ['writing'])
})

test('会话曾选中的 Skill 被全局停用后不随请求发送', () => {
  assert.deepEqual(
    selectedEnabledSkills(skills, ['writing', 'coding']).map((skill) => skill.id),
    ['writing']
  )
})
