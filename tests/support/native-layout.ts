// Sanitized, minimal stand-in for the native Claude Code context prefix measured in
// stage 2a (client 2.1.266): the first user message carried exactly two text blocks,
// block 0 a single complete <system-reminder> section with the harness lead-in and
// "# name" context headers, block 1 the parent-authored delegation prompt whose first
// line is the channel-A marker. Only the boundaries are reproduced here, never the
// captured private contents.
export const NATIVE_CONTEXT_LEAD_IN = "As you answer the user's questions, you can use the following context:";

export function nativeContextBlockV1(extraLines: readonly string[] = []): string {
  return [
    '<system-reminder>',
    NATIVE_CONTEXT_LEAD_IN,
    '# claudeMd',
    'Codebase and user instructions are shown below.',
    '',
    'Contents of /tmp/sanitized/CLAUDE.md (project instructions, checked into the codebase):',
    '',
    '# Sanitized project instructions',
    'Plain fixture text.',
    ...extraLines,
    '# currentDate',
    "Today's date is 2026-09-09.",
    '',
    '      IMPORTANT: this context may or may not be relevant to your tasks.',
    '</system-reminder>',
    '',
    '',
  ].join('\n');
}

export function nativeLayoutUserMessage(payload: string, contextBlock: string = nativeContextBlockV1()): Record<string, unknown> {
  return { role: 'user', content: [{ type: 'text', text: contextBlock }, { type: 'text', text: payload }] };
}

// Layout v2, as measured on Claude Code 2.1.268: the first user message carries THREE text
// blocks. Block 0 is a single complete <system-reminder> section whose second line opens with
// the operator-instructions lead-in and whose body is the instruction files; block 1 is exactly
// the v1 context scaffold above; block 2 is the parent-authored delegation prompt. As with v1,
// only the boundaries are reproduced here, never the captured private contents. The lead-in is
// matched as a PREFIX: the real client continues that same line with further sentences.
export const NATIVE_INSTRUCTIONS_LEAD_IN = 'Codebase and user instructions are shown below.';

export function nativeInstructionsBlockV2(extraLines: readonly string[] = []): string {
  return [
    '<system-reminder>',
    `${NATIVE_INSTRUCTIONS_LEAD_IN} Be sure to adhere to these instructions.`,
    '',
    'Contents of /tmp/sanitized/CLAUDE.md (user instructions):',
    '',
    '# Sanitized global instructions',
    'Plain fixture text.',
    ...extraLines,
    '',
    '## Start',
    '</system-reminder>',
  ].join('\n');
}

export function nativeLayoutV2UserMessage(
  payload: string,
  instructionsBlock: string = nativeInstructionsBlockV2(),
  contextBlock: string = nativeContextBlockV1(),
): Record<string, unknown> {
  return {
    role: 'user',
    content: [
      { type: 'text', text: instructionsBlock },
      { type: 'text', text: contextBlock },
      { type: 'text', text: payload },
    ],
  };
}
