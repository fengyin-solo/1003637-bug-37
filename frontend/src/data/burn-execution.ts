import {
  BURN_JOURNAL_KEY,
  BURN_REMINDER_KEY,
  commit,
  listCollection,
  listRows,
} from './local-store'
import type {
  BurnExecJournal,
  BurnExecStep,
  BurnPermitView,
  EntryRow,
  PassageReminder,
} from './types'

/**
 * 用火审批执行领域服务（纯数据层，不依赖 Vue）。
 *
 * 取数链路：焚烧审批列表 / 检查站通行提醒都从本模块读取，两边口径一致。
 * 执行管线分三步，每步都是独立落库的恢复点（saga）：
 *   1. safety-briefing  现场安全交底：写恢复日志
 *   2. checkpoint-notify 检查站通行提醒：待放行提醒 + 推进日志，同一次落库
 *   3. finalize         执行结果落库：审批单→已执行、核销安全措施、提醒→已通行、删日志，同一次落库
 * 任一步之后断电，库里都留着最后完成的步骤；恢复时从失败环节继续，步骤体幂等可安全重放。
 */

// ---- 执行管线：步骤顺序即恢复顺序 ----------------------------------------------------

export const EXEC_PIPELINE: { step: BurnExecStep; label: string }[] = [
  { step: 'safety-briefing', label: '现场安全交底' },
  { step: 'checkpoint-notify', label: '检查站通行提醒' },
  { step: 'finalize', label: '执行结果落库' },
]

const STEP_LABEL: Record<BurnExecStep, string> = {
  'safety-briefing': '现场安全交底',
  'checkpoint-notify': '检查站通行提醒',
  finalize: '执行结果落库',
}

export function stepLabel(step: BurnExecStep): string {
  return STEP_LABEL[step]
}

function nextStepOf(step: BurnExecStep): BurnExecStep | null {
  const index = EXEC_PIPELINE.findIndex((item) => item.step === step)
  return index >= 0 && index < EXEC_PIPELINE.length - 1
    ? EXEC_PIPELINE[index + 1].step
    : null
}

// ---- 状态机常量 --------------------------------------------------------------------

export const BURN_KEY = 'burnpermit'
export const STATUS_DRAFT = '待申请'
export const STATUS_PENDING = '待审批'
export const STATUS_APPROVED = '已批准'
export const STATUS_REJECTED = '已驳回'
export const STATUS_EXECUTED = '已执行'

/** 待处理口径：只有终态（已执行 / 已驳回）不再待处理——修复「待执行被算成已执行」的取数口径。 */
const TERMINAL_STATUSES = new Set([STATUS_EXECUTED, STATUS_REJECTED])

export function isPendingStatus(status: string): boolean {
  return !TERMINAL_STATUSES.has(status)
}

// ---- 历史数据兼容与异常空态 ----------------------------------------------------------

const HISTORICAL_APPROVER_HINT = '历史申请未登记审批人（原值留空，兼容保留）'
const MISSING_TEXT = '—'

/** 执行用火必须齐全的关键字段；缺失则保留空态并说明原因，不允许推进。 */
const REQUIRED_FIELDS = ['审批编号', '申请单位', '用火类型', '用火地点', '计划时段', '安全措施']

export function missingRequiredFields(row: EntryRow): string[] {
  return REQUIRED_FIELDS.filter((field) => String(row[field] ?? '').trim() === '')
}

/** 异常原因：关键字段缺失时给出可读说明；正常申请返回空串。 */
export function abnormalReasonOf(row: EntryRow): string {
  const missing = missingRequiredFields(row)
  if (missing.length === 0) {
    return ''
  }
  return `关键字段缺失（${missing.join('、')}），保留空态，需补录后再办理`
}

/** 历史申请缺审批人时按原值勤记录兼容：原值不动，仅展示层给出说明。 */
export function approverDisplayOf(row: EntryRow): string {
  const value = String(row['审批人'] ?? '').trim()
  if (value !== '') {
    return value
  }
  return row.status === STATUS_APPROVED || row.status === STATUS_EXECUTED
    ? HISTORICAL_APPROVER_HINT
    : MISSING_TEXT
}

// ---- 故障注入：模拟「执行到一半断电」 ------------------------------------------------
// 注入后在指定步骤已落库、下一步开始前抛错：已完成的恢复点保留在库里，审批单不动。
// 取值：'' 不注入 | 'start' 启动即断电 | 'recover' 恢复提交时再断电 | 步骤名（该步完成后断电）

