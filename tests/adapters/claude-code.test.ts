import { describe, expect, test } from 'bun:test';
import { enrichParentTools, normalizeClaudeRequest } from '../../src/adapters/claude-code';
import { CorrelationStore } from '../../src/adapters/correlation';
import { signRoleMarker } from '../../src/adapters/markers';
import { buildCatalog } from '../../src/core/catalog';
import type { CapabilityProfile } from '../../src/core/types';
import { FIXTURE_MODEL_ID, configFixture, snapshotFixture } from '../support/fixtures';

const SECRET = 'router-secret';

const profile: CapabilityProfile = { client: 'claude-code', version: '2.1.263', status: 'pending', correlation: false, correlationEntropy: 'pending', fork: false, adapterMarkerPosition: 'unknown', probes: {}, lifecycle: { 'next-turn': 'pending', resume: 'pending', compaction: 'pending', nested: 'pending', parallel: 'pending' } };

describe('enrichParentTools', () => {
  test('dodaje katalog tylko do narzędzi Agent, Task i Workflow, idempotentnie i bez modeli bez opisu', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture([FIXTURE_MODEL_ID, 'gateway/undescribed']));
    const body = { tools: [{ name: 'Agent', description: 'Launch agent', input_schema: { properties: { prompt: { description: 'Prompt' } } } }, { name: 'Bash', description: 'Run' }] };
    const once = enrichParentTools(body, catalog);
    const twice = enrichParentTools(once, catalog);
    const agentOnce = (once.tools as Array<{ description: string }>)[0];
    const agent = (twice.tools as Array<{ name: string; description: string; input_schema: { properties: { prompt: { description: string } } } }>)[0];
    expect(agent?.description.startsWith('Launch agent')).toBe(true);
    expect(agent?.description).toContain('fast');
    expect(agent?.description).not.toContain('gateway/undescribed');
    // D9: the parent must be shown the literal marker syntax it needs to use.
    expect(agent?.description).toContain('<subagent-router v="1" model="ALIAS"/>');
    // Idempotency is proven by the fixed header block appearing exactly once and by
    // description equality across a second enrichment call, not by counting every
    // occurrence of the tag prefix (which would forbid ever showing usage syntax).
    expect(agent?.description.split('<subagent-router catalog>').length).toBe(2);
    expect(agent?.description).toBe(agentOnce?.description);
    expect(agent?.input_schema.properties.prompt.description).toContain('pierwsz');
    expect((twice.tools as Array<{ name: string; description: string }>)[1]?.description).toBe('Run');
    expect((body.tools[0] as { description: string }).description).toBe('Launch agent');
  });
});

