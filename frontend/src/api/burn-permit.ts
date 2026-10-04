import { mutate, store } from '@/data/local-store'
import type {
  ActionResult,
  BurnExecution,
  BurnPermitView,
  BurnStep,
  EntryRow,
  ReminderRow,
} from '@/data/types'

const MODULE_KEY = 'burnpermit'
const APPROVED = '已批准'
const EXECUTED = '已执行'

// 执行用火的固定环节顺序：恢复点之后的环节从这里继续。
const STEP_ORDER: BurnStep[] = ['safety', 'notice', 'finish']
export const STEP_LABEL: Record<BurnStep, string> = {
  safety: '确认现场安全措施',
  notice: '下发通行提醒',
  finish: '完成执行并归档',
}

/** 模拟断电时抛出的错误：用来中断事务、把数据留在“断电前”的状态。 */
export class PowerFailure extends Error {
  constructor(step: BurnStep) {
    super(`执行到「${STEP_LABEL[step]}」时断电，流程中断，数据保持断电前状态`)
    this.name = 'PowerFailure'
  }
}

function findPermit(draft: { entries: Record<string, EntryRow[]> }, id: number): EntryRow | null {
  return draft.entries[MODULE_KEY]?.find((row) => Number(row.id) === id) ?? null
}

/** 历史兼容：审批人缺失（空串/null/缺字段）时按原值勤记录，不补假数据。 */
function missingApprover(row: EntryRow): boolean {
  const value = row['审批人']
  return value === null || value === undefined || String(value).trim() === ''
}

/** 同步关联通行提醒：审批单状态怎么变，提醒状态就跟着怎么变，同一事务内完成。 */
function syncReminder(
  draft: { reminders: ReminderRow[] },
  permit: EntryRow,
  status: ReminderRow['status'],
): void {
  const linked = draft.reminders.filter((item) => item.permitId === Number(permit.id))
  for (const item of linked) {
    item.status = status
    item.审批编号 = String(permit['审批编号'] ?? item.审批编号)
    item.用火地点 = String(permit['用火地点'] ?? item.用火地点)
    item.计划时段 = String(permit['计划时段'] ?? item.计划时段)
  }
}

function nextReminderId(reminders: ReminderRow[]): number {
  return reminders.reduce((max, item) => Math.max(max, item.id), 0) + 1
}

/**
 * 列表取数链路：审批单本体 + 执行会话（入口是否残留）+ 关联提醒 + 异常原因，
 * 全部从同一份 store 快照里读，保证“看到的状态”和底层数据一致。
 */
export function listBurnPermits(filters: Record<string, string> = {}): BurnPermitView[] {
  const snapshot = store()
  const rows = snapshot.entries[MODULE_KEY] ?? []
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')

  return rows
    .filter((row) =>
      pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
    )
    .map((row) => {
      const id = Number(row.id)
      const execution = snapshot.executions[String(id)] ?? null
      const reminders = snapshot.reminders.filter((item) => item.permitId === id)
      const issues: string[] = []
      let interruptStep: BurnStep | null = null
      if (missingApprover(row)) {
        issues.push('历史申请缺审批人，保留原值（空），请补录后再继续流转')
      }
      if (execution && row.status !== EXECUTED) {
        interruptStep = execution.done[execution.done.length - 1] ?? null
        issues.push(
          `执行断电中断：已完成「${execution.done
            .map((step) => STEP_LABEL[step])
            .join('、')}」，请从「${STEP_LABEL[nextStep(execution)]}」恢复`,
        )
      }
      // 数据自洽性兜底：已执行但提醒没闭环，属于异常关联，明确暴露出来。
      if (row.status === EXECUTED && reminders.some((item) => item.status !== '已闭环')) {
        issues.push('审批单已执行但存在未闭环的通行提醒')
      }
      return {
        ...row,
        executing: Boolean(execution) && row.status !== EXECUTED,
        reminderCount: reminders.length,
        issue: issues.join('；'),
        interruptStep,
      } as BurnPermitView
    })
}

function nextStep(execution: BurnExecution): BurnStep {
  return STEP_ORDER.find((step) => !execution.done.includes(step)) ?? 'finish'
}

export type BurnActionResult = ActionResult & {
  /** 断电中断时返回，供页面打开恢复入口 */
  interrupted?: BurnStep
}

