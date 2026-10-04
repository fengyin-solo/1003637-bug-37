<template>
  <section class="page" data-module="burnpermit">
    <header class="page-head">
      <div>
        <h2>焚烧审批管理</h2>
        <p class="page-desc">维护用火审批单，围绕审批编号、申请单位、用火类型、用火地点做登记、筛选与状态流转。执行用火走「安全措施 → 通行提醒 → 完成执行」三步，断电后可从失败环节恢复。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="resetScene">重置为示例断电现场</button>
        <button class="btn" type="button" @click="exportRows">导出焚烧审批清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>通行提醒</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-abnormal': row.abnormal || row.executing }">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '审批人'">
              <span v-if="row[column] === '' || row[column] == null" class="empty-tag" title="历史申请缺审批人，按原值勤记录">空（待补录）</span>
              <template v-else>{{ row[column] }}</template>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>
            <span v-if="row.reminderCount > 0">{{ row.reminderCount }} 条</span>
            <span v-else class="empty-tag">无</span>
          </td>
          <td>
            {{ row.status }}
            <span v-if="row.executing" class="badge badge-warn">执行中断</span>
          </td>
          <td class="row-actions">
            <template v-for="action in actionsFor(row)" :key="action.key">
              <button class="link" type="button" @click="runAction(action.key, row)">{{ action.label }}</button>
            </template>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无焚烧审批数据</td>
        </tr>
      </tbody>
    </table>

    <!-- 异常/空态说明：历史缺审批人、断电中断等都在这里交代原因 -->
    <ul v-if="issueRows.length" class="issue-list">
      <li v-for="item in issueRows" :key="String(item.id)" class="issue-item">
        <strong>{{ item['审批编号'] }}</strong>：{{ item.issue }}
      </li>
    </ul>

    <!-- 关联通行提醒：与审批单同次落库、同步更新 -->
    <section class="reminder-panel">
      <h3>关联通行提醒</h3>
      <table class="data-table">
        <thead>
          <tr><th>审批编号</th><th>用火地点</th><th>计划时段</th><th>提醒内容</th><th>提醒状态</th></tr>
        </thead>
        <tbody>
          <tr v-for="reminder in reminders" :key="reminder.id">
            <td>{{ reminder.审批编号 }}</td>
            <td>{{ reminder.用火地点 }}</td>
            <td>{{ reminder.计划时段 }}</td>
            <td>{{ reminder.提醒内容 }}</td>
            <td>
              {{ reminder.status }}
              <span v-if="reminder.status === '待生效'" class="badge badge-ok">待生效</span>
              <span v-else-if="reminder.status === '已闭环'" class="badge badge-done">已闭环</span>
              <span v-else class="badge badge-warn">{{ reminder.status }}</span>
            </td>
          </tr>
          <tr v-if="!reminders.length">
            <td colspan="5" class="empty-state">暂无通行提醒（执行用火时同步生成，不重复下发）</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 执行用火弹窗：三步环节 + 断电模拟 + 恢复 -->
    <div v-if="execDialog.open" class="modal-mask" @click.self="closeExecDialog">
      <div class="modal">
        <h3>{{ execDialog.resume ? '恢复执行用火' : '执行用火' }} · {{ execDialog.code }}</h3>
        <p class="modal-desc">
          用火地点：{{ execDialog.place }} ｜ 计划时段：{{ execDialog.period }}
        </p>

        <ol class="step-list">
          <li v-for="step in stepList" :key="step.key" :class="stepClass(step.key)">
            <span class="step-name">{{ step.label }}</span>
            <span class="step-state">{{ stepState(step.key) }}</span>
          </li>
        </ol>

        <label v-if="execDialog.step !== 'finish'" class="crash-line">
          <input v-model="execDialog.crashNext" type="checkbox" />
          模拟本环节处理时断电（事务整体失败，回到断电前状态，之后可恢复重试）
        </label>

        <div class="modal-actions">
          <button class="btn primary" type="button" :disabled="execDialog.busy" @click="advance">
            {{ execDialog.step === 'finish' ? '完成执行并归档' : `执行：${stepLabel(execDialog.step)}` }}
          </button>
          <button v-if="execDialog.resume || execDialog.started" class="btn ghost" type="button" @click="abandon">
            放弃并清理入口残留
          </button>
          <button class="btn" type="button" @click="closeExecDialog">返回列表</button>
        </div>
        <p v-if="execDialog.message" class="modal-message">{{ execDialog.message }}</p>
      </div>
    </div>

    <!-- 历史申请补录审批人 -->
    <div v-if="approverDialog.open" class="modal-mask" @click.self="approverDialog.open = false">
      <div class="modal">
        <h3>补录审批人 · {{ approverDialog.code }}</h3>
        <p class="modal-desc">历史申请缺少审批人，原记录保留空值，仅补录人名，不改变审批单状态。</p>
        <input v-model="approverDialog.name" class="text-input" placeholder="请输入审批人姓名" />
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="saveApprover">保存补录</button>
          <button class="btn" type="button" @click="approverDialog.open = false">取消</button>
        </div>
        <p v-if="approverDialog.message" class="modal-message">{{ approverDialog.message }}</p>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条焚烧审批记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  advanceBurnExecution,
  cancelBurnExecution,
  listBurnPermits,
  listReminders,
  startBurnExecution,
  STEP_LABEL,
  submitBurnAction,
} from '@/api/burn-permit'
import { downloadEntries, resetModule } from '@/api/local-service'
import type { BurnPermitView, BurnStep, ReminderRow } from '@/data/types'

