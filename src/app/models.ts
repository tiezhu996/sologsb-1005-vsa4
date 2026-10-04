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

/* ------------------------------------------------------------------ */
/* 外部复核：冻结案件包 / 复核变更单 / 待决合并                          */
/* ------------------------------------------------------------------ */

/** 支持映射记录：某技术特征对某说明书段落的一条依据 */
export interface SupportMapping {
  featureId: string
  paragraphId: string
}

export type ReviewEntityKind = 'claim' | 'feature' | 'mapping'
export type ReviewEntityOp = 'add' | 'update' | 'remove'

/** 变更单中的单条变化（按权利要求 / 技术特征 / 支持映射记录） */
export interface ChangeRecord {
  kind: ReviewEntityKind
  op: ReviewEntityOp
  /** claim / feature 为对象 id；mapping 为 `${featureId}⇄${paragraphId}` */
  entityId: string
  baselineHash: string | null
  proposedHash: string | null
  claim?: Claim
  feature?: Feature
  mapping?: SupportMapping
  note?: string
}

/** 冻结案件包：外发的不可变基线 */
export interface FrozenPackage {
  fileType: 'patent-frozen-package'
  formatVersion: 1
  packageId: string
  frozenAt: string
  frozenBy: Role
  caseTitle: string
  baselineHash: string
  claims: Claim[]
  paragraphs: Paragraph[]
  features: Feature[]
}

/** 复核变更单：外部只回传变化项 */
export interface ChangeOrder {
  fileType: 'patent-change-order'
  formatVersion: 1
  orderId: string
  packageId: string
  baselineHash: string
  reviewerName: string
  exportedAt: string
  summary: string
  changes: ChangeRecord[]
}

/** 复核界面位置（随会话持久化，重开可接着处理） */
export interface ReviewUiSelection {
  tab: string
  claimId: string
  featureId: string | null
}

/** 本机留存的复核会话（离线复核员在本机可直接复核，也可凭冻结包在外部电脑复核） */
export interface ReviewSession {
  sessionId: string
  packageId: string
  packageSummary: {
    frozenAt: string
    caseTitle: string
    claimCount: number
    featureCount: number
    mappingCount: number
  }
  startedAt: string
  workingClaims: Claim[]
  workingFeatures: Feature[]
  /** 复核上下文随包携带；支持映射只存在 feature.supportIds 中，段落不允许复核员改动 */
  contextParagraphs: Paragraph[]
  reviewerName: string
  ui: ReviewUiSelection
}

export type MergeStatus = 'auto' | 'pending' | 'accepted' | 'rejected'
export type PendingReason =
  | 'source-removed'
  | 'both-changed'
  | 'missing-parent'
  | 'target-missing'
  | 'mapping-target-missing'
  | 'mapping-feature-pending'

export interface MergeItem {
  index: number
  change: ChangeRecord
  status: MergeStatus
  reason: PendingReason | null
  detail: string
  /** 逐项决议：accept = 采用变更单，reject = 保留本机现状 */
  resolution: 'accept' | 'reject' | null
  resolvedAt: string | null
}

export type MergeSessionState = 'open' | 'confirmed' | 'discarded'

export interface MergeSession {
  sessionId: string
  orderId: string
  packageId: string
  baselineHash: string
  importedAt: string
  importedFrom: string
  reviewerName: string
  state: MergeSessionState
  items: MergeItem[]
  /** 确认合并时的处理记录 id */
  recordId?: string
}

export type RecordAction =
  | 'legacy-upgrade'
  | 'freeze'
  | 'review-start'
  | 'review-export'
  | 'review-discard'
  | 'import'
  | 'resolve'
  | 'merge-confirm'
  | 'merge-discard'
  | 'storage-recovered'

/** 处理记录：每次关键动作独立留痕 */
export interface ProcessingRecord {
  id: string
  at: string
  action: RecordAction
  detail: string
  refId?: string
}

export interface StorageFault {
  since: string
  lastError: string
}

/** 冻结包 / 变更单归档（确认后原件不可变地独立留存） */
export interface FrozenArchiveEntry {
  archivedAt: string
  pkg: FrozenPackage
}
export interface OrderArchiveEntry {
  archivedAt: string
  order: ChangeOrder
  mergeSessionId: string | null
}

/** v2 持久化信封：整包升级后统一结构，任何写入失败都保留上一版完整案卷 */
export interface PersistEnvelopeV2 {
  format: 'patent-workbench-v2'
  version: 2
  caseState: WorkbenchState
  /** 历次冻结案件包原件，独立留存、不可变 */
  frozenPackages: FrozenArchiveEntry[]
  reviewSession: ReviewSession | null
  mergeSessions: MergeSession[]
  /** 历次回传的复核变更单原件，独立留存 */
  orderArchives: OrderArchiveEntry[]
  processingRecords: ProcessingRecord[]
  activeMode: 'case' | 'review'
  storageFault: StorageFault | null
}
