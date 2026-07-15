import { useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  CopyPlus,
  ExternalLink,
  FileCode2,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  Image as ImageIcon,
  Pencil,
  RefreshCw,
  Trash2,
  X
} from 'lucide-react'
import type { FileNode } from '../../../shared/types'
import { useAppStore } from '../store'

type ContextMenuState = {
  x: number
  y: number
  node: FileNode
}

type CreateState = {
  parent: FileNode
  kind: 'file' | 'directory'
}

function iconForFile(name: string): React.JSX.Element {
  const extension = name.split('.').pop()?.toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(extension ?? '')) {
    return <ImageIcon size={15} />
  }
  if (
    ['ts', 'tsx', 'js', 'jsx', 'json', 'py', 'cs', 'go', 'rs', 'html', 'css', 'vue'].includes(
      extension ?? ''
    )
  ) {
    return <FileCode2 size={15} />
  }
  return <FileText size={15} />
}

function InlineRename({
  node,
  onCommit,
  onCancel
}: {
  node: FileNode
  onCommit: (value: string) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(node.name)

  return (
    <input
      className="tree-rename-input"
      autoFocus
      value={value}
      onFocus={(event) => {
        const dot = value.lastIndexOf('.')
        event.currentTarget.setSelectionRange(0, node.kind === 'file' && dot > 0 ? dot : value.length)
      }}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') void onCommit(value)
        if (event.key === 'Escape') onCancel()
      }}
      onBlur={() => {
        if (value.trim() && value !== node.name) void onCommit(value)
        else onCancel()
      }}
    />
  )
}

