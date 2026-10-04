<template>
  <section class="page" data-module="burnpermit">
    <header class="page-head">
      <div>
        <h2>焚烧审批管理</h2>
        <p class="page-desc">维护用火审批单，围绕审批编号、申请单位、用火类型、用火地点做登记、筛选与状态流转；用火执行支持断电恢复。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记用火审批单</button>
        <button class="btn" type="button" @click="syncHistory">兼容历史审批·同步提醒</button>
        <button class="btn" type="button" @click="exportRows">导出焚烧审批清单</button>
      </div>
    </header>

    <div v-if="interrupted.length" class="recover-banner">
      <strong>检测到 {{ interrupted.length }} 条用火审批单执行中途断电：</strong>
      <span v-for="item in interrupted" :key="item.permitId" class="recover-chip">
        审批单 #{{ item.permitId }} 停在「{{ item.stepLabel }}」
        <button class="link" type="button" @click="resume(item.permitId, item.token)">从失败环节继续</button>
      </span>
      <span class="banner-hint">处理后请留在本列表确认状态已回到「已批准」或推进到「已执行」。</span>
    </div>

    <div class="fault-bar">
      <label class="filter-item">
        <span>断电演练（联调用，模拟执行到一半断电）</span>
        <select v-model="faultPoint">
          <option v-for="point in faultPoints" :key="point.value" :value="point.value">{{ point.label }}</option>
        </select>
      </label>
      <button class="btn ghost" type="button" @click="applyFaultPoint">应用演练设置</button>
    </div>

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
          <th>关联通行提醒</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in views" :key="String(row.id)" :class="{ 'row-abnormal': row.abnormal, 'row-interrupted': row.resumeStep }">
          <td>{{ row['审批编号'] || '—' }}</td>
          <td>{{ row['申请单位'] || '—' }}</td>
          <td>{{ row['用火类型'] || '—' }}</td>
          <td>{{ row['用火地点'] || '—' }}</td>
          <td>{{ row['计划时段'] || '—' }}</td>
          <td>
            <template v-if="row.status === '已执行'">
              <span class="muted">已核销</span>
            </template>
            <template v-else>{{ row['安全措施'] || '—' }}</template>
          </td>
          <td>
            {{ row.审批人显示 }}
            <span v-if="row['补录说明']" class="cell-note" :title="String(row['补录说明'])">ⓘ</span>
          </td>
          <td>{{ row['审批状态'] || '—' }}</td>
          <td>
            <span v-if="row.reminderStatus" :class="{ 'cell-warn': row.reminderStatus.includes('未同步') }">{{ row.reminderStatus }}</span>
            <span v-else class="muted">—</span>
          </td>
          <td>
            <strong :class="row.resumeStep ? 'status-interrupted' : ''">{{ row.status }}</strong>
            <div v-if="row.resumeStep" class="cell-note">断电中断，恢复点：{{ row.resumeStep }}</div>
            <div v-if="row.abnormalReason" class="cell-warn">{{ row.abnormalReason }}</div>
            <div v-if="row['执行记录']" class="cell-note" :title="String(row['执行记录'])">执行记录留痕</div>
          </td>
          <td class="row-actions">
            <template v-if="row.resumeStep">
              <button class="link" type="button" @click="resume(Number(row.id), row.token)">从「{{ row.resumeStep }}」恢复</button>
            </template>
            <template v-else>
              <button
                v-for="action in actionsFor(row)"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
          </td>
        </tr>
        <tr v-if="!views.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无焚烧审批数据，可先登记用火审批单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条焚烧审批记录</span>
      <span v-if="noticeMessage" :class="noticeOk ? 'ok-text' : 'error-text'">{{ noticeMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  executeBurnPermit,
  interruptedBurnPermits,
  listBurnPermitViews,
  moduleMeta,
  passageReminders,
  recoverBurnPermit,
  runAction as applyAction,
  syncBurnHistory,
} from '@/api/local-service'
import type { BurnPermitView } from '@/data/types'
import { EXEC_PIPELINE, setFaultInjection } from '@/data/burn-execution'

// 断电演练：选择在哪个环节后制造断电，下一次「执行用火」会在该恢复点之后中断（仅演示/联调用）。
const faultPoints = [
  { value: '', label: '正常（不演练断电）' },
  { value: 'start', label: '启动前断电' },
  { value: 'safety-briefing', label: '交底后断电' },
  { value: 'checkpoint-notify', label: '通行提醒后断电' },
  { value: 'finalize', label: '落库前断电' },
]
const faultPoint = ref('')
function applyFaultPoint() {
  setFaultInjection(faultPoint.value)
  notify(
    faultPoint.value
      ? `已设置断电演练点：${faultPoints.find((item) => item.value === faultPoint.value)?.label}，下次执行将中断`
      : '已取消断电演练',
    true,
  )
}

const meta = moduleMeta('burnpermit')
const columns = ['审批编号', '申请单位', '用火类型', '用火地点', '计划时段', '安全措施', '审批人', '审批状态']
const statuses = ['待申请', '待审批', '已批准', '已驳回', '已执行']
const stats = ref([
  { label: '待审批申请', value: 0 },
  { label: '已批准待执行', value: 0 },
  { label: '已执行用火', value: 0 },
  { label: '异常/驳回', value: 0 },
])

const views = ref<BurnPermitView[]>([])
const total = ref(0)
const noticeMessage = ref('')
const noticeOk = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: views.value.filter((row) => String(row.status) === status).length,
  })),
)

