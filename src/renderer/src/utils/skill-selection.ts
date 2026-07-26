import type { SkillDefinition } from '../../../shared/types'

export function enabledSkills(skills: SkillDefinition[]): SkillDefinition[] {
  return skills.filter((skill) => skill.enabled)
}

export function selectedEnabledSkills(
  skills: SkillDefinition[],
  selectedSkillIds: string[] = []
): SkillDefinition[] {
  const selected = new Set(selectedSkillIds)
  return skills.filter((skill) => skill.enabled && selected.has(skill.id))
}
