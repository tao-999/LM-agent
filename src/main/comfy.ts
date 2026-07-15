import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  ChatAttachment,
  ComfyWorkflow,
  ComfyWorkflowInspection,
  ComfyWorkflowNode
} from '../shared/types'

type ComfyImageReference = {
  filename: string
  subfolder?: string
  type?: string
}

type UiWorkflowNode = {
  id: string | number
  type: string
  title?: string
  mode?: number
  inputs?: Array<{
    name?: string
    link?: string | number | null
    widget?: { name?: string }
  }>
  outputs?: Array<{ name?: string }>
  widgets_values?: unknown[] | unknown
  properties?: Record<string, unknown>
}

type UiWorkflowLink = {
  id: string | number
  originId: string
  originSlot: number
  targetId: string
  targetSlot: number
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function uiLink(value: unknown): UiWorkflowLink | null {
  if (Array.isArray(value) && value.length >= 5) {
    return {
      id: value[0] as string | number,
      originId: String(value[1]),
      originSlot: Number(value[2]) || 0,
      targetId: String(value[3]),
      targetSlot: Number(value[4]) || 0
    }
  }
  const item = objectRecord(value)
  if (!item) return null
  const id = item.id
  const originId = item.origin_id
  const targetId = item.target_id
  if (
    (typeof id !== 'string' && typeof id !== 'number') ||
    (typeof originId !== 'string' && typeof originId !== 'number') ||
    (typeof targetId !== 'string' && typeof targetId !== 'number')
  ) {
    return null
  }
  return {
    id,
    originId: String(originId),
    originSlot: Number(item.origin_slot) || 0,
    targetId: String(targetId),
    targetSlot: Number(item.target_slot) || 0
  }
}

function uiNodes(value: unknown): UiWorkflowNode[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw) => {
    const node = objectRecord(raw)
    if (
      !node ||
      (typeof node.id !== 'string' && typeof node.id !== 'number') ||
      typeof node.type !== 'string'
    ) {
      return []
    }
    return [node as unknown as UiWorkflowNode]
  })
}

function uiLinks(value: unknown): UiWorkflowLink[] {
  return Array.isArray(value)
    ? value.map(uiLink).filter((item): item is UiWorkflowLink => Boolean(item))
    : []
}

function widgetValues(node: UiWorkflowNode): unknown[] {
  if (Array.isArray(node.widgets_values)) return [...node.widgets_values]
  return node.widgets_values === undefined ? [] : [node.widgets_values]
}

function literalFromPrimitive(node: UiWorkflowNode | undefined): unknown {
  return node?.type === 'PrimitiveNode' ? widgetValues(node)[0] : undefined
}