const columns = ["审批编号", "申请单位", "用火类型", "用火地点", "计划时段", "安全措施", "审批人", "审批状态"]
const stepList: { key: BurnStep; label: string }[] = [
  { key: 'safety', label: STEP_LABEL.safety },
  { key: 'notice', label: STEP_LABEL.notice },
  { key: 'finish', label: STEP_LABEL.finish },
]

const rows = ref<BurnPermitView[]>([])
const reminders = ref<ReminderRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = computed(() => [
  { label: '待审批申请', value: rows.value.filter((row) => row.status === '待审批').length },
  { label: '已批准待执行', value: rows.value.filter((row) => row.status === '已批准').length },
  { label: '已执行', value: rows.value.filter((row) => row.status === '已执行').length },
])

const statusSummary = computed(() => {
  const statuses = ['待申请', '待审批', '已批准', '已驳回', '已执行']
  return statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  }))
})

const issueRows = computed(() => rows.value.filter((row) => row.issue))

/** 行内动作按状态决定：状态只能从「已批准」推进到「已执行」，且执行入口不残留。 */
function actionsFor(row: BurnPermitView): { key: string; label: string }[] {
  if (row.status === '待申请') return [{ key: '提交申请', label: '提交申请' }]
  if (row.status === '待审批') {
    return [
      { key: '批准申请', label: '批准申请' },
      { key: '驳回答复', label: '驳回答复' },
    ]
  }
  if (row.status === '已批准') {
    const list = []
    if (row.executing) {
      list.push({ key: '恢复执行', label: '恢复执行（断电续跑）' })
      list.push({ key: '放弃执行', label: '清理入口残留' })
    } else {
      list.push({ key: '执行用火', label: '执行用火' })
    }
    if (row['审批人'] === '' || row['审批人'] == null) {
      list.push({ key: '补录审批人', label: '补录审批人' })
    }
    list.push({ key: '驳回答复', label: '驳回答复' })
    return list
  }
  if (row.status === '已驳回' && (row['审批人'] === '' || row['审批人'] == null)) {
    return [{ key: '补录审批人', label: '补录审批人' }]
  }
  return []
}

const execDialog = reactive({
  open: false,
  busy: false,
  id: 0,
  code: '',
  place: '',
  period: '',
  resume: false,
  started: false,
  step: 'safety' as BurnStep,
  done: [] as BurnStep[],
  crashNext: false,
  message: '',
})

const approverDialog = reactive({ open: false, id: 0, code: '', name: '', message: '' })

function stepLabel(step: BurnStep): string {
  return STEP_LABEL[step]
}

function stepState(step: BurnStep): string {
  if (execDialog.done.includes(step)) return '已完成'
  if (step === execDialog.step) return execDialog.resume ? '恢复点（待继续）' : '进行中'
  return '待执行'
}

function stepClass(step: BurnStep): string {
  if (execDialog.done.includes(step)) return 'step-done'
  if (step === execDialog.step) return 'step-current'
  return 'step-todo'
}

