/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean | null
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

/** 用火审批单执行用火的分步环节：断电后据此定位“恢复点”，从失败环节继续。 */
export type BurnStep = 'safety' | 'notice' | 'finish'

/** 执行会话：记录已经走到的环节，断电后用来清理残留、避免重复提醒。 */
export type BurnExecution = {
  /** 用火审批单 id */
  permitId: number
  /** 已完成的环节，按顺序依次为 safety / notice / finish */
  done: BurnStep[]
  /** 本次执行关联的通行提醒 id，幂等键，重连/重试不会重复建提醒 */
  reminderId: number | null
  /** 开始执行的时间戳 */
  startedAt: number
}

/** 与用火审批单关联的通行提醒。 */
export type ReminderRow = {
  id: number
  /** 关联的用火审批单 id；历史脏数据可能为 null（找不到审批单） */
  permitId: number | null
  审批编号: string
  用火地点: string
  计划时段: string
  提醒内容: string
  status: string
  createdAt: number
  [field: string]: string | number | null
}

/** 列表页展示的一行：审批单本体 + 执行/异常的取数链路解释。 */
export type BurnPermitView = EntryRow & {
  /** 执行入口是否残留（存在未完成的执行会话） */
  executing: boolean
  /** 关联的通行提醒数 */
  reminderCount: number
  /** 异常/空态原因，例如历史申请缺审批人、执行断电中断 */
  issue: string
  /** 断电时中断在哪个环节（无中断为 null） */
  interruptStep?: BurnStep | null
}
