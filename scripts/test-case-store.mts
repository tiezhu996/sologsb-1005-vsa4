import assert from 'node:assert/strict'

// ---- 内存版 localStorage，可模拟写失败 ----
class MemoryStorage {
  private map = new Map<string, string>()
  failWrites = false
  getItem(key: string): string | null { return this.map.has(key) ? this.map.get(key)! : null }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError: 模拟磁盘写满')
    this.map.set(key, value)
  }
  removeItem(key: string): void { this.map.delete(key) }
  keys(): string[] { return [...this.map.keys()] }
  raw(key: string): string | undefined { return this.map.get(key) }
}

const storage = new MemoryStorage()
;(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = storage
;(globalThis as Record<string, unknown>).window = undefined

const { CaseStoreService } = await import('../src/app/case-store.service')
const { diffSnapshots, buildChangeOrder } = await import('../src/app/review-merge')

// ============ 场景 1：旧版整包首次打开 → 原位升级 + 首个冻结基线 ============
const legacy = {
  claims: [{ id: 'c1', number: 1, title: '旧权项', text: '旧正文', independent: true }],
  paragraphs: [{ id: 'p1', section: '[0001]', text: '依据' }],
  features: [{ id: 'f1', claimId: 'c1', label: '旧特征', text: '正文', parentId: null, referenceIds: [], supportIds: ['p1'], ownerRole: 'author' }],
  annotations: [], orphanMappings: [], versions: [],
  role: 'author', currentUserRole: 'author',
  selectedClaimId: 'c1', selectedFeatureId: null, activeTab: 'mapping'
}
storage.setItem('patent-claim-mapping-workbench-v1', JSON.stringify(legacy))

let store = new CaseStoreService()
let repo = store.snapshot
assert.equal(repo.schemaVersion, 2, '应升级为 v2')
assert.equal(repo.migratedFromLegacy, true)
assert.equal(repo.frozenPackages.length, 1, '升级时补建首个冻结基线')
assert.equal(repo.currentBaselinePackageId, repo.frozenPackages[0].packageId)
assert.equal(repo.workbench.claims[0].title, '旧权项', '旧数据内容保留')
assert.ok(repo.records.some(r => r.kind === 'legacy-upgraded'))
assert.equal(storage.getItem('patent-claim-mapping-workbench-v1'), null, '升级落盘后旧键应移除')
assert.ok(storage.getItem('patent-claim-mapping-case-v2'), 'v2 主库已写入')
assert.ok(storage.getItem('patent-claim-mapping-archive-v1'), '归档库已写入')
const archiveAfterMigration = JSON.parse(storage.getItem('patent-claim-mapping-archive-v1')!)
assert.ok(archiveAfterMigration.records.some((r: { kind: string }) => r.kind === 'legacy-upgraded'), '升级记录进入独立归档库')
assert.ok(archiveAfterMigration.packages[repo.frozenPackages[0].packageId], '首个基线进入归档库')

// ============ 场景 2：冻结 + 外部变更单 + 两边都改 → 待决 → 重开续处 ============
// 本机修改 f1 正文（基线之后录入）
const changed = store.mutateWorkbench(state => {
  state.features[0].text = '本机后来录入的修订'
})
assert.equal(changed, true)

const baseline = store.currentBaseline!
// 外部复核员也修改 f1 正文，并新增一个支持映射
const reviewed = structuredClone(baseline.snapshot)
reviewed.features[0].text = '外部复核修订'
reviewed.features[0].supportIds.push('p1') // 已存在，无变化；改为新增对 f1 无意义，这里直接构造条目
const entries = diffSnapshots(baseline.snapshot, reviewed)
assert.ok(entries.some(e => e.entity === 'feature' && e.entityId === 'f1' && e.operation === 'update'))
const order = buildChangeOrder({
  orderId: 'chg-x', baselinePackageId: baseline.packageId, caseCode: baseline.caseCode,
  reviewerName: '外部复核员', createdAt: new Date().toISOString(), note: '回传', entries
})
const importResult = store.importChangeOrder(JSON.stringify(order), '代理人 · 陈昊')
assert.equal(importResult.ok, true, importResult.message)
const f1Item = store.activeSession!.items.find(i => i.entityId === 'f1')!
assert.equal(f1Item.status, 'pending-both-modified', '两边都改过必须进待决区')

// 案卷在确认前不得被外部内容写入
assert.equal(store.workbench.features[0].text, '本机后来录入的修订')

// ---- 模拟重开浏览器：重新实例化服务，未决项必须还在 ----
store = new CaseStoreService()
assert.equal(store.hasActiveSession, true, '重开后合并会话仍在')
assert.equal(store.unresolvedCount, 1, '重开后待决项保留，可继续处理')
assert.equal(store.workbench.features[0].text, '本机后来录入的修订', '未确认前案卷仍是本机版本')

// 裁决采用外部，确认合并
store.resolvePendingItem(f1Item.id, 'take-external', '复核员')
const confirmed = store.confirmMerge('复核员')
assert.equal(confirmed.ok, true, confirmed.message)
assert.equal(store.workbench.features[0].text, '外部复核修订', '确认后才写入可编辑案卷')
assert.equal(store.hasActiveSession, false)
const newBaseline = store.currentBaseline!
assert.notEqual(newBaseline.packageId, baseline.packageId, '确认后补建新的冻结基线')
assert.equal(newBaseline.snapshot.features[0].text, '外部复核修订')
const repo2 = store.snapshot
// 旧冻结包独立留存：仍在 frozenPackages 与归档库
assert.ok(repo2.frozenPackages.some(p => p.packageId === baseline.packageId), '旧冻结包留存')
const archive2 = JSON.parse(storage.getItem('patent-claim-mapping-archive-v1')!)
assert.ok(archive2.packages[baseline.packageId], '旧冻结包在独立归档库')
assert.ok(archive2.orders['chg-x'], '变更单在独立归档库')
const session = Object.values(archive2.sessions as Record<string, { status: string }>).find(s => s.status === 'confirmed')
assert.ok(session, '含裁决结果的会话独立留存')

// ============ 场景 3：主库损坏 → 从备份恢复上一版完整案卷 ============
// 先制造一次新编辑，使主库更新、备份保存上一版
store.mutateWorkbench(state => { state.claims[0].title = '再编辑后的标题' })
const goodMain = storage.raw('patent-claim-mapping-case-v2')!
const backup = storage.raw('patent-claim-mapping-case-v2-backup')!
assert.notEqual(goodMain, backup, '编辑后备份应是上一版')
assert.ok(backup.includes('外部复核修订'), '备份是合并后的完整案卷')

// 破坏主库
storage.setItem('patent-claim-mapping-case-v2', '{这不是合法JSON')
store = new CaseStoreService()
assert.equal(store.workbench.claims[0].title, '旧权项', '主库损坏时从备份恢复上一版完整案卷')
assert.ok(store.workbench.features[0].text === '外部复核修订')
// 启动恢复时自动用备份修复了主库
const repairedMain = JSON.parse(storage.getItem('patent-claim-mapping-case-v2')!)
assert.equal(repairedMain.workbench.claims[0].title, '旧权项', '主库已由备份自动修复')

// ============ 场景 4：写失败 → 保住上一版完整案卷，内存回滚 ============
store = new CaseStoreService()
const before = store.workbench.claims[0].title
storage.failWrites = true
const ok = store.mutateWorkbench(state => { state.claims[0].title = '写不进去的标题' })
assert.equal(ok, false, '写入失败返回 false')
assert.equal(store.workbench.claims[0].title, before, '内存状态回滚到上一版')
storage.failWrites = false
// 磁盘上仍是上一版
const onDisk = JSON.parse(storage.getItem('patent-claim-mapping-case-v2')!)
assert.equal(onDisk.workbench.claims[0].title, before, '磁盘保住上一版')

// ============ 场景 5：原对象本地已移除 → 待决，不直接写入，确认需裁决 ============
store = new CaseStoreService()
const bl = store.freezePackage('第二轮冻结', { role: 'author', name: '代理人' })!
// 本地删除 f1
store.mutateWorkbench(state => { state.features = state.features.filter(f => f.id !== 'f1') })
// 外部修改 f1
const rv = structuredClone(bl.snapshot)
rv.features.find(f => f.id === 'f1')!.text = '外部对f1的新修改'
const ord2 = buildChangeOrder({
  orderId: 'chg-y', baselinePackageId: bl.packageId, caseCode: bl.caseCode,
  reviewerName: '外部', createdAt: new Date().toISOString(), note: '', entries: diffSnapshots(bl.snapshot, rv)
})
const imp2 = store.importChangeOrder(JSON.stringify(ord2), '代理人')
assert.equal(imp2.ok, true)
const removedItem = store.activeSession!.items.find(i => i.entityId === 'f1')!
assert.equal(removedItem.status, 'pending-local-removed', '原对象已移除必须进待决区')
assert.equal(store.confirmMerge('x').ok, false, '存在未裁决待决项时禁止确认')
// 保留本地（即不恢复被删对象）后可确认
store.resolvePendingItem(removedItem.id, 'keep-local', '代理人')
assert.equal(store.confirmMerge('代理人').ok, true)
assert.equal(store.workbench.features.some(f => f.id === 'f1'), false, '保留本地意味着 f1 维持删除')

console.log('全部存储层场景断言通过 ✔')
