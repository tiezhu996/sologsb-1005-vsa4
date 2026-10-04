import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, map, type Subscription } from 'rxjs'
import type {
  Claim,
  Feature,
  FrozenPackage,
  MergeItem,
  OfflineReviewDraft,
  Paragraph,
  Position,
  ProcessingRecord,
  Role,
  ValidationIssue,
  WorkbenchState
} from './models'
import { CaseStoreService } from './case-store.service'

const POSITION_KEY = 'patent-claim-mapping-position-v1'

const ROLE_NAMES: Record<Role, string> = {
  author: '代理人 · 陈昊',
  examiner: '审查员 · 李岚',
  viewer: '观察者'
}
function clone<T>(value: T): T { return structuredClone(value) }

@Injectable({ providedIn: 'root' })
export class WorkbenchService implements OnDestroy {
  private readonly stateSubject = new BehaviorSubject<WorkbenchState>(this.store.workbench)
  private readonly historySubject = new BehaviorSubject<{ past: number; future: number }>({ past: 0, future: 0 })
  private past: WorkbenchState[] = []
  private future: WorkbenchState[] = []
  private repoSub: Subscription

  readonly state$ = this.stateSubject.asObservable()
  readonly history$ = this.historySubject.asObservable()
  readonly repo$ = this.store.repo$
  readonly archive$ = this.store.archive$
  readonly draft$ = this.store.draft$
  readonly notices$ = this.store.notices$
  readonly claims$ = this.state$.pipe(map(state => state.claims))
  readonly paragraphs$ = this.state$.pipe(map(state => state.paragraphs))
  readonly features$ = this.state$.pipe(map(state => state.features))
  readonly annotations$ = this.state$.pipe(map(state => state.annotations))
  readonly role$ = this.state$.pipe(map(state => state.role))
  readonly selectedClaim$ = this.state$.pipe(map(state => state.claims.find(claim => claim.id === state.selectedClaimId) || state.claims[0]))
  readonly selectedFeature$ = this.state$.pipe(map(state => state.features.find(feature => feature.id === state.selectedFeatureId) || null))
  readonly issues$ = this.state$.pipe(map(state => this.validate(state)))

  constructor(private readonly store: CaseStoreService) {
    // 存储层任何变化（含导入、合并确认、写失败回滚）都同步回工作台
    this.repoSub = this.store.repo$.subscribe(repo => {
      if (!repo) return
      this.stateSubject.next(clone(repo.workbench))
    })
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', () => this.savePosition())
  }

  ngOnDestroy(): void {
    this.repoSub.unsubscribe()
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', () => this.savePosition())
  }

  get snapshot(): WorkbenchState { return clone(this.stateSubject.value) }
  get repoSnapshot() { return this.store.snapshot }
  get canUndo(): boolean { return this.past.length > 0 }
  get canRedo(): boolean { return this.future.length > 0 }
  get actorName(): string { return ROLE_NAMES[this.stateSubject.value.role] }

  // ===== 冻结 / 变更单 / 合并（转发至存储层） =====

  get currentBaseline(): FrozenPackage | null { return this.store.currentBaseline }
  get activeSessionItems(): MergeItem[] { return this.store.activeSession?.items ?? [] }
  get hasActiveSession(): boolean { return this.store.hasActiveSession }
  get unresolvedCount(): number { return this.store.unresolvedCount }
  get draft(): OfflineReviewDraft | null { return this.store.currentDraft }
  get draftBaseline(): FrozenPackage | null { return this.store.draftBaseline }
  get records(): ProcessingRecord[] { return this.store.snapshot.records }

  freezeCurrent(note: string): FrozenPackage | null {
    const state = this.stateSubject.value
    return this.store.freezePackage(note, { role: state.role, name: this.actorName })
  }

  exportFrozenPackage(pkg: FrozenPackage): { content: string; filename: string } {
    return this.store.exportPackage(pkg)
  }

  beginOfflineReview(pkg: FrozenPackage, reviewerName: string): OfflineReviewDraft {
    return this.store.beginOfflineReview(pkg, reviewerName)
  }

  mutateDraft(recipe: (draft: OfflineReviewDraft) => void): boolean {
    return this.store.mutateDraft(recipe)
  }

  exportDraftOrder(note: string): { content: string; filename: string } | { error: string } {
    return this.store.exportDraftOrder(note)
  }

