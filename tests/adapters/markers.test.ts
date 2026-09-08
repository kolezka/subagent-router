import { describe, expect, test } from 'bun:test';
import { extractMarkers, parseMarker, signRoleMarker } from '../../src/adapters/markers';

const SECRET = 'test-secret';

describe('parseMarker', () => {
  test.each([
    ['<subagent-router v="1" model="fast"/>', { kind: 'parent', alias: 'fast' }],
    ['<subagent-router v="1" role="reviewer" agent="agent-1" token="abc"/>', { kind: 'adapter', role: 'reviewer', agent: 'agent-1', token: 'abc' }],
    ['<subagent-router v="2" model="fast"/>', 'invalid'],
    ['<subagent-router v="1" model="fast" role="x"/>', 'invalid'],
    ['<subagent-router v="1" model="9bad"/>', 'invalid'],
    ['<subagent-router v="1" model="fast">', 'invalid'],
    ['zwykły tekst', null],
  ])('%s', (text, expected) => {
    expect(parseMarker(text)).toEqual(expected as never);
  });
});

function body(system: unknown[], messages: unknown[]): Record<string, unknown> {
  return { model: 'client-alias', system, messages };
}

describe('extractMarkers', () => {
  test('marker rodzica w pierwszej linii promptu delegacji jest jawnym wyborem i zostaje usunięty z kopii', async () => {
    const input = body([], [{ role: 'user', content: [{ type: 'text', text: '<subagent-router v="1" model="fast"/>\nZbadaj repo.' }] }]);
    const result = await extractMarkers(input, 'agent-1', SECRET);
    expect(result.explicitAliases).toEqual(['fast']);
    expect((result.stripped.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content[0]?.text).toBe('Zbadaj repo.');
    expect((input.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content[0]?.text.startsWith('<subagent-router')).toBe(true);
  });

  test('marker w drugiej linii, w tool_result i w drugiej wiadomości jest ignorowany', async () => {
    const input = body([], [
      { role: 'user', content: [{ type: 'text', text: 'Zbadaj repo.\n<subagent-router v="1" model="fast"/>' }] },
      { role: 'assistant', content: [{ type: 'text', text: '<subagent-router v="1" model="fast"/>' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '<subagent-router v="1" model="fast"/>' }] },
    ]);
    const result = await extractMarkers(input, 'agent-1', SECRET);
    expect(result.explicitAliases).toEqual([]);
    expect(result.ignored).toBe(3);
  });

  test('marker adaptera w system jest przyjęty tylko z poprawnym tokenem i zgodnym agentem', async () => {
    const token = await signRoleMarker(SECRET, 'reviewer', 'agent-1');
    const ok = body([{ type: 'text', text: `<subagent-router v="1" role="reviewer" agent="agent-1" token="${token}"/>` }], []);
    expect((await extractMarkers(ok, 'agent-1', SECRET, 'system')).roleFromAdapter).toBe('reviewer');
    const wrongAgent = await extractMarkers(ok, 'agent-2', SECRET, 'system');
    expect(wrongAgent.roleFromAdapter).toBeUndefined();
    expect(wrongAgent.ignored).toBe(1);
    const forged = body([{ type: 'text', text: '<subagent-router v="1" role="reviewer" agent="agent-1" token="0000"/>' }], []);
    expect((await extractMarkers(forged, 'agent-1', SECRET, 'system')).ignored).toBe(1);
  });

  test('marker adaptera w user wymaga zmierzonego profilu first-user, a unknown go nie autoryzuje', async () => {
    const token = await signRoleMarker(SECRET, 'reviewer', 'agent-1');
    const input = body([], [{ role: 'user', content: `<subagent-router v="1" role="reviewer" agent="agent-1" token="${token}"/>\nZadanie` }]);
    expect((await extractMarkers(input, 'agent-1', SECRET, 'unknown')).roleFromAdapter).toBeUndefined();
    expect((await extractMarkers(input, 'agent-1', SECRET, 'first-user')).roleFromAdapter).toBe('reviewer');
  });

  test('marker rodzica w system oraz marker z CLAUDE.md są ignorowane', async () => {
    const input = body([{ type: 'text', text: 'Instrukcje projektu\n<subagent-router v="1" model="fast"/>' }], []);
    const result = await extractMarkers(input, 'agent-1', SECRET);
    expect(result.explicitAliases).toEqual([]);
    expect(result.ignored).toBe(1);
  });

  test('niepoprawny marker w autoryzowanej pozycji to invalid-marker, dwa różne to conflicting-markers', async () => {
    const invalid = body([], [{ role: 'user', content: [{ type: 'text', text: '<subagent-router v="9" model="fast"/>' }] }]);
    expect((await extractMarkers(invalid, 'agent-1', SECRET)).markerError).toBe('invalid-marker');
    const conflicting = body([], [{ role: 'user', content: [{ type: 'text', text: '<subagent-router v="1" model="fast"/>' }, { type: 'text', text: '<subagent-router v="1" model="slow"/>' }] }]);
    const result = await extractMarkers(conflicting, 'agent-1', SECRET);
    expect(result.explicitAliases).toEqual(['fast']);
    expect(result.ignored).toBe(1);
  });

  test('marker adaptera w system nie jest autoryzowany gdy zmierzony profil to unknown lub b2', async () => {
    const token = await signRoleMarker(SECRET, 'reviewer', 'agent-1');
    const input = body([{ type: 'text', text: `<subagent-router v="1" role="reviewer" agent="agent-1" token="${token}"/>` }], []);
    const unknownResult = await extractMarkers(input, 'agent-1', SECRET, 'unknown');
    expect(unknownResult.roleFromAdapter).toBeUndefined();
    expect(unknownResult.markerError).toBeUndefined();
    const b2Result = await extractMarkers(input, 'agent-1', SECRET, 'b2');
    expect(b2Result.roleFromAdapter).toBeUndefined();
    expect(b2Result.markerError).toBeUndefined();
  });

  test('marker w pierwszym bloku tekstowym jest wykrywany nawet gdy poprzedza go blok obrazu', async () => {
    const input = body([], [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
          { type: 'text', text: '<subagent-router v="1" model="fast"/>\nZbadaj zrzut ekranu.' },
        ],
      },
    ]);
    const result = await extractMarkers(input, 'agent-1', SECRET);
    expect(result.explicitAliases).toEqual(['fast']);
    const strippedContent = (result.stripped.messages as Array<{ content: Array<{ type: string; text?: string }> }>)[0]?.content;
    expect(strippedContent?.[0]?.type).toBe('image');
    expect(strippedContent?.[1]?.text).toBe('Zbadaj zrzut ekranu.');
  });

  test('dwa poprawnie podpisane markery adaptera w system z różnymi rolami dają conflicting-markers', async () => {
    const tokenReviewer = await signRoleMarker(SECRET, 'reviewer', 'agent-1');
    const tokenExplorer = await signRoleMarker(SECRET, 'explorer', 'agent-1');
    const input = body(
      [
        { type: 'text', text: `<subagent-router v="1" role="reviewer" agent="agent-1" token="${tokenReviewer}"/>` },
        { type: 'text', text: `<subagent-router v="1" role="explorer" agent="agent-1" token="${tokenExplorer}"/>` },
      ],
      [],
    );
    const result = await extractMarkers(input, 'agent-1', SECRET, 'system');
    expect(result.markerError).toBe('conflicting-markers');
    expect(result.roleFromAdapter).toBeUndefined();
    expect(result.ignored).toBe(0);
  });
});
