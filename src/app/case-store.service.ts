import { Injectable } from '@angular/core'
import { BehaviorSubject } from 'rxjs'
import type {
  CaseRepositoryV2,
  ChangeOrder,
  FrozenPackage,
  MergeSession,
  OfflineReviewDraft,
  ProcessingRecord,
  ReviewArchive,
  StorageNotice,
  WorkbenchState
} from './models'
import {
  applyMerge,
  buildChangeOrder,
  buildFrozenPackage,
  checksum,
  classifyEntries,
  createMergeSession,
  diffSnapshots,
  emptyArchive,
  resolveItems,
  snapshotFrom,
  verifyOrder,
  verifyPackage,
  type MergeResolutionInput
} from './review-merge'

const CASE_KEY = 'patent-claim-mapping-case-v2'
const CASE_BACKUP_KEY = 'patent-claim-mapping-case-v2-backup'
const LEGACY_KEY = 'patent-claim-mapping-workbench-v1'
const ARCHIVE_KEY = 'patent-claim-mapping-archive-v1'
const ARCHIVE_BACKUP_KEY = 'patent-claim-mapping-archive-v1-backup'
const REVIEW_DRAFT_KEY = 'patent-claim-mapping-review-draft-v1'
const REVIEW_DRAFT_BACKUP_KEY = 'patent-claim-mapping-review-draft-v1-backup'
const CASE_CODE = 'CN-2026-0917'

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
function nowIso(): string { return new Date().toISOString() }
function clone<T>(value: T): T { return structuredClone(value) }

@Injectable({ providedIn: 'root' })
export class CaseStoreService {
  private repository!: CaseRepositoryV2
  private archive!: ReviewArchive
  private draft: OfflineReviewDraft | null = null
  private legacyKeyPendingRemoval = false
  private readonly repoSubject = new BehaviorSubject<CaseRepositoryV2 | null>(null)
  private readonly archiveSubject = new BehaviorSubject<ReviewArchive>(emptyArchive())
  private readonly draftSubject = new BehaviorSubject<OfflineReviewDraft | null>(null)
  private readonly noticeSubject = new BehaviorSubject<StorageNotice[]>([])
  private notices: StorageNotice[] = []

  readonly repo$ = this.repoSubject.asObservable()
  readonly archive$ = this.archiveSubject.asObservable()
  readonly draft$ = this.draftSubject.asObservable()
  readonly notices$ = this.noticeSubject.asObservable()

  constructor() {
    this.bootstrap()
  }

  // ================= 启动与原位升级 =================

  private bootstrap(): void {
    if (typeof localStorage === 'undefined') {
      this.repository = this.freshRepository(this.demoWorkbench(), false)
      this.archive = emptyArchive()
      this.publishAll()
      return
    }

    const rawMain = localStorage.getItem(CASE_KEY)
    const rawBackup = localStorage.getItem(CASE_BACKUP_KEY)
    const startupNotices: StorageNotice[] = []
    let migrated = false

    const healthy = this.pickHealthy(rawMain, rawBackup)
    if (healthy) {
      this.repository = healthy
      this.archive = this.readArchive()
      if (rawMain && !this.looksHealthy(rawMain)) {
        startupNotices.push(this.notice('recovered', '主存储中的案卷已损坏，已从上一版完整备份恢复，未处理完的待决项保留。'))
        this.archiveRecord({ kind: 'storage-recovered', detail: '启动时主库损坏，由备份库恢复上一版完整案卷。', actorName: '系统' })
      }
    } else {
      // v2 两库都不可读：旧版整包数据原位升级，否则初始化示例案卷
      const legacy = this.readJson(LEGACY_KEY)
      if (legacy && this.isLegacyState(legacy)) {
        this.repository = this.migrateLegacy(legacy)
        migrated = true
        startupNotices.push(this.notice('migrated', '旧版整包数据已原位升级为“冻结包 + 变更单”结构，并自动补建首个冻结基线。'))
      } else {
        if (rawMain || rawBackup) {
          startupNotices.push(this.notice('recovered', '案卷主库与备份均无法读取，已加载初始示例案卷；详情见处理记录。'))
        }
        this.repository = this.freshRepository(this.demoWorkbench(), false)
      }
      this.archive = this.readArchive()
      if (migrated) {
        // 升级记录与首个冻结基线同时进入独立归档库
        const migrationRecord = this.repository.records[this.repository.records.length - 1]
        if (migrationRecord) this.archive.records.push(clone(migrationRecord))
        this.repository.frozenPackages.forEach(pkg => { this.archive.packages[pkg.packageId] = clone(pkg) })
      }
    }

    this.draft = this.readHealthy<OfflineReviewDraft>(REVIEW_DRAFT_KEY, REVIEW_DRAFT_BACKUP_KEY) ?? null
    this.persistArchiveSafely()

    if (migrated) {
      // 升级后的仓库首次落盘成功后，旧键才移除；失败则保留旧数据兜底
      if (this.persist()) {
        try { localStorage.removeItem(LEGACY_KEY) } catch { this.legacyKeyPendingRemoval = true }
      } else {
        this.legacyKeyPendingRemoval = true
      }
    }

    this.notices = startupNotices
    this.publishAll()
  }

