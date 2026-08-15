// dsh-usage-panel · projection unit registered against ctx.sessionProjections.
// The unit is pure: init/apply/view with plain-JSON state and a stateVersion
// that invalidates persisted checkpoint rows when fold semantics change.
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { USAGE_PANEL_KEY, applyEvent, initState, usagePanelSchema, type UsagePanelState } from './projection.ts'

export const PROJECTION_STATE_VERSION = 1

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
