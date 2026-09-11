import type { Context } from '@deepseek-ai/cordis';
import type { SessionRecord } from '@deepseek-ai/dsh-session-query';
export declare const name = "dsh-usage-panel";
export declare const inject: string[];
export interface PersistenceSnapshotLike {
    header: SessionRecord['header'];
    revision?: unknown;
}
export interface SessionPersistenceLike {
    /** DSH ≤ 0.1.2 exposed listSnapshots(); 0.1.5 exposes list(). */
    listSnapshots?: () => Promise<readonly PersistenceSnapshotLike[]>;
    list?: () => Promise<readonly PersistenceSnapshotLike[]>;
}
/** Read cheap per-session revisions without loading any event log. */
export declare function listPersistenceRevisions(persistence: SessionPersistenceLike | undefined, logFailure: (message: string) => void): Promise<Map<string, string>>;
export declare function apply(ctx: Context): void;
