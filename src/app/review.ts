import type {
  ChangeOrder, ChangeRecord, Claim, Feature, FrozenPackage,
  MergeItem, Paragraph, PendingReason, SupportMapping
} from './models'

/* ----------------------------- 哈希工具 ----------------------------- */

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

/** FNV-1a 64 位（用两个 32 位表示），碰撞概率足够支撑逐项基线比对 */
export function hashOf(value: unknown): string {
  const text = stableStringify(value)
  let hi = 0x811c9dc5
  let lo = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    hi ^= code
    lo ^= code
    hi = Math.imul(hi, 0x01000193) >>> 0
    lo = Math.imul(lo, 0x01000193) >>> 0
  }
  return `${hi.toString(16).padStart(8, '0')}${lo.toString(16).padStart(8, '0')}`
}

export const claimHash = (claim: Claim): string => hashOf(claim)
/**
 * 技术特征哈希只覆盖特征本体（不含 supportIds）：
 * 支持依据的变化一律以 mapping 记录承载，避免同一变化在“特征修改”和“映射增删”中重复。
 */
export const featureHash = (feature: Feature): string => {
  const { supportIds: _ignored, ...body } = feature
  return hashOf(body)
}
export const mappingHash = (mapping: SupportMapping): string => hashOf(mapping)

export const mappingEntityId = (featureId: string, paragraphId: string): string => `${featureId}⇄${paragraphId}`
export const parseMappingEntityId = (id: string): SupportMapping | null => {
  const sep = id.indexOf('⇄')
  if (sep < 0) return null
  return { featureId: id.slice(0, sep), paragraphId: id.slice(sep + 1) }
}

/* --------------------------- 基线快照/哈希 --------------------------- */

export interface BaselineIndex {
  claims: Map<string, Claim>
  features: Map<string, Feature>
  mappings: Map<string, SupportMapping>
}

export function mappingsOf(features: Feature[]): SupportMapping[] {
  const result: SupportMapping[] = []
  for (const feature of features) {
    for (const paragraphId of feature.supportIds) {
      result.push({ featureId: feature.id, paragraphId })
    }
  }
  return result
}

export function indexOf(claims: Claim[], features: Feature[]): BaselineIndex {
  return {
    claims: new Map(claims.map(item => [item.id, item])),
    features: new Map(features.map(item => [item.id, item])),
    mappings: new Map(mappingsOf(features).map(item => [mappingEntityId(item.featureId, item.paragraphId), item]))
  }
}

/** 整个冻结基线的哈希，导入时必须与变更单声明的一致 */
export function baselineHash(claims: Claim[], features: Feature[]): string {
  return hashOf({ claims, features })
}

/* ----------------------------- 生成变更单 ----------------------------- */

/**
 * 以冻结基线为基准，比对复核工作副本，仅记录变化项：
 * 权利要求、技术特征、支持映射记录三类，op ∈ add / update / remove。
 */
export function diffAgainstBaseline(pkg: FrozenPackage, workingClaims: Claim[], workingFeatures: Feature[]): ChangeRecord[] {
  const base = indexOf(pkg.claims, pkg.features)
  const next = indexOf(workingClaims, workingFeatures)
  const records: ChangeRecord[] = []

  for (const [id, before] of base.claims) {
    const after = next.claims.get(id)
    if (!after) {
      records.push({ kind: 'claim', op: 'remove', entityId: id, baselineHash: claimHash(before), proposedHash: null })
    } else if (claimHash(after) !== claimHash(before)) {
      records.push({ kind: 'claim', op: 'update', entityId: id, baselineHash: claimHash(before), proposedHash: claimHash(after), claim: after })
    }
  }
  for (const [id, after] of next.claims) {
    if (!base.claims.has(id)) {
      records.push({ kind: 'claim', op: 'add', entityId: id, baselineHash: null, proposedHash: claimHash(after), claim: after })
    }
  }

  for (const [id, before] of base.features) {
    const after = next.features.get(id)
    if (!after) {
      records.push({ kind: 'feature', op: 'remove', entityId: id, baselineHash: featureHash(before), proposedHash: null })
    } else if (featureHash(after) !== featureHash(before)) {
      records.push({ kind: 'feature', op: 'update', entityId: id, baselineHash: featureHash(before), proposedHash: featureHash(after), feature: after })
    }
  }
  for (const [id, after] of next.features) {
    if (!base.features.has(id)) {
      records.push({ kind: 'feature', op: 'add', entityId: id, baselineHash: null, proposedHash: featureHash(after), feature: after })
    }
  }

  for (const [id, before] of base.mappings) {
    const after = next.mappings.get(id)
    if (!after) {
      records.push({ kind: 'mapping', op: 'remove', entityId: id, baselineHash: mappingHash(before), proposedHash: null, mapping: before })
    }
  }
  for (const [id, after] of next.mappings) {
    if (!base.mappings.has(id)) {
      records.push({ kind: 'mapping', op: 'add', entityId: id, baselineHash: null, proposedHash: mappingHash(after), mapping: after })
    }
  }

  return records
}