/**
 * 审批类动作（提交/批准/驳回/补录）。状态只能按允许的来源推进：
 * 已批准是执行用火的唯一入口；补录审批人不改状态，只补历史空值。
 * 关联提醒与审批单在同一事务内同步更新，任一失败整体回滚。
 */
export function submitBurnAction(
  id: number,
  action: string,
  payload: { approver?: string } = {},
): BurnActionResult {
  try {
    const message = mutate((draft) => {
      const permit = findPermit(draft, id)
      if (!permit) {
        return { ok: false, message: `没有找到编号为 ${id} 的用火审批单` }
      }

      if (action === '补录审批人') {
        if (!missingApprover(permit)) {
          return { ok: false, message: '该审批单已有审批人，无需补录' }
        }
        const approver = (payload.approver ?? '').trim()
        if (!approver) {
          return { ok: false, message: '补录审批人不能为空' }
        }
        permit['审批人'] = approver
        permit.abnormal = false
        permit['审批状态'] = `历史审批人已补录：${approver}`
        return { ok: true, message: `已补录审批人「${approver}」，审批单状态保持「${permit.status}」` }
      }

      const transitions: Record<string, { from: string[]; to: string }> = {
        提交申请: { from: ['待申请'], to: '待审批' },
        批准申请: { from: ['待审批'], to: APPROVED },
        驳回答复: { from: ['待审批', APPROVED], to: '已驳回' },
      }
      const transition = transitions[action]
      if (!transition) {
        return { ok: false, message: `用火审批单没有登记「${action}」这个动作` }
      }
      if (!transition.from.includes(String(permit.status))) {
        return {
          ok: false,
          message: `「${permit.status}」状态不能${action}，仅允许 ${transition.from.join(' / ')} 状态操作`,
        }
      }
      if (action === '批准申请' && missingApprover(permit)) {
        // 历史空值兼容：拒绝凭空批准，引导先补录，原值保留不动。
        return { ok: false, message: '该历史申请缺少审批人，请先补录审批人后再批准' }
      }

      permit.status = transition.to
      permit.pending = transition.to !== EXECUTED
      permit.abnormal = transition.to === '已驳回'
      permit['审批状态'] =
        transition.to === APPROVED
          ? '已批准待执行'
          : transition.to === '已驳回'
            ? '已驳回'
            : '已提交待批'

      // 驳回可能发生在执行到一半（含断电残留）：同一事务里清掉执行入口，
      // 不让“已驳回”的单子还挂着执行会话；关联提醒同步撤销。
      if (transition.to === '已驳回') {
        delete draft.executions[String(id)]
        syncReminder(draft, permit, '已撤销')
      }
      return { ok: true, message: `用火审批单已${action}，当前状态「${transition.to}」` }
    })
    return message
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '操作失败，数据已回到操作前状态' }
  }
}

export type StartExecutionResult = BurnActionResult & {
  step?: BurnStep
  execution?: BurnExecution
}

/**
 * 开始/恢复执行用火。
 * - 无执行会话：仅当状态为「已批准」时创建，拒绝其它来源（状态只能从已批准推进到已执行）。
 * - 有执行会话（断电中断）：定位恢复点，从失败环节继续；并发的第二次进入直接拒绝。
 * 全程不提前改审批单状态，只有 finish 成功才在同一事务里连同提醒一起落库。
 */
export function startBurnExecution(id: number, resume = false): StartExecutionResult {
  const execution = store().executions[String(id)]
  if (execution) {
    if (!resume) {
      // 并发恢复保护：第二个人/第二次写入直接拒绝，不复用、不重建。
      return {
        ok: false,
        message:
          '该审批单存在未完成的执行会话（疑似断电中断），请使用「恢复执行」从失败环节继续，禁止重复开始',
        interrupted: execution.done[execution.done.length - 1],
      }
    }
    const step = nextStep(execution)
    return {
      ok: true,
      message: `已定位断电恢复点：从「${STEP_LABEL[step]}」继续，已完成环节不会重复执行`,
      step,
      execution,
    }
  }

  const permit = store().entries[MODULE_KEY]?.find((row) => Number(row.id) === id)
  if (!permit) {
    return { ok: false, message: `没有找到编号为 ${id} 的用火审批单` }
  }
  if (String(permit.status) !== APPROVED) {
    return {
      ok: false,
      message: `只有「已批准」的审批单才能执行用火，当前为「${permit.status}」`,
    }
  }
  if (missingApprover(permit)) {
    return { ok: false, message: '该历史申请缺少审批人，请先补录审批人后再执行' }
  }

  // 建会话本身也是一次事务；这里不下发提醒（提醒是 notice 环节的动作）。
  const created: BurnExecution = { permitId: id, done: [], reminderId: null, startedAt: Date.now() }
  mutate((draft) => {
    if (draft.executions[String(id)]) {
      // 并发窗口内的二次创建：拒绝第二次写入。
      throw new Error('执行会话已被建立，拒绝重复写入')
    }
    draft.executions[String(id)] = created
  })
  return { ok: true, message: '执行会话已建立，请逐项确认安全措施', step: 'safety', execution: created }
}

