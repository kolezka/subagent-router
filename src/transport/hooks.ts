import { assertCapability } from '../adapters/capabilities';
import { signRoleMarker } from '../adapters/markers';
import type { CapabilityProfile, OperatorConfig } from '../core/types';

export interface CreateClaudeStartOutputInput {
  agent_id: string;
  agent_type: string;
}

export interface CreateClaudeStartOutputOptions {
  secret: string;
  roles: OperatorConfig['roles'];
  profile: CapabilityProfile;
  fresh: boolean;
}

/**
 * Builds the SubagentStart hook output for Claude Code. Only emits an adapter role marker
 * (channel B) when every one of these holds: the role has a configured route, the caller already
 * proved a fresh one-shot delegation receipt was registered (`fresh`), M10-freshness is measured
 * passed, and M3 is measured passed for a body position (system or first-user) the adapter can
 * actually place text in. Channel B2 carries no in-body marker at all, so a profile whose position
 * excludes system/first-user (e.g. 'b2' or 'unknown') correctly yields no marker here; B2 role
 * delivery happens purely through the freshness receipt on the handler side.
 */
export async function createClaudeStartOutput(
  input: CreateClaudeStartOutputInput,
  options: CreateClaudeStartOutputOptions,
): Promise<Record<string, unknown>> {
  const role = input.agent_type;
  if (options.roles[`claude-code:${role}`] === undefined) return {};
  if (!options.fresh) return {};

  // assertCapability closes the client/status/lifecycle/M10 gate shared with every other
  // claude-marker use; the M10-freshness/M3/position checks below are Task 9 specific
  // (per-request freshness-receipt and body-position concerns assertCapability never receives).
  try {
    assertCapability(options.profile, 'claude-marker', { freshDelegation: options.fresh });
  } catch {
    return {};
  }

  if (options.profile.probes['M10-freshness'] !== 'passed') return {};
  if (options.profile.probes.M3 !== 'passed') return {};

  const position = options.profile.adapterMarkerPosition;
  if (position !== 'system' && position !== 'first-user') return {};

  const token = await signRoleMarker(options.secret, role, input.agent_id);
  const markerText = `<subagent-router v="1" role="${role}" agent="${input.agent_id}" token="${token}"/>`;

  return {
    hookSpecificOutput: {
      hookEventName: 'SubagentStart',
      additionalContext: markerText,
    },
  };
}