/* --------------------------- 导入：逐项三向比对 --------------------------- */

export interface ImportInput {
  order: ChangeOrder
  currentClaims: Claim[]
  currentFeatures: Feature[]
  currentParagraphs: Paragraph[]
  importedAt: string
}

/**
 * 逐项把变更单与冻结基线、本机现状比对：
 * - 与基线一致且本机未动 / 仅本机未动该对象 → auto（可直接合入）
 * - 原对象已在本机移除 → pending(source-removed)
 * - 基线与现状都被改过（两边都改）→ pending(both-changed)
 * - 其它引用缺失问题 → pending，等待人工逐项决议
 * 任何 pending 项都不许直接写入可编辑案卷。
 */
export function classifyMerge(input: ImportInput): MergeItem[] {
  const { order, currentClaims, currentFeatures, currentParagraphs } = input
  const current = indexOf(currentClaims, currentFeatures)
  // 同一张变更单内即将新增的权利要求 / 技术特征：其同单映射不应被误判为“目标不存在”
  const claimsAddedInOrder = new Set(order.changes
    .filter(c => c.kind === 'claim' && c.op === 'add' && c.claim).map(c => c.entityId))
  const featuresAddedInOrder = new Set(order.changes
    .filter(c => c.kind === 'feature' && c.op === 'add' && c.feature).map(c => c.entityId))
  const paragraphExists = (id: string) => currentParagraphs.some(p => p.id === id)
  const claimWillExist = (id: string) => current.claims.has(id) || claimsAddedInOrder.has(id)
  const featureWillExist = (id: string) => current.features.has(id) || featuresAddedInOrder.has(id)
  const items: MergeItem[] = []

  order.changes.forEach((change, index) => {
    let status: MergeItem['status'] = 'auto'
    let reason: PendingReason | null = null
    let detail = ''

    if (change.kind === 'claim') {
      const currentClaim = current.claims.get(change.entityId)
      if (change.op === 'add') {
        if (currentClaim) {
          if (claimHash(currentClaim) !== (change.proposedHash ?? '')) {
            status = 'pending'; reason = 'both-changed'
            detail = '变更单新增的权利要求编号已被本机占用，且两边内容不同。'
          } else {
            detail = '该新增权利要求与本机现有内容完全一致。'
          }
        } else {
          detail = '新增权利要求，本机不存在冲突。'
        }
      } else if (change.op === 'remove') {
        if (!currentClaim) {
          detail = '本机已移除该权利要求，结果一致。'
        } else if (claimHash(currentClaim) !== (change.baselineHash ?? '')) {
          status = 'pending'; reason = 'both-changed'
          detail = '复核端要求删除，但本机在冻结后修改过该权利要求。'
        } else {
          detail = '该权利要求自冻结后本机未改动，可按变更单删除。'
        }
      } else {
        if (!currentClaim) {
          status = 'pending'; reason = 'source-removed'
          detail = '原权利要求在本机已被移除，无法直接套用复核修改。'
        } else if (claimHash(currentClaim) !== (change.baselineHash ?? '')) {
          status = 'pending'; reason = 'both-changed'
          detail = '冻结后本机与复核端都修改过该权利要求。'
        } else {
          detail = '该权利要求冻结后仅复核端修改，本机仍是基线版本。'
        }
      }
    }

    if (change.kind === 'feature') {
      const currentFeature = current.features.get(change.entityId)
      if (change.op === 'add') {
        if (currentFeature) {
          if (featureHash(currentFeature) !== (change.proposedHash ?? '')) {
            status = 'pending'; reason = 'both-changed'
            detail = '变更单新增的技术特征 id 已被本机占用，且两边内容不同。'
          } else {
            detail = '该新增技术特征与本机现有内容完全一致。'
          }
        } else if (change.feature && !claimWillExist(change.feature.claimId)) {
          status = 'pending'; reason = 'missing-parent'
          detail = '新增技术特征所属的权利要求在本机与变更单中均不存在。'
        } else {
          detail = '新增技术特征，本机不存在冲突。'
        }
      } else if (change.op === 'remove') {
        if (!currentFeature) {
          detail = '本机已移除该技术特征，结果一致。'
        } else if (featureHash(currentFeature) !== (change.baselineHash ?? '')) {
          status = 'pending'; reason = 'both-changed'
          detail = '复核端要求删除，但本机在冻结后修改过该技术特征。'
        } else {
          detail = '该技术特征自冻结后本机未改动，可按变更单删除。'
        }
      } else {
        if (!currentFeature) {
          status = 'pending'; reason = 'source-removed'
          detail = '原技术特征在本机已被移除，无法直接套用复核修改。'
        } else if (featureHash(currentFeature) !== (change.baselineHash ?? '')) {
          status = 'pending'; reason = 'both-changed'
          detail = '冻结后本机与复核端都修改过该技术特征。'
        } else if (change.feature && !claimWillExist(change.feature.claimId)) {
          status = 'pending'; reason = 'missing-parent'
          detail = '修改后的技术特征所属权利要求在本机与变更单中均不存在。'
        } else {
          detail = '该技术特征冻结后仅复核端修改，本机仍是基线版本。'
        }
      }
    }

    if (change.kind === 'mapping') {
      const mapping = change.mapping ?? parseMappingEntityId(change.entityId)
      const currentMapping = mapping ? current.mappings.get(mappingEntityId(mapping.featureId, mapping.paragraphId)) : undefined
      if (!mapping) {
        status = 'pending'; reason = 'target-missing'
        detail = '无法解析支持映射记录的标识。'
      } else if (change.op === 'add') {
        if (currentMapping) {
          detail = '该支持映射本机已存在，结果一致。'
        } else {
          if (!paragraphExists(mapping.paragraphId)) {
            status = 'pending'; reason = 'mapping-target-missing'
            detail = `支持段落 ${mapping.paragraphId} 在本机说明书中不存在，无法建立映射。`
          } else if (!featureWillExist(mapping.featureId)) {
            status = 'pending'; reason = 'mapping-feature-pending'
            detail = '映射所属技术特征在本机与变更单中均不存在。'
          } else {
            detail = '新增支持映射，本机不存在冲突。'
          }
        }
      } else {
        // remove
        if (!currentMapping) {
          detail = '该支持映射本机已不存在，结果一致。'
        } else if (!featureWillExist(mapping.featureId)) {
          status = 'pending'; reason = 'mapping-feature-pending'
          detail = '映射所属技术特征在本机与变更单中均不存在，需人工确认。'
        } else {
          detail = '该支持映射可按变更单移除。'
        }
      }
    }

    items.push({
      index,
      change,
      status,
      reason,
      detail,
      resolution: status === 'auto' ? null : null,
      resolvedAt: null
    })
  })

  return items
}