function convertUiWorkflow(root: Record<string, unknown>): Record<string, ComfyWorkflowNode> {
  const topNodes = uiNodes(root.nodes)
  const topLinks = uiLinks(root.links)
  if (!topNodes.length) return {}

  const definitions = objectRecord(root.definitions)
  const subgraphs = Array.isArray(definitions?.subgraphs)
    ? definitions.subgraphs.map(objectRecord).filter(Boolean)
    : []
  const definitionMap = new Map(
    subgraphs
      .filter((item) => typeof item?.id === 'string')
      .map((item) => [String(item!.id), item!] as const)
  )
  const flatNodes = new Map<string, UiWorkflowNode>()
  const flatLinks: UiWorkflowLink[] = []
  const subgraphOutputSources = new Map<string, Map<number, { nodeId: string; slot: number }>>()
  const subgraphInputTargets = new Map<
    string,
    Map<number, Array<{ nodeId: string; slot: number; linkId: string }>>
  >()

  for (const node of topNodes) {
    const nodeId = String(node.id)
    const definition = definitionMap.get(node.type)
    if (!definition) {
      flatNodes.set(nodeId, node)
      continue
    }
    const innerNodes = uiNodes(definition.nodes)
    const innerLinks = uiLinks(definition.links)
    const prefix = `${nodeId}:`
    for (const inner of innerNodes) {
      if (Number(inner.id) < 0) continue
      flatNodes.set(`${prefix}${inner.id}`, {
        ...inner,
        id: `${prefix}${inner.id}`,
        inputs: inner.inputs?.map((input) => ({
          ...input,
          link:
            input.link === null || input.link === undefined
              ? input.link
              : `${prefix}${input.link}`
        }))
      })
    }
    const outputs = new Map<number, { nodeId: string; slot: number }>()
    const inputs = new Map<
      number,
      Array<{ nodeId: string; slot: number; linkId: string }>
    >()
    for (const link of innerLinks) {
      if (link.targetId === '-20') {
        outputs.set(link.targetSlot, {
          nodeId: `${prefix}${link.originId}`,
          slot: link.originSlot
        })
        continue
      }
      if (link.originId === '-10') {
        const targets = inputs.get(link.originSlot) ?? []
        targets.push({
          nodeId: `${prefix}${link.targetId}`,
          slot: link.targetSlot,
          linkId: `${prefix}${link.id}`
        })
        inputs.set(link.originSlot, targets)
        continue
      }
      if (Number(link.targetId) < 0) continue
      flatLinks.push({
        ...link,
        id: `${prefix}${link.id}`,
        originId: `${prefix}${link.originId}`,
        targetId: `${prefix}${link.targetId}`
      })
    }
    subgraphOutputSources.set(nodeId, outputs)
    subgraphInputTargets.set(nodeId, inputs)
  }

  for (const link of topLinks) {
    const source = subgraphOutputSources.get(link.originId)?.get(link.originSlot)
    const originId = source?.nodeId ?? link.originId
    const originSlot = source?.slot ?? link.originSlot
    const targets = subgraphInputTargets.get(link.targetId)?.get(link.targetSlot)
    if (targets?.length) {
      for (const target of targets) {
        flatLinks.push({
          ...link,
          id: target.linkId,
          originId,
          originSlot,
          targetId: target.nodeId,
          targetSlot: target.slot
        })
      }
      continue
    }
    if (definitionMap.has(topNodes.find((node) => String(node.id) === link.targetId)?.type ?? '')) {
      continue
    }
    flatLinks.push({
      ...link,
      originId,
      originSlot
    })
  }

  const sourceByLink = new Map(
    flatLinks.map((link) => [
      String(link.id),
      { nodeId: link.originId, slot: link.originSlot }
    ])
  )
  const nodes: Record<string, ComfyWorkflowNode> = {}
  const skippedTypes = /^(PrimitiveNode|MarkdownNote|Note|Reroute)$/i
  const controlValues = new Set(['fixed', 'randomize', 'increment', 'decrement'])

  for (const [nodeId, node] of flatNodes) {
    if (skippedTypes.test(node.type) || node.mode === 2 || node.mode === 4) continue
    const inputs: Record<string, unknown> = {}
    const values = widgetValues(node)
    let valueIndex = 0
    for (const input of node.inputs ?? []) {
      if (!input.name) continue
      let widgetValue: unknown
      if (input.widget) {
        widgetValue = values[valueIndex]
        valueIndex += 1
        if (
          /seed/i.test(input.name) &&
          typeof values[valueIndex] === 'string' &&
          controlValues.has(String(values[valueIndex]))
        ) {
          valueIndex += 1
        }
      }
      const source = input.link === null || input.link === undefined
        ? undefined
        : sourceByLink.get(String(input.link))
      if (source) {
        const literal = literalFromPrimitive(flatNodes.get(source.nodeId))
        inputs[input.name] =
          literal === undefined ? [source.nodeId, source.slot] : literal
      } else if (input.widget && widgetValue !== undefined) {
        inputs[input.name] = widgetValue
      }
    }
    nodes[nodeId] = {
      class_type: node.type,
      inputs,
      _meta: {
        title: node.title || node.type
      }
    }
  }
  return nodes
}

function pruneToImageOutputs(
  nodes: Record<string, ComfyWorkflowNode>
): Record<string, ComfyWorkflowNode> {
  const outputIds = Object.entries(nodes)
    .filter(
      ([, node]) =>
        /^(SaveImage|PreviewImage)$/i.test(node.class_type) &&
        Object.values(node.inputs).some((value) => linkedNodeId(value))
    )
    .map(([id]) => id)
  const keep = new Set<string>()
  const visit = (id: string): void => {
    if (keep.has(id) || !nodes[id]) return
    keep.add(id)
    for (const value of Object.values(nodes[id].inputs)) {
      const upstream = linkedNodeId(value)
      if (upstream) visit(upstream)
    }
  }
  outputIds.forEach(visit)
  return Object.fromEntries(Object.entries(nodes).filter(([id]) => keep.has(id)))
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:8188'
}

