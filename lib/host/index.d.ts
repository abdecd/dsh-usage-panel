import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-usage-panel";
export declare const inject: string[];
import { type SessionPersistenceLike } from './session-read.ts';
export type { PersistenceSnapshotLike, SessionPersistenceLike, SessionHandleLike, SessionLogSource, } from './session-read.ts';
/** Read cheap per-session revisions without loading any event log. */
export declare function listPersistenceRevisions(persistence: SessionPersistenceLike | undefined, logFailure: (message: string) => void): Promise<Map<string, string>>;
export declare function apply(ctx: Context): void;