describe('normalizeClaudeRequest', () => {
  test('request bez billing metadata jest rodzicem nawet z nagłówkiem agenta', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const result = await normalizeClaudeRequest({ model: 'claude', messages: [] }, new Headers({ 'x-claude-code-agent-id': 'agent-1' }), { profile, catalog, roles: configFixture().roles });
    expect(result.input.scope).toBe('parent');
  });

  test('dziecko z markerem rodzica dostaje explicitIds po dokładnym ID i clientModel z requestu', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const body = {
      model: 'claude-haiku',
      system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }],
      messages: [{ role: 'user', content: '<subagent-router v="1" model="fast"/>\nZadanie' }],
    };
    const result = await normalizeClaudeRequest(body, new Headers({ 'x-claude-code-agent-id': 'agent-1' }), { profile, catalog, roles: configFixture().roles });
    expect(result.input).toMatchObject({ scope: 'child', explicitIds: [FIXTURE_MODEL_ID], clientModel: 'claude-haiku', ignoredMarkers: 0 });
    expect(result.agentId).toBe('agent-1');
    expect((result.forwardBody.messages as Array<{ content: string }>)[0]?.content).toBe('Zadanie');
  });

  test('nieznany alias markera nie może zostać odczytany jako przypadkowe raw upstream ID', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture([FIXTURE_MODEL_ID, 'ghost']));
    const body = { model: 'x', system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }], messages: [{ role: 'user', content: '<subagent-router v="1" model="ghost"/>' }] };
    const result = await normalizeClaudeRequest(body, new Headers(), { profile, catalog, roles: configFixture().roles });
    expect(result.input.explicitIds).toEqual([]);
    expect(result.input.explicitError).toBe('unknown-model');
  });

  test('nie usuwa zwykłego pierwszego bloku system, a parent enrichment jest jedyną zmianą rodzica', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const body = { model: 'claude-opus', system: [{ type: 'text', text: 'zwykły system' }], tools: [{ name: 'Bash', description: 'Run', input_schema: {} }], messages: [] };
    const result = await normalizeClaudeRequest(body, new Headers(), { profile, catalog, roles: configFixture().roles });
    expect(result.input.scope).toBe('parent');
    expect(result.forwardBody.system).toEqual(body.system);
    expect(result.forwardBody.tools).toEqual(body.tools);
  });

  test('zwykła dokumentacja wspominająca cc_is_subagent bez nagłówka billing nie staje się dzieckiem', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const body = {
      model: 'claude-opus',
      system: [{ type: 'text', text: 'Przykład konfiguracji billingu: {"cc_is_subagent": true} pojawia się w dokumentacji SDK.' }],
      messages: [],
    };
    const result = await normalizeClaudeRequest(body, new Headers({ 'x-claude-code-agent-id': 'agent-1' }), { profile, catalog, roles: configFixture().roles });
    expect(result.input.scope).toBe('parent');
    expect(result.forwardBody.system).toEqual(body.system);
  });

  test('rodzic z markerem w treści pierwszej wiadomości zachowuje go bez zmian, licząc tylko ignored', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const body = {
      model: 'claude-opus',
      messages: [{ role: 'user', content: [{ type: 'text', text: '<subagent-router v="1" model="fast"/>\nZbadaj repo.' }] }],
    };
    const result = await normalizeClaudeRequest(body, new Headers(), { profile, catalog, roles: configFixture().roles });
    expect(result.input.scope).toBe('parent');
    expect(result.input.explicitIds).toEqual([]);
    expect(result.input.markerError).toBeUndefined();
    expect(result.input.role).toBeUndefined();
    expect(result.input.ignoredMarkers).toBeGreaterThan(0);
    expect((result.forwardBody.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content[0]?.text).toBe(
      '<subagent-router v="1" model="fast"/>\nZbadaj repo.',
    );
    expect(result.forwardBody.model).toBe('claude-opus');
  });

  test('billing header otoczony innym tekstem lub liniami nie jest rozpoznanym blokiem, system zostaje bez zmian', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const body = {
      model: 'claude-opus',
      system: [{ type: 'text', text: 'Documentation:\nx-anthropic-billing-header: cc_is_subagent=true' }],
      messages: [],
    };
    const result = await normalizeClaudeRequest(body, new Headers({ 'x-claude-code-agent-id': 'agent-1' }), { profile, catalog, roles: configFixture().roles });
    expect(result.input.scope).toBe('parent');
    expect(result.forwardBody.system).toEqual(body.system);
  });

  test('wartość pola cc_is_subagent musi być dokładnie true, nie tylko prefiksem wartości', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const body = {
      model: 'claude-opus',
      system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true=extra' }],
      messages: [],
    };
    const result = await normalizeClaudeRequest(body, new Headers({ 'x-claude-code-agent-id': 'agent-1' }), { profile, catalog, roles: configFixture().roles });
    expect(result.input.scope).toBe('parent');
  });

  test('usuwa tylko rozpoznany blok billing dziecka, zostawiając zwykły system bez zmian', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const body = {
      model: 'claude-haiku',
      system: [
        { type: 'text', text: 'Jesteś pomocnym asystentem projektu.' },
        { type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' },
      ],
      messages: [{ role: 'user', content: 'Zadanie' }],
    };
    const result = await normalizeClaudeRequest(body, new Headers({ 'x-claude-code-agent-id': 'agent-1' }), { profile, catalog, roles: configFixture().roles });
    expect(result.input.scope).toBe('child');
    const forwardSystem = result.forwardBody.system as Array<{ text: string }>;
    expect(forwardSystem).toHaveLength(1);
    expect(forwardSystem[0]?.text).toBe('Jesteś pomocnym asystentem projektu.');
  });

  test('korelacja jest używana tylko przy profilu z correlation true', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const store = new CorrelationStore(() => 0, 1000);
    store.bind('agent-1', FIXTURE_MODEL_ID);
    const body = { model: 'x', system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' }], messages: [{ role: 'user', content: 'bez markera' }] };
    const off = await normalizeClaudeRequest(body, new Headers({ 'x-claude-code-agent-id': 'agent-1' }), { profile, catalog, roles: configFixture().roles, correlation: store });
    expect(off.input.correlatedId).toBeUndefined();
    const on = await normalizeClaudeRequest(body, new Headers({ 'x-claude-code-agent-id': 'agent-1' }), { profile: { ...profile, status: 'supported', correlation: true, correlationEntropy: 'passed', probes: { M1: 'passed' } }, catalog, roles: configFixture().roles, correlation: store });
    expect(on.input.correlatedId).toBe(FIXTURE_MODEL_ID);
  });

  test('adapter-system-marker-remains-ignored-until-m3', async () => {
    const catalog = buildCatalog(configFixture(), await snapshotFixture());
    const token = await signRoleMarker(SECRET, 'explorer', 'agent-1');
    const body = {
      model: 'claude-haiku',
      system: [
        { type: 'text', text: 'x-anthropic-billing-header: cc_is_subagent=true' },
        { type: 'text', text: `<subagent-router v="1" role="explorer" agent="agent-1" token="${token}"/>` },
      ],
      messages: [{ role: 'user', content: 'Zadanie' }],
    };
    const pendingM3Profile: CapabilityProfile = { ...profile, adapterMarkerPosition: 'system', probes: { M3: 'pending' } };
    const result = await normalizeClaudeRequest(body, new Headers({ 'x-claude-code-agent-id': 'agent-1' }), { secret: SECRET, profile: pendingM3Profile, catalog, roles: configFixture().roles });
    expect(result.input.roleDefaultId).toBeUndefined();
    expect(result.adapterRole).toBeUndefined();
    expect(result.input.ignoredMarkers).toBeGreaterThan(0);
  });
});