  private pickHealthy(rawMain: string | null, rawBackup: string | null): CaseRepositoryV2 | null {
    if (rawMain && this.looksHealthy(rawMain)) {
      const parsed = JSON.parse(rawMain) as CaseRepositoryV2
      if (!rawBackup || this.backupSignature(rawBackup) !== parsed.checksum) {
        // 主库正常但备份缺失/落后：刷新备份，保证始终存在上一版完整案卷
        this.atomicSet(CASE_BACKUP_KEY, rawMain)
      }
      return parsed
    }
    if (rawBackup && this.looksHealthy(rawBackup)) {
      const parsed = JSON.parse(rawBackup) as CaseRepositoryV2
      // 主库损坏、备份可用：原位修复主库，保证再次打开仍是同一份完整案卷
      this.atomicSet(CASE_KEY, JSON.stringify({ ...parsed, checksum: this.signature(parsed) }))
      return parsed
    }
    return null
  }

  private looksHealthy(raw: string): boolean {
    try {
      const value = JSON.parse(raw) as CaseRepositoryV2
      return !!value
        && value.schemaVersion === 2
        && Array.isArray(value.workbench?.claims)
        && Array.isArray(value.workbench?.features)
        && Array.isArray(value.workbench?.paragraphs)
        && Array.isArray(value.frozenPackages)
        && Array.isArray(value.sessions)
        && Array.isArray(value.records)
        && typeof value.checksum === 'string'
        && value.checksum === this.signature(value)
    } catch {
      return false
    }
  }

  private signature(value: CaseRepositoryV2): string {
    const { checksum: _omit, ...rest } = value
    void _omit
    return checksum(rest)
  }

  private backupSignature(rawBackup: string): string {
    try {
      return (JSON.parse(rawBackup) as CaseRepositoryV2).checksum
    } catch { return '' }
  }

  /**
   * 关键不变量：主库写入前先把当前健康主库复制到备份库；
   * 写失败或回读不一致时回滚，磁盘上始终保留上一版完整案卷。
   * 返回 false 表示写入失败，调用方必须把内存状态一并回滚。
   */
  private persist(): boolean {
    if (typeof localStorage === 'undefined') return true
    const payload = JSON.stringify(this.assemble())
    const previousMain = localStorage.getItem(CASE_KEY)
    const previousBackup = localStorage.getItem(CASE_BACKUP_KEY)
    try {
      if (previousMain && this.looksHealthy(previousMain) && previousMain !== payload) {
        localStorage.setItem(CASE_BACKUP_KEY, previousMain)
      }
      localStorage.setItem(CASE_KEY, payload)
      if (localStorage.getItem(CASE_KEY) !== payload) throw new Error('写入后回读不一致')
      if (this.legacyKeyPendingRemoval) {
        try { localStorage.removeItem(LEGACY_KEY); this.legacyKeyPendingRemoval = false } catch { /* 下次再试 */ }
      }
      return true
    } catch (error) {
      try { if (previousMain !== null) localStorage.setItem(CASE_KEY, previousMain); else localStorage.removeItem(CASE_KEY) } catch { /* 忽略回滚写失败 */ }
      try { if (previousBackup !== null) localStorage.setItem(CASE_BACKUP_KEY, previousBackup) } catch { /* 忽略 */ }
      this.archiveRecord({
        kind: 'storage-failed',
        detail: `案卷写入失败，已保留上一版完整案卷（${error instanceof Error ? error.message : '未知错误'}）。`,
        actorName: '系统'
      })
      this.persistArchiveSafely()
      this.pushNotice('failed', '本机存储写入失败，已保住上一版完整案卷；可稍后重试，未决项不丢失。')
      return false
    }
  }

