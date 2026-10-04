import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  BURN_KEY,
  approveBurnApplication,
  describeBurnPermit,
  listBurnPermits,
  listInterruptedJournals,
  listPassageReminders,
  recoverBurnExecution,
  rejectBurnApplication,
  startBurnExecution,
  submitBurnApplication,
  syncHistoricalReminders,
} from '@/data/burn-execution'
import type {
  ActionResult,
  BurnPermitView,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  PassageReminder,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows<T extends EntryRow>(rows: T[], filters: Record<string, string>): T[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  // 焚烧审批走执行领域服务的取数口径：修正「待执行显示成已执行」的 pending/abnormal 派生。
  const source = key === BURN_KEY ? listBurnPermits() : listRows(key)
  const matched = filterRows(source, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 焚烧审批列表视图：附带审批人兼容展示、异常空态原因、断电恢复点、并发令牌、关联提醒状态。 */
export function listBurnPermitViews(filters: Record<string, string> = {}): {
  items: BurnPermitView[]
  total: number
} {
  const views = listBurnPermits().map(describeBurnPermit)
  const matched = filterRows(views, filters)
  return { items: matched, total: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  // 焚烧审批的审批流动作收敛到执行领域服务：带合法前驱校验，审批单与提醒同次落库。
  if (key === BURN_KEY) {
    if (action === '提交申请') {
      return submitBurnApplication(id)
    }
    if (action === '批准申请') {
      return approveBurnApplication(id, '值班管理员')
    }
    if (action === '驳回答复') {
      return rejectBurnApplication(id)
    }
    return { ok: false, message: `用火审批单没有登记「${action}」这个动作` }
  }

  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// ---- 用火执行：开始执行 / 断电恢复（页面处理完后再回列表确认） ---------------------------

export function executeBurnPermit(id: number): ActionResult & {
  interrupted: boolean
  resumeStep?: string
  token: string
} {
  return startBurnExecution(id)
}

export function recoverBurnPermit(
  id: number,
  token: string,
): ActionResult & { interrupted: boolean; resumeStep?: string; token: string } {
  return recoverBurnExecution(id, token)
}

export function interruptedBurnPermits(): {
  permitId: number
  step: string
  token: string
}[] {
  return listInterruptedJournals().map((journal) => ({
    permitId: journal.permitId,
    step: journal.step,
    token: journal.token,
  }))
}

/** 检查站通行提醒取数：与审批列表同一取数链路，按 permitId 幂等不重复。 */
export function passageReminders(): PassageReminder[] {
  return listPassageReminders()
}

/** 兼容历史审批：为缺关联提醒的已批准/已执行单据同步提醒（幂等）。 */
export function syncBurnHistory(): ActionResult & { synced: number } {
  return syncHistoricalReminders()
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listEntries(key).items) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = meta.key === BURN_KEY ? listBurnPermits() : rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
