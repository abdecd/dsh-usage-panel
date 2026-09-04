import { z } from 'zod';
import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain';
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import { type UsagePanelState } from './projection.ts';
export declare const usageLedgerRowSchema: z.ZodObject<{
    session: z.ZodObject<{
        id: z.ZodString;
        createdAt: z.ZodNumber;
        cwd: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    revision: z.ZodString;
    stateVersion: z.ZodNumber;
    state: z.ZodObject<{
        totals: z.ZodObject<{
            input: z.ZodNumber;
            output: z.ZodNumber;
            cacheRead: z.ZodNumber;
            cacheWrite: z.ZodNumber;
        }, z.core.$strip>;
        byModel: z.ZodRecord<z.ZodString, z.ZodObject<{
            input: z.ZodNumber;
            output: z.ZodNumber;
            cacheRead: z.ZodNumber;
            cacheWrite: z.ZodNumber;
        }, z.core.$strip>>;
        byDay: z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodObject<{
            input: z.ZodNumber;
            output: z.ZodNumber;
            cacheRead: z.ZodNumber;
            cacheWrite: z.ZodNumber;
        }, z.core.$strip>>>;
        byProvider: z.ZodRecord<z.ZodString, z.ZodObject<{
            input: z.ZodNumber;
            output: z.ZodNumber;
            cacheRead: z.ZodNumber;
            cacheWrite: z.ZodNumber;
        }, z.core.$strip>>;
        byDayProvider: z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodObject<{
            input: z.ZodNumber;
            output: z.ZodNumber;
            cacheRead: z.ZodNumber;
            cacheWrite: z.ZodNumber;
        }, z.core.$strip>>>;
        retries: z.ZodNumber;
        compactionTokens: z.ZodNumber;
        firstTime: z.ZodNullable<z.ZodNumber>;
        lastTime: z.ZodNullable<z.ZodNumber>;
        seedEnd: z.ZodNullable<z.ZodNumber>;
        currentModel: z.ZodString;
        currentProvider: z.ZodString;
        openStep: z.ZodNullable<z.ZodString>;
        steps: z.ZodRecord<z.ZodString, z.ZodObject<{
            buckets: z.ZodObject<{
                input: z.ZodNumber;
                output: z.ZodNumber;
                cacheRead: z.ZodNumber;
                cacheWrite: z.ZodNumber;
            }, z.core.$strip>;
            lastTime: z.ZodNumber;
            model: z.ZodString;
            provider: z.ZodString;
            mode: z.ZodEnum<{
                provisional: "provisional";
                authoritative: "authoritative";
            }>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    title: z.ZodNullable<z.ZodString>;
    depth: z.ZodNumber;
    eventsCounted: z.ZodNumber;
    lastSeq: z.ZodNumber;
    savedAt: z.ZodNumber;
}, z.core.$strip>;
export type UsageLedgerRow = z.infer<typeof usageLedgerRowSchema>;
/**
 * This is deliberately a plain DomainSpec literal. It keeps the storage
 * domain an optional runtime capability: when storage-domain is not mounted,
 * the plugin can still use its existing projection/scan paths without a
 * top-level runtime import of the optional host package.
 */
export declare const usageLedgerDomainSpec: {
    name: string;
    version: number;
    tables: {
        sessions: {
            valueSchema: z.ZodObject<{
                session: z.ZodObject<{
                    id: z.ZodString;
                    createdAt: z.ZodNumber;
                    cwd: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
                revision: z.ZodString;
                stateVersion: z.ZodNumber;
                state: z.ZodObject<{
                    totals: z.ZodObject<{
                        input: z.ZodNumber;
                        output: z.ZodNumber;
                        cacheRead: z.ZodNumber;
                        cacheWrite: z.ZodNumber;
                    }, z.core.$strip>;
                    byModel: z.ZodRecord<z.ZodString, z.ZodObject<{
                        input: z.ZodNumber;
                        output: z.ZodNumber;
                        cacheRead: z.ZodNumber;
                        cacheWrite: z.ZodNumber;
                    }, z.core.$strip>>;
                    byDay: z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodObject<{
                        input: z.ZodNumber;
                        output: z.ZodNumber;
                        cacheRead: z.ZodNumber;
                        cacheWrite: z.ZodNumber;
                    }, z.core.$strip>>>;
                    byProvider: z.ZodRecord<z.ZodString, z.ZodObject<{
                        input: z.ZodNumber;
                        output: z.ZodNumber;
                        cacheRead: z.ZodNumber;
                        cacheWrite: z.ZodNumber;
                    }, z.core.$strip>>;
                    byDayProvider: z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodObject<{
                        input: z.ZodNumber;
                        output: z.ZodNumber;
                        cacheRead: z.ZodNumber;
                        cacheWrite: z.ZodNumber;
                    }, z.core.$strip>>>;
                    retries: z.ZodNumber;
                    compactionTokens: z.ZodNumber;
                    firstTime: z.ZodNullable<z.ZodNumber>;
                    lastTime: z.ZodNullable<z.ZodNumber>;
                    seedEnd: z.ZodNullable<z.ZodNumber>;
                    currentModel: z.ZodString;
                    currentProvider: z.ZodString;
                    openStep: z.ZodNullable<z.ZodString>;
                    steps: z.ZodRecord<z.ZodString, z.ZodObject<{
                        buckets: z.ZodObject<{
                            input: z.ZodNumber;
                            output: z.ZodNumber;
                            cacheRead: z.ZodNumber;
                            cacheWrite: z.ZodNumber;
                        }, z.core.$strip>;
                        lastTime: z.ZodNumber;
                        model: z.ZodString;
                        provider: z.ZodString;
                        mode: z.ZodEnum<{
                            provisional: "provisional";
                            authoritative: "authoritative";
                        }>;
                    }, z.core.$strip>>;
                }, z.core.$strip>;
                title: z.ZodNullable<z.ZodString>;
                depth: z.ZodNumber;
                eventsCounted: z.ZodNumber;
                lastSeq: z.ZodNumber;
                savedAt: z.ZodNumber;
            }, z.core.$strip>;
        };
    };
};
interface LedgerTable {
    get(key: string): UsageLedgerRow | undefined;
    entries(): IterableIterator<[string, UsageLedgerRow]>;
    put(key: string, value: UsageLedgerRow): Promise<void>;
}
interface LedgerDomain extends Pick<Domain<typeof usageLedgerDomainSpec>, 'close'> {
    table(name: 'sessions'): LedgerTable;
}
export interface StorageDomainLike {
    open<S extends DomainSpec>(spec: S): Promise<LedgerDomain & Domain<S>>;
}
export declare function usageLedgerKey(header: SessionHeader): string;
export declare function sameLedgerLifecycle(row: UsageLedgerRow, header: SessionHeader): boolean;
/** Extract the latest durable title without making another log read. */
export declare function titleFromEvents(events: readonly SessionEvent[]): string | null;
/**
 * Count usage-bearing events using the same boundary and event vocabulary as
 * the fallback scan. This is diagnostic only; token totals come from state.
 */
export declare function countUsageEvents(events: readonly SessionEvent[], seedLength?: number): number;
export declare function makeUsageLedgerRow(input: {
    header: SessionHeader;
    revision: string;
    state: UsagePanelState;
    title?: string | null;
    depth?: number;
    eventsCounted?: number;
    lastSeq?: number;
    savedAt?: number;
}): UsageLedgerRow;
/**
 * An opened durable ledger. The per-key queue prevents a scan write and a live
 * event write from interleaving for the same session lifecycle.
 */
export declare class UsageLedger {
    private readonly domain;
    private readonly tails;
    constructor(domain: LedgerDomain);
    entries(): Array<[string, UsageLedgerRow]>;
    get(key: string): UsageLedgerRow | undefined;
    put(key: string, row: UsageLedgerRow): Promise<void>;
    close(): Promise<void>;
}
export declare function openUsageLedger(storageDomain: StorageDomainLike | undefined, logFailure: (message: string) => void): Promise<UsageLedger | null>;
export {};