  private assemble(): CaseRepositoryV2 {
    return { ...this.repository, checksum: this.signature(this.repository) }
  }

  // ================= 旧版整包原位升级 =================

  private isLegacyState(value: unknown): boolean {
    const legacy = value as Partial<WorkbenchState>
    return !!legacy && Array.isArray(legacy.claims) && Array.isArray(legacy.features) && Array.isArray(legacy.paragraphs)
  }

  private migrateLegacy(legacy: Partial<WorkbenchState>): CaseRepositoryV2 {
    const workbench = this.demoWorkbench()
    Object.assign(workbench, clone(legacy))
    workbench.activeTab = workbench.activeTab || 'mapping'
    const baseline = buildFrozenPackage({
      packageId: uid('fpkg'),
      caseCode: CASE_CODE,
      createdAt: nowIso(),
      createdBy: workbench.currentUserRole || workbench.role || 'author',
      createdByName: '系统（旧数据升级）',
      note: '旧版整包数据首次打开时自动补建的首个冻结基线。',
      snapshot: snapshotFrom(workbench.claims, workbench.features, workbench.paragraphs)
    })
    const repo = this.freshRepository(workbench, true)
    repo.frozenPackages = [baseline]
    repo.currentBaselinePackageId = baseline.packageId
    repo.records.push({
      id: uid('rec'), at: nowIso(), kind: 'legacy-upgraded',
      detail: `旧版整包数据原位升级，补建首个冻结基线 ${baseline.packageId}。`,
      relatedId: baseline.packageId, actorName: '系统'
    })
    return repo
  }

  private freshRepository(workbench: WorkbenchState, migrated: boolean): CaseRepositoryV2 {
    return {
      schemaVersion: 2,
      caseCode: CASE_CODE,
      workbench,
      currentBaselinePackageId: null,
      frozenPackages: [],
      sessions: [],
      records: [],
      activeSessionId: null,
      migratedFromLegacy: migrated,
      checksum: ''
    }
  }

  // ================= 归档库（独立留存，主库损坏不影响） =================

  private readArchive(): ReviewArchive {
    return this.readHealthy<ReviewArchive>(ARCHIVE_KEY, ARCHIVE_BACKUP_KEY) ?? emptyArchive()
  }

  private persistArchiveSafely(): void {
    if (typeof localStorage === 'undefined') return
    const payload = JSON.stringify(this.archive)
    const previous = localStorage.getItem(ARCHIVE_KEY)
    try {
      if (previous) localStorage.setItem(ARCHIVE_BACKUP_KEY, previous)
      localStorage.setItem(ARCHIVE_KEY, payload)
      if (localStorage.getItem(ARCHIVE_KEY) !== payload) throw new Error('归档回读不一致')
    } catch {
      try { if (previous) localStorage.setItem(ARCHIVE_KEY, previous) } catch { /* 忽略 */ }
      this.pushNotice('failed', '归档库写入失败，本次处理记录可能未独立留存；案卷本体未受影响。')
    }
  }

  /** 案卷处理记录：同时写入案卷与独立归档库 */
  private appendRecord(record: Omit<ProcessingRecord, 'id' | 'at'>): void {
    const full: ProcessingRecord = { id: uid('rec'), at: nowIso(), ...record }
    this.repository.records.push(full)
    this.archive.records.push(clone(full))
  }

  /** 只写归档库（启动恢复、写失败回滚等案卷无法追加记录的场景） */
  private archiveRecord(record: Omit<ProcessingRecord, 'id' | 'at'>): void {
    const full: ProcessingRecord = { id: uid('rec'), at: nowIso(), ...record }
    this.archive.records.push(clone(full))
  }

  // ================= 可编辑案卷读写 =================

