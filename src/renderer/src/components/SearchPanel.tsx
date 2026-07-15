import { useState } from 'react'
import { FileSearch, LoaderCircle, Search } from 'lucide-react'
import type { SearchResult } from '../../../shared/types'
import { useAppStore } from '../store'

export function SearchPanel({
  onOpenFile
}: {
  onOpenFile: (path: string, line?: number) => Promise<void>
}): React.JSX.Element {
  const workspaceRoot = useAppStore((state) => state.workspaceRoot)
  const workspaceRoots = useAppStore((state) => state.workspaceRoots)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)

  const search = async (): Promise<void> => {
    if (!query.trim() || !workspaceRoots.length) return
    setSearching(true)
    try {
      const grouped = await Promise.all(
        workspaceRoots.map((root) => window.localAgent.files.search(root, query.trim()))
      )
      setResults(grouped.flat())
    } finally {
      setSearching(false)
    }
  }

  return (
    <section className="search-panel">
      <header className="panel-header">
        <div>
          <div className="eyebrow">工作区</div>
          <h2>全文搜索</h2>
        </div>
      </header>
      <div className="search-box">
        <Search size={16} />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void search()
          }}
          placeholder={workspaceRoots.length ? '关键词；a | b 为或，a & b 为且' : '请先打开工作区'}
          disabled={!workspaceRoots.length}
        />
        <button onClick={() => void search()} disabled={searching || !workspaceRoots.length}>
          {searching ? <LoaderCircle size={15} className="spin" /> : '搜索'}
        </button>
      </div>
      <div className="search-summary">
        {results.length ? `找到 ${results.length} 处结果` : '支持 | 或查询、& 且查询，输入后按回车'}
      </div>
      <div className="search-results">
        {results.map((result, index) => (
          <button
            key={`${result.path}-${result.line}-${index}`}
            className="search-result"
            onClick={() => void onOpenFile(result.path, result.line)}
          >
            <FileSearch size={15} />
            <div>
              <strong>{result.path.split(/[\\/]/).pop()}</strong>
              <small>
                {result.path.replace(
                  `${workspaceRoots.find((root) => result.path.startsWith(root)) ?? workspaceRoot}\\`,
                  ''
                ).replace(`${workspaceRoot}/`, '')}:
                {result.line}
              </small>
              <p>{result.preview}</p>
            </div>
          </button>
        ))}
      </div>
    </section>
  )
}