function linkedNodeId(value: unknown): string | null {
  return Array.isArray(value) && (typeof value[0] === 'string' || typeof value[0] === 'number')
    ? String(value[0])
    : null
}

function findUpstreamNode(
  nodes: Record<string, ComfyWorkflowNode>,
  startId: string | null,
  predicate: (node: ComfyWorkflowNode) => boolean,
  visited = new Set<string>()
): string | null {
  if (!startId || visited.has(startId)) return null
  visited.add(startId)
  const node = nodes[startId]
  if (!node) return null
  if (predicate(node)) return startId
  for (const value of Object.values(node.inputs)) {
    const linked = linkedNodeId(value)
    const found = findUpstreamNode(nodes, linked, predicate, visited)
    if (found) return found
  }
  return null
}

function readWorkflow(value: unknown): Record<string, ComfyWorkflowNode> {
  const root = objectRecord(value)
  if (Array.isArray(root?.nodes)) {
    const converted = convertUiWorkflow(root)
    if (Object.keys(converted).length) return converted
  }
  const candidate = objectRecord(root?.prompt) ?? root
  if (!candidate) throw new Error('工作流 JSON 内容无效')
  const nodes: Record<string, ComfyWorkflowNode> = {}
  for (const [id, rawNode] of Object.entries(candidate)) {
    const node = objectRecord(rawNode)
    const inputs = objectRecord(node?.inputs)
    if (!node || typeof node.class_type !== 'string' || !inputs) continue
    nodes[id] = {
      class_type: node.class_type,
      inputs,
      _meta: objectRecord(node._meta) ?? undefined
    }
  }
  if (!Object.keys(nodes).length) {
    throw new Error('工作流中未发现可执行节点')
  }
  return nodes
}

async function collectJsonFiles(directory: string, depth = 0): Promise<string[]> {
  if (depth > 5) return []
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    const files: string[] = []
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        files.push(...(await collectJsonFiles(fullPath, depth + 1)))
      } else if (entry.isFile() && entry.name.toLocaleLowerCase().endsWith('.json')) {
        files.push(fullPath)
      }
    }
    return files
  } catch {
    return []
  }
}

export async function discoverComfyWorkflows(
  dataRoot = process.env.STABILITY_MATRIX_DATA_ROOT || 'G:\\StabilityMatrix\\data'
): Promise<ComfyWorkflow[]> {
  const searchRoots = [
    path.join(dataRoot, 'Packages', 'ComfyUI', 'user', 'default', 'workflows'),
    path.join(dataRoot, 'Workflows')
  ]
  const files = [...new Set((await Promise.all(searchRoots.map((root) => collectJsonFiles(root)))).flat())]
  const workflows: ComfyWorkflow[] = []
  for (const sourcePath of files) {
    try {
      const parsed = JSON.parse(await fs.readFile(sourcePath, 'utf8')) as unknown
      const id = `comfy-${createHash('sha1').update(sourcePath.toLocaleLowerCase()).digest('hex').slice(0, 16)}`
      workflows.push(parseComfyWorkflow(parsed, sourcePath, id))
    } catch (error) {
      console.warn(`Skipped ComfyUI workflow ${sourcePath}:`, error)
    }
  }
  return workflows.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
}

