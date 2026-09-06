// dsh-usage-panel · projection unit registered against ctx.sessionProjections.
// The unit is pure: init/apply/view with plain-JSON state and a stateVersion
// that invalidates persisted checkpoint rows when fold semantics change.
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { USAGE_PANEL_KEY, applyEvent, initState, usagePanelSchema, type UsagePanelState } from './projection.ts'

// v2: added `byDayProvider` (per-day per-provider buckets) so provider totals
// can be rolled up to a window; persisted checkpoints re-fold on this bump.
// v3: seed-boundary semantics fixed — the FIRST session/end-seed marker (or
// the header seedLength) is the fork boundary; LATER markers are lifecycle
// re-seeds (dsh appends one per restart) and must not move it.
// v4: fork-lineage boundary is authoritative via header.seedLength; fresh
// sessions default to seq 0 so unseeded conversations count immediately.
// v5: recover legacy assistant/message routes from message provenance.
// v6: rc.1 initializes the fold from the exact inherited-event count.
export const PROJECTION_STATE_VERSION = 6

type UsageProjectionDefinition = ProjectionDefinition<typeof USAGE_PANEL_KEY, UsagePanelState>
export const usagePanelProjectionDefinition: UsageProjectionDefinition & {
  wire: NonNullable<UsageProjectionDefinition['wire']>
} = {
  key: USAGE_PANEL_KEY,
  stateSchema: usagePanelSchema,
  init: (_header, inheritedEventCount) => initState(inheritedEventCount),
  apply: applyEvent,
  wire: { viewSchema: usagePanelSchema, view: (state) => state },
  stateVersion: PROJECTION_STATE_VERSION,
}