let injectedFault = ''

export function setFaultInjection(point: string): void {
  injectedFault = point
}

export function getFaultInjection(): string {
  return injectedFault
}

class PowerCutError extends Error {
  constructor(public readonly step: BurnExecStep | 'before-start' | 'before-recover') {
    super('执行中途断电')
    this.name = 'PowerCutError'
  }
}

/** 故障点触发：一次性，触发后自动清除，随后的重试可以继续。 */
function faultFires(point: string): boolean {
  if (injectedFault === '') {
    return false
  }
  if (injectedFault !== point) {
    return false
  }
  injectedFault = ''
  return true
}

// ---- 小工具 ------------------------------------------------------------------------

function nowText(): string {
  return new Date().toISOString()
}

function makeToken(): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `t-${Date.now().toString(36)}-${rand}`
}

export function reminderOfPermit(permitId: number): PassageReminder | null {
  return listCollection<PassageReminder>(BURN_REMINDER_KEY).find(
    (item) => item.permitId === permitId,
  ) ?? null
}

export function journalOfPermit(permitId: number): BurnExecJournal | null {
  return listCollection<BurnExecJournal>(BURN_JOURNAL_KEY).find(
    (item) => item.permitId === permitId,
  ) ?? null
}

export function listInterruptedJournals(): BurnExecJournal[] {
  return listCollection<BurnExecJournal>(BURN_JOURNAL_KEY)
}

export function listPassageReminders(): PassageReminder[] {
  // 只读派生排序，不改库：待确认在前，已通行在后。
  const rows = listCollection<PassageReminder>(BURN_REMINDER_KEY)
  return [...rows].sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === '待确认' ? -1 : 1
    }
    return a.permitId - b.permitId
  })
}

// ---- 草稿内操作（配合 commit 使用） --------------------------------------------------

function permitFromDraft(draft: Record<string, unknown>, id: number): EntryRow | null {
  const rows = Array.isArray(draft[BURN_KEY]) ? (draft[BURN_KEY] as EntryRow[]) : []
  return rows.find((row) => Number(row.id) === id) ?? null
}

function putPermit(draft: Record<string, unknown>, updated: EntryRow): void {
  draft[BURN_KEY] = (draft[BURN_KEY] as EntryRow[]).map((row) =>
    Number(row.id) === Number(updated.id) ? updated : row,
  )
}

function putJournal(draft: Record<string, unknown>, journal: BurnExecJournal): void {
  const bag = Array.isArray(draft[BURN_JOURNAL_KEY])
    ? (draft[BURN_JOURNAL_KEY] as BurnExecJournal[]).filter(
        (item) => item.permitId !== journal.permitId,
      )
    : []
  draft[BURN_JOURNAL_KEY] = [...bag, journal]
}

function removeJournal(draft: Record<string, unknown>, permitId: number): void {
  const bag = Array.isArray(draft[BURN_JOURNAL_KEY])
    ? (draft[BURN_JOURNAL_KEY] as BurnExecJournal[])
    : []
  draft[BURN_JOURNAL_KEY] = bag.filter((item) => item.permitId !== permitId)
}

/** 草稿内 upsert 通行提醒：同一审批单只保留一条，从根上杜绝「通行提醒重复出现」。 */
function upsertReminder(draft: Record<string, unknown>, row: EntryRow, stamp: string): void {
  const bag = Array.isArray(draft[BURN_REMINDER_KEY])
    ? [...(draft[BURN_REMINDER_KEY] as PassageReminder[])]
    : []
  const index = bag.findIndex((item) => item.permitId === Number(row.id))
  const base: PassageReminder = {
    permitId: Number(row.id),
    审批编号: String(row['审批编号'] ?? ''),
    用火地点: String(row['用火地点'] ?? ''),
    计划时段: String(row['计划时段'] ?? ''),
    安全措施: String(row['安全措施'] ?? ''),
    提醒状态: '待放行',
    kind: '待确认',
    createdAt: stamp,
    updatedAt: stamp,
  }
  if (index >= 0) {
    // 重放时保留创建时间，其余按审批单最新值同步——兼容历史审批、关联提醒同步更新。
    bag[index] = { ...base, createdAt: bag[index].createdAt }
  } else {
    bag.push(base)
  }
  draft[BURN_REMINDER_KEY] = bag
}