  closeDraft(): void { this.store.closeDraft() }

  importChangeOrder(raw: string): { ok: boolean; message: string } {
    const result = this.store.importChangeOrder(raw, this.actorName)
    if (result.ok) {
      // 外部案卷落盘后，本地撤销栈不再适用
      this.past = []
      this.future = []
      this.updateHistory()
    }
    return result
  }

  resolvePending(itemId: string, resolution: 'take-external' | 'keep-local', note = ''): void {
    this.store.resolvePendingItem(itemId, resolution, this.actorName, note)
  }

  resolveAllPending(resolution: 'take-external' | 'keep-local'): void {
    this.store.resolveAllPending(resolution, this.actorName)
  }

  confirmMerge(): { ok: boolean; message: string } {
    const result = this.store.confirmMerge(this.actorName)
    if (result.ok) {
      this.past = []
      this.future = []
      this.updateHistory()
    }
    return result
  }

  discardMerge(): void {
    this.store.discardMerge(this.actorName)
    this.past = []
    this.future = []
    this.updateHistory()
  }

  dismissNotice(id: string): void { this.store.dismissNotice(id) }

  // ===== 案卷编辑 =====

  selectClaim(id: string): void {
    this.patchState(state => { state.selectedClaimId = id; state.selectedFeatureId = state.features.find(feature => feature.claimId === id)?.id || null })
    this.savePosition()
  }

  selectFeature(id: string | null): void {
    this.patchState(state => { state.selectedFeatureId = id })
    this.savePosition()
  }

  setRole(role: Role): void {
    this.patchState(state => { state.role = role; state.currentUserRole = role })
  }

  setTab(tab: string): void {
    this.patchState(state => { state.activeTab = tab })
    this.savePosition()
  }

  updateClaim(patch: Partial<Claim>): void {
    this.commit(state => {
      const claim = state.claims.find(item => item.id === state.selectedClaimId)
      if (claim) Object.assign(claim, patch)
    })
  }

  addClaim(): void {
    this.commit(state => {
      const number = Math.max(0, ...state.claims.map(claim => claim.number)) + 1
      const claim: Claim = { id: `claim-${Date.now()}`, number, title: `权利要求 ${number}`, independent: false, text: '请录入权利要求正文。' }
      state.claims.push(claim)
      state.selectedClaimId = claim.id
      state.selectedFeatureId = null
    })
  }

