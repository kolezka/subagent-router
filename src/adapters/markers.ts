import type { CapabilityProfile } from '../core/types';

export type ParsedMarker = { kind: 'parent'; alias: string } | { kind: 'adapter'; role: string; agent: string; token: string };

export interface ExtractedMarkers {
  explicitAliases: string[];
  roleFromAdapter?: string;
  markerError?: 'invalid-marker' | 'conflicting-markers';
  ignored: number;
  stripped: Record<string, unknown>;
}

const MARKER_PREFIX = /^<subagent-router(?:\s|\/|>|$)/;
const MARKER_FULL = /^<subagent-router((?:\s+[a-z]+="[^"]*")+)\s*\/>$/;
const ATTR = /([a-z]+)="([^"]*)"/g;
const ALIAS_RE = /^[A-Za-z][A-Za-z0-9_-]{0,126}$/;

export function parseMarker(text: string): ParsedMarker | 'invalid' | null {
  const trimmed = text.trim();
  if (!MARKER_PREFIX.test(trimmed)) return null;

  const match = MARKER_FULL.exec(trimmed);
  if (!match) return 'invalid';

  const attrsPart = match[1] ?? '';
  const attrs: Record<string, string> = {};
  let seenKeys = 0;
  for (const m of attrsPart.matchAll(ATTR)) {
    const key = m[1] as string;
    const value = m[2] as string;
    if (key in attrs) return 'invalid';
    attrs[key] = value;
    seenKeys += 1;
  }
  if (seenKeys === 0) return 'invalid';
  if (attrs.v !== '1') return 'invalid';

  const keys = Object.keys(attrs).sort().join(',');
  if (keys === 'model,v') {
    const alias = attrs.model as string;
    if (!ALIAS_RE.test(alias)) return 'invalid';
    return { kind: 'parent', alias };
  }
  if (keys === 'agent,role,token,v') {
    return { kind: 'adapter', role: attrs.role as string, agent: attrs.agent as string, token: attrs.token as string };
  }
  return 'invalid';
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function markerMessage(role: string, agent: string): string {
  return `v=1|role=${role}|agent=${agent}`;
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export async function signRoleMarker(secret: string, role: string, agent: string): Promise<string> {
  const key = await hmacKey(secret, 'sign');
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(markerMessage(role, agent)));
  return toHex(signature);
}

async function verifyRoleToken(secret: string, role: string, agent: string, token: string): Promise<boolean> {
  const tokenBytes = fromHex(token);
  if (!tokenBytes) return false;
  const key = await hmacKey(secret, 'verify');
  return crypto.subtle.verify('HMAC', key, tokenBytes, new TextEncoder().encode(markerMessage(role, agent)));
}

function isTextBlock(block: unknown): block is { type: 'text'; text: string } {
  return typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string';
}

function firstLine(text: string): string {
  const idx = text.indexOf('\n');
  return idx === -1 ? text : text.slice(0, idx);
}

function stripFirstLine(text: string): string {
  const idx = text.indexOf('\n');
  return idx === -1 ? '' : text.slice(idx + 1);
}

function collectSystemLines(system: unknown): string[] {
  const lines: string[] = [];
  if (!Array.isArray(system)) return lines;
  for (const block of system) {
    if (isTextBlock(block)) {
      for (const line of block.text.split('\n')) lines.push(line);
    }
  }
  return lines;
}

function collectMessageLines(messages: unknown): string[] {
  const lines: string[] = [];
  if (!Array.isArray(messages)) return lines;
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') {
      for (const line of content.split('\n')) lines.push(line);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (isTextBlock(block)) {
          for (const line of block.text.split('\n')) lines.push(line);
        } else if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool_result') {
          const toolContent = (block as { content?: unknown }).content;
          if (typeof toolContent === 'string') {
            for (const line of toolContent.split('\n')) lines.push(line);
          }
        }
      }
    }
  }
  return lines;
}