function markReminderPassed(draft: Record<string, unknown>, permitId: number, stamp: string): void {
  const bag = Array.isArray(draft[BURN_REMINDER_KEY])
    ? [...(draft[BURN_REMINDER_KEY] as PassageReminder[])]
    : []
  const index = bag.findIndex((item) => item.permitId === permitId)
  if (index < 0) {
    return
  }
  bag[index] = { ...bag[index], 提醒状态: '已通行', kind: '已通行', updatedAt: stamp }
  draft[BURN_REMINDER_KEY] = bag
}

// ---- 逐步落库的执行步骤（每步一个 commit，步骤体幂等） -----------------------------------

/** 步骤 1：现场安全交底——只落恢复日志，审批单状态与安全措施一律不动。 */
function persistBriefing(id: number, startedAt: string): BurnExecJournal {
  return commit<BurnExecJournal>((draft) => {
    const journal: BurnExecJournal = {
      permitId: id,
      step: 'safety-briefing',
      token: makeToken(),
      startedAt,
      updatedAt: nowText(),
    }
    putJournal(draft, journal)
    return journal
  })
}

/** 步骤 2：检查站通行提醒——待放行提醒与恢复日志同一次落库。 */
function persistCheckpointNotify(id: number): BurnExecJournal {
  return commit<BurnExecJournal>((draft) => {
    const row = permitFromDraft(draft, id)
    if (!row) {
      throw new Error(`没有找到编号为 ${id} 的用火审批单`)
    }
    const previous = journalOfPermit(id)
    const stamp = nowText()
    upsertReminder(draft, row, stamp)
    const journal: BurnExecJournal = {
      permitId: id,
      step: 'checkpoint-notify',
      token: makeToken(),
      startedAt: previous?.startedAt ?? stamp,
      updatedAt: stamp,
    }
    putJournal(draft, journal)
    return journal
  })
}

/** 步骤 3：执行结果落库——审批单/安全措施/提醒/日志四件事同一次 commit，失败整体回退。 */
function persistFinalize(id: number): void {
  commit<void>((draft) => {
    const row = permitFromDraft(draft, id)
    if (!row) {
      throw new Error(`没有找到编号为 ${id} 的用火审批单`)
    }
    if (row.status !== STATUS_APPROVED) {
      throw new Error(`审批单当前为「${row.status}」，不是「${STATUS_APPROVED}」，不能落执行结果`)
    }
    const stamp = nowText()
    const originalMeasures = String(row['安全措施'] ?? '')
    const executed: EntryRow = {
      ...row,
      status: STATUS_EXECUTED,
      pending: false,
      // 执行入口的安全措施在用火完成时核销，不再残留；原值留痕在执行记录里。
      安全措施: '',
      执行记录: `已于 ${stamp} 执行用火，现场安全措施已核销（原措施：${originalMeasures || '空'}）`,
    }
    putPermit(draft, executed)
    markReminderPassed(draft, id, stamp)
    removeJournal(draft, id)
  })
}

// ---- 对外服务：开始执行 / 断电恢复 ----------------------------------------------------

export type ExecResponse = {
  ok: boolean
  interrupted: boolean
  message: string
  /** 中断时的恢复点（下一步要执行的步骤中文名），用于列表提示「从失败环节继续」 */
  resumeStep?: string
  /** 该行最新令牌，页面重试时携带 */
  token: string
}

function interruptedResponse(journal: BurnExecJournal, prefix: string): ExecResponse {
  const resume = nextStepOf(journal.step)
  return {
    ok: false,
    interrupted: true,
    message: `${prefix}，数据保持断电前状态（审批单仍为「${STATUS_APPROVED}」、安全措施未核销），请从「${resume ? STEP_LABEL[resume] : STEP_LABEL.finalize}」继续`,
    resumeStep: resume ? STEP_LABEL[resume] : STEP_LABEL.finalize,
    token: journal.token,
  }
}