function ProjectTreeNode({
  node,
  depth,
  selectedPath,
  renamingPath,
  onOpenFile,
  onSelect,
  onContextMenu,
  onRename,
  onRenameCancel
}: {
  node: FileNode
  depth: number
  selectedPath: string
  renamingPath: string
  onOpenFile: (path: string, line?: number) => Promise<void>
  onSelect: (node: FileNode) => void
  onContextMenu: (event: React.MouseEvent<HTMLButtonElement>, node: FileNode) => void
  onRename: (node: FileNode, value: string) => Promise<void>
  onRenameCancel: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(depth < 1)
  const selected = selectedPath === node.path
  const renaming = renamingPath === node.path

  if (node.kind === 'directory') {
    return (
      <div className="tree-group">
        <button
          className={`tree-row directory ${selected ? 'selected' : ''}`}
          style={{ paddingLeft: 7 + depth * 12 }}
          onClick={() => {
            onSelect(node)
            setExpanded((value) => !value)
          }}
          onContextMenu={(event) => onContextMenu(event, node)}
          title={node.path}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
          {renaming ? (
            <InlineRename
              node={node}
              onCommit={(value) => onRename(node, value)}
              onCancel={onRenameCancel}
            />
          ) : (
            <span>{node.name}</span>
          )}
        </button>
        {expanded &&
          node.children?.map((child) => (
            <ProjectTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              renamingPath={renamingPath}
              onOpenFile={onOpenFile}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              onRename={onRename}
              onRenameCancel={onRenameCancel}
            />
          ))}
      </div>
    )
  }

  return (
    <button
      className={`tree-row file ${selected ? 'selected' : ''}`}
      style={{ paddingLeft: 22 + depth * 12 }}
      onClick={() => {
        onSelect(node)
        if (!renaming) void onOpenFile(node.path)
      }}
      onContextMenu={(event) => onContextMenu(event, node)}
      title={node.path}
    >
      {iconForFile(node.name)}
      {renaming ? (
        <InlineRename
          node={node}
          onCommit={(value) => onRename(node, value)}
          onCancel={onRenameCancel}
        />
      ) : (
        <span>{node.name}</span>
      )}
    </button>
  )
}

export function ProjectSidebar({
  onOpenFile
}: {
  onOpenFile: (path: string, line?: number) => Promise<void>
}): React.JSX.Element {
  const root = useAppStore((state) => state.workspaceRoot)
  const workspaceRoots = useAppStore((state) => state.workspaceRoots)
  const workspaceTrees = useAppStore((state) => state.workspaceTrees)
  const setWorkspace = useAppStore((state) => state.setWorkspace)
  const setFileTreeForRoot = useAppStore((state) => state.setFileTreeForRoot)
  const setActiveWorkspace = useAppStore((state) => state.setActiveWorkspace)
  const renameWorkspaceRoot = useAppStore((state) => state.renameWorkspaceRoot)
  const closeWorkspace = useAppStore((state) => state.closeWorkspace)
  const renameOpenPath = useAppStore((state) => state.renameOpenPath)
  const removeOpenPath = useAppStore((state) => state.removeOpenPath)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [selectedNode, setSelectedNode] = useState<FileNode | null>(null)
  const [renamingPath, setRenamingPath] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [creating, setCreating] = useState<CreateState | null>(null)
  const [createName, setCreateName] = useState('')

  const openWorkspace = async (): Promise<void> => {
    const result = await window.localAgent.workspace.open()
    if (result) {
      setWorkspace(result.root, result.tree)
      setSelectedNode(null)
    }
  }

  const findRoot = (targetPath: string): string =>
    [...workspaceRoots]
      .sort((left, right) => right.length - left.length)
      .find(
        (item) =>
          targetPath === item ||
          targetPath.startsWith(`${item}\\`) ||
          targetPath.startsWith(`${item}/`)
      ) ?? ''

  const refreshRoot = async (targetRoot: string): Promise<void> => {
    if (!targetRoot) return
    setLoading(true)
    setLoadError('')
    try {
      setFileTreeForRoot(targetRoot, await window.localAgent.workspace.tree(targetRoot))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  const renameNode = async (node: FileNode, value: string): Promise<void> => {
    const nodeRoot = findRoot(node.path)
    if (!nodeRoot || value.trim() === node.name) {
      setRenamingPath('')
      return
    }
    try {
      if (node.path === nodeRoot) {
        const renamed = await window.localAgent.workspace.rename(nodeRoot, value.trim())
        renameWorkspaceRoot(nodeRoot, renamed.root, renamed.tree)
        setSelectedNode({
          ...node,
          name: renamed.root.split(/[\\/]/).pop() || value.trim(),
          path: renamed.root,
          children: renamed.tree
        })
        return
      }
      const nextPath = await window.localAgent.files.rename(nodeRoot, node.path, value.trim())
      renameOpenPath(node.path, nextPath)
      setSelectedNode({ ...node, name: value.trim(), path: nextPath })
      await refreshRoot(nodeRoot)
    } finally {
      setRenamingPath('')
    }
  }

  const deleteNode = async (node: FileNode): Promise<void> => {
    const nodeRoot = findRoot(node.path)
    if (!nodeRoot || node.path === nodeRoot) return
    const accepted = window.confirm(
      `确定删除${node.kind === 'directory' ? '文件夹' : '文件'}“${node.name}”吗？`
    )
    if (!accepted) return
    await window.localAgent.files.delete(nodeRoot, node.path)
    removeOpenPath(node.path)
    setSelectedNode(null)
    await refreshRoot(nodeRoot)
  }

  const createEntry = async (): Promise<void> => {
    if (!creating || !createName.trim()) return
    const parentRoot = findRoot(creating.parent.path)
    if (!parentRoot) return
    const target = await window.localAgent.files.create(
      parentRoot,
      creating.parent.path,
      createName.trim(),
      creating.kind
    )
    const kind = creating.kind
    setCreating(null)
    setCreateName('')
    await refreshRoot(parentRoot)
    if (kind === 'file') await onOpenFile(target)
  }

  useEffect(() => {
    workspaceRoots.forEach((item) => void refreshRoot(item))
  }, [workspaceRoots.join('|')])

  useEffect(() => {
    if (!contextMenu) return
    const close = (): void => setContextMenu(null)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [contextMenu])

  useEffect(() => {
    const handleKeys = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      const selectedRoot = selectedNode ? findRoot(selectedNode.path) : ''
      if (event.key === 'F2' && selectedNode) {
        event.preventDefault()
        setRenamingPath(selectedNode.path)
      }
      if (event.key === 'Delete' && selectedNode && selectedNode.path !== selectedRoot) {
        event.preventDefault()
        void deleteNode(selectedNode)
      }
    }
    window.addEventListener('keydown', handleKeys)
    return () => window.removeEventListener('keydown', handleKeys)
  }, [selectedNode, root, workspaceRoots.join('|')])

  const rootNodes: FileNode[] = workspaceRoots.map((item) => ({
    name: item.split(/[\\/]/).pop() || item,
    path: item,
    kind: 'directory',
    children: workspaceTrees[item] ?? []
  }))

  const showContextMenu = (
    event: React.MouseEvent<HTMLButtonElement>,
    node: FileNode
  ): void => {
    event.preventDefault()
    setSelectedNode(node)
    setContextMenu({ x: event.clientX, y: event.clientY, node })
  }
  const contextRoot = contextMenu ? findRoot(contextMenu.node.path) : ''
  const contextIsRoot = Boolean(contextMenu && contextMenu.node.path === contextRoot)

  return (
    <section className="project-sidebar">
      <header className="project-sidebar-head">
        <div>
          <span>资源管理器</span>
          <strong title={root}>
            {workspaceRoots.length
              ? workspaceRoots.length === 1
                ? rootNodes[0].name
                : `${workspaceRoots.length} 个项目`
              : '未打开文件夹'}
          </strong>
        </div>
        <div className="header-actions">
          <button
            className="icon-button"
            onClick={() => workspaceRoots.forEach((item) => void refreshRoot(item))}
            disabled={!workspaceRoots.length}
            title="刷新全部项目"
          >
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
          </button>
          <button className="icon-button prominent" onClick={() => void openWorkspace()} title="添加项目">
            <FolderPlus size={16} />
          </button>
        </div>
      </header>

      {root && (
        <div className="project-root-path" title={root}>
          CWD：{root}
        </div>
      )}

      <div className="project-tree">
        {rootNodes.length ? (
          <>
            {rootNodes.map((rootNode) => (
              <div className={`workspace-root-node ${rootNode.path === root ? 'cwd' : ''}`} key={rootNode.path}>
                <ProjectTreeNode
                  node={rootNode}
                  depth={0}
                  selectedPath={selectedNode?.path ?? ''}
                  renamingPath={renamingPath}
                  onOpenFile={onOpenFile}
                  onSelect={setSelectedNode}
                  onContextMenu={showContextMenu}
                  onRename={renameNode}
                  onRenameCancel={() => setRenamingPath('')}
                />
                {rootNode.path === root && <span className="cwd-badge">CWD</span>}
              </div>
            ))}
            {loadError && <div className="project-tree-error">{loadError}</div>}
          </>
        ) : (
          <button className="project-open-empty" onClick={() => void openWorkspace()}>
            <FolderOpen size={28} />
            <strong>打开文件夹</strong>
            <span>项目目录会以树型结构显示</span>
          </button>
        )}
      </div>

      {contextMenu && (
        <div
          className="project-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {contextMenu.node.kind === 'file' && (
            <button
              onClick={() => {
                void onOpenFile(contextMenu.node.path)
                setContextMenu(null)
              }}
            >
              <FileText size={14} /> 打开
            </button>
          )}
          {contextMenu.node.kind === 'directory' && (
            <>
              <button
                onClick={() => {
                  setCreating({ parent: contextMenu.node, kind: 'file' })
                  setCreateName('')
                  setContextMenu(null)
                }}
              >
                <FilePlus2 size={14} /> 新建文件
              </button>
              <button
                onClick={() => {
                  setCreating({ parent: contextMenu.node, kind: 'directory' })
                  setCreateName('')
                  setContextMenu(null)
                }}
              >
                <FolderPlus size={14} /> 新建文件夹
              </button>
            </>
          )}
          <button
            onClick={() => {
              setRenamingPath(contextMenu.node.path)
              setContextMenu(null)
            }}
          >
            <Pencil size={14} /> 重命名
            <kbd>F2</kbd>
          </button>
          {!contextIsRoot && (
            <>
              <button
                onClick={async () => {
                  await window.localAgent.files.duplicate(contextRoot, contextMenu.node.path)
                  setContextMenu(null)
                  await refreshRoot(contextRoot)
                }}
              >
                <CopyPlus size={14} /> 创建副本
              </button>
            </>
          )}
          <button
            onClick={() => {
              void navigator.clipboard.writeText(contextMenu.node.path)
              setContextMenu(null)
            }}
          >
            <Copy size={14} /> 复制路径
          </button>
          <button
            onClick={() => {
              void window.localAgent.files.openExternal(contextMenu.node.path)
              setContextMenu(null)
            }}
          >
            <ExternalLink size={14} /> 使用系统程序打开
          </button>
          <button
            onClick={() => {
              void window.localAgent.files.reveal(contextMenu.node.path)
              setContextMenu(null)
            }}
          >
            <FolderSearch size={14} /> 在资源管理器中显示
          </button>
          {!contextIsRoot ? (
            <button
              className="danger"
              onClick={() => {
                setContextMenu(null)
                void deleteNode(contextMenu.node)
              }}
            >
              <Trash2 size={14} /> 删除
              <kbd>Del</kbd>
            </button>
          ) : (
            <>
              {contextRoot !== root && (
                <button
                  onClick={() => {
                    setActiveWorkspace(contextRoot)
                    setContextMenu(null)
                  }}
                >
                  <FolderOpen size={14} /> 设为当前 CWD
                </button>
              )}
              <button
                className="danger"
                onClick={() => {
                  closeWorkspace(contextRoot)
                  setContextMenu(null)
                }}
              >
                <X size={14} /> 移除项目
              </button>
            </>
          )}
        </div>
      )}

      {creating && (
        <div className="project-name-dialog">
          <strong>{creating.kind === 'file' ? '新建文件' : '新建文件夹'}</strong>
          <span title={creating.parent.path}>{creating.parent.name}</span>
          <input
            autoFocus
            value={createName}
            onChange={(event) => setCreateName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void createEntry()
              if (event.key === 'Escape') setCreating(null)
            }}
            placeholder={creating.kind === 'file' ? '例如：main.ts' : '文件夹名称'}
          />
          <div>
            <button onClick={() => setCreating(null)}>取消</button>
            <button className="primary" onClick={() => void createEntry()} disabled={!createName.trim()}>
              创建
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
