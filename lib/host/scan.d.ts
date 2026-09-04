import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query';
import type { Session, SessionId } from '@deepseek-ai/dsh-session';
import type { Overview } from '../shared/contract.ts';
import { type UsageLedger } from './history.ts';
export interface ScanFallbackDeps {
    sq: SessionQueryEngine;
    providerNames: Record<string, string>;
    logFailure: (message: string) => void;
    ledger?: UsageLedger | null;
    revisions?: ReadonlyMap<string, string>;
    liveSessionOf?: (id: SessionId) => Session | undefined;
}
export declare function scanFallback(deps: ScanFallbackDeps, now: number): Promise<Overview>;
