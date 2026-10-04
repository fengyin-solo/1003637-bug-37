import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

// 用火执行链路的附属数据与业务表放在同一个库里：审批单、通行提醒、断电恢复日志同一次 commit 落盘。
export const BURN_REMINDER_KEY = '_burnPassageReminders'
export const BURN_JOURNAL_KEY = '_burnExecJournals'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type StoreShape = Record<string, unknown>

// Node/测试环境没有 localStorage，用内存兜底，保证纯数据层不依赖浏览器也能跑。
const memoryFallback: StoreShape = {}

function storagePick(): Storage | null {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage
  }
  return null
}

function readRaw(): StoreShape {
  const storage = storagePick()
  if (storage) {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw) {
      try {
        return JSON.parse(raw) as StoreShape
      } catch {
        // 落库内容损坏时回落到种子数据，绝不让半截 JSON 把取数链路带崩。
      }
    }
  } else if (memoryFallback[STORAGE_KEY]) {
    return clone(memoryFallback[STORAGE_KEY] as StoreShape)
  }
  const seeded = clone(SEED_ROWS) as StoreShape
  writeRaw(seeded)
  return seeded
}

function writeRaw(data: StoreShape): void {
  // 先序列化再落库：序列化失败（异常数据）时旧值原样保留，不会写出半截内容。
  const encoded = JSON.stringify(data)
  const storage = storagePick()
  if (storage) {
    storage.setItem(STORAGE_KEY, encoded)
  } else {
    memoryFallback[STORAGE_KEY] = clone(data)
  }
}

let cache: StoreShape | null = null

function asRows(value: unknown): EntryRow[] {
  return Array.isArray(value) ? (value as EntryRow[]) : []
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readRaw()
  }
  return cache as Record<string, EntryRow[]>
}

export function listRows(key: string): EntryRow[] {
  return asRows(allRows()[key])
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commit((draft) => {
    draft[key] = rows
  })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

/**
 * 唯一写入口（事务原语）：在草稿上改，改完一次性整体落库。
 * 写入失败（含模拟断电）时缓存与磁盘都保持调用前状态，即「回到断电前状态」。
 * 多 key 变更（审批单 + 通行提醒 + 恢复日志）必须走这里，保证同次落库。
 */
export function commit<T>(mutator: (draft: StoreShape) => T): T {
  const base = cache ?? readRaw()
  const draft = clone(base)
  const result = mutator(draft)
  // 这一行之前抛错（含故障注入）都不会触碰 cache/storage：效果等同于断电。
  writeRaw(draft)
  cache = draft
  return result
}

/** 读取附属集合（通行提醒 / 恢复日志），取不到给空数组。 */
export function listCollection<T>(key: string): T[] {
  const value = allRows()[key]
  return Array.isArray(value) ? (value as T[]) : []
}

/** 测试/调试用：整体重置回种子数据，并清空附属集合与运行期缓存。 */
export function resetAllForTests(): void {
  const seeded = clone(SEED_ROWS) as StoreShape
  seeded[BURN_JOURNAL_KEY] = []
  seeded[BURN_REMINDER_KEY] = []
  writeRaw(seeded)
  cache = seeded
}
