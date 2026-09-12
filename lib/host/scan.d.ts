import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query';
import type { Session, SessionId } from '@deepseek-ai/dsh-session';
import type { Overview } from '../shared/contract.ts';
import { type UsageLedger } from './history.ts';
import { type SessionPersistenceLike } from './session-read.ts';
export interface ScanFallbackDeps {
    sq: SessionQueryEngine;
    persistence?: SessionPersistenceLike;
    providerNames: Record<string, string>;
    logFailure: (message: string) => void;
    ledger?: UsageLedger | null;
    revisions?: ReadonlyMap<string, string>;
    liveSessionOf?: (id: SessionId) => Session | undefined;
}
export declare function scanFallback(deps: ScanFallbackDeps, now: number): Promise<Overview>;
