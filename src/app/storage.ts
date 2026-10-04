import type { PersistEnvelopeV2, WorkbenchState } from './models'

/** v2 信封主键；任何写入失败都保留该键下的上一版完整案卷 */
export const ENVELOPE_KEY = 'patent-workbench-envelope-v2'
/** 原子写临时键：先写临时键并回读校验，通过后才覆盖主键 */
export const ENVELOPE_TMP_KEY = 'patent-workbench-envelope-v2-tmp'
/** v1 旧数据整包键（首次打开时原位升级） */
export const LEGACY_KEY = 'patent-claim-mapping-workbench-v1'

export interface LoadResult {
  envelope: PersistEnvelopeV2 | null
  /** 主键损坏、靠临时键恢复上一版时为 true */
  recoveredFromTmp: boolean
}

function isEnvelope(value: unknown): value is PersistEnvelopeV2 {
  return !!value && typeof value === 'object'
    && (value as PersistEnvelopeV2).format === 'patent-workbench-v2'
    && (value as PersistEnvelopeV2).version === 2
    && !!(value as PersistEnvelopeV2).caseState
}

function parseKey(key: string): PersistEnvelopeV2 | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return isEnvelope(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function loadEnvelope(): LoadResult {
  const main = parseKey(ENVELOPE_KEY)
  if (main) return { envelope: main, recoveredFromTmp: false }
  // 主键缺失或损坏：尝试用临时键保住最近一次已校验的完整写入
  const tmp = parseKey(ENVELOPE_TMP_KEY)
  if (tmp) return { envelope: tmp, recoveredFromTmp: true }
  return { envelope: null, recoveredFromTmp: false }
}

export function readLegacyState(): WorkbenchState | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as WorkbenchState).claims)) return null
    return parsed as WorkbenchState
  } catch {
    return null
  }
}

export function clearLegacyState(): void {
  try { localStorage.removeItem(LEGACY_KEY) } catch { /* 忽略：升级主流程不依赖清理成功 */ }
}

export interface WriteOutcome {
  ok: boolean
  error: string | null
  recovered: boolean
}

/**
 * 原子写：临时键写入→回读比对→覆盖主键→再次回读比对→清理临时键。
 * 任何一步抛错（如 QuotaExceededError）都不会触碰主键，
 * 因此重新打开时仍能读到上一版完整案卷。
 */
export function writeEnvelope(envelope: PersistEnvelopeV2): WriteOutcome {
  let json = ''
  try {
    json = JSON.stringify(envelope)
  } catch (error) {
    return { ok: false, error: describeError(error), recovered: false }
  }
  let existed = false
  try {
    // 1. 写临时键并回读校验
    localStorage.setItem(ENVELOPE_TMP_KEY, json)
    const echoed = localStorage.getItem(ENVELOPE_TMP_KEY)
    if (echoed !== json) throw new Error('临时键回读内容不一致')

    // 2. 覆盖主键（原主键内容在此之前始终完好）
    existed = localStorage.getItem(ENVELOPE_KEY) !== null
    localStorage.setItem(ENVELOPE_KEY, json)

    // 3. 回读主键确认
    const committed = localStorage.getItem(ENVELOPE_KEY)
    if (committed !== json) throw new Error('主键回读内容不一致')

    // 4. 清理临时键
    localStorage.removeItem(ENVELOPE_TMP_KEY)
    return { ok: true, error: null, recovered: false }
  } catch (error) {
    // 写入失败：尽量清掉半成品临时键，主键保持上一版
    try { localStorage.removeItem(ENVELOPE_TMP_KEY) } catch { /* ignore */ }
    return { ok: false, error: describeError(error), recovered: existed }
  }
}

function describeError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      return '本机存储空间不足，写入被拒绝（QuotaExceededError）'
    }
    return `${error.name}: ${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}
