import { describe, expect, it } from 'vitest';
import type { CliRunResult } from './types.js';
import { CodexCliAdapter } from './codex.js';

function raw(stdout: string): CliRunResult {
  return {
    exitCode: 0,
    stdout,
    stderr: '',
    durationMs: 1,
  };
}

describe('CodexCliAdapter', () => {
  it('passes prompts via stdin redirection instead of argv expansion', () => {
    const adapter = new CodexCliAdapter();
    const { command } = adapter.buildCommand({
      prompt: '/tmp/prompt file.txt',
      cwd: '/tmp',
      model: 'gpt-5.4',
    });

    expect(command).toContain('codex exec --json --full-auto');
    expect(command).toContain('- < "/tmp/prompt file.txt"');
    expect(command).not.toContain('$(cat');
  });

  it('disables streaming until a dedicated Codex parser exists', () => {
    const adapter = new CodexCliAdapter();
    expect(adapter.capabilities.supportsStreaming).toBe(false);
  });

  it('ignores non-json noise when extracting assistant output', () => {
    const adapter = new CodexCliAdapter();
    const output = [
      'warning: noisy prelude that should not become assistant output',
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Structured answer' }],
      }),
    ].join('\n');

    const result = adapter.parseWorkerOutput(raw(output));
    expect(result.summary).toContain('Structured answer');
  });

  it('treats ambiguous fallback text as failure instead of success', () => {
    const adapter = new CodexCliAdapter();
    const result = adapter.parseWorkerOutput(raw('Updated src/app.ts and added tests.'));

    expect(result.success).toBe(false);
  });

  it('does not mark mixed success and failure text as successful', () => {
    const adapter = new CodexCliAdapter();
    const result = adapter.parseWorkerOutput(
      raw('Task completed partially, but tests failed with error: assertion mismatch.'),
    );

    expect(result.success).toBe(false);
  });

  it('normalizes reviewer decisions from Codex response.completed output', () => {
    const adapter = new CodexCliAdapter();
    const output = JSON.stringify({
      type: 'response.completed',
      response: {
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: '```json\n{"decision":"approve","feedback":"Looks good","issues":[],"suggestions":[]}\n```',
              },
            ],
          },
        ],
      },
    });

    const result = adapter.parseReviewerOutput(raw(output));
    expect(result.decision).toBe('approve');
    expect(result.feedback).toBe('Looks good');
  });
});
