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
