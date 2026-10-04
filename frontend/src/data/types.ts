/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 用火执行环节：执行用火从安全交底到现场放行要分几步，断电后按步骤名找回恢复点。 */
export type BurnExecStep = 'safety-briefing' | 'checkpoint-notify' | 'finalize'

/** 用火执行断电恢复日志：执行单状态与通行提醒同次落库前的恢复点，全部数据与业务表同一次 commit 写盘。 */
export type BurnExecJournal = {
  /** 用火审批单 id */
  permitId: number
  /** 已完成的最后一步（最终提交成功后日志即删除） */
  step: BurnExecStep
  /** 乐观锁令牌：并发恢复时第二次写入凭旧令牌必然被拒绝 */
  token: string
  startedAt: string
  updatedAt: string
}

/** 关联检查站的通行提醒：审批与提醒同一取数链路，按 permitId 幂等，绝不重复出现。 */
export type PassageReminder = {
  /** 等于来源用火审批单 id，天然幂等键 */
  permitId: number
  审批编号: string
  用火地点: string
  计划时段: string
  安全措施: string
  /** 待放行 / 已通行；审批单推进到已执行时提醒同步更新 */
  提醒状态: '待放行' | '已通行'
  /** 待确认（已批准未执行）/ 已通行（已执行），检查站面板按此分组 */
  kind: '待确认' | '已通行'
  createdAt: string
  updatedAt: string
}

/** 焚烧审批列表行视图：在原始 EntryRow 上附带取数链路里算出的兼容与异常信息。 */
export type BurnPermitView = EntryRow & {
  /** 历史申请缺审批人时按原值勤记录兼容，这里给出兼容展示，不改动原值 */
  审批人显示: string
  /** 异常申请保留空态时的原因说明（关键字段缺失），正常行为空 */
  abnormalReason: string
  /** 断电中断中的执行恢复点（步骤中文名），没有中断为空 */
  resumeStep: string
  /** 该行当前对应的乐观锁令牌，动作提交时原样带回 */
  token: string
  /** 关联通行提醒状态，没有关联提醒为空 */
  reminderStatus: string
}