  get snapshot(): CaseRepositoryV2 { return clone(this.repository) }
  get workbench(): WorkbenchState { return clone(this.repository.workbench) }

  /** 修改可编辑案卷；写盘失败时内存同步回滚到上一版，返回 false */
  mutateWorkbench(recipe: (state: WorkbenchState) => void): boolean {
    const previous = this.repository
    const candidate = clone(previous)
    recipe(candidate.workbench)
    this.repository = candidate
    if (this.persist()) {
      this.publishRepo()
      return true
    }
    this.repository = previous
    this.publishRepo()
    return false
  }

  // ================= 冻结案件包 =================

  freezePackage(note: string, actor: { role: WorkbenchState['role']; name: string }): FrozenPackage | null {
    if (this.repository.activeSessionId) return null
    const state = this.repository.workbench
    const pkg = buildFrozenPackage({
      packageId: uid('fpkg'),
      caseCode: CASE_CODE,
      createdAt: nowIso(),
      createdBy: actor.role,
      createdByName: actor.name,
      note: note.trim() || '冻结基线（无备注）',
      snapshot: snapshotFrom(state.claims, state.features, state.paragraphs)
    })
    this.repository.frozenPackages.push(pkg)
    this.repository.currentBaselinePackageId = pkg.packageId
    this.appendRecord({
      kind: 'package-frozen',
      detail: `生成冻结案件包 ${pkg.packageId}，包含 ${pkg.snapshot.claims.length} 项权利要求、${pkg.snapshot.features.length} 个特征。备注：${pkg.note}`,
      relatedId: pkg.packageId,
      actorName: actor.name
    })
    this.archive.packages[pkg.packageId] = clone(pkg)
    const ok = this.persist()
    this.persistArchiveSafely()
    if (!ok) {
      this.publishRepo()
      return null
    }
    this.publishRepo()
    this.publishArchive()
    return clone(pkg)
  }

  get currentBaseline(): FrozenPackage | null {
    const id = this.repository.currentBaselinePackageId
    return id ? this.repository.frozenPackages.find(pkg => pkg.packageId === id) ?? null : null
  }

  get activeSession(): MergeSession | null {
    const id = this.repository.activeSessionId
    return id ? this.repository.sessions.find(session => session.id === id) ?? null : null
  }

  get hasActiveSession(): boolean { return !!this.repository.activeSessionId }

  // ================= 变更单导入 =================

  /**
   * 导入复核变更单：校验案件号与冻结基线；逐项三方比对。
   * 原对象已移除 / 两边都改过的条目不直接写入案卷，进入待决区。
   */
  importChangeOrder(raw: string, importerName: string): { ok: boolean; message: string } {
    let order: ChangeOrder
    try {
      order = JSON.parse(raw) as ChangeOrder
    } catch {
      return { ok: false, message: '文件不是有效的 JSON，无法解析为变更单。' }
    }
    if (!verifyOrder(order)) return { ok: false, message: '变更单校验和不通过，文件可能已损坏或被改动。' }
    if (order.caseCode !== CASE_CODE) return { ok: false, message: `案件号不匹配：变更单属于 ${order.caseCode}，当前案件为 ${CASE_CODE}。` }
    const baseline = this.repository.frozenPackages.find(pkg => pkg.packageId === order.baselinePackageId)
    if (!baseline) return { ok: false, message: `找不到该变更单对应的冻结基线 ${order.baselinePackageId}，无法逐项比对。` }
    if (this.repository.activeSessionId) return { ok: false, message: '已有未完成的复核合并，请先处理完待决区或放弃该变更单。' }

    const state = this.repository.workbench
    const local = snapshotFrom(state.claims, state.features, state.paragraphs)
    const items = classifyEntries(order.entries, baseline.snapshot, local)
    const session = createMergeSession({ sessionId: uid('msess'), order, items, importedAt: nowIso() })
    this.repository.sessions.push(session)
    this.repository.activeSessionId = session.id
    this.appendRecord({
      kind: 'order-imported',
      detail: `导入变更单 ${order.orderId}（复核员：${order.reviewerName}），共 ${items.length} 项；` +
        `${items.filter(item => item.status === 'clean').length} 项可直接采用，` +
        `${items.filter(item => item.status.startsWith('pending-')).length} 项进入待决区，` +
        `${items.filter(item => item.status === 'redundant').length} 项冗余。`,
      relatedId: session.id,
      actorName: importerName
    })
    this.archive.orders[order.orderId] = clone(order)
    this.archive.sessions[session.id] = clone(session)
    const ok = this.persist()
    this.persistArchiveSafely()
    this.publishRepo()
    this.publishArchive()
    if (!ok) return { ok: false, message: '变更单已解析但案卷写入失败，已保留上一版完整案卷。' }
    return { ok: true, message: '变更单已导入，待决项需逐项裁决后才能确认合并。' }
  }

