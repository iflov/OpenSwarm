import { describe, expect, it } from 'vitest';
import { parseClaudeStreamOutput } from './claudeOutput.js';

describe('parseClaudeStreamOutput', () => {
  it('prefers the result event over raw assistant JSON', () => {
    const assistant = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: '문서 전체를 읽었습니다. Codex에 리뷰를 요청하겠습니다.',
          },
        ],
      },
    });
    const result = JSON.stringify({
      type: 'result',
      result: '작업을 시작했습니다. 리뷰 요청도 이어서 진행합니다.',
      usage: { input_tokens: 3, output_tokens: 9 },
      session_id: 'abc-123',
    });

    expect(parseClaudeStreamOutput(`${assistant}\n${result}`).result).toBe(
      '작업을 시작했습니다. 리뷰 요청도 이어서 진행합니다.',
    );
  });

  it('falls back to assistant text when result text is empty', () => {
    const assistant = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '첫 번째 문단입니다.' },
          { type: 'text', text: '두 번째 문단입니다.' },
        ],
      },
    });
    const result = JSON.stringify({ type: 'result', result: '' });

    expect(parseClaudeStreamOutput(`${assistant}\n${result}`).result).toBe(
      '첫 번째 문단입니다.\n\n두 번째 문단입니다.',
    );
  });

  it('extracts tool summaries from assistant tool_use blocks', () => {
    const assistant = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Read',
            input: { file_path: '/Users/admin/Desktop/OpenSwarm/src/discord/discordCore.ts' },
          },
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'npm test -- --runInBand' },
          },
        ],
      },
    });

    expect(parseClaudeStreamOutput(assistant).toolCalls).toEqual([
      'Read: `discord/discordCore.ts`',
      'Bash: `npm test -- --runInBand`',
    ]);
  });

  it('does not leak verbose garbage when valid NDJSON exists', () => {
    const output = [
      'verbose prelude line',
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '정상 응답' }] },
      }),
      'another non-json line',
    ].join('\n');

    expect(parseClaudeStreamOutput(output).result).toBe('정상 응답');
  });
});