export function parseComfyWorkflow(
  value: unknown,
  sourcePath: string,
  id: string
): ComfyWorkflow {
  const nodes = pruneToImageOutputs(readWorkflow(value))
  if (!Object.values(nodes).some((node) => /^(SaveImage|PreviewImage)$/i.test(node.class_type))) {
    throw new Error('该工作流不包含图片输出节点')
  }
  const samplerEntry = Object.entries(nodes).find(
    ([, node]) =>
      /sampler/i.test(node.class_type) &&
      typeof node.inputs.steps === 'number' &&
      linkedNodeId(node.inputs.positive)
  )
  const stepsEntry =
    samplerEntry ??
    Object.entries(nodes).find(
      ([, node]) => /sampler|scheduler/i.test(node.class_type) && typeof node.inputs.steps === 'number'
    )
  if (!stepsEntry) throw new Error('工作流中未找到可调节的 Steps 节点')

  const sampler = samplerEntry?.[1] ?? stepsEntry[1]
  const positiveStart = linkedNodeId(sampler.inputs.positive)
  const promptInputNames = ['text', 'value', 'prompt', 'string', 'positive']
  const promptInputNameFor = (node: ComfyWorkflowNode): string | undefined =>
    promptInputNames.find((name) => typeof node.inputs[name] === 'string')
  const promptTitle = (node: ComfyWorkflowNode): string =>
    String(node._meta?.title ?? '').toLocaleLowerCase()
  const isExcludedPrompt = (node: ComfyWorkflowNode): boolean =>
    /negative|system|反向|负面|系统/.test(promptTitle(node))
  const isExplicitUserPrompt = (node: ComfyWorkflowNode): boolean =>
    Boolean(promptInputNameFor(node)) &&
    !isExcludedPrompt(node) &&
    /user\s*prompt|positive\s*prompt|main\s*prompt|用户提示|正向提示/.test(
      promptTitle(node)
    )
  const explicitPromptEntry = Object.entries(nodes).find(([, node]) =>
    isExplicitUserPrompt(node)
  )
  const promptNodeId =
    explicitPromptEntry?.[0] ??
    findUpstreamNode(
      nodes,
      positiveStart,
      (node) =>
        Boolean(promptInputNameFor(node)) &&
        !isExcludedPrompt(node) &&
        /text|clip|encode|prompt|string/i.test(node.class_type)
    ) ??
    Object.entries(nodes).find(
      ([, node]) =>
        Boolean(promptInputNameFor(node)) &&
        !isExcludedPrompt(node) &&
        /text|clip|encode|prompt|string/i.test(node.class_type)
    )?.[0]
  if (!promptNodeId) throw new Error('工作流中未找到正向 Prompt 文本节点')
  const promptInputName = promptInputNameFor(nodes[promptNodeId])
  if (!promptInputName) throw new Error('工作流中的正向 Prompt 节点缺少可写文本字段')

  const modelInputNames = [
    'ckpt_name',
    'unet_name',
    'diffusion_model',
    'model_name',
    'model'
  ]
  const modelEntry = Object.entries(nodes)
    .map(([nodeId, node]) => ({
      nodeId,
      node,
      inputName: modelInputNames.find((name) => typeof node.inputs[name] === 'string')
    }))
    .find((entry) => entry.inputName)
  if (!modelEntry?.inputName) throw new Error('工作流中未找到可切换的模型加载节点')

  const aspectRatioInputNames = ['aspect_ratio', 'aspectRatio', 'ratio', 'aspect']
  const megapixelsInputNames = ['megapixels', 'megapixel', 'mp']
  const multipleInputNames = ['multiple', 'divisible_by', 'alignment']
  const aspectRatioEntry = Object.entries(nodes)
    .map(([nodeId, node]) => ({
      nodeId,
      node,
      inputName: aspectRatioInputNames.find(
        (name) => typeof node.inputs[name] === 'string'
      )
    }))
    .find(
      (entry) =>
        entry.inputName &&
        /resolution|aspect|ratio|尺寸|比例/i.test(
          `${entry.node.class_type} ${String(entry.node._meta?.title ?? '')}`
        )
    )
  const megapixelsInputName = aspectRatioEntry
    ? megapixelsInputNames.find(
        (name) => typeof aspectRatioEntry.node.inputs[name] === 'number'
      )
    : undefined
  const multipleInputName = aspectRatioEntry
    ? multipleInputNames.find(
        (name) => typeof aspectRatioEntry.node.inputs[name] === 'number'
      )
    : undefined
  const sizeEntry = Object.entries(nodes).find(
    ([, node]) =>
      typeof node.inputs.width === 'number' &&
      typeof node.inputs.height === 'number' &&
      /latent|image|size|resolution/i.test(node.class_type)
  ) ?? Object.entries(nodes).find(
    ([, node]) =>
      typeof node.inputs.width === 'number' &&
      typeof node.inputs.height === 'number'
  )
  const coreAspectRatios = [
    '1:1 (Square)',
    '2:3 (Portrait Photo)',
    '3:2 (Photo)',
    '3:4 (Portrait Standard)',
    '4:3 (Standard)',
    '9:16 (Portrait Widescreen)',
    '16:9 (Widescreen)',
    '21:9 (Ultrawide)'
  ]
  const defaultAspectRatio =
    aspectRatioEntry?.inputName
      ? String(aspectRatioEntry.node.inputs[aspectRatioEntry.inputName])
      : undefined

  return {
    id,
    name: path.basename(sourcePath, path.extname(sourcePath)),
    sourcePath,
    workflow: nodes,
    promptNodeId,
    promptInputName,
    stepsNodeId: stepsEntry[0],
    stepsInputName: 'steps',
    widthNodeId: sizeEntry?.[0],
    widthInputName: sizeEntry ? 'width' : undefined,
    heightNodeId: sizeEntry?.[0],
    heightInputName: sizeEntry ? 'height' : undefined,
    sizeMode: aspectRatioEntry ? 'aspect_ratio' : sizeEntry ? 'dimensions' : 'workflow',
    aspectRatioNodeId: aspectRatioEntry?.nodeId,
    aspectRatioInputName: aspectRatioEntry?.inputName,
    aspectRatioNodeClass: aspectRatioEntry?.node.class_type,
    megapixelsNodeId: megapixelsInputName ? aspectRatioEntry?.nodeId : undefined,
    megapixelsInputName,
    multipleNodeId: multipleInputName ? aspectRatioEntry?.nodeId : undefined,
    multipleInputName,
    aspectRatioOptions:
      aspectRatioEntry?.node.class_type === 'ResolutionSelector'
        ? coreAspectRatios
        : defaultAspectRatio
          ? [defaultAspectRatio]
          : undefined,
    modelNodeId: modelEntry.nodeId,
    modelInputName: modelEntry.inputName,
    modelNodeClass: modelEntry.node.class_type,
    defaultSteps: Number(stepsEntry[1].inputs.steps) || 20,
    defaultWidth: sizeEntry ? Number(sizeEntry[1].inputs.width) || 1024 : undefined,
    defaultHeight: sizeEntry ? Number(sizeEntry[1].inputs.height) || 1024 : undefined,
    defaultAspectRatio,
    defaultMegapixels:
      megapixelsInputName && aspectRatioEntry
        ? Number(aspectRatioEntry.node.inputs[megapixelsInputName]) || 1
        : undefined,
    defaultMultiple:
      multipleInputName && aspectRatioEntry
        ? Number(aspectRatioEntry.node.inputs[multipleInputName]) || 8
        : undefined,
    defaultModel: String(modelEntry.node.inputs[modelEntry.inputName])
  }
}

