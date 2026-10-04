import assert from 'node:assert/strict'
import {
  applyMerge,
  buildChangeOrder,
  buildFrozenPackage,
  checksum,
  classifyEntries,
  diffSnapshots,
  resolveItems,
  snapshotFrom,
  verifyOrder,
  verifyPackage
} from '../src/app/review-merge'
import type { Claim, Feature, Paragraph } from '../src/app/models'

const claims: Claim[] = [
  { id: 'c1', number: 1, title: '权1', text: '正文A', independent: true }
]
const paragraphs: Paragraph[] = [
  { id: 'p1', section: '[0001]', text: '依据一' },
  { id: 'p2', section: '[0002]', text: '依据二' }
]
const features = (): Feature[] => [
  { id: 'f1', claimId: 'c1', label: 'F1', text: '特征一', parentId: null, referenceIds: [], supportIds: ['p1'], ownerRole: 'author' },
  { id: 'f2', claimId: 'c1', label: 'F2', text: '特征二', parentId: null, referenceIds: ['f1'], supportIds: ['p1'], ownerRole: 'author' }
]

const base = snapshotFrom(claims, features(), paragraphs)

// ---- 1. 复核方：改 f1 正文、删 f2、给 f1 加映射 p2、新增权2 ----
const reviewed: typeof base = structuredClone(base)
;(reviewed.features.find(f => f.id === 'f1')!).text = '特征一（外部修订）'
reviewed.features = reviewed.features.filter(f => f.id !== 'f2')
reviewed.features.find(f => f.id === 'f1')!.supportIds.push('p2')
reviewed.claims.push({ id: 'c2', number: 2, title: '权2', text: '从属正文', independent: false })

const entries = diffSnapshots(base, reviewed)
const types = entries.map(e => `${e.entity}:${e.operation}`).sort()
assert.deepEqual(types, ['claim:add', 'feature:remove', 'feature:update', 'supportMapping:add', 'supportMapping:remove'].sort())
assert.ok(entries.some(e => e.entity === 'supportMapping' && e.operation === 'add' && e.entityId === 'f1→p2'))
assert.ok(entries.some(e => e.entity === 'supportMapping' && e.operation === 'remove' && e.entityId === 'f2→p1'))

// ---- 2. 校验和：冻结包/变更单可验签，篡改即失败 ----
const pkg = buildFrozenPackage({
  packageId: 'fpkg-1', caseCode: 'CASE', createdAt: '2026-10-04T00:00:00Z',
  createdBy: 'author', createdByName: '代理人', note: '基线', snapshot: base
})
assert.equal(verifyPackage(pkg), true)
const tampered = structuredClone(pkg); tampered.snapshot.claims[0].text = '被篡改'
assert.equal(verifyPackage(tampered), false)

const order = buildChangeOrder({
  orderId: 'chg-1', baselinePackageId: 'fpkg-1', caseCode: 'CASE',
  reviewerName: '外部', createdAt: '2026-10-04T01:00:00Z', note: '复核', entries
})
assert.equal(verifyOrder(order), true)

// ---- 3. 本机无修改：全部 clean ----
const itemsAllClean = classifyEntries(entries, base, structuredClone(base))
assert.ok(itemsAllClean.every(i => i.status === 'clean'))

// ---- 4. 本机场景：f1 两边都改过；f2 本地已删除；c2 本地同 ID 冲突 ----
const local = snapshotFrom(claims, features(), paragraphs)
local.features.find(f => f.id === 'f1')!.text = '特征一（本机修订）'
local.features = local.features.filter(f => f.id !== 'f2') // 本机也删了 f2 → 对外部 remove 为 redundant/local-removed?
local.claims.push({ id: 'c2', number: 2, title: '权2-本地不同', text: '本机自己的从属', independent: false })
const items = classifyEntries(entries, base, local)
const byId = new Map(items.map(i => [i.entityId, i]))
assert.equal(byId.get('f1')?.status, 'pending-both-modified') // 两边都改
assert.equal(byId.get('c2')?.status, 'pending-both-modified') // 新增 ID 冲突
// f2 本地已不存在 → 原对象已移除（外部 update/remove 时本地缺失）
assert.equal(byId.get('f2')?.status, 'pending-local-removed')
// f1→p2 新增：f1 仍在且本地无此映射 → clean
assert.equal(byId.get('f1→p2')?.status, 'clean')
assert.ok(items.filter(i => i.status.startsWith('pending-')).every(i => i.resolution === 'pending'))

// ---- 5. 裁决：f1 采用外部、c2 保留本地、f2 采用外部删除 ----
const decided = resolveItems(items, [
  { itemId: byId.get('f1')!.id, resolution: 'take-external', resolvedByName: '复核员', resolvedAt: 't' },
  { itemId: byId.get('c2')!.id, resolution: 'keep-local', resolvedByName: '复核员', resolvedAt: 't' },
  { itemId: byId.get('f2')!.id, resolution: 'take-external', resolvedByName: '复核员', resolvedAt: 't' }
])
assert.equal(decided.find(i => i.entityId === 'f1→p2')?.resolution, 'pending') // clean 项保持 pending 但会被采用

const result = applyMerge({ claims: structuredClone(local.claims), features: structuredClone(local.features) }, decided)
const f1 = result.features.find(f => f.id === 'f1')!
assert.equal(f1.text, '特征一（外部修订）')            // 采用外部
assert.ok(f1.supportIds.includes('p2'))               // clean 映射新增已采用
assert.equal(result.features.some(f => f.id === 'f2'), false)
const c2 = result.claims.find(c => c.id === 'c2')!
assert.equal(c2.title, '权2-本地不同')                // 保留本地
// f1 引用 f2 已随 f2 删除，无悬空引用
assert.deepEqual(f1.referenceIds, [])

// ---- 6. 幂等：再次对结果应用同一批已采用项不产生破坏（clean 映射不重复） ----
const again = applyMerge({ claims: structuredClone(result.claims), features: structuredClone(result.features) }, decided)
assert.deepEqual(again.features.find(f => f.id === 'f1')!.supportIds.sort(), ['p1', 'p2'])

// ---- 7. checksum 稳定性：键顺序不影响 ----
assert.equal(checksum({ a: 1, b: 2 }), checksum({ b: 2, a: 1 }))
assert.notEqual(checksum({ a: 1 }), checksum({ a: 2 }))

console.log('全部合并逻辑断言通过 ✔')
