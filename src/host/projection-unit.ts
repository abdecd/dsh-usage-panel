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
export const PROJECTION_STATE_VERSION = 5

export const usagePanelProjectionDefinition: ProjectionDefinition<
  typeof USAGE_PANEL_KEY,
  UsagePanelState
> = {
  key: USAGE_PANEL_KEY,
  schema: usagePanelSchema,
  init: initState,
  apply: applyEvent,
  view: (state) => state,
  stateVersion: PROJECTION_STATE_VERSION,
}