export function countMarkerLines(body: Record<string, unknown>): number {
  const lines = [...collectSystemLines(body.system), ...collectMessageLines(body.messages)];
  return lines.filter((line) => parseMarker(line) !== null).length;
}

interface SystemAdapterHit {
  role: string;
  blockIndex: number;
  lineIndex: number;
}

// Only scans when the measured profile confirms markers are read from `system`:
// 'unknown' and 'b2' must authorize neither body position, and 'first-user' is a
// different channel entirely (see classifyPositionTwo).
async function scanSystemAdapterMarkers(
  system: unknown,
  agentId: string | undefined,
  secret: string | undefined,
  adapterMarkerPosition: CapabilityProfile['adapterMarkerPosition'],
): Promise<SystemAdapterHit[]> {
  if (adapterMarkerPosition !== 'system') return [];
  if (!Array.isArray(system) || !secret) return [];
  const hits: SystemAdapterHit[] = [];
  for (let i = 0; i < system.length; i += 1) {
    const block = system[i];
    if (!isTextBlock(block)) continue;
    const lines = block.text.split('\n');
    for (let li = 0; li < lines.length; li += 1) {
      const line = lines[li] as string;
      const parsed = parseMarker(line);
      if (parsed === null || parsed === 'invalid') continue;
      if (parsed.kind !== 'adapter') continue;
      if (agentId === undefined || parsed.agent !== agentId) continue;
      const ok = await verifyRoleToken(secret, parsed.role, parsed.agent, parsed.token);
      if (!ok) continue;
      hits.push({ role: parsed.role, blockIndex: i, lineIndex: li });
    }
  }
  return hits;
}

function firstAuthorizedUserMessage(messages: unknown): { message: Record<string, unknown>; index: number } | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (typeof message !== 'object' || message === null) continue;
    const m = message as Record<string, unknown>;
    if (m.role !== 'user') continue;
    const content = m.content;
    if (Array.isArray(content)) {
      const hasToolResult = content.some((b) => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'tool_result');
      if (hasToolResult) return undefined;
    }
    return { message: m, index: i };
  }
  return undefined;
}

interface PositionTwoResult {
  kind: 'parent' | 'adapter' | 'invalid' | 'unauthorized';
  alias?: string;
  role?: string;
}

// 'invalid' is reserved for genuinely malformed marker grammar (sets markerError).
// A syntactically valid adapter marker that the measured profile/agent/signature
// does not authorize at this position is 'unauthorized': it must be silently
// uncounted (folds into `ignored`), symmetric with the system-position scan above.
async function classifyPositionTwo(
  line: string,
  agentId: string | undefined,
  secret: string | undefined,
  adapterMarkerPosition: CapabilityProfile['adapterMarkerPosition'],
): Promise<PositionTwoResult | undefined> {
  const parsed = parseMarker(line);
  if (parsed === null) return undefined;
  if (parsed === 'invalid') return { kind: 'invalid' };
  if (parsed.kind === 'parent') return { kind: 'parent', alias: parsed.alias };

  if (adapterMarkerPosition !== 'first-user') return { kind: 'unauthorized' };
  if (!secret || agentId === undefined || parsed.agent !== agentId) return { kind: 'unauthorized' };
  const ok = await verifyRoleToken(secret, parsed.role, parsed.agent, parsed.token);
  if (!ok) return { kind: 'unauthorized' };
  return { kind: 'adapter', role: parsed.role };
}