  // ================= 待决项裁决 =================

  resolvePendingItem(itemId: string, resolution: 'take-external' | 'keep-local', actorName: string, note = ''): void {
    const session = this.activeSession
    if (!session || session.status !== 'active') return
    const item = session.items.find(candidate => candidate.id === itemId)
    if (!item || !item.status.startsWith('pending-') || item.resolution !== 'pending') return
    const inputs: MergeResolutionInput[] = [{ itemId, resolution, resolvedByName: actorName, resolvedAt: nowIso(), note: note.trim() || undefined }]
    session.items = resolveItems(session.items, inputs)
    this.appendRecord({
      kind: 'item-resolved',
      detail: `待决项「${item.title}」裁决为${resolution === 'take-external' ? '采用复核方' : '保留本地'}。`,
      relatedId: session.id,
      actorName
    })
    this.archive.sessions[session.id] = clone(session)
    this.persistArchiveSafely()
    this.persist()
    this.publishRepo()
  }

  resolveAllPending(resolution: 'take-external' | 'keep-local', actorName: string): void {
    const session = this.activeSession
    if (!session) return
    const inputs: MergeResolutionInput[] = session.items
      .filter(item => item.status.startsWith('pending-') && item.resolution === 'pending')
      .map(item => ({ itemId: item.id, resolution, resolvedByName: actorName, resolvedAt: nowIso() }))
    if (!inputs.length) return
    session.items = resolveItems(session.items, inputs)
    this.appendRecord({
      kind: 'item-resolved',
      detail: `批量裁决 ${inputs.length} 个待决项为${resolution === 'take-external' ? '采用复核方' : '保留本地'}。`,
      relatedId: session.id,
      actorName
    })
    this.archive.sessions[session.id] = clone(session)
    this.persistArchiveSafely()
    this.persist()
    this.publishRepo()
  }

  get unresolvedCount(): number {
    const session = this.activeSession
    return session
      ? session.items.filter(item => item.status.startsWith('pending-') && item.resolution === 'pending').length
      : 0
  }

  // ================= 确认 / 放弃合并 =================

  /** 复核员确认合并后才生成可编辑案卷，并补建合并后的新冻结基线 */
  confirmMerge(confirmerName: string): { ok: boolean; message: string } {
    const session = this.activeSession
    if (!session || session.status !== 'active') return { ok: false, message: '没有进行中的合并会话。' }
    const unresolved = session.items.filter(item => item.status.startsWith('pending-') && item.resolution === 'pending')
    if (unresolved.length) return { ok: false, message: `还有 ${unresolved.length} 个待决项未裁决，不允许直接写入案卷。` }

    const previous = clone(this.repository)
    const state = this.repository.workbench
    const result = applyMerge({ claims: state.claims, features: state.features }, session.items)
    state.claims = result.claims
    state.features = result.features
    this.normalizeAfterMerge(state)

    session.status = 'confirmed'
    session.confirmedAt = nowIso()
    session.confirmedByName = confirmerName

    // 旧冻结包保留在 frozenPackages 与独立归档库；当前基线切换为合并后的新冻结包
    const newBaseline = buildFrozenPackage({
      packageId: uid('fpkg'),
      caseCode: CASE_CODE,
      createdAt: nowIso(),
      createdBy: state.role,
      createdByName: confirmerName,
      note: `复核合并确认后的新冻结基线（来源变更单 ${session.orderId}）`,
      snapshot: snapshotFrom(state.claims, state.features, state.paragraphs)
    })
    session.newBaselinePackageId = newBaseline.packageId
    this.repository.frozenPackages.push(newBaseline)
    this.repository.currentBaselinePackageId = newBaseline.packageId
    this.repository.activeSessionId = null

    const adopted = session.items.filter(item => item.status === 'clean' || item.resolution === 'take-external').length
    this.appendRecord({
      kind: 'merge-confirmed',
      detail: `确认合并变更单 ${session.orderId}：采用 ${adopted} 项，保留本地 ${session.items.length - adopted} 项；旧冻结包与变更单独立归档，新基线 ${newBaseline.packageId}。`,
      relatedId: session.id,
      actorName: confirmerName
    })
    this.archive.packages[newBaseline.packageId] = clone(newBaseline)
    this.archive.sessions[session.id] = clone(session)

    const ok = this.persist()
    this.persistArchiveSafely()
    if (!ok) {
      this.repository = previous
      this.publishRepo()
      return { ok: false, message: '合并结果写盘失败，已回滚到合并前的完整案卷，可重试。' }
    }
    this.publishRepo()
    this.publishArchive()
    return { ok: true, message: '合并完成，已生成可编辑案卷与新的冻结基线。' }
  }

