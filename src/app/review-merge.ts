import type {
  ChangeEntry,
  ChangeOrder,
  Feature,
  FrozenPackage,
  MergeItem,
  MergeSession,
  Paragraph,
  Claim,
  ReviewArchive,
  SnapshotData
} from './models'

// ---- 稳定序列化与校验和（FNV-1a，离线可用，无需 crypto） ----

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

export function checksum(value: unknown): string {
  const text = stableStringify(value)
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// ---- 集合工具 ----

type Entity = Claim | Feature | Paragraph

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map(item => [item.id, item]))
}

function sameObject(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}

// ---- 冻结案件包 ----

export function buildFrozenPackage(params: {
  packageId: string
  caseCode: string
  createdAt: string
  createdBy: FrozenPackage['createdBy']
  createdByName: string
  note: string
  snapshot: SnapshotData
}): FrozenPackage {
  const pkg: FrozenPackage = {
    kind: 'frozen-package',
    packageId: params.packageId,
    caseCode: params.caseCode,
    createdAt: params.createdAt,
    createdBy: params.createdBy,
    createdByName: params.createdByName,
    note: params.note,
    snapshot: params.snapshot,
    checksum: ''
  }
  pkg.checksum = checksum({ ...pkg, checksum: undefined })
  return pkg
}

export function verifyPackage(pkg: FrozenPackage): boolean {
  if (pkg.kind !== 'frozen-package') return false
  const { checksum: expected, ...rest } = pkg
  return checksum(rest) === expected
}

export function snapshotFrom(claims: Claim[], features: Feature[], paragraphs: Paragraph[]): SnapshotData {
  return {
    claims: claims.map(item => ({ ...item })),
    features: features.map(item => ({ ...item, referenceIds: [...item.referenceIds], supportIds: [...item.supportIds] })),
    paragraphs: paragraphs.map(item => ({ ...item }))
  }
}

// ---- 变更单：按 权利要求 / 技术特征 / 支持映射 三类逐项记录 ----

interface SupportKey {
  featureId: string
  paragraphId: string
}

function supportKeyOf(featureId: string, paragraphId: string): string {
  return `${featureId}→${paragraphId}`
}

function supportKeys(features: Feature[]): Map<string, SupportKey> {
  const map = new Map<string, SupportKey>()
  for (const feature of features) {
    for (const paragraphId of feature.supportIds) {
      map.set(supportKeyOf(feature.id, paragraphId), { featureId: feature.id, paragraphId })
    }
  }
  return map
}

export function diffSnapshots(baseline: SnapshotData, reviewed: SnapshotData): ChangeEntry[] {
  const entries: ChangeEntry[] = []

  const collect = <T extends Entity>(
    entity: ChangeEntry['entity'],
    beforeItems: T[],
    afterItems: T[],
    enrich?: (item: T) => Partial<ChangeEntry>
  ): void => {
    const beforeMap = byId(beforeItems)
    const afterMap = byId(afterItems)
    for (const [id, after] of afterMap) {
      const before = beforeMap.get(id)
      if (!before) {
        entries.push({ entity, entityId: id, operation: 'add', after: { ...after }, ...(enrich?.(after) ?? {}) })
      } else if (!sameObject(before, after)) {
        entries.push({ entity, entityId: id, operation: 'update', before: { ...before }, after: { ...after }, ...(enrich?.(after) ?? {}) })
      }
    }
    for (const [id, before] of beforeMap) {
      if (!afterMap.has(id)) {
        entries.push({ entity, entityId: id, operation: 'remove', before: { ...before }, ...(enrich?.(before) ?? {}) })
      }
    }
  }

  collect('claim', baseline.claims, reviewed.claims)
  collect('feature', baseline.features, reviewed.features, item => ({ claimId: item.claimId }))

  // 支持映射单独拆为逐项记录（特征-段落二元组）
  const beforeMappings = supportKeys(baseline.features)
  const afterMappings = supportKeys(reviewed.features)
  const baselineFeatures = byId(baseline.features)
  const reviewedFeatures = byId(reviewed.features)
  for (const [key, mapping] of afterMappings) {
    const feature = reviewedFeatures.get(mapping.featureId)
    if (!beforeMappings.has(key)) {
      entries.push({
        entity: 'supportMapping', entityId: key, operation: 'add',
        featureId: mapping.featureId, paragraphId: mapping.paragraphId, claimId: feature?.claimId,
        after: { featureId: mapping.featureId, paragraphId: mapping.paragraphId }
      })
    }
  }
  for (const [key, mapping] of beforeMappings) {
    if (!afterMappings.has(key)) {
      const feature = baselineFeatures.get(mapping.featureId)
      entries.push({
        entity: 'supportMapping', entityId: key, operation: 'remove',
        featureId: mapping.featureId, paragraphId: mapping.paragraphId, claimId: feature?.claimId,
        before: { featureId: mapping.featureId, paragraphId: mapping.paragraphId }
      })
    }
  }
  return entries
}