export async function extractMarkers(
  body: Record<string, unknown>,
  agentId: string | undefined,
  secret: string | undefined,
  adapterMarkerPosition: CapabilityProfile['adapterMarkerPosition'] = 'system',
): Promise<ExtractedMarkers> {
  const stripped = structuredClone(body);
  const totalMarkerLines = countMarkerLines(body);

  const explicitAliases: string[] = [];
  let roleFromAdapter: string | undefined;
  let markerError: 'invalid-marker' | 'conflicting-markers' | undefined;
  let accepted = 0;

  const systemHits = await scanSystemAdapterMarkers(body.system, agentId, secret, adapterMarkerPosition);
  if (systemHits.length > 0) {
    const distinctRoles = new Set(systemHits.map((hit) => hit.role));
    if (distinctRoles.size > 1) {
      markerError = 'conflicting-markers';
    } else {
      roleFromAdapter = systemHits[0]?.role;
    }
    accepted += systemHits.length;

    const linesByBlock = new Map<number, number[]>();
    for (const hit of systemHits) {
      const existing = linesByBlock.get(hit.blockIndex) ?? [];
      existing.push(hit.lineIndex);
      linesByBlock.set(hit.blockIndex, existing);
    }
    const strippedSystem = stripped.system;
    if (Array.isArray(strippedSystem)) {
      for (const [blockIndex, lineIndices] of linesByBlock) {
        const target = strippedSystem[blockIndex];
        if (!isTextBlock(target)) continue;
        const lines = target.text.split('\n');
        for (const lineIndex of [...lineIndices].sort((a, b) => b - a)) {
          lines.splice(lineIndex, 1);
        }
        (target as { text: string }).text = lines.join('\n');
      }
    }
  }

  const userHit = firstAuthorizedUserMessage(body.messages);
  if (userHit) {
    const content = userHit.message.content;
    let text: string | undefined;
    let updateStrippedText: ((newText: string) => void) | undefined;

    if (typeof content === 'string') {
      text = content;
      updateStrippedText = (newText: string) => {
        const strippedMessages = stripped.messages;
        if (Array.isArray(strippedMessages)) {
          const target = strippedMessages[userHit.index];
          if (typeof target === 'object' && target !== null) {
            (target as Record<string, unknown>).content = newText;
          }
        }
      };
    } else if (Array.isArray(content)) {
      // Per the brief: first line of the first TEXT block, not literally content[0]:
      // a leading image (or other non-text) block must not hide a marker in the text
      // block that actually comes first among text blocks.
      const firstTextIndex = content.findIndex((block) => isTextBlock(block));
      const first = firstTextIndex === -1 ? undefined : content[firstTextIndex];
      if (isTextBlock(first)) {
        text = first.text;
        updateStrippedText = (newText: string) => {
          const strippedMessages = stripped.messages;
          if (Array.isArray(strippedMessages)) {
            const target = strippedMessages[userHit.index];
            if (typeof target === 'object' && target !== null) {
              const targetContent = (target as Record<string, unknown>).content;
              if (Array.isArray(targetContent)) {
                const targetFirst = targetContent[firstTextIndex];
                if (isTextBlock(targetFirst)) {
                  (targetFirst as { text: string }).text = newText;
                }
              }
            }
          }
        };
      }
    }

    if (text !== undefined && updateStrippedText) {
      const line = firstLine(text);
      const classification = await classifyPositionTwo(line, agentId, secret, adapterMarkerPosition);
      if (classification) {
        if (classification.kind === 'parent' && classification.alias !== undefined) {
          explicitAliases.push(classification.alias);
          accepted += 1;
          updateStrippedText(stripFirstLine(text));
        } else if (classification.kind === 'adapter' && classification.role !== undefined) {
          if (roleFromAdapter === undefined) {
            roleFromAdapter = classification.role;
            accepted += 1;
            updateStrippedText(stripFirstLine(text));
          }
        } else if (classification.kind === 'invalid') {
          if (markerError === undefined) markerError = 'invalid-marker';
        }
      }
    }
  }

  const ignored = Math.max(0, totalMarkerLines - accepted);

  return {
    explicitAliases,
    ...(roleFromAdapter !== undefined ? { roleFromAdapter } : {}),
    ...(markerError !== undefined ? { markerError } : {}),
    ignored,
    stripped,
  };
}