/**
 * 执行单个环节。
 * powerFailureAt 指定在哪个环节“断电”：该环节的写入随事务一起失败，
 * 已完成的前序环节保留，审批单与提醒停在断电前状态，之后可重试恢复。
 */
export function advanceBurnExecution(
  id: number,
  step: BurnStep,
  powerFailureAt: BurnStep | null = null,
): BurnActionResult {
  try {
    const result = mutate((draft) => {
      const execution = draft.executions[String(id)]
      if (!execution) {
        return { ok: false, message: '执行会话不存在或已结束，不能继续推进' }
      }
      if (execution.done.includes(step)) {
        // 幂等：重复点击/并发重放同一环节直接拒绝第二次写入。
        return { ok: false, message: `「${STEP_LABEL[step]}」已完成，拒绝重复写入` }
      }
      const expected = nextStep(execution)
      if (step !== expected) {
        return { ok: false, message: `环节顺序错误，应先完成「${STEP_LABEL[expected]}」` }
      }

      const permit = findPermit(draft, id)
      if (!permit || String(permit.status) !== APPROVED) {
        return { ok: false, message: '审批单状态异常，执行中止，数据未改动' }
      }

      // 模拟断电：在真正写任何东西之前抛错，整个 mutate 草稿被丢弃。
      if (powerFailureAt === step) {
        throw new PowerFailure(step)
      }

      if (step === 'notice') {
        // 幂等下发：已有提醒就复用，绝不重复建第二条。
        let reminder = execution.reminderId
          ? draft.reminders.find((item) => item.id === execution.reminderId)
          : draft.reminders.find((item) => item.permitId === id)
        if (!reminder) {
          reminder = {
            id: nextReminderId(draft.reminders),
            permitId: id,
            审批编号: String(permit['审批编号'] ?? ''),
            用火地点: String(permit['用火地点'] ?? ''),
            计划时段: String(permit['计划时段'] ?? ''),
            提醒内容: '用火时段提醒沿线检查站对进山车辆做火种收缴与通行确认',
            status: '待生效',
            createdAt: Date.now(),
          }
          draft.reminders.push(reminder)
        } else {
          reminder.status = '待生效'
        }
        execution.reminderId = reminder.id
      }

      execution.done.push(step)

      if (step === 'finish') {
        // 唯一允许推进到「已执行」的地方：审批单 + 提醒 + 会话清理同次落库。
        permit.status = EXECUTED
        permit.pending = false
        permit.abnormal = false
        permit['审批状态'] = '已按方案执行完毕'
        syncReminder(draft, permit, '已闭环')
        delete draft.executions[String(id)]
        return { ok: true, message: '用火已执行完成，审批单推进到「已执行」，通行提醒已同步闭环' }
      }
      return { ok: true, message: `「${STEP_LABEL[step]}」完成` }
    })
    return result
  } catch (error) {
    if (error instanceof PowerFailure) {
      return { ok: false, message: error.message, interrupted: step }
    }
    return { ok: false, message: error instanceof Error ? error.message : '执行失败，数据已回到断电前状态' }
  }
}

/** 放弃执行：清理残留的执行入口，审批单回到「已批准」的待执行态，提醒一并撤销。 */
export function cancelBurnExecution(id: number): BurnActionResult {
  try {
    return mutate((draft) => {
      const execution = draft.executions[String(id)]
      if (!execution) {
        return { ok: false, message: '没有进行中的执行会话' }
      }
      const permit = findPermit(draft, id)
      if (permit) {
        syncReminder(draft, permit, '已撤销')
      }
      delete draft.executions[String(id)]
      return { ok: true, message: '已清理执行入口残留，审批单保持「已批准」，可重新执行' }
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '清理失败' }
  }
}

export function listReminders(): ReminderRow[] {
  return store().reminders
}