function runAction(action: string, row: BurnPermitView) {
  errorMessage.value = ''
  if (action === '执行用火' || action === '恢复执行') {
    openExecDialog(Number(row.id), Boolean(row.executing))
    return
  }
  if (action === '放弃执行') {
    const result = cancelBurnExecution(Number(row.id))
    errorMessage.value = result.ok ? '' : result.message
    if (result.ok) reload()
    return
  }
  if (action === '补录审批人') {
    approverDialog.open = true
    approverDialog.id = Number(row.id)
    approverDialog.code = String(row['审批编号'])
    approverDialog.name = ''
    approverDialog.message = ''
    return
  }
  const result = submitBurnAction(Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function openExecDialog(id: number, resume: boolean) {
  const result = startBurnExecution(id, resume)
  if (!result.ok || !result.execution || !result.step) {
    errorMessage.value = result.message
    return
  }
  execDialog.open = true
  execDialog.busy = false
  execDialog.id = id
  execDialog.resume = resume
  execDialog.started = !resume
  execDialog.step = result.step
  execDialog.done = [...result.execution.done]
  execDialog.crashNext = false
  execDialog.message = result.message
  const row = rows.value.find((item) => Number(item.id) === id)
  execDialog.code = String(row?.['审批编号'] ?? '')
  execDialog.place = String(row?.['用火地点'] ?? '')
  execDialog.period = String(row?.['计划时段'] ?? '')
}

function advance() {
  execDialog.busy = true
  execDialog.message = ''
  const crashAt = execDialog.crashNext ? execDialog.step : null
  const result = advanceBurnExecution(execDialog.id, execDialog.step, crashAt)
  execDialog.busy = false
  execDialog.crashNext = false
  if (!result.ok) {
    // 断电：执行入口保留，提示可恢复，关闭弹窗回到列表也能看到中断标记
    execDialog.message = result.message
    execDialog.resume = true
    reload()
    return
  }
  if (execDialog.step === 'finish') {
    execDialog.open = false
    reload()
    return
  }
  execDialog.done.push(execDialog.step)
  execDialog.started = true
  const order: BurnStep[] = ['safety', 'notice', 'finish']
  execDialog.step = order[order.indexOf(execDialog.step) + 1]
  execDialog.message = result.message
  reload()
}

function abandon() {
  const result = cancelBurnExecution(execDialog.id)
  execDialog.message = result.message
  if (result.ok) {
    execDialog.open = false
    reload()
  }
}

function closeExecDialog() {
  // 断电/中途离开都保留执行会话，列表据此显示中断态，可再次进来恢复
  execDialog.open = false
  reload()
}

function saveApprover() {
  const result = submitBurnAction(approverDialog.id, '补录审批人', { approver: approverDialog.name })
  approverDialog.message = result.message
  if (result.ok) {
    approverDialog.open = false
    reload()
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('burnpermit')
}

function resetScene() {
  resetModule('burnpermit')
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    rows.value = listBurnPermits(filters.value)
    total.value = rows.value.length
    reminders.value = listReminders()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '焚烧审批列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.row-abnormal { background: #fff8ed; }
.empty-tag { color: #b45309; font-size: 12px; }
.badge { border-radius: 999px; padding: 1px 8px; font-size: 11px; margin-left: 4px; }
.badge-warn { background: #fef3c7; color: #92400e; }
.badge-ok { background: #dbeafe; color: #1d4ed8; }
.badge-done { background: #dcfce7; color: #166534; }
.issue-list { margin: 10px 0; padding: 10px 12px; background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; list-style: none; }
.issue-item { font-size: 12px; color: #92400e; margin: 2px 0; }
.reminder-panel { margin-top: 16px; }
.reminder-panel h3 { font-size: 14px; margin: 0 0 8px; }
.modal-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; align-items: center; justify-content: center; z-index: 20; }
.modal { background: #fff; border-radius: 10px; padding: 18px 20px; width: 480px; max-width: calc(100vw - 32px); }
.modal h3 { margin: 0 0 6px; font-size: 15px; }
.modal-desc { color: var(--muted); font-size: 12px; margin: 0 0 10px; }
.step-list { margin: 0 0 10px; padding-left: 18px; }
.step-list li { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; border-bottom: 1px dashed var(--border); }
.step-done .step-state { color: #166534; }
.step-current .step-state { color: #1d4ed8; font-weight: 600; }
.step-todo .step-state { color: var(--muted); }
.crash-line { display: flex; gap: 6px; align-items: center; font-size: 12px; color: #92400e; margin: 8px 0; }
.modal-actions { display: flex; gap: 8px; margin-top: 12px; }
.modal-message { margin: 10px 0 0; font-size: 12px; color: #b42318; }
.text-input { width: 100%; padding: 7px 9px; border: 1px solid var(--border); border-radius: 6px; }
</style>
