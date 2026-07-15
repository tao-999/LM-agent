import type { BeforeMount } from '@monaco-editor/react'

export type EditorTheme =
  | 'one-dark-pro'
  | 'dracula'
  | 'tokyo-night'
  | 'github-dark'
  | 'monokai'
  | 'nord'
  | 'catppuccin-mocha'
  | 'vs-dark'
  | 'vs'
  | 'hc-black'
  | 'hc-light'

type ThemeOption = {
  id: EditorTheme
  name: string
  description: string
  colors: [string, string, string]
}

type ThemePalette = {
  background: string
  foreground: string
  muted: string
  keyword: string
  string: string
  number: string
  type: string
  function: string
  variable: string
  operator: string
  selection: string
  line: string
  cursor: string
  border: string
}

export const editorThemeOptions: ThemeOption[] = [
  {
    id: 'one-dark-pro',
    name: 'One Dark Pro',
    description: '柔和耐看的现代深色主题',
    colors: ['#282c34', '#61afef', '#e06c75']
  },
  {
    id: 'dracula',
    name: 'Dracula',
    description: '高饱和紫色系经典主题',
    colors: ['#282a36', '#bd93f9', '#ff79c6']
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    description: '低对比蓝紫夜间主题',
    colors: ['#1a1b26', '#7aa2f7', '#bb9af7']
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    description: '克制清爽的 GitHub 配色',
    colors: ['#0d1117', '#58a6ff', '#ff7b72']
  },
  {
    id: 'monokai',
    name: 'Monokai',
    description: '鲜明活泼的经典代码配色',
    colors: ['#272822', '#66d9ef', '#f92672']
  },
  {
    id: 'nord',
    name: 'Nord',
    description: '冷静舒适的极地蓝配色',
    colors: ['#2e3440', '#88c0d0', '#b48ead']
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    description: '柔和温润的深色主题',
    colors: ['#1e1e2e', '#89b4fa', '#f38ba8']
  },
  {
    id: 'vs-dark',
    name: 'VS 深色',
    description: 'Monaco 官方经典深色',
    colors: ['#1e1e1e', '#569cd6', '#ce9178']
  },
  {
    id: 'vs',
    name: 'VS 浅色',
    description: 'Monaco 官方经典浅色',
    colors: ['#ffffff', '#0000ff', '#a31515']
  },
  {
    id: 'hc-black',
    name: '高对比度深色',
    description: '强化边界与文字辨识度',
    colors: ['#000000', '#75beff', '#f48771']
  },
  {
    id: 'hc-light',
    name: '高对比度浅色',
    description: '浅色高对比度显示',
    colors: ['#ffffff', '#0f4a85', '#8b1a10']
  }
]

const customThemes: Record<
  Exclude<EditorTheme, 'vs-dark' | 'vs' | 'hc-black' | 'hc-light'>,
  ThemePalette
