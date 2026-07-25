export type WorkspaceExpandedPaths = Record<string, boolean>

export function normalizeWorkspaceTreePath(value: string): string {
  return value.replace(/\//g, '\\').replace(/\\+$/, '').toLocaleLowerCase()
}

export function isWorkspacePathExpanded(
  expandedPaths: WorkspaceExpandedPaths,
  path: string,
  defaultExpanded = false
): boolean {
  return expandedPaths[normalizeWorkspaceTreePath(path)] ?? defaultExpanded
}

export function updateWorkspacePathExpanded(
  expandedPaths: WorkspaceExpandedPaths,
  path: string,
  expanded: boolean
): WorkspaceExpandedPaths {
  return {
    ...expandedPaths,
    [normalizeWorkspaceTreePath(path)]: expanded
  }
}

export function remapWorkspaceExpandedPaths(
  expandedPaths: WorkspaceExpandedPaths,
  sourcePath: string,
  targetPath: string
): WorkspaceExpandedPaths {
  const source = normalizeWorkspaceTreePath(sourcePath)
  const target = normalizeWorkspaceTreePath(targetPath)
  return Object.fromEntries(
    Object.entries(expandedPaths).map(([path, expanded]) => [
      path === source || path.startsWith(`${source}\\`)
        ? `${target}${path.slice(source.length)}`
        : path,
      expanded
    ])
  )
}

export function removeWorkspaceExpandedPaths(
  expandedPaths: WorkspaceExpandedPaths,
  targetPath: string
): WorkspaceExpandedPaths {
  const target = normalizeWorkspaceTreePath(targetPath)
  return Object.fromEntries(
    Object.entries(expandedPaths).filter(
      ([path]) => path !== target && !path.startsWith(`${target}\\`)
    )
  )
}