  /** 放弃合并：案卷不动，变更单与处理记录仍独立留存 */
  discardMerge(actorName: string): void {
    const session = this.activeSession
    if (!session) return
    session.status = 'discarded'
    session.discardedAt = nowIso()
    this.repository.activeSessionId = null
    this.appendRecord({
      kind: 'merge-discarded',
      detail: `放弃变更单 ${session.orderId} 的合并，案卷未写入任何变更；变更单与裁决记录独立留存。`,
      relatedId: session.id,
      actorName
    })
    this.archive.sessions[session.id] = clone(session)
    this.persistArchiveSafely()
    this.persist()
    this.publishRepo()
  }

  private normalizeAfterMerge(state: WorkbenchState): void {
    if (!state.claims.some(claim => claim.id === state.selectedClaimId)) {
      state.selectedClaimId = state.claims[0]?.id || ''
    }
    state.selectedFeatureId = state.features.some(feature => feature.id === state.selectedFeatureId)
      ? state.selectedFeatureId
      : state.features.find(feature => feature.claimId === state.selectedClaimId)?.id || null
    const featureIds = new Set(state.features.map(feature => feature.id))
    const paragraphIds = new Set(state.paragraphs.map(paragraph => paragraph.id))
    state.annotations = state.annotations.filter(annotation => featureIds.has(annotation.featureId))
    state.features.forEach(feature => { feature.supportIds = feature.supportIds.filter(id => paragraphIds.has(id)) })
  }

  // ================= 离线复核员工作区 =================

  beginOfflineReview(pkg: FrozenPackage, reviewerName: string): OfflineReviewDraft {
    const draft: OfflineReviewDraft = {
      packageId: pkg.packageId,
      caseCode: pkg.caseCode,
      reviewerName: reviewerName.trim() || '离线复核员',
      note: '',
      savedAt: nowIso(),
      reviewed: clone(pkg.snapshot)
    }
    this.draft = draft
    this.persistDraft()
    this.publishDraft()
    return clone(draft)
  }

  get currentDraft(): OfflineReviewDraft | null { return this.draft ? clone(this.draft) : null }
  get draftBaseline(): FrozenPackage | null {
    if (!this.draft) return null
    return this.repository.frozenPackages.find(pkg => pkg.packageId === this.draft!.packageId) ?? null
  }

  mutateDraft(recipe: (draft: OfflineReviewDraft) => void): boolean {
    if (!this.draft) return false
    const previous = clone(this.draft)
    const candidate = clone(this.draft)
    recipe(candidate)
    candidate.savedAt = nowIso()
    this.draft = candidate
    if (!this.persistDraft()) {
      this.draft = previous
      this.publishDraft()
      this.pushNotice('failed', '复核草稿写入失败，已保住上一版草稿。')
      return false
    }
    this.publishDraft()
    return true
  }

