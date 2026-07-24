export type AgentWorkflowStage = 'understand' | 'tasks' | 'execute'

export function toolAvailableInStage(
  stage: AgentWorkflowStage,
  toolName: string
): boolean {
  if (stage === 'understand') return false
  if (stage === 'tasks') return toolName === 'update_tasks'
  return true
}

export function workflowToolChoice(
  stage: AgentWorkflowStage,
  forceTool: boolean
): 'auto' | 'required' {
  if (stage === 'understand') return 'auto'
  if (stage === 'tasks') return 'required'
  return forceTool ? 'required' : 'auto'
}