/** 执行前置校验（只读，不写库）。 */
function validateStart(id: number): { row: EntryRow } | { error: string } {
  const rows = listRows(BURN_KEY)
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { error: `没有找到编号为 ${id} 的用火审批单` }
  }
  // 先判状态硬规则：已执行/已驳回等一律不允许再执行（修复后只能从已批准推进）。
  if (row.status !== STATUS_APPROVED) {
    return { error: `只有「${STATUS_APPROVED}」的审批单才能执行，当前为「${row.status}」` }
  }
  const existingJournal = journalOfPermit(id)
  if (existingJournal) {
    const resume = nextStepOf(existingJournal.step)
    return {
      error: `该审批单存在断电中断（停在「${STEP_LABEL[existingJournal.step]}」），请从「${
        resume ? STEP_LABEL[resume] : STEP_LABEL.finalize
      }」恢复，不要重复发起`,
    }
  }
  const reason = abnormalReasonOf(row)
  if (reason) {
    // 异常申请保留空态：不推进、不改状态，只把原因返回给页面说明。
    return { error: `无法执行：${reason}` }
  }
  return { row }
}

/** 开始执行用火：只允许「已批准」进入，逐环节落库，断电可从失败环节继续。 */
export function startBurnExecution(id: number): ExecResponse {
  const validation = validateStart(id)
  if ('error' in validation) {
    return { ok: false, interrupted: false, message: validation.error, token: '' }
  }

  if (faultFires('start')) {
    return {
      ok: false,
      interrupted: true,
      message: `执行在启动前断电，审批单保持「${STATUS_APPROVED}」，可重新发起执行`,
      resumeStep: STEP_LABEL['safety-briefing'],
      token: '',
    }
  }

  const startedAt = nowText()
  try {
    // 步骤 1：交底落库后断电 → 库里留下恢复点，恢复时从步骤 2 继续。
    const briefing = persistBriefing(id, startedAt)
    if (faultFires('safety-briefing')) {
      throw new PowerCutError('safety-briefing')
    }
    // 步骤 2：通行提醒 + 日志落库后断电 → 恢复时从步骤 3 继续；提醒已按幂等键写入，不会重复。
    persistCheckpointNotify(id)
    if (faultFires('checkpoint-notify')) {
      throw new PowerCutError('checkpoint-notify')
    }
    // 步骤 3：业务结果同次落库；这一步提交前断电则整体未写入，恢复时重放（幂等）。
    if (faultFires('finalize')) {
      throw new PowerCutError('finalize')
    }
    persistFinalize(id)
    return {
      ok: true,
      interrupted: false,
      message: '用火执行完成，审批单已推进到「已执行」，关联通行提醒同步更新为已通行',
      token: '',
    }
  } catch (error) {
    if (error instanceof PowerCutError) {
      const journal = journalOfPermit(id)
      if (journal) {
        return interruptedResponse(journal, '执行中途断电')
      }
      return {
        ok: false,
        interrupted: true,
        message: `执行中途断电且恢复点未留存，审批单保持「${STATUS_APPROVED}」，可重新发起`,
        resumeStep: STEP_LABEL['safety-briefing'],
        token: '',
      }
    }
    return { ok: false, interrupted: false, message: (error as Error).message, token: '' }
  }
}

/**
 * 断电恢复：携带列表取到的令牌提交；并发恢复时第二次写入令牌必然对不上而被拒绝。
 * 从日志记录的下一个环节继续（步骤体幂等），成功后一路推进到「已执行」。
 */
