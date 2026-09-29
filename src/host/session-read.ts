import { interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { SessionRecord, SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'

export interface PersistenceSnapshotLike {
  header: SessionRecord['header']
  revision?: unknown
}

export interface SessionHandleLike {
  readonly id?: SessionId
  readonly header: SessionHeader
  readonly inheritedEventCount?: number
  read: (fromSeq?: number, toSeqExclusive?: number, options?: unknown) => Promise<{
    readonly events: readonly SessionEvent[]
  }>
  close: () => Promise<void>
}

export interface SessionPersistenceLike {
  /** DSH ≤ 0.1.2 exposed listSnapshots(); 0.1.5 exposes list(). */
  listSnapshots?: () => Promise<readonly PersistenceSnapshotLike[]>
  list?: () => Promise<readonly PersistenceSnapshotLike[]>
  open?: (id: SessionId, access: 'read' | 'write') => Promise<SessionHandleLike>
}

export interface SessionLogSource {
  readonly session: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly events: readonly SessionEvent[]
}

/**
 * Detect DSH 0.1.5-rc.2 upstream bug in dsh-session-query `readSession`:
 * It incorrectly verifies cold historical sessions using `Session.create`
 * (which expects `inheritedEventCount === log.length` for new seeds) instead
 * of `Session.fromRestore`.
 */
export function isSeededSessionConstructorError(err: unknown): boolean {
  const message = String((err as Error)?.message ?? err)
  return message.includes('seeded session constructor seed must equal its inherited prefix')
}

export async function readSessionFromPersistence(
  persistence: SessionPersistenceLike,
  sessionId: SessionId,
): Promise<SessionLogSource> {
  if (typeof persistence.open !== 'function') {
    throw new Error('persistence.open is not available')
  }
  const handle = await persistence.open(sessionId, 'read')
  try {
    const result = await handle.read(0)
    return {
      session: handle.header,
      inheritedEventCount: (Number(handle.inheritedEventCount) || 0) as SessionLogOffset,
      // Match query cold-read crash recovery without mutating persisted events.
      events: [...result.events, ...interruptedTurnClosers(result.events)],
    }
  } finally {
    try {
      await handle.close()
    } catch {}
  }
}

/**
 * Read a logical session log with graceful fallback to sessionPersistence
 * when the upstream sessionQuery.readSession suffers from the seeded constructor bug.
 */
export async function readSessionLog(
  sq: Pick<SessionQueryEngine, 'readSession'>,
  persistence: SessionPersistenceLike | undefined,
  sessionId: SessionId,
  persistedOnly = false,
): Promise<SessionLogSource> {
  // Only callers that have ruled out a live session may skip query replay.
  // Persistence supplies the validated log and lineage from the same handle.
  if (persistedOnly && typeof persistence?.open === 'function') {
    return readSessionFromPersistence(persistence, sessionId)
  }
  try {
    return await sq.readSession(sessionId)
  } catch (err) {
    if (persistence && typeof persistence.open === 'function' && isSeededSessionConstructorError(err)) {
      try {
        return await readSessionFromPersistence(persistence, sessionId)
      } catch (fallbackErr) {
        throw new Error(
          `${String((err as Error)?.message ?? err)} (persistence fallback failed: ${String((fallbackErr as Error)?.message ?? fallbackErr)})`,
        )
      }
    }
    throw err
  }
}
