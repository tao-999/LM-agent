import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
import { placeViewportMenuBesideRect } from '../utils/viewport-menu'

type ContextMenuState = {
  anchorLeft: number
  anchorRight: number
  anchorTop: number
  anchorBottom: number
  left: number
  top: number
  horizontal: 'right' | 'left'
  vertical: 'down' | 'up'
  node: FileNode
}

type CreateState = {
  parent: FileNode
  kind: 'file' | 'directory'
}

type FileClipboardState = {
  node: FileNode
  root: string
}

function normalizedPath(value: string): string {
  return value.replace(/\//g, '\\').replace(/\\+$/, '').toLocaleLowerCase()
}

function parentPath(value: string): string {
  return value.replace(/[\\/][^\\/]+$/, '')
}

function findTreeNode(nodes: FileNode[], targetPath: string): FileNode | null {
  for (const node of nodes) {
    if (normalizedPath(node.path) === normalizedPath(targetPath)) return node
    const child = node.children ? findTreeNode(node.children, targetPath) : null
    if (child) return child
  }
  return null
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
  onRenameCancel,
  draggingPath,
  dropTargetPath,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop
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
  draggingPath: string
  dropTargetPath: string
  onDragStart: (event: React.DragEvent<HTMLButtonElement>, node: FileNode) => void
  onDragEnd: () => void
  onDragOver: (event: React.DragEvent<HTMLButtonElement>, node: FileNode) => boolean
  onDragLeave: (event: React.DragEvent<HTMLButtonElement>, node: FileNode) => void
  onDrop: (event: React.DragEvent<HTMLButtonElement>, node: FileNode) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(depth < 1)
  const selected = selectedPath === node.path
  const renaming = renamingPath === node.path

  if (node.kind === 'directory') {
    return (
      <div className="tree-group">
        <button
          className={`tree-row directory ${selected ? 'selected' : ''} ${
            draggingPath === node.path ? 'dragging' : ''
          } ${dropTargetPath === node.path ? 'drop-target' : ''}`}
          style={{ paddingLeft: 7 + depth * 12 }}
          draggable={!renaming && depth > 0}
          onClick={() => {
            onSelect(node)
            setExpanded((value) => !value)
          }}
          onContextMenu={(event) => onContextMenu(event, node)}
          onDragStart={(event) => onDragStart(event, node)}
          onDragEnd={onDragEnd}
          onDragEnter={(event) => {
            if (onDragOver(event, node)) setExpanded(true)
          }}
          onDragOver={(event) => onDragOver(event, node)}
          onDragLeave={(event) => onDragLeave(event, node)}
          onDrop={(event) => onDrop(event, node)}
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
              draggingPath={draggingPath}
              dropTargetPath={dropTargetPath}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
            />
          ))}
      </div>
    )
  }

  return (
    <button
      className={`tree-row file ${selected ? 'selected' : ''} ${
        draggingPath === node.path ? 'dragging' : ''
      }`}
      style={{ paddingLeft: 22 + depth * 12 }}
      draggable={!renaming}
      onClick={() => {
        onSelect(node)
        if (!renaming) void onOpenFile(node.path)
      }}
      onContextMenu={(event) => onContextMenu(event, node)}
      onDragStart={(event) => onDragStart(event, node)}
      onDragEnd={onDragEnd}
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
  const [fileClipboard, setFileClipboard] = useState<FileClipboardState | null>(null)
  const [dragSource, setDragSource] = useState<FileClipboardState | null>(null)
  const [dropTargetPath, setDropTargetPath] = useState('')
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)

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

  const canTransferTo = (source: FileClipboardState, target: FileNode): boolean => {
    if (target.kind !== 'directory') return false
    const sourcePath = normalizedPath(source.node.path)
    const targetPath = normalizedPath(target.path)
    if (source.node.kind === 'directory' && targetPath.startsWith(`${sourcePath}\\`)) return false
    if (sourcePath === targetPath) return false
    return normalizedPath(`${target.path}\\${source.node.name}`) !== sourcePath
  }

  const transferEntry = async (
    source: FileClipboardState,
    target: FileNode,
    mode: 'copy' | 'move'
  ): Promise<void> => {
    if (!canTransferTo(source, target)) return
    const targetRoot = findRoot(target.path)
    if (!targetRoot) return
    setLoadError('')
    setLoading(true)
    try {
      const executeTransfer = (overwrite = false): Promise<string> =>
        mode === 'copy'
          ? window.localAgent.files.copyToDirectory(
              source.root,
              source.node.path,
              targetRoot,
              target.path,
              overwrite
            )
          : window.localAgent.files.moveToDirectory(
              source.root,
              source.node.path,
              targetRoot,
              target.path,
              overwrite
            )
      let nextPath: string
      try {
        nextPath = await executeTransfer()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!message.includes('目标目录已存在')) throw error
        const accepted = window.confirm(
          `目标位置已存在“${source.node.name}”，是否替换？${
            source.node.kind === 'directory' ? '\n替换会移除目标文件夹中的旧内容。' : ''
          }`
        )
        if (!accepted) return
        nextPath = await executeTransfer(true)
      }
      if (mode === 'move') {
        renameOpenPath(source.node.path, nextPath)
        setSelectedNode({ ...source.node, path: nextPath })
      }
      await Promise.all(
        [...new Set([source.root, targetRoot])].map(async (workspaceRoot) => {
          setFileTreeForRoot(workspaceRoot, await window.localAgent.workspace.tree(workspaceRoot))
        })
      )
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
      setDropTargetPath('')
      setDragSource(null)
    }
  }

  const copyNode = (node: FileNode): void => {
    const nodeRoot = findRoot(node.path)
    if (!nodeRoot || normalizedPath(node.path) === normalizedPath(nodeRoot)) return
    setFileClipboard({ node, root: nodeRoot })
    setSelectedNode(node)
  }

  const pasteInto = (target: FileNode): void => {
    if (!fileClipboard) return
    void transferEntry(fileClipboard, target, 'copy')
  }

  const beginDrag = (event: React.DragEvent<HTMLButtonElement>, node: FileNode): void => {
    const nodeRoot = findRoot(node.path)
    if (!nodeRoot || normalizedPath(node.path) === normalizedPath(nodeRoot)) {
      event.preventDefault()
      return
    }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', node.path)
    setSelectedNode(node)
    setDragSource({ node, root: nodeRoot })
  }

  const dragOverDirectory = (
    event: React.DragEvent<HTMLButtonElement>,
    target: FileNode
  ): boolean => {
    if (!dragSource || !canTransferTo(dragSource, target)) return false
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setDropTargetPath(target.path)
    return true
  }

  const leaveDropTarget = (
    event: React.DragEvent<HTMLButtonElement>,
    target: FileNode
  ): void => {
    if (
      event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    ) {
      return
    }
    setDropTargetPath((current) => (current === target.path ? '' : current))
  }

  const dropIntoDirectory = (
    event: React.DragEvent<HTMLButtonElement>,
    target: FileNode
  ): void => {
    event.preventDefault()
    event.stopPropagation()
    if (dragSource) void transferEntry(dragSource, target, 'move')
  }

  const rootNodes: FileNode[] = workspaceRoots.map((item) => ({
    name: item.split(/[\\/]/).pop() || item,
    path: item,
    kind: 'directory',
    children: workspaceTrees[item] ?? []
  }))

  useEffect(() => {
    workspaceRoots.forEach((item) => void refreshRoot(item))
  }, [workspaceRoots.join('|')])

  useEffect(() => {
    if (!contextMenu) return
    const close = (): void => setContextMenu(null)
    const closeOnScroll = (event: Event): void => {
      if (event.target instanceof Node && contextMenuRef.current?.contains(event.target)) return
      close()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', closeOnScroll, true)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', closeOnScroll, true)
    }
  }, [contextMenu])

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return
    const menu = contextMenuRef.current
    const placement = placeViewportMenuBesideRect({
      anchorLeft: contextMenu.anchorLeft,
      anchorRight: contextMenu.anchorRight,
      anchorTop: contextMenu.anchorTop,
      anchorBottom: contextMenu.anchorBottom,
      menuWidth: menu.offsetWidth,
      menuHeight: menu.offsetHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    })
    if (
      placement.left === contextMenu.left &&
      placement.top === contextMenu.top &&
      placement.horizontal === contextMenu.horizontal &&
      placement.vertical === contextMenu.vertical
    ) {
      return
    }
    setContextMenu((current) => (current ? { ...current, ...placement } : current))
  }, [contextMenu])

  useEffect(() => {
    const handleKeys = (event: KeyboardEvent): void => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable)
      ) return
      if (!sidebarRef.current?.contains(document.activeElement)) return
      const selectedRoot = selectedNode ? findRoot(selectedNode.path) : ''
      const modifier = event.ctrlKey || event.metaKey
      if (modifier && event.key.toLocaleLowerCase() === 'c' && selectedNode) {
        if (window.getSelection()?.toString()) return
        event.preventDefault()
        copyNode(selectedNode)
        return
      }
      if (modifier && event.key.toLocaleLowerCase() === 'v' && fileClipboard) {
        const fallbackRoot = rootNodes.find((node) => node.path === root) ?? rootNodes[0]
        const target =
          selectedNode?.kind === 'directory'
            ? selectedNode
            : selectedNode
              ? findTreeNode(rootNodes, parentPath(selectedNode.path))
              : fallbackRoot
        if (target?.kind === 'directory') {
          event.preventDefault()
          pasteInto(target)
        }
        return
      }
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
  }, [selectedNode, root, workspaceRoots.join('|'), fileClipboard, workspaceTrees])

  const showContextMenu = (
    event: React.MouseEvent<HTMLButtonElement>,
    node: FileNode
  ): void => {
    event.preventDefault()
    event.stopPropagation()
    const anchor = event.currentTarget.getBoundingClientRect()
    setSelectedNode(node)
    setContextMenu({
      anchorLeft: anchor.left,
      anchorRight: anchor.right,
      anchorTop: anchor.top,
      anchorBottom: anchor.bottom,
      left: anchor.right + 4,
      top: anchor.top,
      horizontal: 'right',
      vertical: 'down',
      node
    })
  }
  const contextRoot = contextMenu ? findRoot(contextMenu.node.path) : ''
  const contextIsRoot = Boolean(contextMenu && contextMenu.node.path === contextRoot)

  return (
    <section ref={sidebarRef} className="project-sidebar">
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
                  draggingPath={dragSource?.node.path ?? ''}
                  dropTargetPath={dropTargetPath}
                  onDragStart={beginDrag}
                  onDragEnd={() => {
                    setDragSource(null)
                    setDropTargetPath('')
                  }}
                  onDragOver={dragOverDirectory}
                  onDragLeave={leaveDropTarget}
                  onDrop={dropIntoDirectory}
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

      {contextMenu && createPortal(
        <div
          ref={contextMenuRef}
          className="project-context-menu"
          data-horizontal={contextMenu.horizontal}
          data-vertical={contextMenu.vertical}
          style={{ left: contextMenu.left, top: contextMenu.top }}
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
              {fileClipboard && (
                <button
                  disabled={!canTransferTo(fileClipboard, contextMenu.node)}
                  onClick={() => {
                    pasteInto(contextMenu.node)
                    setContextMenu(null)
                  }}
                >
                  <CopyPlus size={14} /> 粘贴
                  <kbd>Ctrl+V</kbd>
                </button>
              )}
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
            <button
              onClick={() => {
                copyNode(contextMenu.node)
                setContextMenu(null)
              }}
            >
              <Copy size={14} /> 复制
              <kbd>Ctrl+C</kbd>
            </button>
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
        </div>,
        document.body
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