export function recoverBurnExecution(id: number, token: string): ExecResponse {
  const journal = journalOfPermit(id)
  if (!journal) {
    const rows = listRows(BURN_KEY)
    const row = rows.find((item) => Number(item.id) === id)
    if (row?.status === STATUS_EXECUTED) {
      return { ok: false, interrupted: false, message: '该审批单已执行完成，无需重复恢复', token: '' }
    }
    return { ok: false, interrupted: false, message: '没有找到断电中断记录，无法恢复；如确需执行请重新发起', token: '' }
  }
  // 乐观锁：令牌不符即并发的第二次写入，拒绝且不落任何内容。
  if (journal.token !== token) {
    return {
      ok: false,
      interrupted: true,
      message: '检测到并发恢复：本次写入令牌已过期，已拒绝第二次写入；请返回列表刷新后重试',
      resumeStep: STEP_LABEL[nextStepOf(journal.step) ?? 'finalize'],
      token: journal.token,
    }
  }
  const row = listRows(BURN_KEY).find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, interrupted: false, message: `没有找到编号为 ${id} 的用火审批单`, token: '' }
  }
  if (row.status !== STATUS_APPROVED) {
    return {
      ok: false,
      interrupted: false,
      message: `审批单当前为「${row.status}」，不是「${STATUS_APPROVED}」，恢复中止并保持原状`,
      token: '',
    }
  }

  try {
    // 从失败环节继续：日志记录的是最后完成的步骤，从下一步开始重放。
    let cursor: BurnExecStep | null = nextStepOf(journal.step)
    if (cursor === 'checkpoint-notify') {
      if (faultFires('recover')) {
        throw new PowerCutError('before-recover')
      }
      persistCheckpointNotify(id)
      if (faultFires('checkpoint-notify')) {
        throw new PowerCutError('checkpoint-notify')
      }
      cursor = nextStepOf('checkpoint-notify')
    }
    if (cursor === 'finalize') {
      if (faultFires('recover') || faultFires('finalize')) {
        throw new PowerCutError('finalize')
      }
      persistFinalize(id)
      cursor = null
    }
    return {
      ok: true,
      interrupted: false,
      message: '断电恢复完成：已从失败环节继续执行到「已执行」，关联通行提醒同步更新',
      token: '',
    }
  } catch (error) {
    if (error instanceof PowerCutError) {
      const latest = journalOfPermit(id)
      if (latest) {
        return interruptedResponse(latest, '恢复时再次断电')
      }
      return {
        ok: false,
        interrupted: true,
        message: '恢复在提交前断电，数据保持断电前状态，可重新重试',
        resumeStep: STEP_LABEL[nextStepOf(journal.step) ?? 'finalize'],
        token: journal.token,
      }
    }
    return { ok: false, interrupted: false, message: (error as Error).message, token: '' }
  }
}

// ---- 审批流动作：提交 / 批准 / 驳回（带合法前驱校验） -----------------------------------

export type BurnActionResponse = { ok: boolean; message: string }

function advancePermitStatus(
  id: number,
  action: '提交申请' | '批准申请' | '驳回答复',
  operator: string,
): BurnActionResponse {
  const target =
    action === '提交申请' ? STATUS_PENDING : action === '批准申请' ? STATUS_APPROVED : STATUS_REJECTED
  // 合法前驱：修复后状态只能沿既定链路推进，禁止从任意状态跳变。
  const allowedPre: Record<string, string[]> = {
    [STATUS_PENDING]: [STATUS_DRAFT, STATUS_REJECTED],
    [STATUS_APPROVED]: [STATUS_PENDING],
    [STATUS_REJECTED]: [STATUS_PENDING],
  }
  try {
    return commit<BurnActionResponse>((draft) => {
      const row = permitFromDraft(draft, id)
      if (!row) {
        return { ok: false, message: `没有找到编号为 ${id} 的用火审批单` }
      }
      if (row.status === target) {
        return { ok: false, message: `审批单已经是「${target}」，不用重复操作` }
      }
      if (!allowedPre[target].includes(row.status)) {
        return { ok: false, message: `「${row.status}」不能${action}到「${target}」` }
      }
      const stamp = nowText()
      const updated: EntryRow = { ...row, status: target, pending: isPendingStatus(target) }
      if (target === STATUS_APPROVED) {
        // 历史申请缺审批人的补录做法：原值勤记录保留兼容，仅在批准动作时补登为操作人并加注记。
        if (String(row['审批人'] ?? '').trim() === '') {
          updated['审批人'] = `${operator}（系统补录历史缺登记审批人）`
          updated['补录说明'] = `历史申请缺审批人，${stamp} 由${operator}批准时补录，原记录留空兼容`
        }
        // 批准即生成待放行通行提醒（与审批单同次落库，permitId 幂等，重复批准不产生重复提醒）。
        upsertReminder(draft, updated, stamp)
      }
      if (target === STATUS_REJECTED) {
        updated.abnormal = true
        // 驳回时撤回可能存在的待放行提醒与中断日志，避免残留。
        draft[BURN_REMINDER_KEY] = (Array.isArray(draft[BURN_REMINDER_KEY])
          ? (draft[BURN_REMINDER_KEY] as PassageReminder[])
          : []
        ).filter((item) => item.permitId !== id)
        removeJournal(draft, id)
      }
      putPermit(draft, updated)
      return { ok: true, message: `审批单已${action}，当前状态「${target}」` }
    })
  } catch (error) {
    return { ok: false, message: (error as Error).message }
  }
}

