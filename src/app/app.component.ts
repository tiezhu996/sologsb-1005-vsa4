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
  Annotation, ChangeOrder, Claim, Feature, FrozenPackage, MergeItem,
  MergeSession, PersistEnvelopeV2, Role, ValidationIssue, WorkbenchState
} from './models'
import { WorkbenchService } from './workbench.service'
import { validateFrozenPackage } from './review'

interface Notice { severity: 'success' | 'warn' | 'error'; text: string }

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, TextareaModule, SelectModule, CardModule, BadgeModule, DialogModule, TooltipModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit, AfterViewInit, OnDestroy {
  envelope!: PersistEnvelopeV2
  state!: WorkbenchState
  mode: 'case' | 'review' = 'case'
  issues: ValidationIssue[] = []
  history = { past: 0, future: 0 }
  compareA = ''
  compareB = ''
  annotationDraft = ''
  versionDialog = false
  versionName = ''
  activeIssue: ValidationIssue | null = null
  notice: Notice | null = null
  storageFault: { since: string; lastError: string } | null = null

  reviewerName = '审查员 · 李岚'
  selectedFrozenPackageId = ''
  importedFrozenPackage: FrozenPackage | null = null
  importedFrozenError = ''
  orderImportMessage: Notice | null = null

  roleOptions: Array<{ label: string; value: Role }> = [
    { label: '代理人（可编辑主数据与本人批注）', value: 'author' },
    { label: '审查员（可编辑本人批注）', value: 'examiner' },
    { label: '观察者（只读）', value: 'viewer' }
  ]
  private subscriptions = new Subscription()
  private noticeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(readonly service: WorkbenchService) {
    this.state = service.snapshot
  }

  ngOnInit(): void {
    this.subscriptions.add(this.service.envelope$.subscribe(envelope => {
      this.envelope = structuredClone(envelope)
      this.mode = envelope.activeMode === 'review' && envelope.reviewSession ? 'review' : 'case'
      if (!this.selectedFrozenPackageId) this.selectedFrozenPackageId = envelope.frozenPackages.at(-1)?.pkg.packageId || ''
    }))
    this.subscriptions.add(this.service.state$.subscribe(state => {
      this.state = structuredClone(state)
      this.syncCompareSelection()
    }))
    this.subscriptions.add(this.service.issues$.subscribe(issues => this.issues = issues))
    this.subscriptions.add(this.service.history$.subscribe(history => this.history = history))
    this.subscriptions.add(this.service.storageFault$.subscribe(fault => { this.storageFault = fault }))
    window.addEventListener('keydown', this.handleKeyboard)
  }

  ngAfterViewInit(): void {
    const position = this.service.readPosition()
    setTimeout(() => window.scrollTo({ top: position.scrollY || 0, behavior: 'instant' as ScrollBehavior }), 0)
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe()
    window.removeEventListener('keydown', this.handleKeyboard)
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
  }

  get selectedClaim(): Claim | undefined { return this.state.claims.find(item => item.id === this.state.selectedClaimId) }
  get selectedFeature(): Feature | undefined { return this.state.features.find(item => item.id === this.state.selectedFeatureId) }
  get claimFeatures(): Feature[] { return this.state.features.filter(item => item.claimId === this.state.selectedClaimId) }
  get featureAnnotations(): Annotation[] { return this.selectedFeature ? this.state.annotations.filter(item => item.featureId === this.selectedFeature?.id) : [] }
  get currentRoleLabel(): string { return this.roleOptions.find(item => item.value === this.state.role)?.label || '' }
  get errorCount(): number { return this.issues.filter(item => item.severity === 'error').length }
  get warningCount(): number { return this.issues.filter(item => item.severity === 'warning').length }
  get canEditMainData(): boolean { return this.mode === 'review' || (this.state.role !== 'viewer' && !this.openMerge) }
  get canEditCaseData(): boolean { return this.mode === 'case' && this.state.role !== 'viewer' && !this.openMerge }
  get mappedFeatureCount(): number { return this.claimFeatures.filter(feature => feature.supportIds.length > 0).length }
  get frozenPackages(): PersistEnvelopeV2['frozenPackages'] { return this.envelope.frozenPackages }
  get latestFrozenPackage(): FrozenPackage | undefined { return this.envelope.frozenPackages.at(-1)?.pkg }
  get reviewSession() { return this.envelope.reviewSession }
  get openMerge(): MergeSession | null { return this.envelope.mergeSessions.find(session => session.state === 'open') || null }
  get closedMerges(): MergeSession[] { return this.envelope.mergeSessions.filter(session => session.state !== 'open') }
  get pendingItems(): MergeItem[] { return this.openMerge?.items.filter(item => item.status === 'pending') || [] }
  get autoItems(): MergeItem[] { return this.openMerge?.items.filter(item => item.status === 'auto') || [] }
  get resolvedItems(): MergeItem[] {
    return this.openMerge?.items.filter(item => item.status === 'accepted' || item.status === 'rejected') || []
  }
  get canConfirmMerge(): boolean { return !!this.openMerge && this.openMerge.items.every(item => item.status !== 'pending') }

  claimLabel(id: string): string { return this.state.claims.find(item => item.id === id)?.title || '未命名权利要求' }
  featureLabel(id: string): string { return this.state.features.find(item => item.id === id)?.label || id }
  paragraphLabel(id: string): string { return this.state.paragraphs.find(item => item.id === id)?.section || id }
  isMapped(feature: Feature | undefined, paragraphId: string): boolean { return !!feature?.supportIds.includes(paragraphId) }
  isOwnAnnotation(annotation: Annotation): boolean { return annotation.authorRole === this.state.role }
  ownerLabel(role: Role): string { return ({ author: '代理人', examiner: '审查员', viewer: '观察者' })[role] }

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

  restoreVersion(id: string): void { this.service.restoreVersion(id) }

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

  syncCompareSelection(): void {
    if (!this.state.versions.some(item => item.id === this.compareA)) this.compareA = this.state.versions[1]?.id || this.state.versions[0]?.id || ''
    if (!this.state.versions.some(item => item.id === this.compareB)) this.compareB = this.state.versions[0]?.id || ''
  }

  exportFile(type: 'json' | 'csv'): void {
    const content = type === 'json' ? this.service.exportJson() : this.service.exportCsv()
    const mime = type === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8'
    this.download(`patent-claim-check-${new Date().toISOString().slice(0, 10)}.${type}`, content, mime)
  }

  locateIssue(issue: ValidationIssue): void {
    this.activeIssue = issue
    if (issue.featureId) this.service.selectFeature(issue.featureId)
    this.service.setTab('mapping')
  }

  closeIssue(): void { this.activeIssue = null }

  /* ------------------------- 冻结案件包 / 外发复核 ------------------------- */

  freezeNow(): void {
    const pkg = this.service.freezePackage()
    this.selectedFrozenPackageId = pkg.packageId
    this.flash('success', `已生成冻结案件包 ${pkg.packageId}，基线哈希 ${pkg.baselineHash.slice(0, 12)}…`)
  }

  downloadJson(filename: string, content: string): void {
    this.download(filename, content, 'application/json;charset=utf-8')
  }

  exportFrozen(packageId: string): void {
    const content = this.service.exportFrozenPackageJson(packageId)
    if (content) this.downloadJson(`frozen-package-${packageId}.json`, content)
  }

  startLocalReview(): void {
    const error = this.service.startReview(this.selectedFrozenPackageId, this.reviewerName)
    if (error) this.flash('error', error)
    else this.flash('success', '已进入离线复核模式，全部修改只记录在复核工作副本中。')
  }

  onFrozenFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    this.importedFrozenError = ''
    this.importedFrozenPackage = null
    if (!file) return
    file.text().then(text => {
      let raw: unknown
      try { raw = JSON.parse(text) } catch { this.importedFrozenError = '文件不是有效的 JSON。'; return }
      const shapeError = validateFrozenPackage(raw)
      if (shapeError) { this.importedFrozenError = shapeError; return }
      this.importedFrozenPackage = raw as FrozenPackage
    })
    input.value = ''
  }

  openImportedFrozen(): void {
    if (!this.importedFrozenPackage) return
    const error = this.service.startReviewFromPackage(this.importedFrozenPackage, this.reviewerName)
    if (error) { this.flash('error', error); return }
    this.importedFrozenPackage = null
    this.flash('success', '已在当前电脑打开冻结包并进入复核模式。')
  }

  exportReviewChangeOrder(): void {
    const order = this.service.exportChangeOrder()
    if (!order) { this.flash('error', '当前没有进行中的复核会话。'); return }
    if (!order.changes.length) { this.flash('warn', '复核副本与冻结基线完全一致，没有需要回传的变化。'); return }
    this.downloadJson(`change-order-${order.orderId}.json`, JSON.stringify(order, null, 2))
    this.flash('success', `变更单已导出：${order.summary}`)
  }

  discardReview(): void {
    if (!window.confirm('放弃本次复核？工作副本中的修改不会进入可编辑案卷。')) return
    this.service.discardReview()
    this.flash('warn', '已退出复核模式，复核改动已丢弃。')
  }

  onOrderFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    this.service.importChangeOrder(file).then(result => {
      this.orderImportMessage = {
        severity: result.ok ? 'success' : 'error',
        text: result.message
      }
      if (result.ok) this.service.setTab('pending')
    })
  }

  resolveItem(item: MergeItem, resolution: 'accept' | 'reject'): void {
    if (!this.openMerge) return
    this.service.resolveMergeItem(this.openMerge.sessionId, item.index, resolution)
  }

  resolveAll(accept: boolean): void {
    if (!this.openMerge) return
    for (const item of this.pendingItems) {
      this.service.resolveMergeItem(this.openMerge.sessionId, item.index, accept ? 'accept' : 'reject')
    }
  }

  confirmMerge(): void {
    if (!this.openMerge) return
    const result = this.service.confirmMerge(this.openMerge.sessionId)
    this.flash(result.ok ? 'success' : 'error', result.message)
    if (result.ok) this.service.setTab('mapping')
  }

  discardMerge(): void {
    if (!this.openMerge) return
    if (!window.confirm('放弃本次合并？变更单原件仍会独立留存，可重新导入。')) return
    this.service.discardMerge(this.openMerge.sessionId)
    this.flash('warn', '已放弃合并，可编辑案卷保持导入前状态。')
  }

  exportOrder(orderId: string): void {
    const content = this.service.exportArchivedOrderJson(orderId)
    if (content) this.downloadJson(`change-order-${orderId}.json`, content)
  }

  exportRecords(): void {
    this.downloadJson(`processing-records-${new Date().toISOString().slice(0, 10)}.json`, this.service.exportRecordsJson())
  }

  retrySave(): void {
    if (this.service.retrySave()) this.flash('success', '存储已恢复，完整案卷重新落盘。')
    else this.flash('error', '写入仍失败，上一版完整案卷保持可用。')
  }

  /* ------------------------------ 展示辅助 ------------------------------ */

  itemKindLabel(item: MergeItem): string {
    return ({ claim: '权利要求', feature: '技术特征', mapping: '支持映射' })[item.change.kind]
  }

  itemOpLabel(item: MergeItem): string {
    return ({ add: '新增', update: '修改', remove: '删除' })[item.change.op]
  }

  itemTargetLabel(item: MergeItem): string {
    const change = item.change
    if (change.kind === 'mapping' && change.mapping) {
      return `${this.featureLabel(change.mapping.featureId)} → ${this.paragraphLabel(change.mapping.paragraphId)}`
    }
    if (change.kind === 'claim') return change.claim ? `权${change.claim.number} · ${change.claim.title}` : change.entityId
    if (change.kind === 'feature') return change.feature ? change.feature.label : change.entityId
    return change.entityId
  }

  proposedText(item: MergeItem): string {
    const change = item.change
    if (change.kind === 'claim' && change.claim) return change.claim.text || '（空正文）'
    if (change.kind === 'feature' && change.feature) {
      return [`标签：${change.feature.label}`, `正文：${change.feature.text || '（空）'}`, `支持段落：${change.feature.supportIds.map(id => this.paragraphLabel(id)).join('；') || '无'}`].join('\n')
    }
    if (change.kind === 'mapping' && change.mapping) return `${this.featureLabel(change.mapping.featureId)} ↔ ${this.paragraphLabel(change.mapping.paragraphId)}`
    return '—'
  }

  currentText(item: MergeItem): string {
    const change = item.change
    if (change.kind === 'claim') {
      const claim = this.envelope.caseState.claims.find(c => c.id === change.entityId)
      return claim ? claim.text : '（本机不存在）'
    }
    if (change.kind === 'feature') {
      const feature = this.envelope.caseState.features.find(f => f.id === change.entityId)
      return feature
        ? [`标签：${feature.label}`, `正文：${feature.text || '（空）'}`, `支持段落：${feature.supportIds.map(id => this.paragraphLabel(id)).join('；') || '无'}`].join('\n')
        : '（本机不存在）'
    }
    if (change.kind === 'mapping' && change.mapping) {
      const feature = this.envelope.caseState.features.find(f => f.id === change.mapping!.featureId)
      const exists = feature?.supportIds.includes(change.mapping.paragraphId)
      return exists ? '本机存在该映射' : '（本机不存在该映射）'
    }
    return '—'
  }

  statusLabel(session: MergeSession): string {
    return ({ open: '待处理', confirmed: '已确认合并', discarded: '已放弃' })[session.state]
  }

  recordActionLabel(action: string): string {
    const labels: Record<string, string> = {
      'legacy-upgrade': '旧档升级',
      freeze: '生成冻结包',
      'review-start': '开始复核',
      'review-export': '导出变更单',
      'review-discard': '放弃复核',
      import: '导入变更单',
      resolve: '待决项决议',
      'merge-confirm': '确认合并',
      'merge-discard': '放弃合并',
      'storage-recovered': '存储恢复'
    }
    return labels[action] || action
  }

  private download(filename: string, content: string, mime: string): void {
    const url = URL.createObjectURL(new Blob([content], { type: mime }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.click()
    URL.revokeObjectURL(url)
  }

  private flash(severity: Notice['severity'], text: string): void {
    this.notice = { severity, text }
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.noticeTimer = setTimeout(() => { this.notice = null }, 5200)
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
      if (this.mode === 'review') this.exportReviewChangeOrder()
      else this.versionDialog = true
    }
  }
}