  addParagraph(): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const next = state.paragraphs.length + 1
      state.paragraphs.push({ id: `para-${Date.now()}`, section: `说明书 [${String(next * 5).padStart(4, '0')}]`, text: '' })
    })
  }

  updateParagraph(id: string, patch: Partial<Paragraph>): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const paragraph = state.paragraphs.find(item => item.id === id)
      if (paragraph) Object.assign(paragraph, patch)
    })
  }

  deleteParagraph(id: string): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      state.paragraphs = state.paragraphs.filter(item => item.id !== id)
      state.features.forEach(feature => { feature.supportIds = feature.supportIds.filter(paragraphId => paragraphId !== id) })
      state.orphanMappings = state.orphanMappings.filter(item => item.paragraphId !== id)
    })
  }

  addFeature(): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
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
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const feature = state.features.find(item => item.id === id)
      if (feature) Object.assign(feature, patch)
    })
  }

  deleteFeature(id: string): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const feature = state.features.find(item => item.id === id)
      if (!feature) return
      feature.supportIds.forEach(paragraphId => state.orphanMappings.push({
        id: `orphan-${Date.now()}-${paragraphId}`, featureLabel: feature.label, paragraphId,
        reason: `技术特征“${feature.label}”已删除，但支持段落映射仍被保留。`
      }))
      state.features = state.features.filter(item => item.id !== id)
      state.features.forEach(item => {
        item.referenceIds = item.referenceIds.filter(refId => refId !== id)
        if (item.parentId === id) item.parentId = null
      })
      state.annotations = state.annotations.filter(item => item.featureId !== id)
      state.selectedFeatureId = state.features.find(item => item.claimId === state.selectedClaimId)?.id || null
    })
  }

  toggleParagraphMapping(featureId: string, paragraphId: string): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const feature = state.features.find(item => item.id === featureId)
      if (!feature) return
      const index = feature.supportIds.indexOf(paragraphId)
      if (index >= 0) feature.supportIds.splice(index, 1)
      else feature.supportIds.push(paragraphId)
      state.orphanMappings = state.orphanMappings.filter(item => item.paragraphId !== paragraphId)
    })
  }

  clearOrphan(id: string): void {
    this.commit(state => { state.orphanMappings = state.orphanMappings.filter(item => item.id !== id) })
  }

  addAnnotation(featureId: string, text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    const role = this.stateSubject.value.role
    this.commit(state => state.annotations.push({
      id: `annotation-${Date.now()}`, featureId, authorRole: role, authorName: ROLE_NAMES[role], text: trimmed, updatedAt: new Date().toISOString()
    }))
  }

  updateAnnotation(id: string, text: string): void {
    this.commit(state => {
      const annotation = state.annotations.find(item => item.id === id)
      if (annotation && annotation.authorRole === state.role) annotation.text = text
    })
  }

  deleteAnnotation(id: string): void {
    this.commit(state => {
      const annotation = state.annotations.find(item => item.id === id)
      if (annotation && annotation.authorRole === state.role) state.annotations = state.annotations.filter(item => item.id !== id)
    })
  }

  createVersion(name?: string): void {
    this.commit(state => {
      state.versions.unshift({
        id: `version-${Date.now()}`, name: name?.trim() || `快照 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        createdAt: new Date().toISOString(), claims: clone(state.claims), features: clone(state.features)
      })
    })
  }

  restoreVersion(id: string): void {
    this.commit(state => {
      const version = state.versions.find(item => item.id === id)
      if (!version) return
      state.claims = clone(version.claims)
      state.features = clone(version.features)
      if (!state.claims.some(claim => claim.id === state.selectedClaimId)) state.selectedClaimId = state.claims[0]?.id || ''
      state.selectedFeatureId = state.features.find(feature => feature.claimId === state.selectedClaimId)?.id || null
    })
  }

  undo(): void {
    const previous = this.past.pop()
    if (!previous) return
    const current = clone(this.stateSubject.value)
    const ok = this.store.mutateWorkbench(state => { Object.assign(state, clone(previous)) })
    if (ok) {
      this.future.push(current)
      this.updateHistory()
      this.savePosition()
    } else {
      this.past.push(previous)
    }
  }

  redo(): void {
    const next = this.future.pop()
    if (!next) return
    const current = clone(this.stateSubject.value)
    const ok = this.store.mutateWorkbench(state => { Object.assign(state, clone(next)) })
    if (ok) {
      this.past.push(current)
      this.updateHistory()
      this.savePosition()
    } else {
      this.future.push(next)
    }
  }

  savePosition(): void {
    if (typeof localStorage === 'undefined') return
    const state = this.stateSubject.value
    const position: Position = { tab: state.activeTab, claimId: state.selectedClaimId, featureId: state.selectedFeatureId, scrollY: window.scrollY }
    try { localStorage.setItem(POSITION_KEY, JSON.stringify(position)) } catch { /* 位置写失败不阻断 */ }
  }

  readPosition(): Position {
    const fallback: Position = { tab: this.stateSubject.value.activeTab, claimId: this.stateSubject.value.selectedClaimId, featureId: this.stateSubject.value.selectedFeatureId, scrollY: 0 }
    if (typeof localStorage === 'undefined') return fallback
    try {
      const stored = JSON.parse(localStorage.getItem(POSITION_KEY) || '{}') as Partial<Position>
      return { ...fallback, ...stored } as Position
    } catch { return fallback }
  }

  exportJson(): string {
  return JSON.stringify({
    schemaVersion: 2,
    caseCode: 'CN-2026-0917',
    ...this.snapshot,
    validationIssues: this.validate(this.stateSubject.value)
  }, null, 2)
}

  exportCsv(): string {
    const state = this.stateSubject.value
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

  validate(state = this.stateSubject.value): ValidationIssue[] {
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

  private commit(recipe: (state: WorkbenchState) => void): void {
    const current = clone(this.stateSubject.value)
    const ok = this.store.mutateWorkbench(recipe)
    if (!ok) return
    this.past.push(current)
    if (this.past.length > 60) this.past.shift()
    this.future = []
    this.updateHistory()
  }

  private patchState(recipe: (state: WorkbenchState) => void): void {
    this.store.mutateWorkbench(recipe)
  }

  private updateHistory(): void { this.historySubject.next({ past: this.past.length, future: this.future.length }) }
}
