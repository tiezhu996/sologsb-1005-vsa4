import { Injectable } from '@angular/core'
import { BehaviorSubject, combineLatest, map, type Observable } from 'rxjs'
import type {
  Annotation, ChangeOrder, Claim, ClaimVersion, Feature, FrozenPackage,
  MergeItem, MergeSession, OrphanMapping, Paragraph, PersistEnvelopeV2,
  Position, ProcessingRecord, RecordAction, ReviewUiSelection, Role,
  ValidationIssue, WorkbenchState
} from './models'
import {
  applyResolvedItems, baselineHash, classifyMerge, diffAgainstBaseline,
  mappingsOf, validateChangeOrder
} from './review'
import {
  ENVELOPE_KEY, clearLegacyState, loadEnvelope, readLegacyState, writeEnvelope
} from './storage'

const POSITION_KEY = 'patent-claim-mapping-position-v2'
const CASE_TITLE = 'CN-2026-0917'

const initialClaims: Claim[] = [
  { id: 'claim-1', number: 1, title: '一种自适应展柜环境控制装置', independent: true, text: '一种自适应展柜环境控制装置，包括：柜体；环境传感模块，设置于所述柜体内并用于采集温湿度数据；以及控制模块，与所述环境传感模块通信，并根据所述温湿度数据调节所述柜体的微环境。' },
  { id: 'claim-2', number: 2, title: '传感模块的布置方式', independent: false, text: '根据权利要求1所述的装置，其特征在于，所述环境传感模块包括沿所述柜体对角线布置的多个温湿度传感器。' },
  { id: 'claim-3', number: 3, title: '控制模块的调节策略', independent: false, text: '根据权利要求1所述的装置，其特征在于，所述控制模块基于历史数据与当前数据之间的偏差分级调节除湿单元。' }
]
const initialParagraphs: Paragraph[] = [
  { id: 'para-0012', section: '说明书 [0012]', text: '柜体1形成用于陈列文物的封闭空间。环境传感模块2安装于柜体内部，可采集温度、相对湿度等环境数据，并将数据发送至控制模块3。' },
  { id: 'para-0018', section: '说明书 [0018]', text: '在一种实施方式中，多个温湿度传感器沿柜体对角线布置，由此可降低局部气流造成的测量偏差。传感器数量可根据柜体容积设定。' },
  { id: 'para-0024', section: '说明书 [0024]', text: '控制模块可比较当前湿度与预设区间，并结合历史变化趋势生成调节等级。当偏差持续超过阈值时，控制模块启动除湿单元并提高调节频率。' },
  { id: 'para-0031', section: '说明书 [0031]', text: '控制模块与传感模块之间可以采用有线或无线通信。通信链路可周期传输数据，传输周期例如为十秒至五分钟。' },
  { id: 'para-0040', section: '说明书 [0040]', text: '微环境调节包括湿度调节、温度调节及气体交换。控制策略可记录执行结果，用于后续趋势判断。' }
]
const initialFeatures: Feature[] = [
  { id: 'feature-a', claimId: 'claim-1', label: 'A · 柜体', text: '柜体', parentId: null, referenceIds: [], supportIds: ['para-0012'], ownerRole: 'author' },
  { id: 'feature-b', claimId: 'claim-1', label: 'B · 环境传感模块', text: '设置于柜体内，用于采集温湿度数据', parentId: 'feature-a', referenceIds: [], supportIds: ['para-0012', 'para-0018'], ownerRole: 'author' },
  { id: 'feature-c', claimId: 'claim-1', label: 'C · 控制模块通信', text: '与环境传感模块通信', parentId: 'feature-a', referenceIds: ['feature-b'], supportIds: ['para-0012', 'para-0031'], ownerRole: 'author' },
  { id: 'feature-d', claimId: 'claim-1', label: 'D · 调节微环境', text: '根据温湿度数据调节柜体微环境', parentId: null, referenceIds: ['feature-b', 'feature-c'], supportIds: ['para-0024', 'para-0040'], ownerRole: 'author' },
  { id: 'feature-e', claimId: 'claim-2', label: 'E · 对角线布置', text: '多个温湿度传感器沿柜体对角线布置', parentId: null, referenceIds: [], supportIds: ['para-0018'], ownerRole: 'author' },
  { id: 'feature-f', claimId: 'claim-3', label: 'F · 分级调节', text: '基于历史数据与当前数据的偏差分级调节除湿单元', parentId: null, referenceIds: [], supportIds: ['para-0024'], ownerRole: 'author' }
]
const initialAnnotations: Annotation[] = [
  { id: 'annotation-1', featureId: 'feature-b', authorRole: 'examiner', authorName: '审查员 · 李岚', text: '“温湿度数据”是否包括露点等派生数据？建议在从属权利要求中限定。', updatedAt: '2026-09-24T03:10:00.000Z' },
  { id: 'annotation-2', featureId: 'feature-d', authorRole: 'author', authorName: '代理人 · 陈昊', text: '[0024] 已支持分级调节，发布前补充除湿单元与通信模块的连接关系。', updatedAt: '2026-09-24T04:05:00.000Z' }
]

