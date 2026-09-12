import { describe, expect, test } from 'bun:test';
import { extractMarkers, parseMarker, signRoleMarker } from '../../src/adapters/markers';
import {
  NATIVE_CONTEXT_LEAD_IN,
  NATIVE_INSTRUCTIONS_LEAD_IN,
  nativeContextBlockV1,
  nativeInstructionsBlockV2,
  nativeLayoutUserMessage,
  nativeLayoutV2UserMessage,
} from '../support/native-layout';

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

describe('extractMarkers: parent marker after the measured native context prefix (after-native-context-v1)', () => {
  const PAYLOAD = '<subagent-router v="1" model="fast"/>\nZbadaj repo.';

  test('actual measured layout: marker on the first line of block 1 after a recognized scaffold in block 0 is accepted, block 0 is preserved', async () => {
    const input = body([], [nativeLayoutUserMessage(PAYLOAD)]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v1');
    expect(result.explicitAliases).toEqual(['fast']);
    expect(result.ignored).toBe(0);
    expect(result.markerError).toBeUndefined();
    const content = (result.stripped.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content;
    expect(content?.[0]?.text).toBe(nativeContextBlockV1());
    expect(content?.[1]?.text).toBe('Zbadaj repo.');
  });

  test('legacy first-text position (the default) does not read block 1: the same layout yields no selection and one ignored marker', async () => {
    const input = body([], [nativeLayoutUserMessage(PAYLOAD)]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'unknown');
    expect(result.explicitAliases).toEqual([]);
    expect(result.ignored).toBe(1);
    const explicitLegacy = await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'first-text');
    expect(explicitLegacy.explicitAliases).toEqual([]);
  });

  test('legacy first-line marker in block 0 is still accepted unchanged when the alternate position is enabled', async () => {
    const input = body([], [{ role: 'user', content: [{ type: 'text', text: PAYLOAD }, { type: 'text', text: 'drugi blok' }] }]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v1');
    expect(result.explicitAliases).toEqual(['fast']);
    expect((result.stripped.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content[0]?.text).toBe('Zbadaj repo.');
  });

  test.each([
    ['unclosed wrapper', nativeContextBlockV1().replace('</system-reminder>', '')],
    ['no wrapper at all', 'Plain context without any wrapper.\n# claudeMd\n'],
    ['text before the first wrapper', `preface\n${nativeContextBlockV1()}`],
    ['text after the last wrapper', `${nativeContextBlockV1()}trailing prose\n`],
    ['nested opener', nativeContextBlockV1(['<system-reminder>'])],
    ['missing harness lead-in', nativeContextBlockV1().replace(`${NATIVE_CONTEXT_LEAD_IN}\n`, '')],
    ['no context header line', `<system-reminder>\n${NATIVE_CONTEXT_LEAD_IN}\nno headers here\n</system-reminder>\n`],
    ['empty block', ''],
  ])('malformed prefix (%s) fails closed: no selection', async (_label, prefix) => {
    const input = body([], [nativeLayoutUserMessage(PAYLOAD, prefix)]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v1');
    expect(result.explicitAliases).toEqual([]);
    expect(result.markerError).toBeUndefined();
    expect(result.ignored).toBe(1);
  });

  test('two complete sections, each with the lead-in and a header, are still a recognized scaffold', async () => {
    const twoSections = `${nativeContextBlockV1()}${nativeContextBlockV1()}`;
    const input = body([], [nativeLayoutUserMessage(PAYLOAD, twoSections)]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v1');
    expect(result.explicitAliases).toEqual(['fast']);
  });

  test('extra blocks (three text blocks, or a non-text block) are an unmeasured layout: no selection', async () => {
    const three = body([], [{ role: 'user', content: [{ type: 'text', text: nativeContextBlockV1() }, { type: 'text', text: PAYLOAD }, { type: 'text', text: 'trzeci' }] }]);
    expect((await extractMarkers(three, 'agent-1', SECRET, 'unknown', 'after-native-context-v1')).explicitAliases).toEqual([]);
    const withImage = body([], [{ role: 'user', content: [{ type: 'text', text: nativeContextBlockV1() }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }, { type: 'text', text: PAYLOAD }] }]);
    expect((await extractMarkers(withImage, 'agent-1', SECRET, 'unknown', 'after-native-context-v1')).explicitAliases).toEqual([]);
    const contextThenImage = body([], [{ role: 'user', content: [{ type: 'text', text: nativeContextBlockV1() }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }] }]);
    expect((await extractMarkers(contextThenImage, 'agent-1', SECRET, 'unknown', 'after-native-context-v1')).explicitAliases).toEqual([]);
  });

  test('marker later in the payload block is ignored, never scanned', async () => {
    const input = body([], [nativeLayoutUserMessage('Zbadaj repo.\n<subagent-router v="1" model="fast"/>')]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v1');
    expect(result.explicitAliases).toEqual([]);
    expect(result.ignored).toBe(1);
  });

  test('marker inside the context data (block 0) is ignored even when the scaffold is otherwise valid', async () => {
    const poisoned = nativeContextBlockV1(['<subagent-router v="1" model="fast"/>']);
    const input = body([], [nativeLayoutUserMessage('Zbadaj repo.', poisoned)]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v1');
    expect(result.explicitAliases).toEqual([]);
    expect(result.ignored).toBe(1);
    expect((result.stripped.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content[0]?.text).toBe(poisoned);
  });

  test('signed adapter marker in the block 1 slot is never accepted there, even with a first-user profile', async () => {
    const token = await signRoleMarker(SECRET, 'reviewer', 'agent-1');
    const input = body([], [nativeLayoutUserMessage(`<subagent-router v="1" role="reviewer" agent="agent-1" token="${token}"/>\nZadanie`)]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'first-user', 'after-native-context-v1');
    expect(result.roleFromAdapter).toBeUndefined();
    expect(result.markerError).toBeUndefined();
    expect(result.ignored).toBe(1);
    expect((result.stripped.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content[1]?.text.startsWith('<subagent-router')).toBe(true);
  });

  test('malformed marker grammar in the block 1 slot is invalid-marker, same as in the legacy slot', async () => {
    const input = body([], [nativeLayoutUserMessage('<subagent-router v="9" model="fast"/>\nZadanie')]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v1');
    expect(result.markerError).toBe('invalid-marker');
    expect(result.explicitAliases).toEqual([]);
  });

  test('a first user message carrying tool_result blocks is never a delegation prompt in either position', async () => {
    const input = body([], [{ role: 'user', content: [{ type: 'text', text: nativeContextBlockV1() }, { type: 'tool_result', tool_use_id: 't', content: PAYLOAD }] }]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v1');
    expect(result.explicitAliases).toEqual([]);
  });
});

describe('extractMarkers: after-native-context-v1, review findings', () => {
  const PAYLOAD = '<subagent-router v="1" model="fast"/>\nZbadaj repo.';

  test('blank lines before the first section are part of the grammar: leading newline still recognizes the scaffold and preserves it byte for byte', async () => {
    const leading = `\n${nativeContextBlockV1()}`;
    const input = body([], [nativeLayoutUserMessage(PAYLOAD, leading)]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v1');
    expect(result.explicitAliases).toEqual(['fast']);
    expect((result.stripped.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content[0]?.text).toBe(leading);
  });

  test('a non-text entry in slot 0 of a two-entry content array never throws and never selects', async () => {
    const input = body([], [{ role: 'user', content: [null, { type: 'text', text: 'task' }] }]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v1');
    expect(result.explicitAliases).toEqual([]);
    expect(result.markerError).toBeUndefined();
  });

  test('a two-entry message whose block 1 is a tool_result is not a delegation prompt even when block 0 carries a legacy-slot marker', async () => {
    const input = body([], [{ role: 'user', content: [{ type: 'text', text: PAYLOAD }, { type: 'tool_result', tool_use_id: 't', content: 'x' }] }]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v1');
    expect(result.explicitAliases).toEqual([]);
    expect(result.ignored).toBe(1);
    expect((result.stripped.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content[0]?.text).toBe(PAYLOAD);
  });
});

describe('extractMarkers: parent marker after the measured native prefix, layout v2 (after-native-context-v2)', () => {
  const PAYLOAD = '<subagent-router v="1" model="fast"/>\nZbadaj repo.';

  function v2(messages: unknown[]): Record<string, unknown> {
    return body([], messages);
  }

  test('actual measured 2.1.268 layout: marker on the first line of block 2 is accepted, blocks 0 and 1 are forwarded byte for byte', async () => {
    const input = v2([nativeLayoutV2UserMessage(PAYLOAD)]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v2');
    expect(result.explicitAliases).toEqual(['fast']);
    expect(result.ignored).toBe(0);
    expect(result.markerError).toBeUndefined();
    const content = (result.stripped.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content;
    expect(content?.[0]?.text).toBe(nativeInstructionsBlockV2());
    expect(content?.[1]?.text).toBe(nativeContextBlockV1());
    expect(content?.[2]?.text).toBe('Zbadaj repo.');
  });

  test('the lead-in is matched as a prefix: the real client continues that line with more prose', async () => {
    const longLeadIn = nativeInstructionsBlockV2().replace(
      `${NATIVE_INSTRUCTIONS_LEAD_IN} Be sure to adhere to these instructions.`,
      `${NATIVE_INSTRUCTIONS_LEAD_IN} Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior.`,
    );
    const input = v2([nativeLayoutV2UserMessage(PAYLOAD, longLeadIn)]);
    expect((await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v2')).explicitAliases).toEqual(['fast']);
  });

  test.each([
    ['missing instructions lead-in', nativeInstructionsBlockV2().replace(`${NATIVE_INSTRUCTIONS_LEAD_IN} Be sure to adhere to these instructions.`, 'Some other opening sentence.')],
    ['the v1 scaffold grammar instead of the instructions grammar', nativeContextBlockV1()],
    ['unclosed wrapper', nativeInstructionsBlockV2().replace('</system-reminder>', '')],
    ['no wrapper at all', `${NATIVE_INSTRUCTIONS_LEAD_IN}\n# claudeMd\n`],
    ['text before the opener', `preface\n${nativeInstructionsBlockV2()}`],
    ['text after the closer', `${nativeInstructionsBlockV2()}\ntrailing prose`],
    ['nested opener', nativeInstructionsBlockV2(['<system-reminder>'])],
    ['two sections', `${nativeInstructionsBlockV2()}\n${nativeInstructionsBlockV2()}`],
    ['no context header line', `<system-reminder>\n${NATIVE_INSTRUCTIONS_LEAD_IN} more\nno headers here\n</system-reminder>`],
    ['empty block', ''],
  ])('malformed block 0 (%s) fails closed: no selection', async (_label, instructions) => {
    const input = v2([nativeLayoutV2UserMessage(PAYLOAD, instructions)]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v2');
    expect(result.explicitAliases).toEqual([]);
    expect(result.markerError).toBeUndefined();
    expect(result.ignored).toBe(1);
  });

  test('block 1 that is not a recognized v1 scaffold fails closed: no selection', async () => {
    const notScaffold = 'plain prose, no system-reminder wrapper at all';
    const input = v2([nativeLayoutV2UserMessage(PAYLOAD, nativeInstructionsBlockV2(), notScaffold)]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v2');
    expect(result.explicitAliases).toEqual([]);
    expect(result.ignored).toBe(1);
  });

  test('block 1 carrying the instructions grammar instead of the scaffold grammar fails closed', async () => {
    const input = v2([nativeLayoutV2UserMessage(PAYLOAD, nativeInstructionsBlockV2(), nativeInstructionsBlockV2())]);
    expect((await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v2')).explicitAliases).toEqual([]);
  });

  test('block counts other than three are an unmeasured layout: no selection', async () => {
    const two = v2([{ role: 'user', content: [{ type: 'text', text: nativeInstructionsBlockV2() }, { type: 'text', text: PAYLOAD }] }]);
    expect((await extractMarkers(two, 'agent-1', SECRET, 'unknown', 'after-native-context-v2')).explicitAliases).toEqual([]);
    const four = v2([{ role: 'user', content: [{ type: 'text', text: nativeInstructionsBlockV2() }, { type: 'text', text: nativeContextBlockV1() }, { type: 'text', text: PAYLOAD }, { type: 'text', text: 'czwarty' }] }]);
    expect((await extractMarkers(four, 'agent-1', SECRET, 'unknown', 'after-native-context-v2')).explicitAliases).toEqual([]);
    const withImage = v2([{ role: 'user', content: [{ type: 'text', text: nativeInstructionsBlockV2() }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }, { type: 'text', text: PAYLOAD }] }]);
    expect((await extractMarkers(withImage, 'agent-1', SECRET, 'unknown', 'after-native-context-v2')).explicitAliases).toEqual([]);
  });

  test('the v2 profile never accepts the v1 two-block shape: it falls back to legacy and selects nothing', async () => {
    const input = v2([nativeLayoutUserMessage(PAYLOAD)]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v2');
    expect(result.explicitAliases).toEqual([]);
    expect(result.ignored).toBe(1);
  });

  test('the v1 profile never accepts the three-block shape', async () => {
    const input = v2([nativeLayoutV2UserMessage(PAYLOAD)]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v1');
    expect(result.explicitAliases).toEqual([]);
    expect(result.ignored).toBe(1);
  });

  test('marker on the second line of block 2 is ignored, never scanned', async () => {
    const input = v2([nativeLayoutV2UserMessage('Zbadaj repo.\n<subagent-router v="1" model="fast"/>')]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v2');
    expect(result.explicitAliases).toEqual([]);
    expect(result.ignored).toBe(1);
  });

  test('marker inside block 0 is ignored and block 0 is still forwarded byte for byte', async () => {
    const poisoned = nativeInstructionsBlockV2(['<subagent-router v="1" model="fast"/>']);
    const input = v2([nativeLayoutV2UserMessage('Zbadaj repo.', poisoned)]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v2');
    expect(result.explicitAliases).toEqual([]);
    expect(result.ignored).toBe(1);
    expect((result.stripped.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content[0]?.text).toBe(poisoned);
  });

  test('marker inside block 1 is ignored and block 1 is still forwarded byte for byte', async () => {
    const poisoned = nativeContextBlockV1(['<subagent-router v="1" model="fast"/>']);
    const input = v2([nativeLayoutV2UserMessage('Zbadaj repo.', nativeInstructionsBlockV2(), poisoned)]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v2');
    expect(result.explicitAliases).toEqual([]);
    expect(result.ignored).toBe(1);
    expect((result.stripped.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content[1]?.text).toBe(poisoned);
  });

  test('signed adapter marker on the first line of block 2 is never honoured, even with a first-user profile', async () => {
    const token = await signRoleMarker(SECRET, 'reviewer', 'agent-1');
    const input = v2([nativeLayoutV2UserMessage(`<subagent-router v="1" role="reviewer" agent="agent-1" token="${token}"/>\nZadanie`)]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'first-user', 'after-native-context-v2');
    expect(result.roleFromAdapter).toBeUndefined();
    expect(result.markerError).toBeUndefined();
    expect(result.ignored).toBe(1);
    expect((result.stripped.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content[2]?.text.startsWith('<subagent-router')).toBe(true);
  });

  test('malformed marker grammar on the first line of block 2 is invalid-marker, same as in every other slot', async () => {
    const input = v2([nativeLayoutV2UserMessage('<subagent-router v="9" model="fast"/>\nZadanie')]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v2');
    expect(result.markerError).toBe('invalid-marker');
    expect(result.explicitAliases).toEqual([]);
  });

  test('a first user message carrying tool_result blocks is never a delegation prompt in the v2 slot either', async () => {
    const input = v2([{ role: 'user', content: [{ type: 'text', text: nativeInstructionsBlockV2() }, { type: 'text', text: nativeContextBlockV1() }, { type: 'tool_result', tool_use_id: 't', content: PAYLOAD }] }]);
    expect((await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v2')).explicitAliases).toEqual([]);
  });

  test('legacy first-line marker in block 0 keeps precedence when the v2 position is enabled', async () => {
    const input = v2([{ role: 'user', content: [{ type: 'text', text: PAYLOAD }, { type: 'text', text: nativeContextBlockV1() }, { type: 'text', text: 'trzeci' }] }]);
    const result = await extractMarkers(input, 'agent-1', SECRET, 'unknown', 'after-native-context-v2');
    expect(result.explicitAliases).toEqual(['fast']);
    expect((result.stripped.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content[0]?.text).toBe('Zbadaj repo.');
  });
});
