// 這次打開 App 之後的同步過程（loadstate 用）：
//   fresh       這次打開已經完整同步成功過（syncing → idle，沒有錯誤）。持久化的 lastPullAt 不算：
//               上次打開的資料只能叫「快取」（cached-syncing），不能叫「最新」。
//   failStreak  連續同步失敗的次數（syncing → offline／error），成功就歸零。給連線橫幅用。
// 必須在 client.start() 之前建立，才看得到第一輪。
import { useSyncExternalStore } from 'react'
import type { SyncClient } from '@food-log/sync-client'

export interface SessionSnapshot {
  fresh: boolean
  failStreak: number
}

export class SessionTracker {
  private snap: SessionSnapshot
  private readonly listeners = new Set<() => void>()
  private prevPhase: string
  private readonly unsub: () => void

  constructor(client: SyncClient) {
    // 試用模式沒有同步：本機資料就是正本。
    this.snap = { fresh: client.mode === 'trial', failStreak: 0 }
    this.prevPhase = client.getStatus().phase
    this.unsub = client.status.subscribe(() => this.onStatus(client.getStatus()))
  }

  private onStatus(s: { phase: string; error: string | null }): void {
    const prev = this.prevPhase
    this.prevPhase = s.phase
    let { fresh, failStreak } = this.snap
    if (s.phase === 'idle' && s.error === null && prev === 'syncing') {
      fresh = true
      failStreak = 0
    } else if (prev === 'syncing' && (s.phase === 'offline' || s.phase === 'error')) {
      failStreak += 1
    }
    if (fresh !== this.snap.fresh || failStreak !== this.snap.failStreak) {
      this.snap = { fresh, failStreak }
      for (const l of [...this.listeners]) l()
    }
  }

  getSnapshot = (): SessionSnapshot => this.snap
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  dispose(): void {
    this.unsub()
    this.listeners.clear()
  }
}

export function useSession(tracker: SessionTracker): SessionSnapshot {
  return useSyncExternalStore(tracker.subscribe, tracker.getSnapshot, tracker.getSnapshot)
}