function demoState(): WorkbenchState {
  return {
    claims: structuredClone(initialClaims), paragraphs: structuredClone(initialParagraphs),
    features: structuredClone(initialFeatures), annotations: structuredClone(initialAnnotations),
    orphanMappings: [], versions: [],
    role: 'author', currentUserRole: 'author',
    selectedClaimId: 'claim-1', selectedFeatureId: 'feature-b', activeTab: 'mapping'
  }
}
function clone<T>(value: T): T { return structuredClone(value) }
function nowIso(): string { return new Date().toISOString() }
function record(action: RecordAction, detail: string, refId?: string): ProcessingRecord {
  return { id: `record-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: nowIso(), action, detail, refId }
}

type ReviewSelection = ReviewUiSelection

@Injectable({ providedIn: 'root' })
export class WorkbenchService {
  private envelopeSubject: BehaviorSubject<PersistEnvelopeV2>
  private reviewSelectionSubject: BehaviorSubject<ReviewSelection>
  private historySubject = new BehaviorSubject<{ past: number; future: number }>({ past: 0, future: 0 })
  private storageFaultSubject = new BehaviorSubject<{ since: string; lastError: string } | null>(null)

  /** 案件模式与复核模式各自独立的撤销/重做栈 */
  private casePast: PersistEnvelopeV2[] = []
  private caseFuture: PersistEnvelopeV2[] = []
  private reviewPast: PersistEnvelopeV2[] = []
  private reviewFuture: PersistEnvelopeV2[] = []

  readonly envelope$: Observable<PersistEnvelopeV2>
  readonly state$: Observable<WorkbenchState>
  readonly history$ = this.historySubject.asObservable()
  readonly storageFault$ = this.storageFaultSubject.asObservable()

  readonly mode$: Observable<'case' | 'review'>
  readonly reviewSession$: Observable<PersistEnvelopeV2['reviewSession']>
  readonly openMerge$: Observable<MergeSession | null>
  readonly mergeSessions$: Observable<MergeSession[]>
  readonly frozenPackages$: Observable<FrozenPackage[]>
  readonly orderArchives$: Observable<PersistEnvelopeV2['orderArchives']>
  readonly records$: Observable<ProcessingRecord[]>

  readonly claims$: Observable<Claim[]>
  readonly paragraphs$: Observable<Paragraph[]>
  readonly features$: Observable<Feature[]>
  readonly annotations$: Observable<Annotation[]>
  readonly role$: Observable<Role>
  readonly selectedClaim$: Observable<Claim | undefined>
  readonly selectedFeature$: Observable<Feature | null>
  readonly issues$: Observable<ValidationIssue[]>

  constructor() {
    const boot = this.bootstrap()
    this.envelopeSubject = new BehaviorSubject<PersistEnvelopeV2>(boot.envelope)
    this.reviewSelectionSubject = new BehaviorSubject<ReviewSelection>(
      boot.envelope.reviewSession?.ui ?? { tab: 'mapping', claimId: 'claim-1', featureId: null }
    )
    if (boot.fault) this.storageFaultSubject.next(boot.fault)

    this.envelope$ = this.envelopeSubject.asObservable()
    this.mode$ = this.envelope$.pipe(map(env => env.activeMode === 'review' && env.reviewSession ? 'review' : 'case'))
    this.reviewSession$ = this.envelope$.pipe(map(env => env.reviewSession))
    this.openMerge$ = this.envelope$.pipe(map(env => env.mergeSessions.find(session => session.state === 'open') || null))
    this.mergeSessions$ = this.envelope$.pipe(map(env => env.mergeSessions))
    this.frozenPackages$ = this.envelope$.pipe(map(env => env.frozenPackages.map(entry => entry.pkg)))
    this.orderArchives$ = this.envelope$.pipe(map(env => env.orderArchives))
    this.records$ = this.envelope$.pipe(map(env => env.processingRecords))

    this.state$ = combineLatest([this.envelope$, this.reviewSelectionSubject]).pipe(
      map(([envelope, selection]) => this.projectState(envelope, selection))
    )
    this.claims$ = this.state$.pipe(map(state => state.claims))
    this.paragraphs$ = this.state$.pipe(map(state => state.paragraphs))
    this.features$ = this.state$.pipe(map(state => state.features))
    this.annotations$ = this.state$.pipe(map(state => state.annotations))
    this.role$ = this.state$.pipe(map(state => state.role))
    this.selectedClaim$ = this.state$.pipe(map(state => state.claims.find(claim => claim.id === state.selectedClaimId)))
    this.selectedFeature$ = this.state$.pipe(map(state => state.features.find(feature => feature.id === state.selectedFeatureId) || null))
    this.issues$ = this.state$.pipe(map(state => this.validate(state)))

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this.savePosition())
    }
  }

  /* ------------------------------ 启动与升级 ------------------------------ */

  private bootstrap(): { envelope: PersistEnvelopeV2; fault: { since: string; lastError: string } | null } {
    if (typeof localStorage === 'undefined') {
      return { envelope: this.freshEnvelope(), fault: null }
    }
    const loaded = loadEnvelope()
    if (loaded.envelope) {
      if (!loaded.recoveredFromTmp) return { envelope: loaded.envelope, fault: null }
      // 主键损坏，已用临时键保住上一版完整案卷：原位修复并留痕
      const recovered = loaded.envelope
      recovered.processingRecords.push(record('storage-recovered', '主键数据无法读取，已从最近一次校验通过的副本恢复完整案卷。'))
      const outcome = writeEnvelope(recovered)
      return outcome.ok
        ? { envelope: recovered, fault: null }
        : { envelope: recovered, fault: { since: nowIso(), lastError: outcome.error || '恢复后写回失败' } }
    }

    const legacy = readLegacyState()
    if (legacy) {
      const envelope = this.migrateLegacy(legacy)
      const outcome = writeEnvelope(envelope)
      if (outcome.ok) {
        clearLegacyState()
        return { envelope, fault: null }
      }
      // 首次升级即写失败：内存中使用升级后的信封，但保留旧键，下次打开仍能原位升级
      return { envelope, fault: { since: nowIso(), lastError: outcome.error || '升级写入失败' } }
    }

    const fresh = this.freshEnvelope()
    const outcome = writeEnvelope(fresh)
    return outcome.ok
      ? { envelope: fresh, fault: null }
      : { envelope: fresh, fault: { since: nowIso(), lastError: outcome.error || '初始写入失败' } }
  }

  private freshEnvelope(): PersistEnvelopeV2 {
    const envelope: PersistEnvelopeV2 = {
      format: 'patent-workbench-v2',
      version: 2,
      caseState: demoState(),
      frozenPackages: [],
      reviewSession: null,
      mergeSessions: [],
      orderArchives: [],
      processingRecords: [],
      activeMode: 'case',
      storageFault: null
    }
    this.freezeInto(envelope, '初始冻结基线（首次建档）')
    return envelope
  }

  /** 旧数据整包首次打开 → v2 信封，并补上首个冻结基线 */
  private migrateLegacy(legacy: WorkbenchState): PersistEnvelopeV2 {
    const caseState: WorkbenchState = { ...demoState(), ...clone(legacy), role: legacy.currentUserRole ?? legacy.role ?? 'author' }
    const envelope: PersistEnvelopeV2 = {
      format: 'patent-workbench-v2',
      version: 2,
      caseState,
      frozenPackages: [],
      reviewSession: null,
      mergeSessions: [],
      orderArchives: [],
      processingRecords: [record('legacy-upgrade', '检测到旧版整包数据，已原位升级为“冻结案件包 + 复核变更单”结构。')],
      activeMode: 'case',
      storageFault: null
    }
    this.freezeInto(envelope, '首个冻结基线（旧数据整包升级时补建）')
    return envelope
  }

  /* -------------------------------- 投影 -------------------------------- */

  private projectState(envelope: PersistEnvelopeV2, selection: ReviewSelection): WorkbenchState {
    if (envelope.activeMode === 'review' && envelope.reviewSession) {
      const session = envelope.reviewSession
      return {
        claims: session.workingClaims,
        paragraphs: session.contextParagraphs,
        features: session.workingFeatures,
        annotations: [],
        orphanMappings: [],
        versions: [],
        role: 'examiner',
        currentUserRole: 'examiner',
        selectedClaimId: selection.claimId,
        selectedFeatureId: selection.featureId,
        activeTab: selection.tab
      }
    }
    return envelope.caseState
  }

  get snapshot(): WorkbenchState { return this.projectState(this.envelopeSubject.value, this.reviewSelectionSubject.value) }
  get envelopeSnapshot(): PersistEnvelopeV2 { return this.envelopeSubject.value }
  get mode(): 'case' | 'review' {
    const env = this.envelopeSubject.value
    return env.activeMode === 'review' && env.reviewSession ? 'review' : 'case'
  }
  get canUndo(): boolean { return this.mode === 'review' ? this.reviewPast.length > 0 : this.casePast.length > 0 }
  get canRedo(): boolean { return this.mode === 'review' ? this.reviewFuture.length > 0 : this.caseFuture.length > 0 }

  /* ------------------------------ 通用提交/存储 ------------------------------ */

  /**
   * 所有状态变化的唯一入口：先在内存构造下一版信封，再原子写盘。
   * 写失败时不触碰已落盘的上一版完整案卷，仅在界面挂出存储故障。
   * trackHistory=false 用于选择位置等非内容变化，不占用撤销栈。
   */
  private modeOf(envelope: PersistEnvelopeV2): 'case' | 'review' {
    return envelope.activeMode === 'review' && envelope.reviewSession ? 'review' : 'case'
  }

  private commit(next: PersistEnvelopeV2, trackHistory = true): void {
    const current = this.envelopeSubject.value
    const modeChanged = this.modeOf(current) !== this.modeOf(next)
    if (modeChanged) {
      // 案件/复核模式边界不共享撤销栈，避免撤销时跨模式回退
      this.casePast = []
      this.caseFuture = []
      this.reviewPast = []
      this.reviewFuture = []
    } else if (trackHistory) {
      if (this.modeOf(next) === 'review') {
        this.reviewPast.push(current)
        if (this.reviewPast.length > 60) this.reviewPast.shift()
        this.reviewFuture = []
      } else {
        this.casePast.push(current)
        if (this.casePast.length > 60) this.casePast.shift()
        this.caseFuture = []
      }
    }
    const outcome = writeEnvelope(next)
    this.envelopeSubject.next(next)
    this.syncReviewSelection(next)
    this.updateHistory()
    if (outcome.ok) {
      this.storageFaultSubject.next(null)
    } else {
      this.storageFaultSubject.next({
        since: this.storageFaultSubject.value?.since ?? nowIso(),
        lastError: outcome.error || '写入失败'
      })
    }
  }

  /** 不进撤销栈的轻量替换（启动恢复等场景已直接落盘时不用，这里仅用于撤销/重做） */
  private replacePersisted(next: PersistEnvelopeV2): void {
    const outcome = writeEnvelope(next)
    this.envelopeSubject.next(next)
    this.syncReviewSelection(next)
    this.updateHistory()
    if (!outcome.ok) {
      this.storageFaultSubject.next({
        since: this.storageFaultSubject.value?.since ?? nowIso(),
        lastError: outcome.error || '写入失败'
      })
    } else {
      this.storageFaultSubject.next(null)
    }
  }

  retrySave(): boolean {
    const outcome = writeEnvelope(this.envelopeSubject.value)
    if (outcome.ok) {
      const next = clone(this.envelopeSubject.value)
      next.processingRecords.push(record('storage-recovered', '存储恢复可用，当前完整案卷已重新落盘。'))
      const second = writeEnvelope(next)
      if (second.ok) {
        this.envelopeSubject.next(next)
        this.storageFaultSubject.next(null)
        return true
      }
    }
    return false
  }

  private syncReviewSelection(envelope: PersistEnvelopeV2): void {
    const session = envelope.reviewSession
    if (envelope.activeMode !== 'review' || !session) return
    const claim = session.workingClaims.find(item => item.id === session.ui.claimId) || session.workingClaims[0]
    const claimId = claim?.id || ''
    let featureId = session.ui.featureId
    if (featureId && !session.workingFeatures.some(item => item.id === featureId && item.claimId === claimId)) {
      featureId = session.workingFeatures.find(item => item.claimId === claimId)?.id || null
    }
    const tab = session.ui.tab
    if (tab !== this.reviewSelectionSubject.value.tab || claimId !== this.reviewSelectionSubject.value.claimId || featureId !== this.reviewSelectionSubject.value.featureId) {
      this.reviewSelectionSubject.next({ tab, claimId, featureId })
    }
  }

  /** 复核模式下记录选择位置：写入会话并持久化，但不进撤销栈；重开可接着处理 */
  private saveReviewSelection(patch: Partial<ReviewSelection>): void {
    const env = this.envelopeSubject.value
    if (!env.reviewSession) return
    const next = clone(env)
    const session = next.reviewSession!
    session.ui = { ...session.ui, ...patch }
    const claim = session.workingClaims.find(item => item.id === session.ui.claimId) || session.workingClaims[0]
    session.ui.claimId = claim?.id || ''
    if (session.ui.featureId && !session.workingFeatures.some(item => item.id === session.ui.featureId && item.claimId === session.ui.claimId)) {
      session.ui.featureId = session.workingFeatures.find(item => item.claimId === session.ui.claimId)?.id || null
    }
    this.commit(next, false)
  }

  /* ------------------------------ 案件模式：选择/角色/标签 ------------------------------ */

  selectClaim(id: string): void {
    if (this.mode === 'review') {
      const featureId = this.envelopeSubject.value.reviewSession?.workingFeatures.find(f => f.claimId === id)?.id || null
      this.saveReviewSelection({ claimId: id, featureId })
      return
    }
    this.patchCase(state => {
      state.selectedClaimId = id
      state.selectedFeatureId = state.features.find(feature => feature.claimId === id)?.id || null
    })
    this.savePosition()
  }

  selectFeature(id: string | null): void {
    if (this.mode === 'review') {
      this.saveReviewSelection({ featureId: id })
      return
    }
    this.patchCase(state => { state.selectedFeatureId = id })
    this.savePosition()
  }

  setRole(role: Role): void {
    if (this.mode !== 'case' || this.hasOpenMerge) return
    this.mutateCase(state => { state.role = role; state.currentUserRole = role })
  }

  setTab(tab: string): void {
    if (this.mode === 'review') {
      this.saveReviewSelection({ tab })
      return
    }
    this.patchCase(state => { state.activeTab = tab })
    this.savePosition()
  }

  /* ------------------------------ 案件模式：编辑 ------------------------------ */

  private get hasOpenMerge(): boolean {
    return this.envelopeSubject.value.mergeSessions.some(session => session.state === 'open')
  }

  private blockCaseEdit(): boolean { return this.mode !== 'case' || this.hasOpenMerge }

  updateClaim(patch: Partial<Claim>): void {
    if (this.mode === 'review') return this.updateReviewClaim(this.reviewSelectionSubject.value.claimId, patch)
    if (this.blockCaseEdit() || this.snapshot.role === 'viewer') return
    this.mutateCase(state => {
      const claim = state.claims.find(item => item.id === state.selectedClaimId)
      if (claim) Object.assign(claim, patch)
    })
  }

  addClaim(): void {
    if (this.mode === 'review') return this.addReviewClaim()
    if (this.blockCaseEdit() || this.snapshot.role === 'viewer') return
    this.mutateCase(state => {
      const number = Math.max(0, ...state.claims.map(claim => claim.number)) + 1
      const claim: Claim = { id: `claim-${Date.now()}`, number, title: `权利要求 ${number}`, independent: false, text: '请录入权利要求正文。' }
      state.claims.push(claim)
      state.selectedClaimId = claim.id
      state.selectedFeatureId = null
    })
  }

  addParagraph(): void {
    if (this.blockCaseEdit() || this.snapshot.role === 'viewer') return
    this.mutateCase(state => {
      const next = state.paragraphs.length + 1
      state.paragraphs.push({ id: `para-${Date.now()}`, section: `说明书 [${String(next * 5).padStart(4, '0')}]`, text: '' })
    })
  }

  updateParagraph(id: string, patch: Partial<Paragraph>): void {
    if (this.blockCaseEdit() || this.snapshot.role === 'viewer') return
    this.mutateCase(state => {
      const paragraph = state.paragraphs.find(item => item.id === id)
      if (paragraph) Object.assign(paragraph, patch)
    })
  }

  deleteParagraph(id: string): void {
    if (this.blockCaseEdit() || this.snapshot.role === 'viewer') return
    this.mutateCase(state => {
      state.paragraphs = state.paragraphs.filter(item => item.id !== id)
      state.features.forEach(feature => { feature.supportIds = feature.supportIds.filter(paragraphId => paragraphId !== id) })
      state.orphanMappings = state.orphanMappings.filter(item => item.paragraphId !== id)
    })
  }

  addFeature(): void {
    if (this.mode === 'review') return this.addReviewFeature()
    if (this.blockCaseEdit() || this.snapshot.role === 'viewer') return
    this.mutateCase(state => {
      const feature: Feature = {
        id: `feature-${Date.now()}`, claimId: state.selectedClaimId,
        label: `新特征 ${state.features.filter(item => item.claimId === state.selectedClaimId).length + 1}`,
        text: '', parentId: null, referenceIds: [], supportIds: [], ownerRole: state.role
      }
      state.features.push(feature)
      state.selectedFeatureId = feature.id
    })
  }

  updateFeature(id: string, patch: Partial<Feature>): void {
    if (this.mode === 'review') return this.updateReviewFeature(id, patch)
    if (this.blockCaseEdit() || this.snapshot.role === 'viewer') return
    this.mutateCase(state => {
      const feature = state.features.find(item => item.id === id)
      if (feature) Object.assign(feature, patch)
    })
  }

  deleteFeature(id: string): void {
    if (this.mode === 'review') return this.deleteReviewFeature(id)
    if (this.blockCaseEdit() || this.snapshot.role === 'viewer') return
    this.mutateCase(state => {
      const feature = state.features.find(item => item.id === id)
      if (!feature) return
      feature.supportIds.forEach(paragraphId => state.orphanMappings.push({
        id: `orphan-${Date.now()}-${paragraphId}`, featureLabel: feature.label, paragraphId,
        reason: `技术特征“${feature.label}”已删除，但支持段落映射仍被保留。`
      }))
      this.removeFeatureCascade(state, id)
      state.selectedFeatureId = state.features.find(item => item.claimId === state.selectedClaimId)?.id || null
    })
  }

  private removeFeatureCascade(state: WorkbenchState, id: string): void {
    state.features = state.features.filter(item => item.id !== id)
    state.features.forEach(item => {
      item.referenceIds = item.referenceIds.filter(refId => refId !== id)
      if (item.parentId === id) item.parentId = null
    })
    state.annotations = state.annotations.filter(item => item.featureId !== id)
  }

  toggleParagraphMapping(featureId: string, paragraphId: string): void {
    if (this.mode === 'review') return this.toggleReviewMapping(featureId, paragraphId)
    if (this.blockCaseEdit() || this.snapshot.role === 'viewer') return
    this.mutateCase(state => {
      const feature = state.features.find(item => item.id === featureId)
      if (!feature) return
      const index = feature.supportIds.indexOf(paragraphId)
      if (index >= 0) feature.supportIds.splice(index, 1)
      else feature.supportIds.push(paragraphId)
      state.orphanMappings = state.orphanMappings.filter(item => item.paragraphId !== paragraphId)
    })
  }

  clearOrphan(id: string): void {
    if (this.blockCaseEdit()) return
    this.mutateCase(state => { state.orphanMappings = state.orphanMappings.filter(item => item.id !== id) })
  }

  addAnnotation(featureId: string, text: string): void {
    if (this.blockCaseEdit()) return
    const trimmed = text.trim()
    if (!trimmed) return
    const role = this.snapshot.role
    const names: Record<Role, string> = { author: '代理人 · 陈昊', examiner: '审查员 · 李岚', viewer: '观察者' }
    this.mutateCase(state => state.annotations.push({
      id: `annotation-${Date.now()}`, featureId, authorRole: role, authorName: names[role], text: trimmed, updatedAt: nowIso()
    }))
  }

  updateAnnotation(id: string, text: string): void {
    if (this.blockCaseEdit()) return
    this.mutateCase(state => {
      const annotation = state.annotations.find(item => item.id === id)
      if (annotation && annotation.authorRole === state.role) annotation.text = text
    })
  }

  deleteAnnotation(id: string): void {
    if (this.blockCaseEdit()) return
    this.mutateCase(state => {
      const annotation = state.annotations.find(item => item.id === id)
      if (annotation && annotation.authorRole === state.role) state.annotations = state.annotations.filter(item => item.id !== id)
    })
  }

  createVersion(name?: string): void {
    if (this.blockCaseEdit()) return
    this.mutateCase(state => {
      state.versions.unshift({
        id: `version-${Date.now()}`, name: name?.trim() || `快照 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        createdAt: nowIso(), claims: clone(state.claims), features: clone(state.features)
      })
    })
  }

  restoreVersion(id: string): void {
    if (this.blockCaseEdit()) return
    this.mutateCase(state => {
      const version = state.versions.find(item => item.id === id)
      if (!version) return
      state.claims = clone(version.claims)
      state.features = clone(version.features)
      if (!state.claims.some(claim => claim.id === state.selectedClaimId)) state.selectedClaimId = state.claims[0]?.id || ''
      state.selectedFeatureId = state.features.find(feature => feature.claimId === state.selectedClaimId)?.id || null
    })
  }

  private mutateCase(recipe: (state: WorkbenchState) => void, trackHistory = true): void {
    const next = clone(this.envelopeSubject.value)
    recipe(next.caseState)
    this.commit(next, trackHistory)
  }

  private patchCase(recipe: (state: WorkbenchState) => void): void {
    // 选择/标签类变化同样落盘以保证崩溃重开可恢复，但不进入撤销栈
    this.mutateCase(recipe, false)
  }

  /* ------------------------------ 撤销 / 重做 ------------------------------ */

  undo(): void {
    const inReview = this.mode === 'review'
    const past = inReview ? this.reviewPast : this.casePast
    const future = inReview ? this.reviewFuture : this.caseFuture
    const previous = past.pop()
    if (!previous) return
    future.push(clone(this.envelopeSubject.value))
    this.replacePersisted(previous)
  }

  redo(): void {
    const inReview = this.mode === 'review'
    const future = inReview ? this.reviewFuture : this.caseFuture
    const past = inReview ? this.reviewPast : this.casePast
    const nextEnv = future.pop()
    if (!nextEnv) return
    past.push(clone(this.envelopeSubject.value))
    this.replacePersisted(nextEnv)
  }

  private updateHistory(): void {
    this.historySubject.next(this.mode === 'review'
      ? { past: this.reviewPast.length, future: this.reviewFuture.length }
      : { past: this.casePast.length, future: this.caseFuture.length })
  }

  /* ------------------------------ 位置恢复 ------------------------------ */

  savePosition(): void {
    if (typeof localStorage === 'undefined' || this.mode !== 'case') return
    const state = this.envelopeSubject.value.caseState
    const position: Position = { tab: state.activeTab, claimId: state.selectedClaimId, featureId: state.selectedFeatureId, scrollY: window.scrollY }
    try { localStorage.setItem(POSITION_KEY, JSON.stringify(position)) } catch { /* 位置丢失不影响案卷 */ }
  }

  readPosition(): Position {
    const fallback: Position = { tab: 'mapping', claimId: this.envelopeSubject.value.caseState.selectedClaimId, featureId: null, scrollY: 0 }
    if (typeof localStorage === 'undefined') return fallback
    try {
      const stored = localStorage.getItem(POSITION_KEY)
      return stored ? { ...fallback, ...JSON.parse(stored) } : fallback
    } catch { return fallback }
  }

  /* ------------------------------ 导出 ------------------------------ */

  exportJson(): string {
    return JSON.stringify({ ...this.snapshot, validationIssues: this.validate(this.snapshot) }, null, 2)
  }

  exportCsv(): string {
    const state = this.snapshot
    const rows = state.features.map(feature => [
      state.claims.find(claim => claim.id === feature.claimId)?.number || '', feature.label, feature.text,
      state.features.find(item => item.id === feature.parentId)?.label || '',
      feature.referenceIds.map(id => state.features.find(item => item.id === id)?.label || id).join('；'),
      feature.supportIds.map(id => state.paragraphs.find(item => item.id === id)?.section || id).join('；')
    ])
    const csv = [['权利要求', '技术特征', '特征内容', '父级特征', '引用特征', '支持段落'], ...rows]
      .map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n')
    return `﻿${csv}`
  }

  /* ------------------------------ 冻结案件包 ------------------------------ */

  private freezeInto(envelope: PersistEnvelopeV2, note: string): FrozenPackage {
    const state = envelope.caseState
    const pkg: FrozenPackage = {
      fileType: 'patent-frozen-package',
      formatVersion: 1,
      packageId: `frozen-${Date.now()}`,
      frozenAt: nowIso(),
      frozenBy: state.currentUserRole,
      caseTitle: CASE_TITLE,
      baselineHash: baselineHash(state.claims, state.features),
      claims: clone(state.claims),
      paragraphs: clone(state.paragraphs),
      features: clone(state.features)
    }
    envelope.frozenPackages.push({ archivedAt: nowIso(), pkg })
    envelope.processingRecords.push(record('freeze',
      `生成冻结案件包：${note}；权利要求 ${pkg.claims.length} 项、技术特征 ${pkg.features.length} 个、支持映射 ${mappingsOf(pkg.features).length} 条。`,
      pkg.packageId))
    return pkg
  }

  freezePackage(): FrozenPackage {
    const next = clone(this.envelopeSubject.value)
    const pkg = this.freezeInto(next, '代理人手工冻结')
    this.commit(next, false)
    return pkg
  }

  exportFrozenPackageJson(packageId: string): string | null {
    const entry = this.envelopeSubject.value.frozenPackages.find(item => item.pkg.packageId === packageId)
    return entry ? JSON.stringify(entry.pkg, null, 2) : null
  }

  /* ------------------------------ 离线复核 ------------------------------ */

  startReview(packageId: string, reviewerName: string): string | null {
    const env = this.envelopeSubject.value
    if (env.reviewSession) return '已有进行中的复核会话，请先导出变更单或放弃复核。'
    if (env.mergeSessions.some(session => session.state === 'open')) return '存在待决合并，请先确认或放弃后再发起复核。'
    const entry = env.frozenPackages.find(item => item.pkg.packageId === packageId)
    if (!entry) return '冻结案件包不存在或已不在本机留存中。'
    const next = clone(env)
    const error = this.openReviewSession(next, entry.pkg, reviewerName, false)
    if (error) return error
    this.commit(next, false)
    return null
  }

  /** 外部电脑：直接导入冻结案件包并进入复核（不改动本机可编辑案卷） */
  startReviewFromPackage(pkg: FrozenPackage, reviewerName: string): string | null {
    const env = this.envelopeSubject.value
    if (env.reviewSession) return '已有进行中的复核会话，请先结束当前复核。'
    if (env.mergeSessions.some(session => session.state === 'open')) return '存在待决合并，请先处理后再发起复核。'
    const next = clone(env)
    const error = this.openReviewSession(next, pkg, reviewerName, true)
    if (error) return error
    this.commit(next, false)
    return null
  }

  private openReviewSession(next: PersistEnvelopeV2, pkg: FrozenPackage, reviewerName: string, external: boolean): string | null {
    if (baselineHash(pkg.claims, pkg.features) !== pkg.baselineHash) {
      return '冻结包内容与基线哈希不一致，文件可能已被改动。'
    }
    if (!next.frozenPackages.some(entry => entry.pkg.packageId === pkg.packageId)) {
      next.frozenPackages.push({ archivedAt: nowIso(), pkg: clone(pkg) })
    }
    const name = reviewerName.trim() || '离线复核员'
    next.reviewSession = {
      sessionId: `review-${Date.now()}`,
      packageId: pkg.packageId,
      packageSummary: {
        frozenAt: pkg.frozenAt,
        caseTitle: pkg.caseTitle,
        claimCount: pkg.claims.length,
        featureCount: pkg.features.length,
        mappingCount: mappingsOf(pkg.features).length
      },
      startedAt: nowIso(),
      workingClaims: clone(pkg.claims),
      workingFeatures: clone(pkg.features),
      contextParagraphs: clone(pkg.paragraphs),
      reviewerName: name,
      ui: {
        tab: 'mapping',
        claimId: pkg.claims[0]?.id || '',
        featureId: pkg.features.find(f => f.claimId === pkg.claims[0]?.id)?.id || null
      }
    }
    next.activeMode = 'review'
    next.processingRecords.push(record('review-start',
      external
        ? `外部电脑导入冻结包 ${pkg.packageId} 并开始复核（复核员：${name}）。`
        : `离线复核员“${name}”基于冻结包 ${pkg.packageId} 开始复核。`,
      pkg.packageId))
    this.reviewPast = []
    this.reviewFuture = []
    return null
  }

  discardReview(): void {
    const next = clone(this.envelopeSubject.value)
    if (!next.reviewSession) return
    const id = next.reviewSession.sessionId
    next.processingRecords.push(record('review-discard', `放弃复核会话 ${id}，复核工作副本改动未进入可编辑案卷。`, id))
    next.reviewSession = null
    next.activeMode = 'case'
    next.caseState.activeTab = 'mapping'
    this.commit(next, false)
  }

  private mutateReview(recipe: (session: NonNullable<PersistEnvelopeV2['reviewSession']>) => void): void {
    const next = clone(this.envelopeSubject.value)
    if (!next.reviewSession) return
    recipe(next.reviewSession)
    this.commit(next)
  }

  private updateReviewClaim(claimId: string, patch: Partial<Claim>): void {
    this.mutateReview(session => {
      const claim = session.workingClaims.find(item => item.id === claimId)
      if (claim) Object.assign(claim, patch)
    })
  }

  private addReviewClaim(): void {
    this.mutateReview(session => {
      const number = Math.max(0, ...session.workingClaims.map(claim => claim.number)) + 1
      const claim: Claim = { id: `claim-r${Date.now()}`, number, title: `权利要求 ${number}（复核新增）`, independent: false, text: '' }
      session.workingClaims.push(claim)
      session.ui = { ...session.ui, claimId: claim.id, featureId: null }
    })
  }

  private addReviewFeature(): void {
    this.mutateReview(session => {
      const claimId = session.ui.claimId
      const feature: Feature = {
        id: `feature-r${Date.now()}`, claimId,
        label: `复核新特征 ${session.workingFeatures.filter(item => item.claimId === claimId).length + 1}`,
        text: '', parentId: null, referenceIds: [], supportIds: [], ownerRole: 'examiner'
      }
      session.workingFeatures.push(feature)
      session.ui = { ...session.ui, featureId: feature.id }
    })
  }

  private updateReviewFeature(id: string, patch: Partial<Feature>): void {
    this.mutateReview(session => {
      const feature = session.workingFeatures.find(item => item.id === id)
      if (feature) Object.assign(feature, patch)
    })
  }

  private deleteReviewFeature(id: string): void {
    this.mutateReview(session => {
      session.workingFeatures = session.workingFeatures.filter(item => item.id !== id)
      session.workingFeatures.forEach(item => {
        item.referenceIds = item.referenceIds.filter(refId => refId !== id)
        if (item.parentId === id) item.parentId = null
      })
    })
  }

  private toggleReviewMapping(featureId: string, paragraphId: string): void {
    this.mutateReview(session => {
      const feature = session.workingFeatures.find(item => item.id === featureId)
      if (!feature) return
      const index = feature.supportIds.indexOf(paragraphId)
      if (index >= 0) feature.supportIds.splice(index, 1)
      else feature.supportIds.push(paragraphId)
    })
  }

  /** 当前复核工作副本相对冻结基线的变化清单（实时） */
  reviewChanges() {
    const env = this.envelopeSubject.value
    const session = env.reviewSession
    if (!session) return []
    const pkg = env.frozenPackages.find(entry => entry.pkg.packageId === session.packageId)?.pkg
    return pkg ? diffAgainstBaseline(pkg, session.workingClaims, session.workingFeatures) : []
  }

  /** 以冻结包为基线导出仅含变化项的复核变更单 */
  exportChangeOrder(): ChangeOrder | null {
    const env = this.envelopeSubject.value
    const session = env.reviewSession
    if (!session) return null
    const pkg = env.frozenPackages.find(entry => entry.pkg.packageId === session.packageId)?.pkg
    if (!pkg) return null
    const changes = diffAgainstBaseline(pkg, session.workingClaims, session.workingFeatures)
    const order: ChangeOrder = {
      fileType: 'patent-change-order',
      formatVersion: 1,
      orderId: `order-${Date.now()}`,
      packageId: pkg.packageId,
      baselineHash: pkg.baselineHash,
      reviewerName: session.reviewerName,
      exportedAt: nowIso(),
      summary: `权利要求变化 ${changes.filter(c => c.kind === 'claim').length} 项、技术特征变化 ${changes.filter(c => c.kind === 'feature').length} 项、支持映射变化 ${changes.filter(c => c.kind === 'mapping').length} 条。`,
      changes
    }
    const next = clone(env)
    next.processingRecords.push(record('review-export',
      `导出复核变更单 ${order.orderId}：${order.summary}`, order.orderId))
    this.commit(next, false)
    return order
  }

  /* ------------------------------ 导入变更单与待决合并 ------------------------------ */

  async importChangeOrder(file: File): Promise<{ ok: boolean; message: string }> {
    let raw: unknown
    try {
      raw = JSON.parse(await file.text())
    } catch {
      return { ok: false, message: '文件不是有效的 JSON。' }
    }
    const shapeError = validateChangeOrder(raw)
    if (shapeError) return { ok: false, message: shapeError }
    const order = raw as ChangeOrder

    const env = this.envelopeSubject.value
    if (env.activeMode === 'review' || env.reviewSession) return { ok: false, message: '请先结束当前复核会话，再导入变更单。' }
    if (env.mergeSessions.some(session => session.state === 'open')) {
      return { ok: false, message: '已有待决合并会话：请逐项处理并确认，或放弃后再导入。' }
    }
    const pkgEntry = env.frozenPackages.find(entry => entry.pkg.packageId === order.packageId)
    if (!pkgEntry) return { ok: false, message: `本机留存中找不到冻结包 ${order.packageId}，无法核验基线。` }
    const pkg = pkgEntry.pkg
    if (pkg.baselineHash !== order.baselineHash) {
      return { ok: false, message: '变更单的基线哈希与本机冻结包不一致，可能来自其它案卷或不同冻结版本。' }
    }

    const items = classifyMerge({
      order,
      currentClaims: env.caseState.claims,
      currentFeatures: env.caseState.features,
      currentParagraphs: env.caseState.paragraphs,
      importedAt: nowIso()
    })
    const pending = items.filter(item => item.status === 'pending').length
    const auto = items.length - pending

    const session: MergeSession = {
      sessionId: `merge-${Date.now()}`,
      orderId: order.orderId,
      packageId: order.packageId,
      baselineHash: order.baselineHash,
      importedAt: nowIso(),
      importedFrom: file.name,
      reviewerName: order.reviewerName,
      state: 'open',
      items
    }

    const next = clone(env)
    next.mergeSessions.unshift(session)
    next.caseState.activeTab = 'pending'
    next.orderArchives.unshift({ archivedAt: nowIso(), order: clone(order), mergeSessionId: session.sessionId })
    next.processingRecords.push(record('import',
      `导入变更单 ${order.orderId}（来自 ${file.name}，复核员：${order.reviewerName}）：共 ${items.length} 项，自动可合入 ${auto} 项，进入待决区 ${pending} 项；待决项未写入可编辑案卷。`,
      session.sessionId))
    this.commit(next, false)
    return pending
      ? { ok: true, message: `已导入：${auto} 项可自动合入，${pending} 项进入待决区等待逐项确认。` }
      : { ok: true, message: `已导入：全部 ${auto} 项均可自动合入，确认后生效。` }
  }

  resolveMergeItem(sessionId: string, itemIndex: number, resolution: 'accept' | 'reject'): void {
    const next = clone(this.envelopeSubject.value)
    const session = next.mergeSessions.find(item => item.sessionId === sessionId)
    if (!session || session.state !== 'open') return
    const item = session.items.find(entry => entry.index === itemIndex)
    if (!item) return
    item.resolution = resolution
    item.resolvedAt = nowIso()
    if (item.status === 'pending') item.status = resolution === 'accept' ? 'accepted' : 'rejected'
    next.processingRecords.push(record('resolve',
      `${resolution === 'accept' ? '采纳' : '拒绝'}待决项 #${item.index + 1}（${describeChange(item.change)}）。`, session.sessionId))
    this.commit(next, false)
  }

  unresolvedCount(sessionId: string): number {
    const session = this.envelopeSubject.value.mergeSessions.find(item => item.sessionId === sessionId)
    return session ? session.items.filter(item => item.status === 'pending').length : 0
  }

  /** 离线复核员确认合并：所有待决项必须已有逐项决议，之后才生成可编辑案卷 */
  confirmMerge(sessionId: string): { ok: boolean; message: string } {
    const env = this.envelopeSubject.value
    const session = env.mergeSessions.find(item => item.sessionId === sessionId)
    if (!session || session.state !== 'open') return { ok: false, message: '合并会话不存在或已结束。' }
    const unresolved = session.items.filter(item => item.status === 'pending')
    if (unresolved.length) return { ok: false, message: `还有 ${unresolved.length} 个待决项未作采纳/拒绝决定。` }

    const result = applyResolvedItems(env.caseState.claims, env.caseState.features, session.items)
    const next = clone(env)
    const beforeFeatures = new Map(next.caseState.features.map(f => [f.id, f]))
    next.caseState.claims = result.claims
    next.caseState.features = result.features

    // 接受“删除特征”后，其说明书支持映射进入待清理清单；批注随特征移除
    const surviving = new Set(result.features.map(f => f.id))
    for (const feature of next.caseState.features) {
      for (const paragraphId of feature.supportIds) {
        if (!next.caseState.paragraphs.some(p => p.id === paragraphId)) {
          feature.supportIds = feature.supportIds.filter(id => id !== paragraphId)
        }
      }
    }
    for (const [id, removed] of beforeFeatures) {
      if (!surviving.has(id)) {
        removed.supportIds.forEach(paragraphId => {
          if (next.caseState.paragraphs.some(p => p.id === paragraphId)) {
            next.caseState.orphanMappings.push({
              id: `orphan-${Date.now()}-${paragraphId}-${Math.random().toString(36).slice(2, 6)}`,
              featureLabel: removed.label, paragraphId,
              reason: `外部合并删除技术特征“${removed.label}”，其支持段落映射留存待清理。`
            })
          }
        })
      }
    }
    next.caseState.annotations = next.caseState.annotations.filter(a => surviving.has(a.featureId))
    if (!next.caseState.claims.some(c => c.id === next.caseState.selectedClaimId)) {
      next.caseState.selectedClaimId = next.caseState.claims[0]?.id || ''
    }
    next.caseState.selectedFeatureId = next.caseState.features
      .find(f => f.id === next.caseState.selectedFeatureId && f.claimId === next.caseState.selectedClaimId)?.id || null

    const target = next.mergeSessions.find(item => item.sessionId === sessionId)!
    target.state = 'confirmed'
    const acceptedCount = session.items.filter(i => i.status === 'auto' || i.resolution === 'accept').length
    const rejectedCount = session.items.length - acceptedCount
    const rec = record('merge-confirm',
      `离线复核员确认合并变更单 ${session.orderId}：采纳 ${acceptedCount} 项、拒绝 ${rejectedCount} 项，已生成可编辑案卷；冻结包、变更单与全部处理记录独立留存。`,
      session.sessionId)
    target.recordId = rec.id
    next.processingRecords.push(rec)
    const archive = next.orderArchives.find(entry => entry.order.orderId === session.orderId)
    if (archive) archive.mergeSessionId = session.sessionId
    this.commit(next, false)
    return { ok: true, message: `合并完成：采纳 ${acceptedCount} 项，拒绝 ${rejectedCount} 项。` }
  }

  discardMerge(sessionId: string): void {
    const next = clone(this.envelopeSubject.value)
    const session = next.mergeSessions.find(item => item.sessionId === sessionId)
    if (!session || session.state !== 'open') return
    session.state = 'discarded'
    next.caseState.activeTab = 'mapping'
    next.processingRecords.push(record('merge-discard',
      `放弃合并变更单 ${session.orderId}，可编辑案卷保持导入前状态；变更单原件继续留存。`, session.sessionId))
    this.commit(next, false)
  }

  exportArchivedOrderJson(orderId: string): string | null {
    const entry = this.envelopeSubject.value.orderArchives.find(item => item.order.orderId === orderId)
    return entry ? JSON.stringify(entry.order, null, 2) : null
  }

  exportRecordsJson(): string {
    const env = this.envelopeSubject.value
    return JSON.stringify({
      exportedAt: nowIso(),
      storageKey: ENVELOPE_KEY,
      frozenPackages: env.frozenPackages.map(entry => ({
        packageId: entry.pkg.packageId, frozenAt: entry.pkg.frozenAt, archivedAt: entry.archivedAt,
        claimCount: entry.pkg.claims.length, featureCount: entry.pkg.features.length
      })),
      archivedOrders: env.orderArchives.map(entry => ({
        orderId: entry.order.orderId, packageId: entry.order.packageId,
        reviewerName: entry.order.reviewerName, archivedAt: entry.archivedAt, mergeSessionId: entry.mergeSessionId
      })),
      processingRecords: env.processingRecords
    }, null, 2)
  }

  /* ------------------------------ 校验 ------------------------------ */

  validate(state: WorkbenchState = this.snapshot): ValidationIssue[] {
    const issues: ValidationIssue[] = []
    for (const feature of state.features) {
      if (!feature.text.trim()) issues.push({ id: `empty-${feature.id}`, severity: 'warning', type: 'empty-feature', featureId: feature.id, title: `${feature.label} 内容为空`, detail: '请补全技术特征文字，避免映射对象不明确。' })
      if (!feature.supportIds.length) issues.push({ id: `support-${feature.id}`, severity: 'error', type: 'missing-support', featureId: feature.id, title: `${feature.label} 缺少说明书依据`, detail: '至少为一个说明书段落建立支持映射。' })
      if (this.hasReferenceCycle(feature, state.features)) issues.push({ id: `cycle-${feature.id}`, severity: 'error', type: 'cycle', featureId: feature.id, title: `${feature.label} 存在循环引用`, detail: '特征层级或引用关系形成闭环，请移除其中一条关系。' })
    }
    state.orphanMappings.forEach(item => issues.push({ id: item.id, severity: 'warning', type: 'orphan-mapping', title: '存在待清理映射', detail: item.reason }))
    return issues
  }

  private hasReferenceCycle(start: Feature, features: Feature[]): boolean {
    const visited = new Set<string>()
    const visit = (id: string): boolean => {
      if (id === start.id && visited.size > 0) return true
      if (visited.has(id)) return false
      visited.add(id)
      const feature = features.find(item => item.id === id)
      if (!feature) return false
      if (feature.parentId && visit(feature.parentId)) return true
      return feature.referenceIds.some(visit)
    }
    return visit(start.id)
  }
}

function describeChange(change: MergeItem['change']): string {
  const opLabel = { add: '新增', update: '修改', remove: '删除' }[change.op]
  const kindLabel = { claim: '权利要求', feature: '技术特征', mapping: '支持映射' }[change.kind]
  return `${kindLabel}${opLabel} ${change.entityId}`
}
