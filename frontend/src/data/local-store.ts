import { SEED_EXECUTIONS, SEED_REMINDERS, SEED_ROWS } from './seed'
import type { BurnExecution, EntryRow, ReminderRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'
// 版本变更时会把旧数据整体重置，避免半成品结构污染取数链路。
const STORE_VERSION = 2

export type StoreShape = {
  version: number
  entries: Record<string, EntryRow[]>
  reminders: ReminderRow[]
  // key 为用火审批单 id，保证同一时刻一张单子最多只有一条执行会话
  executions: Record<string, BurnExecution>
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function freshStore(): StoreShape {
  return {
    version: STORE_VERSION,
    entries: clone(SEED_ROWS),
    reminders: clone(SEED_REMINDERS),
    executions: clone(SEED_EXECUTIONS),
  }
}

function normalize(raw: unknown): StoreShape {
  // 结构不对、版本过期、或缺少关键集合时一律回到播种数据：宁可空态也不读脏数据。
  if (!raw || typeof raw !== 'object') {
    return freshStore()
  }
  const candidate = raw as Partial<StoreShape>
  if (candidate.version !== STORE_VERSION || !candidate.entries || !Array.isArray(candidate.reminders)) {
    return freshStore()
  }
  return {
    version: STORE_VERSION,
    entries: candidate.entries,
    reminders: candidate.reminders,
    executions: candidate.executions ?? {},
  }
}

function persist(store: StoreShape): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  }
}

function readStorage(): StoreShape {
  const fallback = freshStore()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    persist(fallback)
    return fallback
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    persist(fallback)
    return fallback
  }
  const normalized = normalize(parsed)
  // 归一化若触发了回退（版本过期/结构损坏），把干净结构写回，避免每次读取都重算。
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as Partial<StoreShape>).version !== STORE_VERSION ||
    !(parsed as Partial<StoreShape>).entries ||
    !Array.isArray((parsed as Partial<StoreShape>).reminders)
  ) {
    persist(normalized)
  }
  return normalized
}

let cache: StoreShape | null = null

export function store(): StoreShape {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return store().entries
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  mutate((draft) => {
    draft.entries[key] = rows
  })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

/**
 * 在一次“事务”里改多个集合：先在草稿上改，最后只落库一次。
 * 审批单与通行提醒必须同一次落库；中途抛错时草稿直接丢弃，
 * localStorage 里仍是断电前的旧状态，不会出现一半新一半旧。
 */
export function mutate<T>(fn: (draft: StoreShape) => T): T {
  const current = store()
  const draft: StoreShape = clone(current)
  const result = fn(draft)
  cache = draft
  persist(draft)
  return result
}

export function storageKey(): string {
  return STORAGE_KEY
}