const interrupted = computed(() =>
  interruptedBurnPermits().map((item) => {
    const found = EXEC_PIPELINE.find((step) => step.step === item.step)
    const nextIndex = EXEC_PIPELINE.findIndex((step) => step.step === item.step) + 1
    const next = EXEC_PIPELINE[nextIndex]
    return {
      permitId: item.permitId,
      stepLabel: found ? found.label : item.step,
      nextLabel: next ? next.label : '执行结果落库',
      token: item.token,
    }
  }),
)

function actionsFor(row: BurnPermitView): string[] {
  // 异常申请保留空态：不给执行入口，只允许先补录（这里以提示说明，不落动作）。
  if (row.abnormalReason) {
    return []
  }
  const list: string[] = []
  if (row.status === '待申请' || row.status === '已驳回') {
    list.push('提交申请')
  }
  if (row.status === '待审批') {
    list.push('批准申请', '驳回答复')
  }
  // 修复后的硬规则：只有「已批准」出现执行入口。
  if (row.status === '已批准') {
    list.push('执行用火')
  }
  return list
}

function notify(message: string, ok = false) {
  noticeMessage.value = message
  noticeOk.value = ok
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  notify('用火审批单登记入口尚未接入审批流')
}

function syncHistory() {
  const result = syncBurnHistory()
  reload()
  notify(result.message, result.ok)
}

function runAction(action: string, row: BurnPermitView) {
  if (action === '执行用火') {
    const result = executeBurnPermit(Number(row.id))
    reload()
    if (result.interrupted) {
      notify(`审批单 #${row.id} ${result.message}`)
    } else {
      notify(result.message, result.ok)
    }
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  reload()
  notify(result.message, result.ok)
}

function resume(id: number, token: string) {
  const result = recoverBurnPermit(id, token)
  // 恢复（无论成功、再次断电还是被并发拒绝）后都重新取数，回列表确认最新状态。
  reload()
  notify(result.message, result.ok)
}

function reload() {
  noticeMessage.value = ''
  try {
    const payload = listBurnPermitViews(filters.value)
    views.value = payload.items
    total.value = payload.total
    const pending = views.value.filter((row) => row.status === '待审批').length
    const approved = views.value.filter((row) => row.status === '已批准').length
    const executed = views.value.filter((row) => row.status === '已执行').length
    const abnormal = views.value.filter((row) => row.abnormal || row.status === '已驳回').length
    stats.value = [
      { label: '待审批申请', value: pending },
      { label: '已批准待执行', value: approved },
      { label: '已执行用火', value: executed },
      { label: '异常/驳回', value: abnormal },
    ]
    // 取一次提醒链路，保持检查站面板的数据源被预热（同一取数链路）。
    passageReminders()
  } catch (error) {
    notify(error instanceof Error ? error.message : '焚烧审批列表读取失败')
  }
}

onMounted(reload)
</script>