export function submitBurnApplication(id: number): BurnActionResponse {
  return advancePermitStatus(id, '提交申请', '')
}

export function approveBurnApplication(id: number, operator: string): BurnActionResponse {
  return advancePermitStatus(id, '批准申请', operator)
}

export function rejectBurnApplication(id: number): BurnActionResponse {
  return advancePermitStatus(id, '驳回答复', '')
}

/**
 * 兼容历史审批：为库里已批准/已执行但缺关联提醒的审批单同步通行提醒（幂等，不重复）。
 * 一次操作补齐历史数据的取数链路，审批单原值不动，提醒与其同库落盘。
 */
export function syncHistoricalReminders(): BurnActionResponse & { synced: number } {
  try {
    return commit<BurnActionResponse & { synced: number }>((draft) => {
      const rows = (draft[BURN_KEY] as EntryRow[]) ?? []
      const existing = new Set(
        (Array.isArray(draft[BURN_REMINDER_KEY])
          ? (draft[BURN_REMINDER_KEY] as PassageReminder[])
          : []
        ).map((item) => item.permitId),
      )
      const bag = Array.isArray(draft[BURN_REMINDER_KEY])
        ? [...(draft[BURN_REMINDER_KEY] as PassageReminder[])]
        : []
      let synced = 0
      const stamp = nowText()
      for (const row of rows) {
        if (existing.has(Number(row.id))) {
          continue
        }
        if (row.status !== STATUS_APPROVED && row.status !== STATUS_EXECUTED) {
          continue
        }
        if (missingRequiredFields(row).length > 0) {
          // 异常历史单据保留空态，不凭空造提醒。
          continue
        }
        const reminder: PassageReminder = {
          permitId: Number(row.id),
          审批编号: String(row['审批编号'] ?? ''),
          用火地点: String(row['用火地点'] ?? ''),
          计划时段: String(row['计划时段'] ?? ''),
          安全措施: String(row['安全措施'] ?? ''),
          提醒状态: row.status === STATUS_EXECUTED ? '已通行' : '待放行',
          kind: row.status === STATUS_EXECUTED ? '已通行' : '待确认',
          createdAt: stamp,
          updatedAt: stamp,
        }
        bag.push(reminder)
        existing.add(Number(row.id))
        synced += 1
      }
      draft[BURN_REMINDER_KEY] = bag
      return {
        ok: true,
        synced,
        message:
          synced > 0
            ? `已为 ${synced} 条历史审批补同步通行提醒`
            : '历史审批的关联提醒已是最新，无需同步',
      }
    })
  } catch (error) {
    return { ok: false, synced: 0, message: (error as Error).message }
  }
}

// ---- 列表取数：审批列表与提醒面板共用的口径 -------------------------------------------

/** 审批列表取数：修正 pending/abnormal 口径（只在读取层派生，不改原值）。 */
export function listBurnPermits(): EntryRow[] {
  return listRows(BURN_KEY).map((row) => ({
    ...row,
    pending: isPendingStatus(String(row.status)),
    abnormal: Boolean(row.abnormal) || abnormalReasonOf(row) !== '',
  }))
}

function reminderStatusText(row: EntryRow): string {
  const reminder = reminderOfPermit(Number(row.id))
  if (reminder) {
    return reminder.提醒状态
  }
  if (row.status === STATUS_APPROVED) {
    return '待放行（历史数据未同步，可点「同步历史提醒」）'
  }
  return ''
}

/** 列表行视图组装：兼容展示、异常原因、恢复点、并发令牌、提醒状态一次性取齐。 */
export function describeBurnPermit(row: EntryRow): BurnPermitView {
  const journal = journalOfPermit(Number(row.id))
  const resume = journal ? nextStepOf(journal.step) : null
  return {
    ...row,
    pending: isPendingStatus(String(row.status)),
    abnormal: Boolean(row.abnormal) || abnormalReasonOf(row) !== '',
    审批人显示: approverDisplayOf(row),
    abnormalReason: abnormalReasonOf(row),
    resumeStep: resume ? STEP_LABEL[resume] : journal ? STEP_LABEL.finalize : '',
    token: journal?.token ?? '',
    reminderStatus: reminderStatusText(row),
  }
}