export function buildChangeOrder(params: {
  orderId: string
  baselinePackageId: string
  caseCode: string
  reviewerName: string
  createdAt: string
  note: string
  entries: ChangeEntry[]
}): ChangeOrder {
  const order: ChangeOrder = {
    kind: 'change-order',
    orderId: params.orderId,
    baselinePackageId: params.baselinePackageId,
    caseCode: params.caseCode,
    reviewerName: params.reviewerName,
    createdAt: params.createdAt,
    note: params.note,
    entries: params.entries,
    checksum: ''
  }
  order.checksum = checksum({ ...order, checksum: undefined })
  return order
}

export function verifyOrder(order: ChangeOrder): boolean {
  if (order.kind !== 'change-order' || !Array.isArray(order.entries)) return false
  const { checksum: expected, ...rest } = order
  return checksum(rest) === expected
}

// ---- 导入：逐项与冻结基线 + 本地现状做三方比对 ----

function describeEntry(entry: ChangeEntry, snapshot: SnapshotData): { title: string; detail: string } {
  const actionText = entry.operation === 'add' ? '新增' : entry.operation === 'remove' ? '删除' : '修改'
  if (entry.entity === 'claim') {
    const claim = (entry.after ?? entry.before) as Claim | undefined
    return { title: `权利要求 ${claim?.number ?? ''} ${claim?.title ?? entry.entityId}（${actionText}）`, detail: describeFields(entry) }
  }
  if (entry.entity === 'feature') {
    const feature = (entry.after ?? entry.before) as Feature | undefined
    const claim = snapshot.claims.find(item => item.id === feature?.claimId)
    return { title: `特征 ${feature?.label ?? entry.entityId}（${actionText}）`, detail: `归属：${claim ? `权利要求 ${claim.number}` : '未知'} · ${describeFields(entry)}` }
  }
  const feature = snapshot.features.find(item => item.id === entry.featureId)
  const paragraph = snapshot.paragraphs.find(item => item.id === entry.paragraphId)
  return {
    title: `支持映射：${feature?.label ?? entry.featureId} ↔ ${paragraph?.section ?? entry.paragraphId}（${actionText}）`,
    detail: entry.operation === 'add' ? '复核方新增该支持依据映射。' : '复核方移除该支持依据映射。'
  }
}

function describeFields(entry: ChangeEntry): string {
  if (entry.operation === 'add') return '复核方新增对象。'
  if (entry.operation === 'remove') return '复核方删除对象。'
  const changed: string[] = []
  const before = (entry.before ?? {}) as Record<string, unknown>
  const after = (entry.after ?? {}) as Record<string, unknown>
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
  const labels: Record<string, string> = {
    number: '编号', title: '名称', text: '正文', independent: '独权标记',
    label: '特征名', parentId: '父级', referenceIds: '引用', supportIds: '支持段落', claimId: '归属权项', ownerRole: '负责角色'
  }
  for (const key of keys) {
    if (!sameObject(before[key], after[key])) changed.push(labels[key] ?? key)
  }
  return changed.length ? `变更字段：${changed.join('、')}` : '内容无实质差异'
}

