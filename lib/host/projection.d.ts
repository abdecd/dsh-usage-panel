import { z } from 'zod';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
declare const bucketSchema: z.ZodObject<{
    input: z.ZodNumber;
    output: z.ZodNumber;
    cacheRead: z.ZodNumber;
    cacheWrite: z.ZodNumber;
}, z.core.$strip>;
declare const stepSchema: z.ZodObject<{
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
}, z.core.$strip>;
export declare const usagePanelSchema: z.ZodObject<{
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
export type Buckets = z.infer<typeof bucketSchema>;
export type StepState = z.infer<typeof stepSchema>;
export type UsagePanelState = z.infer<typeof usagePanelSchema>;
export declare const USAGE_PANEL_KEY = "usagePanel";
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionMap {
        usagePanel: UsagePanelState;
    }
    interface SessionProjectionStateMap {
        usagePanel: UsagePanelState;
    }
}
export declare function initState(seedEnd?: number | null): UsagePanelState;
/**
 * Pure transition: previous state + one committed session event → next state.
 * Returns the SAME reference for unrelated events (zero downstream work, per
 * the registry contract). State is plain JSON (persisted-cache precondition).
 */
export declare function applyEvent(state: UsagePanelState, event: SessionEvent): UsagePanelState;
/**
 * The seed boundary (first countable seq) for a stored log. `seedLength` —
 * the DURABLE fork-lineage value from the session header — is authoritative
 * when explicitly provided (even if 0): a forked session's prefix is its
 * parent's history and stays excluded across later lifecycle re-seed markers,
 * while an unforked session (seedLength === 0) counts all of its own history.
 * When `seedLength` is omitted, falls back to the FIRST session/end-seed marker,
 * or seq 0 if no marker is present.
 */
export declare function seedBoundaryOf(events: readonly SessionEvent[], seedLength?: number): number;
/**
 * Fold a full event list from init (cold read path / tests). Two-pass: the
 * seed boundary (seedBoundaryOf) is located first and preset — a single
 * forward pass would count fork-seed events that precede it.
 */
export declare function foldEvents(events: readonly SessionEvent[], seedLength?: number): UsagePanelState;
/** Sum a session's day buckets whose key >= cutoffKey (recent-30d window). */
export declare function recentOf(value: UsagePanelState, cutoffKey: string): {
    totals: Buckets;
    byModel: Record<string, Buckets>;
};
/** Sum a session's per-day provider buckets whose key >= cutoffKey (window). */
export declare function providerWindowOf(value: UsagePanelState, cutoffKey: string): Record<string, Buckets>;
export {};
