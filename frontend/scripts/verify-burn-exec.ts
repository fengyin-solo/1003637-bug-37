/**
 * 用火执行断电恢复链路的端到端验证脚本（纯 Node，不依赖浏览器）。
 * 运行：npx esbuild scripts/verify-burn-exec.ts | node
 */
import {
  approveBurnApplication,
  approverDisplayOf,
  describeBurnPermit,
  listBurnPermits,
  listPassageReminders,
  recoverBurnExecution,
  rejectBurnApplication,
  startBurnExecution,
  syncHistoricalReminders,
  setFaultInjection,
  journalOfPermit,
  reminderOfPermit,
} from '../src/data/burn-execution'
import { BURN_JOURNAL_KEY, BURN_REMINDER_KEY, commit, resetAllForTests } from '../src/data/local-store'
import type { EntryRow } from '../src/data/types'
import { SEED_ROWS } from '../src/data/seed'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  ✅ ${name}`)
  } else {
    failed += 1
    console.error(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

function findPermit(id: number) {
  return listBurnPermits().find((row) => Number(row.id) === id)!
}

function resetData() {
  // 整体重置：业务表回种子、通行提醒与断电日志清空，保证用例间互不污染。
  resetAllForTests()
}

// ---- 极简 localStorage 垫片：local-store 在无 window 时本就有内存兜底，这里仅提供运行宿主 ----
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string) {
    this.map.set(key, value)
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
  clear() {
    this.map.clear()
  }
}
;(globalThis as { window?: unknown; localStorage?: Storage }).window = { localStorage: new MemoryStorage() }
;(globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage() as unknown as Storage

// 垫片在 import 之后安装，重置一次让 store 从干净种子重读。
resetData()
void BURN_JOURNAL_KEY
void BURN_REMINDER_KEY

// ============================================================================
console.log('场景1：正常执行——已批准→已执行，安全措施核销，提醒同次落库且不重复')
{
  resetData()
  const id = 3 // 种子里 BURN-0003，已批准
  const before = findPermit(id)
  check('执行前状态为已批准', before.status === '已批准')
  check('执行前安全措施有值', String(before['安全措施']) !== '')

  const result = startBurnExecution(id)
  check('执行返回 ok', result.ok, result.message)
  const after = findPermit(id)
  check('执行后状态为已执行', after.status === '已执行')
  check('执行后 pending=false（不会再被误显示成待执行）', after.pending === false)
  check('执行入口安全措施已核销（不残留）', String(after['安全措施']) === '')
  check('执行记录留痕保留原安全措施', String(after['执行记录']).includes('焚烧审批样例3'))

  const reminders = listPassageReminders().filter((item) => item.permitId === id)
  check('关联通行提醒恰好一条（不重复）', reminders.length === 1, `实际 ${reminders.length} 条`)
  check('提醒状态同步为已通行', reminders[0]?.提醒状态 === '已通行')
  check('恢复日志已删除', journalOfPermit(id) === null)

  // 重复执行应被拒绝（已执行不是已批准）
  const again = startBurnExecution(id)
  check('重复执行被拒（已执行不能再执行）', !again.ok && again.message.includes('当前为「已执行」'), again.message)
}

// ============================================================================
console.log('场景2：执行到一半断电——逐环节中断、状态保持已批准、从失败环节继续')
for (const fault of ['safety-briefing', 'checkpoint-notify', 'finalize'] as const) {
  resetData()
  const id = 3
  setFaultInjection(fault)
  const cut = startBurnExecution(id)
  check(`[${fault}] 断电返回中断`, cut.interrupted === true, cut.message)
  const stuck = findPermit(id)
  check(`[${fault}] 审批单仍是已批准（列表不会显示成已执行）`, stuck.status === '已批准')
  check(`[${fault}] 安全措施未核销（执行入口不残留半成品）`, String(stuck['安全措施']) !== '')

  const journal = journalOfPermit(id)
  if (fault === 'safety-briefing') {
    check('[safety-briefing] 恢复点停在交底', journal?.step === 'safety-briefing')
    check('[safety-briefing] 尚未写通行提醒', reminderOfPermit(id) === null)
  } else if (fault === 'checkpoint-notify') {
    check('[checkpoint-notify] 恢复点停在通行提醒', journal?.step === 'checkpoint-notify')
    const reminder = reminderOfPermit(id)
    check('[checkpoint-notify] 待放行提醒已落库', reminder?.提醒状态 === '待放行')
  } else {
    check('[finalize] 恢复点停在落库前（提醒步骤已完成）', journal?.step === 'checkpoint-notify')
  }

  // 用过期令牌先模拟并发恢复
  const staleToken = journal?.token ?? ''
  const concurrent = recoverBurnExecution(id, 't-stale-token')
  check(`[${fault}] 并发恢复第二次写入被拒绝`, !concurrent.ok && concurrent.message.includes('并发'))
  check(`[${fault}] 被拒后日志仍在（没被第二次写入破坏）`, journalOfPermit(id)?.token === staleToken)

  // 正确令牌恢复
  const recovered = recoverBurnExecution(id, staleToken)
  check(`[${fault}] 断电可重试，恢复成功`, recovered.ok, recovered.message)
  const done = findPermit(id)
  check(`[${fault}] 恢复后状态已执行`, done.status === '已执行')
  check(`[${fault}] 恢复后安全措施核销`, String(done['安全措施']) === '')
  const reminders = listPassageReminders().filter((item) => item.permitId === id)
  check(`[${fault}] 提醒只有一条（重放不重复）`, reminders.length === 1, `实际 ${reminders.length} 条`)
  check(`[${fault}] 提醒已转已通行`, reminders[0]?.提醒状态 === '已通行')
  check(`[${fault}] 恢复日志清除`, journalOfPermit(id) === null)
}

// ============================================================================
console.log('场景3：状态机硬规则——只有已批准能执行；审批流非法跳变被拒')
{
  resetData()
  const draftId = 1 // 待申请
  check('待申请执行被拒', startBurnExecution(draftId).message.includes('只有'))
  const rejectResult = rejectBurnApplication(2) // 待审批→已驳回
  check('待审批可驳回', rejectResult.ok, rejectResult.message)
  check('已驳回执行被拒', startBurnExecution(2).message.includes('只有'))
  const reSubmit = approveBurnApplication(2, '值班管理员')
  check('已驳回不能直接批准（必须先提交）', !reSubmit.ok && reSubmit.message.includes('不能'))

  resetData()
  // 先批准 id=2 再执行，走通审批→执行链路
  const approve = approveBurnApplication(2, '值班管理员')
  check('待审批可批准', approve.ok, approve.message)
  check('批准后是已批准', findPermit(2).status === '已批准')
  const exec = startBurnExecution(2)
  check('批准后可执行到已执行', exec.ok && findPermit(2).status === '已执行', exec.message)
}

// ============================================================================
console.log('场景4：历史申请缺审批人——原值留空兼容，批准时补录')
{
  resetData()
  const id = 4 // 种子历史数据：已批准、无审批人字段
  const raw = findPermit(id)
  check('历史审批单原值无审批人字段', raw['审批人'] === undefined)
  const view = describeBurnPermit(raw)
  check('展示层给出兼容说明', view.审批人显示.includes('历史申请未登记审批人'))
  check('历史单可正常执行（不因缺审批人卡住）', startBurnExecution(id).ok)

  // 待审批且缺审批人的历史单（id=5 同时缺关键字段，但审批流允许先批准）：批准时补录审批人
  const approval = approveBurnApplication(5, '王防火')
  if (approval.ok) {
    const r5 = findPermit(5)
    check('批准时补录审批人（带补录注记）', String(r5['审批人']).includes('王防火') && String(r5['审批人']).includes('补录'))
    check('补录说明已留痕', String(r5['补录说明']).includes('原记录留空兼容'))
    check('补录不改动其它原值（用火地点仍空，异常空态原因保留）', r5['用火地点'] === '')
  } else {
    check('批准缺审批人的历史单成功（补录分支）', false, approval.message)
  }
}

// ============================================================================
console.log('场景5：异常申请保留空态并说明原因，不允许执行')
{
  resetData()
  const id = 5 // 缺用火地点、安全措施，状态待审批
  const view = describeBurnPermit(findPermit(id))
  check('异常原因可读', view.abnormalReason.includes('用火地点') && view.abnormalReason.includes('安全措施'))
  check('异常单 pending 仍按状态计算（待审批=待处理）', view.pending === true)
  check('异常单 abnormal=true（看板可见）', view.abnormal === true)
  // 待审批阶段先走审批流也不允许：在「批准」前缺字段的单即便被批准，执行环节仍要拦。
  // 直接造一条「已批准但关键字段缺失」的单，验证执行入口的空态拦截：
  commit((draft) => {
    const bag = draft.burnpermit as EntryRow[]
    const idx = bag.findIndex((r) => Number(r.id) === id)
    bag[idx] = { ...bag[idx], status: '已批准', pending: true }
  })
  const exec = startBurnExecution(id)
  check('异常单执行被拒并带原因', !exec.ok && exec.message.includes('关键字段缺失'), exec.message)
  check('异常单状态保持已批准（空态保留，未推进到已执行）', findPermit(id).status === '已批准')
  check('异常单不产生通行提醒', reminderOfPermit(id) === null)
  check('异常单不产生恢复日志', journalOfPermit(id) === null)
}

// ============================================================================
console.log('场景6：兼容历史审批——缺关联提醒的已批准单可同步，幂等不重复')
{
  resetData()
  // 种子 id=4 已批准但无提醒（历史迁移）
  check('同步前无提醒', reminderOfPermit(4) === null)
  const sync1 = syncHistoricalReminders()
  check('首次同步补 1 条以上', sync1.synced >= 1 && sync1.ok, sync1.message)
  const reminder = reminderOfPermit(4)
  check('历史已批准单补出待放行提醒', reminder?.提醒状态 === '待放行')
  const sync2 = syncHistoricalReminders()
  check('再次同步为 0（幂等不重复）', sync2.synced === 0)
  check('提醒仍只有一条', listPassageReminders().filter((r) => r.permitId === 4).length === 1)

  // 执行后提醒随审批同步更新
  const exec = startBurnExecution(4)
  check('历史单执行成功', exec.ok, exec.message)
  check('执行后提醒同步已通行', reminderOfPermit(4)?.提醒状态 === '已通行')
}

// ============================================================================
console.log('场景7：审批单与提醒同次落库——审批/驳回不产生孤立提醒')
{
  resetData()
  const approve = approveBurnApplication(2, '值班管理员')
  check('批准成功', approve.ok)
  check('批准同次生成待放行提醒', reminderOfPermit(2)?.提醒状态 === '待放行')
  // 驳回另一条待审批，不应有提醒残留
  const reject = rejectBurnApplication(5) // 异常但状态待审批，驳回链路应清理
  check('驳回成功', reject.ok, reject.message)
  check('驳回后无关联提醒', reminderOfPermit(5) === null)
  check('驳回后无残留执行日志', journalOfPermit(5) === null)
}

// ============================================================================
console.log('场景8：待执行口径修复——列表 pending 不再把待执行算成已执行')
{
  resetData()
  const counts = {
    待申请: 0,
    待审批: 0,
    已批准: 0,
    已驳回: 0,
    已执行: 0,
  } as Record<string, { pending: number; total: number }>
  Object.keys(counts).forEach((k) => (counts[k] = { pending: 0, total: 0 }))
  for (const row of listBurnPermits()) {
    counts[row.status].total += 1
    if (row.pending) counts[row.status].pending += 1
  }
  check('已批准（待执行）pending=true', counts['已批准'].pending === counts['已批准'].total)
  check('已执行 pending=false', counts['已执行'].pending === 0)
  check('已驳回 pending=false', counts['已驳回'].pending === 0 || counts['已驳回'].total === 0)
}

// ============================================================================
console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