/**
 * 三方比对：
 * - 本地相对基线未动、外部改动 → clean（可直接采用）
 * - 外部新增且本地同 ID 已存在且不同 → 两边都改过
 * - 外部修改/删除，但本地对象已不存在 → 原对象已移除
 * - 外部修改/删除，但本地相对基线也改了同一对象 → 两边都改过
 * - 外部改动相对本地现状已无差异 → redundant（冗余）
 */
export function classifyEntries(entries: ChangeEntry[], baseline: SnapshotData, local: SnapshotData): MergeItem[] {
  const localClaims = byId(local.claims)
  const localFeatures = byId(local.features)
  const localMappings = supportKeys(local.features)

  return entries.map((entry, index) => {
    const description = describeEntry(entry, baseline)
    const base: MergeItem = {
      id: `merge-${index + 1}-${entry.entity}-${entry.entityId}`.replace(/[^\w-]/g, '_'),
      entity: entry.entity,
      entityId: entry.entityId,
      operation: entry.operation,
      status: 'clean',
      resolution: 'pending',
      title: description.title,
      detail: description.detail,
      claimId: entry.claimId,
      featureId: entry.featureId,
      paragraphId: entry.paragraphId,
      baselineObject: entry.before,
      externalObject: entry.after
    }

    if (entry.entity === 'supportMapping') {
      const key = supportKeyOf(entry.featureId!, entry.paragraphId!)
      const featureStillExists = localFeatures.has(entry.featureId!)
      if (entry.operation === 'add') {
        if (localMappings.has(key)) {
          base.status = 'redundant'
          base.detail = '本地已存在相同支持映射，变更单条目冗余。'
        } else if (!featureStillExists) {
          base.status = 'pending-local-removed'
          base.detail = '映射所指向的技术特征在本地案卷中已被移除，需人工确认。'
        }
      } else {
        if (!localMappings.has(key)) {
          if (!featureStillExists) {
            base.status = 'pending-local-removed'
            base.detail = '技术特征本地已移除，映射随之不存在，需人工确认。'
          } else {
            base.status = 'redundant'
            base.detail = '本地已移除该支持映射，变更单条目冗余。'
          }
        }
      }
      base.localObject = localMappings.has(key)
        ? { featureId: entry.featureId, paragraphId: entry.paragraphId }
        : undefined
      return base
    }

    const localMap = entry.entity === 'claim' ? localClaims : localFeatures
    const baselineMap = entry.entity === 'claim' ? byId(baseline.claims) : byId(baseline.features)
    const localObject = localMap.get(entry.entityId)
    const baselineObject = baselineMap.get(entry.entityId)
    base.localObject = localObject ? { ...localObject } : undefined

    if (entry.operation === 'add') {
      if (localObject) {
        if (sameObject(localObject, entry.after)) {
          base.status = 'redundant'
          base.detail = '本地已存在内容一致的对象，变更单条目冗余。'
        } else {
          base.status = 'pending-both-modified'
          base.detail = '复核方新增的对象 ID 与本地对象冲突且内容不同，需人工确认。'
        }
      }
      return base
    }

    if (!localObject) {
      base.status = 'pending-local-removed'
      base.detail = '该对象在本地案卷中已被移除，不能直接写入，需人工确认。'
      return base
    }

    const localChangedFromBaseline = !baselineObject || !sameObject(baselineObject, localObject)
    if (entry.operation === 'update') {
      if (sameObject(localObject, entry.after)) {
        base.status = 'redundant'
        base.detail = '本地内容与复核方结果一致，变更单条目冗余。'
      } else if (localChangedFromBaseline) {
        base.status = 'pending-both-modified'
        base.detail = '本地与复核方都修改了该对象，需人工确认保留哪一版。'
      }
      return base
    }

    // remove
    if (localChangedFromBaseline) {
      base.status = 'pending-both-modified'
      base.detail = '复核方要求删除，但本地在冻结后修改过该对象，需人工确认。'
    }
    return base
  })
}

