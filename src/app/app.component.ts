import { AfterViewInit, Component, OnDestroy, OnInit } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { ButtonModule } from 'primeng/button'
import { InputTextModule } from 'primeng/inputtext'
import { TextareaModule } from 'primeng/textarea'
import { SelectModule } from 'primeng/select'
import { CardModule } from 'primeng/card'
import { BadgeModule } from 'primeng/badge'
import { DialogModule } from 'primeng/dialog'
import { TooltipModule } from 'primeng/tooltip'
import { Subscription } from 'rxjs'
import type {
  Annotation,
  Claim,
  Feature,
  FrozenPackage,
  MergeItem,
  MergeSession,
  OfflineReviewDraft,
  ProcessingRecord,
  ReviewArchive,
  Role,
  StorageNotice,
  ValidationIssue,
  WorkbenchState
} from './models'
import { WorkbenchService } from './workbench.service'

interface ImportFeedback { ok: boolean; message: string }

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, TextareaModule, SelectModule, CardModule, BadgeModule, DialogModule, TooltipModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit, AfterViewInit, OnDestroy {
  state: WorkbenchState
  issues: ValidationIssue[] = []
  history = { past: 0, future: 0 }
  compareA = ''
  compareB = ''
  annotationDraft = ''
  versionDialog = false
  versionName = ''
  activeIssue: ValidationIssue | null = null

  // 冻结 / 复核
  baseline: FrozenPackage | null = null
  frozenPackages: FrozenPackage[] = []
  mergeItems: MergeItem[] = []
  archive: ReviewArchive | null = null
  draft: OfflineReviewDraft | null = null
  notices: StorageNotice[] = []
  records: ProcessingRecord[] = []
  freezeDialog = false
  freezeNote = ''
  importFeedback: ImportFeedback | null = null
  resolveNote = ''
  resolveItem: MergeItem | null = null
  confirmFeedback = ''
  reviewDialog = false
  reviewDraftState: OfflineReviewDraft | null = null
  reviewOrderNote = ''
  reviewMessage = ''
  reviewSelectedClaimId = ''
  reviewSelectedFeatureId: string | null = null
  reviewerName = '外部复核员'
  roleOptions: Array<{ label: string; value: Role }> = [
    { label: '代理人（可编辑主数据与本人批注）', value: 'author' },
    { label: '审查员（可编辑本人批注）', value: 'examiner' },
    { label: '观察者（只读）', value: 'viewer' }
  ]
  private subscriptions = new Subscription()
  private fileInput: HTMLInputElement | null = null

  constructor(readonly service: WorkbenchService) {
    this.state = service.snapshot
    this.syncReviewState()
  }

  ngOnInit(): void {
    this.subscriptions.add(this.service.state$.subscribe(state => {
      this.state = structuredClone(state)
      this.syncVersions()
    }))
    this.subscriptions.add(this.service.issues$.subscribe(issues => this.issues = issues))
    this.subscriptions.add(this.service.history$.subscribe(history => this.history = history))
    this.subscriptions.add(this.service.repo$.subscribe(() => this.syncReviewState()))
    this.subscriptions.add(this.service.archive$.subscribe(archive => { this.archive = structuredClone(archive) }))
    this.subscriptions.add(this.service.draft$.subscribe(draft => {
      this.draft = draft ? structuredClone(draft) : null
      if (draft && !this.reviewDraftState) this.reviewDraftState = structuredClone(draft)
      if (!draft) { this.reviewDialog = false; this.reviewDraftState = null }
    }))
    this.subscriptions.add(this.service.notices$.subscribe(notices => { this.notices = structuredClone(notices) }))
    window.addEventListener('keydown', this.handleKeyboard)
  }

  ngAfterViewInit(): void {
    const position = this.service.readPosition()
    setTimeout(() => window.scrollTo({ top: position.scrollY || 0, behavior: 'instant' as ScrollBehavior }), 0)
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe()
    window.removeEventListener('keydown', this.handleKeyboard)
  }

  get selectedClaim(): Claim | undefined { return this.state.claims.find(item => item.id === this.state.selectedClaimId) }
  get selectedFeature(): Feature | undefined { return this.state.features.find(item => item.id === this.state.selectedFeatureId) }
  get claimFeatures(): Feature[] { return this.state.features.filter(item => item.claimId === this.state.selectedClaimId) }
  get featureAnnotations(): Annotation[] { return this.selectedFeature ? this.state.annotations.filter(item => item.featureId === this.selectedFeature?.id) : [] }
  get currentRoleLabel(): string { return this.roleOptions.find(item => item.value === this.state.role)?.label || '' }
  get errorCount(): number { return this.issues.filter(item => item.severity === 'error').length }
  get warningCount(): number { return this.issues.filter(item => item.severity === 'warning').length }
  get canEditMainData(): boolean { return this.state.role !== 'viewer' }
  get mappedFeatureCount(): number { return this.claimFeatures.filter(feature => feature.supportIds.length > 0).length }

  // ===== 冻结 / 复核派生数据 =====
  get pendingItems(): MergeItem[] { return this.mergeItems.filter(item => item.status.startsWith('pending-') && item.resolution === 'pending') }
  get cleanItems(): MergeItem[] { return this.mergeItems.filter(item => item.status === 'clean') }
  get redundantItems(): MergeItem[] { return this.mergeItems.filter(item => item.status === 'redundant') }
  get resolvedItems(): MergeItem[] { return this.mergeItems.filter(item => item.resolution !== 'pending') }
  get archivedSessions(): ProcessingRecord[] { return this.records }
  get reviewClaim(): { claim?: Claim; features: Feature[] } {
    const claims = this.reviewDraftState?.reviewed.claims ?? []
    const features = this.reviewDraftState?.reviewed.features ?? []
    const claim = claims.find(item => item.id === this.reviewSelectedClaimId) ?? claims[0]
    return { claim, features: features.filter(feature => feature.claimId === claim?.id) }
  }
  get reviewFeature(): Feature | undefined {
    return this.reviewDraftState?.reviewed.features.find(item => item.id === this.reviewSelectedFeatureId)
  }

  claimLabel(id: string): string { return this.state.claims.find(item => item.id === id)?.title || '未命名权利要求' }
  featureLabel(id: string): string { return this.state.features.find(item => item.id === id)?.label || id }
  paragraphLabel(id: string): string { return this.state.paragraphs.find(item => item.id === id)?.section || id }
  isMapped(feature: Feature, paragraphId: string): boolean { return feature.supportIds.includes(paragraphId) }
  isOwnAnnotation(annotation: Annotation): boolean { return annotation.authorRole === this.state.role }
  ownerLabel(role: Role): string { return ({ author: '代理人', examiner: '审查员', viewer: '观察者' })[role] }

  statusBadge(item: MergeItem): { label: string; cls: string } {
    if (item.status === 'clean') return { label: '可直接采用', cls: 'ok' }
    if (item.status === 'redundant') return { label: '冗余无变化', cls: 'muted' }
    if (item.status === 'pending-local-removed') return { label: '本地对象已移除', cls: 'danger' }
    return { label: '两边都改过', cls: 'warn' }
  }

  recordKindLabel(kind: ProcessingRecord['kind']): string {
    const labels: Record<ProcessingRecord['kind'], string> = {
      'legacy-upgraded': '原位升级',
      'package-frozen': '冻结基线',
      'order-imported': '导入变更单',
      'item-resolved': '待决裁决',
      'merge-confirmed': '确认合并',
      'merge-discarded': '放弃合并',
      'storage-recovered': '备份恢复',
      'storage-failed': '写入失败'
    }
    return labels[kind]
  }

  archivedSessionList() {
    const sessions = this.archive?.sessions ?? {}
    return Object.values(sessions)
      .sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1))
      .slice(0, 10)
  }

  adoptedCount(session: MergeSession): number {
    return session.items.filter(item => item.status === 'clean' || item.resolution === 'take-external').length
  }

  keptLocalCount(session: MergeSession): number {
    return session.items.filter(item => item.resolution === 'keep-local').length
  }

  resolutionLabel(item: MergeItem): string {
    if (item.resolution === 'take-external') return `已裁决：采用复核方（${item.resolvedByName || ''}）`
    if (item.resolution === 'keep-local') return `已裁决：保留本地（${item.resolvedByName || ''}）`
    return '待裁决'
  }

  updateClaimField(field: 'title' | 'text' | 'number' | 'independent', event: Event): void {
    const element = event.target as HTMLInputElement
    const value = field === 'number' ? Number(element.value) : field === 'independent' ? element.checked : element.value
    this.service.updateClaim({ [field]: value })
  }

  updateFeatureField(field: 'label' | 'text', event: Event): void {
    if (!this.selectedFeature) return
    this.service.updateFeature(this.selectedFeature.id, { [field]: (event.target as HTMLInputElement | HTMLTextAreaElement).value })
  }

  updateFeatureParent(event: Event): void {
    if (!this.selectedFeature) return
    this.service.updateFeature(this.selectedFeature.id, { parentId: (event.target as HTMLSelectElement).value || null })
  }

  toggleReference(featureId: string, checked: boolean): void {
    if (!this.selectedFeature) return
    const ids = checked
      ? Array.from(new Set([...this.selectedFeature.referenceIds, featureId]))
      : this.selectedFeature.referenceIds.filter(id => id !== featureId)
    this.service.updateFeature(this.selectedFeature.id, { referenceIds: ids })
  }

  addAnnotation(): void {
    if (!this.selectedFeature) return
    this.service.addAnnotation(this.selectedFeature.id, this.annotationDraft)
    this.annotationDraft = ''
  }

  updateAnnotation(annotation: Annotation, event: Event): void {
    this.service.updateAnnotation(annotation.id, (event.target as HTMLTextAreaElement).value)
  }

  createVersion(): void {
    this.service.createVersion(this.versionName)
    this.versionName = ''
    this.versionDialog = false
  }

  restoreVersion(id: string): void {
    this.service.restoreVersion(id)
  }

  getVersion(id: string) { return this.state.versions.find(item => item.id === id) }
  compareRows(): Array<{ label: string; before: string; after: string; changed: boolean }> {
    const a = this.getVersion(this.compareA)
    const b = this.getVersion(this.compareB)
    if (!a || !b) return []
    const ids = Array.from(new Set([...a.claims.map(item => item.id), ...b.claims.map(item => item.id)]))
    return ids.map(id => {
      const before = a.claims.find(item => item.id === id)?.text || ''
      const after = b.claims.find(item => item.id === id)?.text || ''
      return { label: `权利要求 ${a.claims.find(item => item.id === id)?.number || b.claims.find(item => item.id === id)?.number || '?'}`, before, after, changed: before !== after }
    })
  }

  exportFile(type: 'json' | 'csv'): void {
    const content = type === 'json' ? this.service.exportJson() : this.service.exportCsv()
    const mime = type === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8'
    this.download(content, `patent-claim-check-${new Date().toISOString().slice(0, 10)}.${type}`, mime)
  }

  locateIssue(issue: ValidationIssue): void {
    this.activeIssue = issue
    if (issue.featureId) this.service.selectFeature(issue.featureId)
    this.service.setTab('mapping')
  }

  closeIssue(): void { this.activeIssue = null }

  // ===== 冻结案件包 =====

  openFreezeDialog(): void {
    this.freezeNote = ''
    this.freezeDialog = true
  }

  confirmFreeze(): void {
    const pkg = this.service.freezeCurrent(this.freezeNote)
    this.freezeDialog = false
    if (!pkg) this.importFeedback = { ok: false, message: '存在未处理完的复核合并，不能冻结新基线。' }
  }

  downloadFrozenPackage(pkg: FrozenPackage): void {
    const file = this.service.exportFrozenPackage(pkg)
    this.download(file.content, file.filename, 'application/json;charset=utf-8')
  }

  // ===== 离线复核（本机模拟外部复核员机器） =====

  openReview(pkg: FrozenPackage): void {
    if (this.draft && this.draft.packageId !== pkg.packageId) {
      this.reviewMessage = '已有进行中的复核草稿，请先导出变更单或关闭草稿。'
      return
    }
    if (!this.draft) this.service.beginOfflineReview(pkg, this.reviewerName)
    this.reviewDraftState = structuredClone(this.service.draft)
    if (!this.reviewDraftState) return
    this.reviewSelectedClaimId = this.reviewDraftState?.reviewed.claims[0]?.id ?? ''
    this.reviewSelectedFeatureId = this.reviewDraftState?.reviewed.features.find(f => f.claimId === this.reviewSelectedClaimId)?.id ?? null
    this.reviewOrderNote = ''
    this.reviewMessage = ''
    this.reviewDialog = true
  }

  resumeReview(): void {
    if (!this.draft) return
    this.reviewDraftState = structuredClone(this.draft)
    this.reviewSelectedClaimId = this.reviewDraftState.reviewed.claims[0]?.id ?? ''
    this.reviewSelectedFeatureId = this.reviewDraftState.reviewed.features.find(f => f.claimId === this.reviewSelectedClaimId)?.id ?? null
    this.reviewerName = this.draft.reviewerName
    this.reviewDialog = true
  }

  selectReviewClaim(id: string): void {
    this.reviewSelectedClaimId = id
    this.reviewSelectedFeatureId = this.reviewClaim.features[0]?.id ?? null
  }

  selectReviewFeature(id: string): void {
    this.reviewSelectedFeatureId = id
  }

  updateReviewClaim(field: 'title' | 'text' | 'number', event: Event): void {
    const element = event.target as HTMLInputElement
    this.mutateReview(draft => {
      const claim = draft.reviewed.claims.find(item => item.id === this.reviewSelectedClaimId)
      if (!claim) return
      if (field === 'number') claim.number = Number(element.value)
      else claim[field] = element.value
    })
  }

  updateReviewFeatureField(field: 'label' | 'text', event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value
    this.mutateReview(draft => {
      const feature = draft.reviewed.features.find(item => item.id === this.reviewSelectedFeatureId)
      if (feature) feature[field] = value
    })
  }

  toggleReviewMapping(paragraphId: string): void {
    this.mutateReview(draft => {
      const feature = draft.reviewed.features.find(item => item.id === this.reviewSelectedFeatureId)
      if (!feature) return
      const index = feature.supportIds.indexOf(paragraphId)
      if (index >= 0) feature.supportIds.splice(index, 1)
      else feature.supportIds.push(paragraphId)
    })
  }

  isReviewMapped(paragraphId: string): boolean {
    return !!this.reviewFeature?.supportIds.includes(paragraphId)
  }

  deleteReviewFeature(): void {
    if (!this.reviewSelectedFeatureId) return
    const id = this.reviewSelectedFeatureId
    this.mutateReview(draft => {
      draft.reviewed.features = draft.reviewed.features.filter(item => item.id !== id)
      draft.reviewed.features.forEach(item => {
        item.referenceIds = item.referenceIds.filter(refId => refId !== id)
        if (item.parentId === id) item.parentId = null
      })
    })
    this.reviewSelectedFeatureId = this.reviewClaim.features[0]?.id ?? null
  }

  addReviewFeature(): void {
    const id = `feature-review-${Date.now()}`
    this.mutateReview(draft => {
      draft.reviewed.features.push({
        id, claimId: this.reviewSelectedClaimId,
        label: `复核新增特征 ${draft.reviewed.features.filter(f => f.claimId === this.reviewSelectedClaimId).length + 1}`,
        text: '', parentId: null, referenceIds: [], supportIds: [], ownerRole: 'examiner'
      })
    })
    this.reviewSelectedFeatureId = id
  }

  saveReviewerName(): void {
    if (this.reviewDraftState) this.reviewDraftState.reviewerName = this.reviewerName.trim() || '离线复核员'
    this.saveReviewDraft()
  }

  /** 保存编辑态草稿到存储层（失败时编辑态回退到磁盘版本） */
  private saveReviewDraft(): void {
    if (!this.reviewDraftState) return
    const candidate = structuredClone(this.reviewDraftState)
    const ok = this.service.mutateDraft(draft => {
      draft.reviewed = candidate.reviewed
      draft.reviewerName = candidate.reviewerName
      draft.note = candidate.note
    })
    if (!ok) {
      this.reviewMessage = '草稿写入失败，已保留上一版；请重试。'
      this.reviewDraftState = this.service.draft ? structuredClone(this.service.draft) : this.reviewDraftState
    } else {
      this.reviewMessage = ''
    }
  }

  private mutateReview(recipe: (draft: OfflineReviewDraft) => void): void {
    if (!this.reviewDraftState) return
    recipe(this.reviewDraftState)
    this.saveReviewDraft()
  }

  exportReviewOrder(): void {
    const result = this.service.exportDraftOrder(this.reviewOrderNote)
    if ('error' in result) {
      this.reviewMessage = result.error
      return
    }
    this.download(result.content, result.filename, 'application/json;charset=utf-8')
    this.reviewMessage = '变更单已导出；回传给代理人后关闭草稿即可。'
  }

  closeReviewDialog(): void {
    this.reviewDialog = false
  }

  // ===== 变更单导入与待决合并 =====

  pickOrderFile(): void {
    this.fileInput?.remove()
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (file) this.readOrderFile(file)
      input.remove()
      this.fileInput = null
    })
    this.fileInput = input
    input.click()
  }

  private readOrderFile(file: File): void {
    const reader = new FileReader()
    reader.onload = () => {
      const result = this.service.importChangeOrder(String(reader.result ?? ''))
      this.importFeedback = result
    }
    reader.onerror = () => { this.importFeedback = { ok: false, message: '读取文件失败，请重试。' } }
    reader.readAsText(file)
  }

  openResolveDialog(item: MergeItem): void {
    this.resolveItem = item
    this.resolveNote = ''
  }

  decideResolution(resolution: 'take-external' | 'keep-local'): void {
    if (!this.resolveItem) return
    this.service.resolvePending(this.resolveItem.id, resolution, this.resolveNote)
    this.resolveItem = null
  }

  resolveAll(resolution: 'take-external' | 'keep-local'): void {
    this.service.resolveAllPending(resolution)
  }

  confirmMerge(): void {
    const result = this.service.confirmMerge()
    this.confirmFeedback = result.message
    if (result.ok) setTimeout(() => { this.confirmFeedback = '' }, 4000)
  }

  discardMerge(): void {
    this.service.discardMerge()
    this.confirmFeedback = '已放弃本次合并，案卷未改动；变更单与记录已独立留存。'
  }

  dismissNotice(id: string): void { this.service.dismissNotice(id) }
  dismissFeedback(): void { this.importFeedback = null }

  private download(content: string, filename: string, mime: string): void {
    const url = URL.createObjectURL(new Blob([content], { type: mime }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.click()
    URL.revokeObjectURL(url)
  }

  private syncReviewState(): void {
    this.baseline = this.service.currentBaseline
    this.mergeItems = this.service.activeSessionItems
    this.records = this.service.records
    this.frozenPackages = structuredClone(this.service.repoSnapshot.frozenPackages)
  }

  private syncVersions(): void {
    if (!this.state.versions.some(item => item.id === this.compareA)) this.compareA = this.state.versions[1]?.id || this.state.versions[0]?.id || ''
    if (!this.state.versions.some(item => item.id === this.compareB)) this.compareB = this.state.versions[0]?.id || ''
  }

  private handleKeyboard = (event: KeyboardEvent): void => {
    if (!(event.metaKey || event.ctrlKey)) return
    if (event.key.toLowerCase() === 'z') {
      event.preventDefault()
      event.shiftKey ? this.service.redo() : this.service.undo()
    } else if (event.key.toLowerCase() === 'y') {
      event.preventDefault()
      this.service.redo()
    } else if (event.key.toLowerCase() === 's') {
      event.preventDefault()
      this.versionDialog = true
    }
  }
}
