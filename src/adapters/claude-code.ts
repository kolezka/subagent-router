import { countMarkerLines, extractMarkers } from './markers';
import type { CorrelationStore } from './correlation';
import type { CapabilityProfile, EffectiveCatalog, OperatorConfig, ParentPromptPosition, RouteInput } from '../core/types';

const CATALOG_BLOCK_HEADER = '<subagent-router catalog>';
const ENRICHED_TOOL_NAMES = new Set(['agent', 'task', 'workflow']);
// Fixed sentence used both as the appended note and as its own idempotency check:
// a real fixed string, not a generic substring that could false-positive against
// unrelated pre-existing text in the field.
const PROMPT_NOTE_SENTENCE =
  'Aby wybrać model, dodaj w pierwszej linii treści tego pola znacznik: <subagent-router v="1" model="ALIAS"/> (zastąp ALIAS wybranym aliasem modelu).';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function enrichParentTools(body: Record<string, unknown>, catalog: EffectiveCatalog): Record<string, unknown> {
  const clone = structuredClone(body);
  const tools = clone.tools;
  if (!Array.isArray(tools)) return clone;

  const catalogLines: string[] = [];
  for (const model of catalog.byAlias.values()) {
    if (model.enabled && model.description !== undefined) {
      catalogLines.push(`- ${model.alias}: ${model.description}`);
    }
  }

  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const name = typeof tool.name === 'string' ? tool.name.toLowerCase() : '';
    if (!ENRICHED_TOOL_NAMES.has(name)) continue;

    if (typeof tool.description === 'string' && !tool.description.includes(CATALOG_BLOCK_HEADER) && catalogLines.length > 0) {
      const block = [
        CATALOG_BLOCK_HEADER,
        'Dostępne modele (alias: opis):',
        ...catalogLines,
        'Aby wybrać model dla tego zlecenia, dodaj w pierwszej linii treści zadania znacznik: <subagent-router v="1" model="ALIAS"/> (zastąp ALIAS wybranym aliasem modelu).',
      ].join('\n');
      tool.description = `${tool.description}\n\n${block}`;
    }

    const inputSchema = tool.input_schema;
    if (isRecord(inputSchema)) {
      const properties = inputSchema.properties;
      if (isRecord(properties)) {
        const prompt = properties.prompt;
        if (isRecord(prompt) && typeof prompt.description === 'string' && !prompt.description.includes(PROMPT_NOTE_SENTENCE)) {
          prompt.description = `${prompt.description}\n\n${PROMPT_NOTE_SENTENCE}`;
        }
      }
    }
  }

  return clone;
}

export interface NormalizedClaudeRequest {
  input: RouteInput;
  forwardBody: Record<string, unknown>;
  agentId?: string;
  adapterRole?: string;
}

// Provenance must come from a genuinely recognized billing header BLOCK, never a bare
// substring or line anywhere in a larger system text (ordinary docs quoting the header,
// or a header line buried among other prose, would otherwise be misread as child
// origin). No `m` flag: `^`/`$` anchor the whole (already-trimmed) string, so the
// block's entire content must be nothing but the technical header line, not that line
// plus extra text or extra newlines.
const BILLING_HEADER_RE = /^x-anthropic-billing-header[ \t]*:[ \t]*(.+)$/i;

function billingValueSaysSubagent(value: string): boolean {
  const trimmed = value.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed)) return parsed.cc_is_subagent === true;
  } catch {
    // Not JSON: fall through to key=value form below.
  }
  for (const part of trimmed.split(/[;,]/)) {
    const eqIndex = part.indexOf('=');
    if (eqIndex === -1) continue;
    const key = part.slice(0, eqIndex).trim();
    // Split only on the first '=' and require the exact remaining value to be
    // "true": `part.split('=')` would let "cc_is_subagent=true=extra" pass by
    // silently truncating to its second segment.
    const val = part.slice(eqIndex + 1).trim();
    if (key === 'cc_is_subagent') return val === 'true';
  }
  return false;
}

function isBillingMetadataText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.includes('\n')) return false;
  const match = BILLING_HEADER_RE.exec(trimmed);
  const value = match?.[1];
  return value !== undefined && billingValueSaysSubagent(value);
}

function findBillingBlockIndex(system: unknown): number | undefined {
  if (!Array.isArray(system)) return undefined;
  for (let i = 0; i < system.length; i += 1) {
    const block = system[i];
    if (isRecord(block) && typeof block.text === 'string' && isBillingMetadataText(block.text)) {
      return i;
    }
  }
  return undefined;
}

// The native client identifies its exact version in the user-agent it sends, e.g.
// `claude-cli/2.1.266 (external, sdk-cli)`. Only the version token is read, bounded on both
// sides so a longer version string never prefix-matches a shorter profile version.
const CLAUDE_CLI_USER_AGENT_RE = /^claude-cli\/(\d+\.\d+\.\d+)(?:\s|$)/;