export function createMergeSession(params: {
  sessionId: string
  order: ChangeOrder
  items: MergeItem[]
  importedAt: string
}): MergeSession {
  return {
    id: params.sessionId,
    orderId: params.order.orderId,
    baselinePackageId: params.order.baselinePackageId,
    reviewerName: params.order.reviewerName,
    importedAt: params.importedAt,
    status: 'active',
    items: params.items
  }
}

// ---- 确认合并：按裁决结果逐项应用，生成可编辑案卷 ----

export interface MergeApplyResult {
  claims: Claim[]
  features: Feature[]
}

export interface MergeResolutionInput {
  itemId: string
  resolution: Extract<MergeItem['resolution'], 'take-external' | 'keep-local'>
  resolvedByName: string
  resolvedAt: string
  note?: string
}

export function resolveItems(items: MergeItem[], inputs: MergeResolutionInput[]): MergeItem[] {
  const map = new Map(inputs.map(input => [input.itemId, input]))
  return items.map(item => {
    const decision = map.get(item.id)
    if (!decision) return item
    return {
      ...item,
      resolution: decision.resolution,
      resolvedByName: decision.resolvedByName,
      resolvedAt: decision.resolvedAt,
      resolutionNote: decision.note
    }
  })
}

export function pendingCount(items: MergeItem[]): number {
  return items.filter(item => item.status.startsWith('pending-') && item.resolution === 'pending').length
}

export function applyMerge(
  data: { claims: Claim[]; features: Feature[] },
  items: MergeItem[]
): MergeApplyResult {
  const claims = data.claims.map(item => ({ ...item }))
  const features = data.features.map(item => ({ ...item, referenceIds: [...item.referenceIds], supportIds: [...item.supportIds] }))

  const adopt = (item: MergeItem): boolean => item.status === 'clean' || item.resolution === 'take-external'

  // 先处理 claim / feature 实体，再统一处理支持映射
  for (const item of items.filter(candidate => candidate.entity !== 'supportMapping')) {
    if (!adopt(item)) continue
    if (item.entity === 'claim') {
      const next = structuredClone(item.externalObject) as Claim | undefined
      if (!next) continue
      const index = claims.findIndex(row => row.id === item.entityId)
      if (item.operation === 'remove') {
        if (index >= 0) claims.splice(index, 1)
      } else if (index < 0) {
        claims.push(next)
      } else {
        claims[index] = next
      }
    } else {
      const next = structuredClone(item.externalObject) as Feature | undefined
      if (!next) continue
      const index = features.findIndex(row => row.id === item.entityId)
      if (item.operation === 'remove') {
        if (index >= 0) features.splice(index, 1)
      } else if (index < 0) {
        features.push(next)
      } else {
        features[index] = next
      }
    }
  }

  // 应用确认后的支持映射
  for (const item of items.filter(candidate => candidate.entity === 'supportMapping')) {
    const feature = features.find(row => row.id === item.featureId)
    if (!feature) continue
    const has = feature.supportIds.includes(item.paragraphId!)
    const adopt = item.resolution === 'take-external' || item.status === 'clean'
    if (item.operation === 'add' && adopt && !has) feature.supportIds.push(item.paragraphId!)
    if (item.operation === 'remove' && adopt && has) {
      feature.supportIds = feature.supportIds.filter(id => id !== item.paragraphId)
    }
  }

  // 删除权利要求时级联清理其特征；删除特征时清理引用回指
  const validClaimIds = new Set(claims.map(item => item.id))
  const survivingFeatures = features.filter(feature => validClaimIds.has(feature.claimId))
  const validFeatureIds = new Set(survivingFeatures.map(item => item.id))
  for (const feature of survivingFeatures) {
    if (feature.parentId && !validFeatureIds.has(feature.parentId)) feature.parentId = null
    feature.referenceIds = feature.referenceIds.filter(id => validFeatureIds.has(id))
  }
  return { claims, features: survivingFeatures }
}

// ---- 归档 ----

export function emptyArchive(): ReviewArchive {
  return { packages: {}, orders: {}, sessions: {}, records: [] }
}
