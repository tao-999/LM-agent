export const markdownKatexOptions = {
  throwOnError: false,
  strict: 'ignore' as const,
  globalGroup: true,
  macros: {
    '\\RR': '\\mathbb{R}',
    '\\NN': '\\mathbb{N}',
    '\\ZZ': '\\mathbb{Z}',
    '\\QQ': '\\mathbb{Q}',
    '\\CC': '\\mathbb{C}',
    '\\abs': '\\left\\lvert #1 \\right\\rvert',
    '\\norm': '\\left\\lVert #1 \\right\\rVert',
    '\\set': '\\left\\{ #1 \\right\\}',
    '\\vect': '\\boldsymbol{#1}'
  }
}

function normalizeBareMathEnvironments(segment: string): string {
  return segment
    .replace(
      /\\begin\{equation\*?\}([\s\S]*?)\\end\{equation\*?\}/g,
      (_match, formula: string) => `\n\n$$\n${formula.trim()}\n$$\n\n`
    )
    .replace(
      /\\begin\{align\*?\}([\s\S]*?)\\end\{align\*?\}/g,
      (_match, formula: string) =>
        `\n\n$$\n\\begin{aligned}\n${formula.trim()}\n\\end{aligned}\n$$\n\n`
    )
    .replace(
      /\\begin\{gather\*?\}([\s\S]*?)\\end\{gather\*?\}/g,
      (_match, formula: string) =>
        `\n\n$$\n\\begin{gathered}\n${formula.trim()}\n\\end{gathered}\n$$\n\n`
    )
}

export function normalizeMarkdownMath(value: string): string {
  return value
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|\$\$[\s\S]*?\$\$)/g)
    .map((segment, index) => {
      if (index % 2 === 1) return segment
      return normalizeBareMathEnvironments(segment)
        .replace(
          /\\\[([\s\S]*?)\\\]/g,
          (_match, formula: string) => `\n\n$$\n${formula.trim()}\n$$\n\n`
        )
        .replace(
          /\\\(([\s\S]*?)\\\)/g,
          (_match, formula: string) => `$${formula.trim()}$`
        )
    })
    .join('')
}