/* --------------------- 应用已决议条目到工作副本 --------------------- */

export interface ApplyResult {
  claims: Claim[]
  features: Feature[]
}

/**
 * 按复核员决议把条目落到副本上。只应用 status=auto 或 resolution=accept 的条目；
 * resolution=reject 表示保留本机现状。调用方必须保证已无未决项。
 */
export function applyResolvedItems(
  currentClaims: Claim[],
  currentFeatures: Feature[],
  items: MergeItem[]
): ApplyResult {
  const claims = structuredClone(currentClaims)
  const features = structuredClone(currentFeatures)
  const claimById = new Map(claims.map(item => [item.id, item]))
  const featureById = new Map(features.map(item => [item.id, item]))

  const effective = items.filter(item => item.status === 'auto' || item.resolution === 'accept')

  // 先处理权利要求与技术特征本体，最后统一处理映射，保证引用顺序
  for (const item of effective) {
    const change = item.change
    if (change.kind === 'claim') {
      if (change.op === 'add' && change.claim && !claimById.has(change.entityId)) {
        claims.push(structuredClone(change.claim))
        claimById.set(change.entityId, change.claim)
      } else if (change.op === 'remove') {
        const pos = claims.findIndex(candidate => candidate.id === change.entityId)
        if (pos >= 0) {
          claims.splice(pos, 1)
          claimById.delete(change.entityId)
        }
      } else if (change.op === 'update' && change.claim) {
        const target = claimById.get(change.entityId)
        if (target) Object.assign(target, structuredClone(change.claim))
      }
    }
  }

  for (const item of effective) {
    const change = item.change
    if (change.kind !== 'feature') continue
    if (change.op === 'add' && change.feature && !featureById.has(change.entityId)) {
      // 新增特征先不带 supportIds：其依据一律由同单 mapping add 记录填入，
      // 避免特征对象里携带的快照与映射记录重复生效
      const { supportIds: _ignored, ...body } = structuredClone(change.feature)
      const added: Feature = { ...body, supportIds: [] }
      features.push(added)
      featureById.set(added.id, added)
    } else if (change.op === 'remove') {
      const pos = features.findIndex(candidate => candidate.id === change.entityId)
      if (pos >= 0) {
        features.splice(pos, 1)
        featureById.delete(change.entityId)
      }
    } else if (change.op === 'update' && change.feature) {
      const target = featureById.get(change.entityId)
      if (target) {
        // 只采纳特征本体字段，绝不整体覆盖 supportIds，防止冲掉冻结后本机新增的依据
        const { supportIds: _ignored, ...body } = structuredClone(change.feature)
        Object.assign(target, body)
      }
    }
  }

  // 清理被接受的特征删除 / 权利要求删除带来的悬挂关系
  for (const feature of features) {
    if (feature.parentId && !featureById.has(feature.parentId)) feature.parentId = null
    feature.referenceIds = feature.referenceIds.filter(id => featureById.has(id))
    if (!claimById.has(feature.claimId)) {
      feature.claimId = claims[0]?.id ?? feature.claimId
    }
  }

  for (const item of effective) {
    const change = item.change
    if (change.kind !== 'mapping' || !change.mapping) continue
    const { featureId, paragraphId } = change.mapping
    const target = featureById.get(featureId)
    if (!target) continue
    if (change.op === 'add') {
      if (paragraphId && !target.supportIds.includes(paragraphId)) target.supportIds.push(paragraphId)
    } else {
      target.supportIds = target.supportIds.filter(id => id !== paragraphId)
    }
  }

  return { claims, features }
}

/** 校验导入文件基本形状，返回可读错误信息；合法返回 null */
export function validateChangeOrder(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return '文件不是有效的变更单 JSON。'
  const order = raw as Partial<ChangeOrder>
  if (order.fileType !== 'patent-change-order') return '文件类型不是“复核变更单”。'
  if (order.formatVersion !== 1) return `不支持的变更单版本：${String(order.formatVersion)}。`
  if (!order.packageId || !order.baselineHash) return '变更单缺少冻结包标识或基线哈希。'
  if (!Array.isArray(order.changes)) return '变更单缺少变化记录列表。'
  return null
}

export function validateFrozenPackage(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return '文件不是有效的冻结包 JSON。'
  const pkg = raw as Partial<FrozenPackage>
  if (pkg.fileType !== 'patent-frozen-package') return '文件类型不是“冻结案件包”。'
  if (pkg.formatVersion !== 1) return `不支持的冻结包版本：${String(pkg.formatVersion)}。`
  if (!pkg.packageId || !pkg.baselineHash || !Array.isArray(pkg.claims) || !Array.isArray(pkg.features)) {
    return '冻结包内容不完整。'
  }
  return null
}
