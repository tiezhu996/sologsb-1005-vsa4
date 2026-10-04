export type Role = 'author' | 'examiner' | 'viewer'

export interface Claim {
  id: string
  number: number
  title: string
  text: string
  independent: boolean
}

export interface Paragraph {
  id: string
  section: string
  text: string
}

export interface Feature {
  id: string
  claimId: string
  label: string
  text: string
  parentId: string | null
  referenceIds: string[]
  supportIds: string[]
  ownerRole: Role
}

export interface Annotation {
  id: string
  featureId: string
  authorRole: Role
  authorName: string
  text: string
  updatedAt: string
}

export interface OrphanMapping {
  id: string
  featureLabel: string
  paragraphId: string
  reason: string
}

export interface ClaimVersion {
  id: string
  name: string
  createdAt: string
  claims: Claim[]
  features: Feature[]
}

export interface Position {
  tab: string
  claimId: string
  featureId: string | null
  scrollY: number
}

export interface WorkbenchState {
  claims: Claim[]
  paragraphs: Paragraph[]
  features: Feature[]
  annotations: Annotation[]
  orphanMappings: OrphanMapping[]
  versions: ClaimVersion[]
  role: Role
  selectedClaimId: string
  selectedFeatureId: string | null
  activeTab: string
  currentUserRole: Role
}

export interface ValidationIssue {
  id: string
  severity: 'error' | 'warning'
  type: 'cycle' | 'missing-support' | 'orphan-mapping' | 'empty-feature'
  featureId?: string
  title: string
  detail: string
}

// ===== 冻结案件包 / 复核变更单 / 合并会话 =====

export type ReviewEntityType = 'claim' | 'feature' | 'supportMapping'
export type ReviewOperation = 'add' | 'update' | 'remove'

/** 冻结基线快照：外部复核员拿到的整包内容 */
export interface SnapshotData {
  claims: Claim[]
  features: Feature[]
  paragraphs: Paragraph[]
}

export interface FrozenPackage {
  kind: 'frozen-package'
  packageId: string
  caseCode: string
  createdAt: string
  createdBy: Role
  createdByName: string
  note: string
  snapshot: SnapshotData
  checksum: string
}

/** 变更单条目：按权利要求 / 技术特征 / 支持映射记录三类变化 */
export interface ChangeEntry {
  entity: ReviewEntityType
  entityId: string
  operation: ReviewOperation
  claimId?: string
  featureId?: string
  paragraphId?: string
  before?: unknown
  after?: unknown
}

export interface ChangeOrder {
  kind: 'change-order'
  orderId: string
  baselinePackageId: string
  caseCode: string
  reviewerName: string
  createdAt: string
  note: string
  entries: ChangeEntry[]
  checksum: string
}

/** 待决区条目状态：干净可直接采用 / 对象已移除 / 两边都改过 / 冗余无变化 */
export type MergeStatus =
  | 'clean'
  | 'pending-local-removed'
  | 'pending-both-modified'
  | 'redundant'

export type MergeResolution = 'pending' | 'take-external' | 'keep-local'

export interface MergeItem {
  id: string
  entity: ReviewEntityType
  entityId: string
  operation: ReviewOperation
  status: MergeStatus
  resolution: MergeResolution
  title: string
  detail: string
  claimId?: string
  featureId?: string
  paragraphId?: string
  baselineObject?: unknown
  localObject?: unknown
  externalObject?: unknown
  resolvedByName?: string
  resolvedAt?: string
  resolutionNote?: string
}

export type MergeSessionStatus = 'active' | 'confirmed' | 'discarded'

export interface MergeSession {
  id: string
  orderId: string
  baselinePackageId: string
  reviewerName: string
  importedAt: string
  status: MergeSessionStatus
  items: MergeItem[]
  confirmedAt?: string
  confirmedByName?: string
  newBaselinePackageId?: string
  discardedAt?: string
}

export type ProcessingRecordKind =
  | 'legacy-upgraded'
  | 'package-frozen'
  | 'order-imported'
  | 'item-resolved'
  | 'merge-confirmed'
  | 'merge-discarded'
  | 'storage-recovered'
  | 'storage-failed'

export interface ProcessingRecord {
  id: string
  at: string
  kind: ProcessingRecordKind
  detail: string
  relatedId?: string
  actorName?: string
}

/** 独立留存库：旧冻结包、变更单、处理记录单独保管 */
export interface ReviewArchive {
  packages: Record<string, FrozenPackage>
  orders: Record<string, ChangeOrder>
  sessions: Record<string, MergeSession>
  records: ProcessingRecord[]
}

/** 离线复核员本机暂存：依据冻结包修改，关闭重开可继续，最终导出变更单 */
export interface OfflineReviewDraft {
  packageId: string
  caseCode: string
  reviewerName: string
  note: string
  savedAt: string
  reviewed: SnapshotData
}

export interface StorageNotice {
  id: string
  kind: 'recovered' | 'failed' | 'migrated'
  message: string
  at: string
}

/** v2 案件仓库：可编辑案卷 + 冻结基线 + 会话 + 记录 */
export interface CaseRepositoryV2 {
  schemaVersion: 2
  caseCode: string
  workbench: WorkbenchState
  currentBaselinePackageId: string | null
  frozenPackages: FrozenPackage[]
  sessions: MergeSession[]
  records: ProcessingRecord[]
  activeSessionId: string | null
  migratedFromLegacy: boolean
  /** 除 checksum 外整个仓库的稳定哈希，写后回读校验用 */
  checksum: string
}
