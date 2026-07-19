function cleanToolJson(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}

function normalizeMalformedKeys(value: string): string {
  let output = ''
  let index = 0
  while (index < value.length) {
    const character = value[index]
    if (character === '"') {
      const start = index
      index += 1
      while (index < value.length) {
        if (value[index] === '\\') {
          index += 2
          continue
        }
        if (value[index] === '"') {
          index += 1
          break
        }
        index += 1
      }
      output += value.slice(start, index)
      continue
    }
    if (character !== '{' && character !== '[' && character !== ',') {
      output += character
      index += 1
      continue
    }

    output += character
    index += 1
    const whitespaceStart = index
    while (index < value.length && /\s/.test(value[index])) index += 1
    output += value.slice(whitespaceStart, index)

    const remainder = value.slice(index)
    const halfQuotedKey = remainder.match(/^([A-Za-z_][\w.-]*)"\s*:/)
    const bareKey = remainder.match(/^([A-Za-z_][\w.-]*)\s*:/)
    const match = halfQuotedKey ?? bareKey
    if (!match) continue
    output += `"${match[1]}":`
    index += match[0].length
  }
  return output
}

function wrapBareArrayObjects(value: string): string {
  const output: string[] = []
  const arrayFrames: Array<{ insertedObject: boolean }> = []
  let inString = false
  let escaped = false

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (inString) {
      output.push(character)
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }
    if (character === '"') {
      inString = true
      output.push(character)
      continue
    }
    if (character === '[') {
      output.push(character)
      let cursor = index + 1
      while (cursor < value.length && /\s/.test(value[cursor])) {
        output.push(value[cursor])
        cursor += 1
      }
      const bareObject = /^"(?:\\.|[^"\\])+"\s*:/.test(value.slice(cursor))
      if (bareObject) output.push('{')
      arrayFrames.push({ insertedObject: bareObject })
      index = cursor - 1
      continue
    }
    if (character === ']') {
      const frame = arrayFrames.pop()
      if (frame?.insertedObject) {
        let cursor = output.length - 1
        while (cursor >= 0 && /^\s$/.test(output[cursor])) cursor -= 1
        if (output[cursor] !== '}') output.push('}')
      }
      output.push(character)
      continue
    }
    output.push(character)
  }
  return output.join('')
}

function removeTrailingCommas(value: string): string {
  return value.replace(/,\s*([}\]])/g, '$1')
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Parses tool arguments while repairing only deterministic JSON damage seen in
 * local-model function calls: half-quoted keys, bare keys, missing object braces
 * around an array item, and trailing commas. The returned object still passes
 * through each tool's JSON-schema validation before execution.
 */
export function parseToolArgumentsJson(value: string): Record<string, unknown> | null {
  const cleaned = cleanToolJson(value)
  const normalizedKeys = normalizeMalformedKeys(cleaned)
  const wrappedArrays = wrapBareArrayObjects(normalizedKeys)
  const candidates = [cleaned, normalizedKeys, wrappedArrays, removeTrailingCommas(wrappedArrays)]
  for (const candidate of [...new Set(candidates)]) {
    const parsed = parseObject(candidate)
    if (parsed) return parsed
  }
  return null
}
