export type AgentWorkflowStage = 'understand' | 'tasks' | 'execute'
export type AgentToolRisk = 'read' | 'write' | 'create' | 'delete' | 'command'
export type AgentPermissionMode = 'read-only' | 'read-write-manual' | 'read-write-auto'

export function initialWorkflowStage(useWorkflow: boolean): AgentWorkflowStage {
  return useWorkflow ? 'understand' : 'execute'
}

export function toolAvailableInStage(
  stage: AgentWorkflowStage,
  toolName: string
): boolean {
  if (toolName === 'update_tasks') return true
  if (stage === 'understand') return false
  if (stage === 'tasks') return false
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

const destructiveCommandPatterns = [
  /(?:^|[;&|]\s*|\s)(?:rm|rmdir|rd|del|erase|unlink|shred|ri)(?:\s|$)/i,
  /\bremove-item\b/i,
  /\bgit\s+clean\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\b(?:fs\.(?:rm|rmdir|unlink)|os\.(?:remove|unlink)|shutil\.rmtree)\s*\(/i,
  /\.unlink\s*\(/i
]

export function commandContainsDestructiveOperation(command: string): boolean {
  return destructiveCommandPatterns.some((pattern) => pattern.test(command))
}

export function shouldRequestToolApproval(
  risk: AgentToolRisk,
  permissionMode: AgentPermissionMode,
  commandDeletes = false
): boolean {
  if (risk === 'read') return false
  if (risk === 'delete') return true
  if (risk === 'command') {
    return permissionMode === 'read-write-manual' || commandDeletes
  }
  return permissionMode === 'read-write-manual'
}