export function observedClaudeClientVersion(headers: Headers): string | undefined {
  const userAgent = headers.get('user-agent');
  if (userAgent === null) return undefined;
  return CLAUDE_CLI_USER_AGENT_RE.exec(userAgent)?.[1];
}

// createHandler freezes one profile per generation and never reloads it per request, so an
// alternate layout, each measured on one exact client version, must additionally be bound to the
// version this request actually claims. Anything else falls back to the legacy first-text slot.
// The profile's declared layout is returned as-is, never widened: a v1 profile opens only the
// two-block slot and a v2 profile only the three-block one.
const ALTERNATE_PARENT_PROMPT_POSITIONS: readonly ParentPromptPosition[] = ['after-native-context-v1', 'after-native-context-v2'];

function effectiveParentPromptPosition(profile: CapabilityProfile, headers: Headers): ParentPromptPosition {
  const declared = profile.parentPromptPosition;
  if (declared === undefined || !ALTERNATE_PARENT_PROMPT_POSITIONS.includes(declared)) return 'first-text';
  if (profile.probes['M3-A'] !== 'passed') return 'first-text';
  const observedVersion = observedClaudeClientVersion(headers);
  if (observedVersion === undefined || observedVersion !== profile.version) return 'first-text';
  return declared;
}

export async function normalizeClaudeRequest(
  body: Record<string, unknown>,
  headers: Headers,
  options: {
    secret?: string;
    profile: CapabilityProfile;
    correlation?: CorrelationStore;
    catalog: EffectiveCatalog;
    roles: OperatorConfig['roles'];
  },
): Promise<NormalizedClaudeRequest> {
  const agentId = headers.get('x-claude-code-agent-id') ?? undefined;
  const scope: 'parent' | 'child' = findBillingBlockIndex(body.system) !== undefined ? 'child' : 'parent';

  if (scope === 'parent') {
    // No confirmed child origin: never strip or activate markers. The parent keeps
    // its system/messages/model exactly as sent; marker-shaped lines are only
    // counted (ignoredMarkers), never parsed for routing effect.
    const clientModel = typeof body.model === 'string' ? body.model : undefined;
    const input: RouteInput = {
      client: 'claude-code',
      scope,
      explicitIds: [],
      freshDelegation: false,
      ignoredMarkers: countMarkerLines(body),
      ...(clientModel !== undefined ? { clientModel } : {}),
    };
    return {
      input,
      forwardBody: structuredClone(body),
      ...(agentId !== undefined ? { agentId } : {}),
    };
  }

  const markers = await extractMarkers(
    body,
    agentId,
    options.secret,
    options.profile.adapterMarkerPosition,
    effectiveParentPromptPosition(options.profile, headers),
  );

  let explicitIds: string[] = [];
  let explicitError: 'unknown-model' | undefined;
  const firstAlias = markers.explicitAliases[0];
  if (firstAlias !== undefined) {
    const resolved = options.catalog.byAlias.get(firstAlias);
    if (resolved !== undefined) {
      explicitIds = [resolved.id];
    } else {
      explicitError = 'unknown-model';
    }
  }

  let adapterRole: string | undefined;
  let roleDefaultId: string | undefined;
  let ignoredMarkers = markers.ignored;
  if (markers.roleFromAdapter !== undefined) {
    if (options.profile.probes.M3 === 'passed') {
      adapterRole = markers.roleFromAdapter;
      roleDefaultId = options.roles[`claude-code:${adapterRole}`]?.routeOverride;
    } else {
      ignoredMarkers += 1;
    }
  }

  let correlatedId: string | undefined;
  if (
    options.correlation !== undefined &&
    options.profile.correlation === true &&
    options.profile.probes.M1 === 'passed' &&
    options.profile.correlationEntropy === 'passed' &&
    agentId !== undefined
  ) {
    correlatedId = options.correlation.get(agentId);
  }

  const forwardBody = markers.stripped;
  const forwardBillingIndex = findBillingBlockIndex(forwardBody.system);
  if (forwardBillingIndex !== undefined && Array.isArray(forwardBody.system)) {
    forwardBody.system.splice(forwardBillingIndex, 1);
  }

  const clientModel = typeof body.model === 'string' ? body.model : undefined;

  const input: RouteInput = {
    client: 'claude-code',
    scope,
    explicitIds,
    freshDelegation: false,
    ignoredMarkers,
    ...(adapterRole !== undefined ? { role: adapterRole } : {}),
    ...(roleDefaultId !== undefined ? { roleDefaultId } : {}),
    ...(correlatedId !== undefined ? { correlatedId } : {}),
    ...(markers.markerError !== undefined ? { markerError: markers.markerError } : {}),
    ...(explicitError !== undefined ? { explicitError } : {}),
    ...(clientModel !== undefined ? { clientModel } : {}),
  };

  return {
    input,
    forwardBody,
    ...(agentId !== undefined ? { agentId } : {}),
    ...(adapterRole !== undefined ? { adapterRole } : {}),
  };
}
