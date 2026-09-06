import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection';
import { USAGE_PANEL_KEY, type UsagePanelState } from './projection.ts';
export declare const PROJECTION_STATE_VERSION = 6;
type UsageProjectionDefinition = ProjectionDefinition<typeof USAGE_PANEL_KEY, UsagePanelState>;
export declare const usagePanelProjectionDefinition: UsageProjectionDefinition & {
    wire: NonNullable<UsageProjectionDefinition['wire']>;
};
export {};