function stringOptions(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const direct = value.filter((item): item is string => typeof item === 'string')
  if (direct.length) return direct
  for (const item of value) {
    const nested = stringOptions(item)
    if (nested.length) return nested
  }
  return []
}

function modelFolder(inputName: string): string {
  if (inputName === 'ckpt_name') return 'checkpoints'
  if (inputName === 'unet_name' || inputName === 'diffusion_model') {
    return 'diffusion_models'
  }
  return 'checkpoints'
}

export async function inspectComfyWorkflow(
  baseUrlValue: string,
  workflow: ComfyWorkflow,
  signal?: AbortSignal
): Promise<ComfyWorkflowInspection> {
  const baseUrl = normalizeBaseUrl(baseUrlValue)
  let stats: Response
  try {
    stats = await fetch(`${baseUrl}/system_stats`, {
      signal: signal ?? AbortSignal.timeout(3500)
    })
  } catch {
    throw new Error(`无法连接 ${baseUrl}，将在后台自动重试`)
  }
  if (!stats.ok) throw new Error(`ComfyUI 连接失败：HTTP ${stats.status}`)

  let models: string[] = []
  const infoResponse = await fetch(
    `${baseUrl}/object_info/${encodeURIComponent(workflow.modelNodeClass)}`,
    { signal }
  )
  if (infoResponse.ok) {
    const info = objectRecord(await infoResponse.json())
    const schema = objectRecord(info?.[workflow.modelNodeClass])
    const input = objectRecord(schema?.input)
    const required = objectRecord(input?.required)
    const optional = objectRecord(input?.optional)
    models = stringOptions(
      required?.[workflow.modelInputName] ?? optional?.[workflow.modelInputName]
    )
  }
  if (!models.length) {
    const response = await fetch(
      `${baseUrl}/models/${modelFolder(workflow.modelInputName)}`,
      { signal }
    )
    if (response.ok) models = stringOptions(await response.json())
  }
  if (!models.includes(workflow.defaultModel)) models.unshift(workflow.defaultModel)
  let aspectRatios = workflow.aspectRatioOptions ?? []
  if (workflow.aspectRatioNodeClass && workflow.aspectRatioInputName) {
    try {
      const aspectResponse = await fetch(
        `${baseUrl}/object_info/${encodeURIComponent(workflow.aspectRatioNodeClass)}`,
        { signal }
      )
      if (aspectResponse.ok) {
        const info = objectRecord(await aspectResponse.json())
        const schema = objectRecord(info?.[workflow.aspectRatioNodeClass])
        const input = objectRecord(schema?.input)
        const required = objectRecord(input?.required)
        const optional = objectRecord(input?.optional)
        const discovered = stringOptions(
          required?.[workflow.aspectRatioInputName] ??
            optional?.[workflow.aspectRatioInputName]
        )
        if (discovered.length) aspectRatios = discovered
      }
    } catch {
      // 比例选项属于增强信息，读取失败时继续使用工作流 JSON 中的配置。
    }
  }
  return {
    connected: true,
    message: `已连接 ComfyUI，发现 ${models.length} 个可选模型`,
    models: [...new Set(models.filter(Boolean))],
    aspectRatios: [...new Set(aspectRatios.filter(Boolean))]
  }
}

