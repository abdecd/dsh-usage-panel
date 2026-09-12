import type { SessionRecord, SessionQueryEngine } from '@deepseek-ai/dsh-session-query';
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
export interface PersistenceSnapshotLike {
    header: SessionRecord['header'];
    revision?: unknown;
}
export interface SessionHandleLike {
    readonly id?: SessionId;
    readonly header: SessionHeader;
    readonly inheritedEventCount?: number;
    read: (fromSeq?: number, toSeqExclusive?: number, options?: unknown) => Promise<{
        readonly events: readonly SessionEvent[];
    }>;
    close: () => Promise<void>;
}
export interface SessionPersistenceLike {
    /** DSH ≤ 0.1.2 exposed listSnapshots(); 0.1.5 exposes list(). */
    listSnapshots?: () => Promise<readonly PersistenceSnapshotLike[]>;
    list?: () => Promise<readonly PersistenceSnapshotLike[]>;
    open?: (id: SessionId, access: 'read' | 'write') => Promise<SessionHandleLike>;
}
export interface SessionLogSource {
    readonly session: SessionHeader;
    readonly inheritedEventCount: SessionLogOffset;
    readonly events: readonly SessionEvent[];
}
/**
 * Detect DSH 0.1.5-rc.2 upstream bug in dsh-session-query `readSession`:
 * It incorrectly verifies cold historical sessions using `Session.create`
 * (which expects `inheritedEventCount === log.length` for new seeds) instead
 * of `Session.fromRestore`.
 */
export declare function isSeededSessionConstructorError(err: unknown): boolean;
export declare function readSessionFromPersistence(persistence: SessionPersistenceLike, sessionId: SessionId): Promise<SessionLogSource>;
/**
 * Read a logical session log with graceful fallback to sessionPersistence
 * when the upstream sessionQuery.readSession suffers from the seeded constructor bug.
 */
export declare function readSessionLog(sq: Pick<SessionQueryEngine, 'readSession'>, persistence: SessionPersistenceLike | undefined, sessionId: SessionId): Promise<SessionLogSource>;