> = {
  'one-dark-pro': {
    background: '#282c34',
    foreground: '#abb2bf',
    muted: '#5c6370',
    keyword: '#c678dd',
    string: '#98c379',
    number: '#d19a66',
    type: '#e5c07b',
    function: '#61afef',
    variable: '#e06c75',
    operator: '#56b6c2',
    selection: '#3e4451',
    line: '#2c313c',
    cursor: '#528bff',
    border: '#3e4451'
  },
  dracula: {
    background: '#282a36',
    foreground: '#f8f8f2',
    muted: '#6272a4',
    keyword: '#ff79c6',
    string: '#f1fa8c',
    number: '#bd93f9',
    type: '#8be9fd',
    function: '#50fa7b',
    variable: '#f8f8f2',
    operator: '#ff79c6',
    selection: '#44475a',
    line: '#2d303e',
    cursor: '#f8f8f0',
    border: '#44475a'
  },
  'tokyo-night': {
    background: '#1a1b26',
    foreground: '#c0caf5',
    muted: '#565f89',
    keyword: '#bb9af7',
    string: '#9ece6a',
    number: '#ff9e64',
    type: '#2ac3de',
    function: '#7aa2f7',
    variable: '#c0caf5',
    operator: '#89ddff',
    selection: '#33467c',
    line: '#1f2335',
    cursor: '#c0caf5',
    border: '#292e42'
  },
  'github-dark': {
    background: '#0d1117',
    foreground: '#c9d1d9',
    muted: '#8b949e',
    keyword: '#ff7b72',
    string: '#a5d6ff',
    number: '#79c0ff',
    type: '#ffa657',
    function: '#d2a8ff',
    variable: '#ffa657',
    operator: '#ff7b72',
    selection: '#264f78',
    line: '#161b22',
    cursor: '#58a6ff',
    border: '#30363d'
  },
  monokai: {
    background: '#272822',
    foreground: '#f8f8f2',
    muted: '#75715e',
    keyword: '#f92672',
    string: '#e6db74',
    number: '#ae81ff',
    type: '#66d9ef',
    function: '#a6e22e',
    variable: '#fd971f',
    operator: '#f92672',
    selection: '#49483e',
    line: '#2e2f29',
    cursor: '#f8f8f0',
    border: '#49483e'
  },
  nord: {
    background: '#2e3440',
    foreground: '#d8dee9',
    muted: '#616e88',
    keyword: '#81a1c1',
    string: '#a3be8c',
    number: '#b48ead',
    type: '#8fbcbb',
    function: '#88c0d0',
    variable: '#d8dee9',
    operator: '#81a1c1',
    selection: '#434c5e',
    line: '#3b4252',
    cursor: '#d8dee9',
    border: '#4c566a'
  },
  'catppuccin-mocha': {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    muted: '#6c7086',
    keyword: '#cba6f7',
    string: '#a6e3a1',
    number: '#fab387',
    type: '#94e2d5',
    function: '#89b4fa',
    variable: '#f38ba8',
    operator: '#89dceb',
    selection: '#45475a',
    line: '#24243a',
    cursor: '#f5e0dc',
    border: '#45475a'
  }
}

export const registerEditorThemes: BeforeMount = (monaco) => {
  for (const [name, palette] of Object.entries(customThemes)) {
    monaco.editor.defineTheme(name, {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: palette.muted.slice(1), fontStyle: 'italic' },
        { token: 'keyword', foreground: palette.keyword.slice(1) },
        { token: 'keyword.control', foreground: palette.keyword.slice(1) },
        { token: 'string', foreground: palette.string.slice(1) },
        { token: 'string.escape', foreground: palette.operator.slice(1) },
        { token: 'number', foreground: palette.number.slice(1) },
        { token: 'type', foreground: palette.type.slice(1) },
        { token: 'type.identifier', foreground: palette.type.slice(1) },
        { token: 'function', foreground: palette.function.slice(1) },
        { token: 'identifier.function', foreground: palette.function.slice(1) },
        { token: 'variable', foreground: palette.variable.slice(1) },
        { token: 'operator', foreground: palette.operator.slice(1) },
        { token: 'delimiter', foreground: palette.foreground.slice(1) },
        { token: 'tag', foreground: palette.variable.slice(1) },
        { token: 'attribute.name', foreground: palette.number.slice(1) }
      ],
      colors: {
        'editor.background': palette.background,
        'editor.foreground': palette.foreground,
        'editorGutter.background': palette.background,
        'editorLineNumber.foreground': palette.muted,
        'editorLineNumber.activeForeground': palette.foreground,
        'editorCursor.foreground': palette.cursor,
        'editor.selectionBackground': palette.selection,
        'editor.inactiveSelectionBackground': `${palette.selection}88`,
        'editor.lineHighlightBackground': palette.line,
        'editorWhitespace.foreground': `${palette.muted}55`,
        'editorIndentGuide.background1': `${palette.muted}44`,
        'editorIndentGuide.activeBackground1': palette.muted,
        'editorBracketMatch.background': `${palette.selection}99`,
        'editorBracketMatch.border': palette.operator,
        'editorWidget.background': palette.background,
        'editorWidget.border': palette.border,
        'editorSuggestWidget.background': palette.background,
        'editorSuggestWidget.border': palette.border,
        'editorSuggestWidget.selectedBackground': palette.line,
        'editorHoverWidget.background': palette.background,
        'editorHoverWidget.border': palette.border,
        'minimap.background': palette.background,
        'scrollbarSlider.background': `${palette.muted}55`,
        'scrollbarSlider.hoverBackground': `${palette.muted}88`,
        'scrollbarSlider.activeBackground': `${palette.muted}aa`,
        'diffEditor.insertedTextBackground': '#2ea04333',
        'diffEditor.removedTextBackground': '#f8514933',
        'diffEditor.insertedLineBackground': '#2ea04318',
        'diffEditor.removedLineBackground': '#f8514918'
      }
    })
  }
}