function outputImages(value: unknown): ComfyImageReference[] {
  const history = objectRecord(value)
  if (!history) return []
  const outputs = objectRecord(history.outputs)
  if (!outputs) return []
  const result: ComfyImageReference[] = []
  for (const output of Object.values(outputs)) {
    const images = objectRecord(output)?.images
    if (!Array.isArray(images)) continue
    for (const image of images) {
      const item = objectRecord(image)
      if (typeof item?.filename !== 'string') continue
      result.push({
        filename: item.filename,
        subfolder: typeof item.subfolder === 'string' ? item.subfolder : '',
        type: typeof item.type === 'string' ? item.type : 'output'
      })
    }
  }
  return result
}

function imageMimeType(filename: string): string {
  if (/\.jpe?g$/i.test(filename)) return 'image/jpeg'
  if (/\.webp$/i.test(filename)) return 'image/webp'
  return 'image/png'
}

export async function runComfyWorkflow(
  baseUrlValue: string,
  workflow: ComfyWorkflow,
  prompt: string,
  steps: number,
  size: {
    width: number
    height: number
    aspectRatio?: string
    megapixels?: number
    multiple?: number
  },
  checkpoint: string,
  outputDirectory: string,
  signal: AbortSignal,
  onProgress: (message: string) => void
): Promise<ChatAttachment[]> {
  const baseUrl = normalizeBaseUrl(baseUrlValue)
  const graph = structuredClone(workflow.workflow)
  graph[workflow.promptNodeId].inputs[workflow.promptInputName] = prompt
  graph[workflow.stepsNodeId].inputs[workflow.stepsInputName] = Math.max(
    1,
    Math.min(200, Math.round(steps))
  )
  if (workflow.widthNodeId && workflow.widthInputName && graph[workflow.widthNodeId]) {
    graph[workflow.widthNodeId].inputs[workflow.widthInputName] = Math.max(
      64,
      Math.min(8192, Math.round(size.width))
    )
  }
  if (workflow.heightNodeId && workflow.heightInputName && graph[workflow.heightNodeId]) {
    graph[workflow.heightNodeId].inputs[workflow.heightInputName] = Math.max(
      64,
      Math.min(8192, Math.round(size.height))
    )
  }
  if (
    workflow.aspectRatioNodeId &&
    workflow.aspectRatioInputName &&
    graph[workflow.aspectRatioNodeId] &&
    size.aspectRatio
  ) {
    graph[workflow.aspectRatioNodeId].inputs[workflow.aspectRatioInputName] =
      size.aspectRatio
  }
  if (
    workflow.megapixelsNodeId &&
    workflow.megapixelsInputName &&
    graph[workflow.megapixelsNodeId] &&
    Number.isFinite(size.megapixels)
  ) {
    graph[workflow.megapixelsNodeId].inputs[workflow.megapixelsInputName] = Math.max(
      0.1,
      Math.min(64, Number(size.megapixels))
    )
  }
  if (
    workflow.multipleNodeId &&
    workflow.multipleInputName &&
    graph[workflow.multipleNodeId] &&
    Number.isFinite(size.multiple)
  ) {
    graph[workflow.multipleNodeId].inputs[workflow.multipleInputName] = Math.max(
      1,
      Math.min(1024, Math.round(Number(size.multiple)))
    )
  }
  graph[workflow.modelNodeId].inputs[workflow.modelInputName] = checkpoint

  const randomSeed = Math.floor(Math.random() * 2_147_483_647)
  for (const node of Object.values(graph)) {
    if (typeof node.inputs.seed === 'number') node.inputs.seed = randomSeed
    if (typeof node.inputs.noise_seed === 'number') node.inputs.noise_seed = randomSeed
  }

  const clientId = crypto.randomUUID()
  const response = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: clientId }),
    signal
  })
  const queued = objectRecord(await response.json())
  if (!response.ok || typeof queued?.prompt_id !== 'string') {
    const detail = queued?.node_errors
      ? JSON.stringify(queued.node_errors).slice(0, 2000)
      : `HTTP ${response.status}`
    throw new Error(`ComfyUI 拒绝了工作流：${detail}`)
  }

  const promptId = queued.prompt_id
  const startedAt = Date.now()
  while (!signal.aborted && Date.now() - startedAt < 10 * 60 * 1000) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1000)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(new Error('图片生成已停止'))
        },
        { once: true }
      )
    })
    const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
    onProgress(`ComfyUI 正在生成 · ${elapsed} 秒`)
    const historyResponse = await fetch(`${baseUrl}/history/${promptId}`, { signal })
    if (!historyResponse.ok) continue
    const allHistory = objectRecord(await historyResponse.json())
    const item = objectRecord(allHistory?.[promptId])
    if (!item) continue
    const references = outputImages(item)
    const status = objectRecord(item.status)
    if (!references.length && status?.completed !== true) continue
    if (!references.length) throw new Error('工作流已经结束，但没有返回图片输出')

    const attachments: ChatAttachment[] = []
    for (const reference of references) {
      const query = new URLSearchParams({
        filename: reference.filename,
        subfolder: reference.subfolder ?? '',
        type: reference.type ?? 'output'
      })
      const imageResponse = await fetch(`${baseUrl}/view?${query}`, { signal })
      if (!imageResponse.ok) continue
      const bytes = Buffer.from(await imageResponse.arrayBuffer())
      const mimeType = imageResponse.headers.get('content-type') || imageMimeType(reference.filename)
      await fs.mkdir(outputDirectory, { recursive: true })
      const extension = path.extname(reference.filename) || '.png'
      const cleanBase =
        path.basename(reference.filename, extension).replace(/[^\p{L}\p{N}._-]+/gu, '_') ||
        'generated'
      const localPath = path.join(
        outputDirectory,
        `${Date.now()}-${crypto.randomUUID()}-${cleanBase}${extension}`
      )
      await fs.writeFile(localPath, bytes)
      const localUrl = pathToFileURL(localPath).toString().replace(/^file:/, 'local-file:')
      attachments.push({
        name: reference.filename,
        kind: 'image',
        mimeType,
        size: bytes.length,
        data: localUrl,
        thumbnail: localUrl
      })
    }
    if (attachments.length) return attachments
    throw new Error('ComfyUI 图片读取失败')
  }
  if (signal.aborted) throw new Error('图片生成已停止')
  throw new Error('ComfyUI 图片生成超时')
}

export async function interruptComfy(baseUrlValue: string): Promise<void> {
  const baseUrl = normalizeBaseUrl(baseUrlValue)
  await fetch(`${baseUrl}/interrupt`, { method: 'POST' }).catch(() => undefined)
}

export async function freeComfyMemory(baseUrlValue: string): Promise<void> {
  const baseUrl = normalizeBaseUrl(baseUrlValue)
  const response = await fetch(`${baseUrl}/free`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unload_models: true, free_memory: true })
  })
  if (!response.ok) throw new Error(`ComfyUI 卸载模型失败：HTTP ${response.status}`)
}