  /** 基于冻结基线逐项生成变更单文件内容（按权利要求/特征/支持映射） */
  exportDraftOrder(note: string): { content: string; filename: string } | { error: string } {
    if (!this.draft) return { error: '没有进行中的离线复核草稿。' }
    const baseline = this.repository.frozenPackages.find(pkg => pkg.packageId === this.draft!.packageId)
    if (!baseline) return { error: '草稿对应的冻结基线已不存在。' }
    const entries = diffSnapshots(baseline.snapshot, this.draft.reviewed)
    if (!entries.length) return { error: '相对冻结基线没有任何变化，无需生成变更单。' }
    const order = buildChangeOrder({
      orderId: uid('chg'),
      baselinePackageId: baseline.packageId,
      caseCode: baseline.caseCode,
      reviewerName: this.draft.reviewerName,
      createdAt: nowIso(),
      note: note.trim() || this.draft.note || '离线复核回传',
      entries
    })
    return { content: JSON.stringify(order, null, 2), filename: `change-order-${baseline.caseCode}-${order.orderId}.json` }
  }

  closeDraft(): void {
    this.draft = null
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(REVIEW_DRAFT_KEY)
        localStorage.removeItem(REVIEW_DRAFT_BACKUP_KEY)
      } catch { /* 忽略 */ }
    }
    this.publishDraft()
  }

  private persistDraft(): boolean {
    if (typeof localStorage === 'undefined' || !this.draft) return true
    const payload = JSON.stringify(this.draft)
    const previous = localStorage.getItem(REVIEW_DRAFT_KEY)
    try {
      if (previous) localStorage.setItem(REVIEW_DRAFT_BACKUP_KEY, previous)
      localStorage.setItem(REVIEW_DRAFT_KEY, payload)
      return localStorage.getItem(REVIEW_DRAFT_KEY) === payload
    } catch {
      try { if (previous) localStorage.setItem(REVIEW_DRAFT_KEY, previous) } catch { /* 忽略 */ }
      return false
    }
  }

  // ================= 冻结包导出 / 解析 =================

  exportPackage(pkg: FrozenPackage): { content: string; filename: string } {
    return { content: JSON.stringify(pkg, null, 2), filename: `frozen-package-${pkg.caseCode}-${pkg.packageId}.json` }
  }

  parseFrozenPackage(raw: string): { ok: true; pkg: FrozenPackage } | { ok: false; message: string } {
    try {
      const pkg = JSON.parse(raw) as FrozenPackage
      if (!verifyPackage(pkg)) return { ok: false, message: '冻结包校验和不通过，文件可能已损坏。' }
      return { ok: true, pkg }
    } catch {
      return { ok: false, message: '冻结包不是有效的 JSON。' }
    }
  }

  // ================= 通知 =================

  dismissNotice(id: string): void {
    this.notices = this.notices.filter(notice => notice.id !== id)
    this.noticeSubject.next([...this.notices])
  }

  private notice(kind: StorageNotice['kind'], message: string): StorageNotice {
    return { id: uid('notice'), kind, message, at: nowIso() }
  }
  private pushNotice(kind: StorageNotice['kind'], message: string): void {
    this.notices = [...this.notices, this.notice(kind, message)]
    this.noticeSubject.next([...this.notices])
  }

  // ================= 通用 =================

  private readJson(key: string): unknown | null {
    if (typeof localStorage === 'undefined') return null
    try {
      const raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : null
    } catch { return null }
  }

  private readHealthy<T>(mainKey: string, backupKey: string): T | null {
    const main = this.readJson(mainKey) as T | null
    if (main) return main
    const backup = this.readJson(backupKey) as T | null
    if (backup) this.pushNotice('recovered', '主存储读取失败，已从备份恢复。')
    return backup
  }

  private atomicSet(key: string, value: string): void {
    try { localStorage.setItem(key, value) } catch { /* 备份写失败不阻断主流程 */ }
  }

  private publishRepo(): void { this.repoSubject.next(clone(this.repository)) }
  private publishArchive(): void { this.archiveSubject.next(clone(this.archive)) }
  private publishDraft(): void { this.draftSubject.next(this.draft ? clone(this.draft) : null) }
  private publishAll(): void {
    this.publishRepo()
    this.publishArchive()
    this.publishDraft()
    this.noticeSubject.next([...this.notices])
  }

  private demoWorkbench(): WorkbenchState { return clone(DEMO_WORKBENCH) }
}

// 初始示例数据
const DEMO_WORKBENCH: WorkbenchState = {
  claims: [
    { id: 'claim-1', number: 1, title: '一种自适应展柜环境控制装置', independent: true, text: '一种自适应展柜环境控制装置，包括：柜体；环境传感模块，设置于所述柜体内并用于采集温湿度数据；以及控制模块，与所述环境传感模块通信，并根据所述温湿度数据调节所述柜体的微环境。' },
    { id: 'claim-2', number: 2, title: '传感模块的布置方式', independent: false, text: '根据权利要求1所述的装置，其特征在于，所述环境传感模块包括沿所述柜体对角线布置的多个温湿度传感器。' },
    { id: 'claim-3', number: 3, title: '控制模块的调节策略', independent: false, text: '根据权利要求1所述的装置，其特征在于，所述控制模块基于历史数据与当前数据之间的偏差分级调节除湿单元。' }
  ],
  paragraphs: [
    { id: 'para-0012', section: '说明书 [0012]', text: '柜体1形成用于陈列文物的封闭空间。环境传感模块2安装于柜体内部，可采集温度、相对湿度等环境数据，并将数据发送至控制模块3。' },
    { id: 'para-0018', section: '说明书 [0018]', text: '在一种实施方式中，多个温湿度传感器沿柜体对角线布置，由此可降低局部气流造成的测量偏差。传感器数量可根据柜体容积设定。' },
    { id: 'para-0024', section: '说明书 [0024]', text: '控制模块可比较当前湿度与预设区间，并结合历史变化趋势生成调节等级。当偏差持续超过阈值时，控制模块启动除湿单元并提高调节频率。' },
    { id: 'para-0031', section: '说明书 [0031]', text: '控制模块与传感模块之间可以采用有线或无线通信。通信链路可周期传输数据，传输周期例如为十秒至五分钟。' },
    { id: 'para-0040', section: '说明书 [0040]', text: '微环境调节包括湿度调节、温度调节及气体交换。控制策略可记录执行结果，用于后续趋势判断。' }
  ],
  features: [
    { id: 'feature-a', claimId: 'claim-1', label: 'A · 柜体', text: '柜体', parentId: null, referenceIds: [], supportIds: ['para-0012'], ownerRole: 'author' },
    { id: 'feature-b', claimId: 'claim-1', label: 'B · 环境传感模块', text: '设置于柜体内，用于采集温湿度数据', parentId: 'feature-a', referenceIds: [], supportIds: ['para-0012', 'para-0018'], ownerRole: 'author' },
    { id: 'feature-c', claimId: 'claim-1', label: 'C · 控制模块通信', text: '与环境传感模块通信', parentId: 'feature-a', referenceIds: ['feature-b'], supportIds: ['para-0012', 'para-0031'], ownerRole: 'author' },
    { id: 'feature-d', claimId: 'claim-1', label: 'D · 调节微环境', text: '根据温湿度数据调节柜体微环境', parentId: null, referenceIds: ['feature-b', 'feature-c'], supportIds: ['para-0024', 'para-0040'], ownerRole: 'author' },
    { id: 'feature-e', claimId: 'claim-2', label: 'E · 对角线布置', text: '多个温湿度传感器沿柜体对角线布置', parentId: null, referenceIds: [], supportIds: ['para-0018'], ownerRole: 'author' },
    { id: 'feature-f', claimId: 'claim-3', label: 'F · 分级调节', text: '基于历史数据与当前数据的偏差分级调节除湿单元', parentId: null, referenceIds: [], supportIds: ['para-0024'], ownerRole: 'author' }
  ],
  annotations: [
    { id: 'annotation-1', featureId: 'feature-b', authorRole: 'examiner', authorName: '审查员 · 李岚', text: '“温湿度数据”是否包括露点等派生数据？建议在从属权利要求中限定。', updatedAt: '2026-09-24T03:10:00.000Z' },
    { id: 'annotation-2', featureId: 'feature-d', authorRole: 'author', authorName: '代理人 · 陈昊', text: '[0024] 已支持分级调节，发布前补充除湿单元与通信模块的连接关系。', updatedAt: '2026-09-24T04:05:00.000Z' }
  ],
  orphanMappings: [],
  versions: [],
  role: 'author',
  currentUserRole: 'author',
  selectedClaimId: 'claim-1',
  selectedFeatureId: 'feature-b',
  activeTab: 'mapping'
}
