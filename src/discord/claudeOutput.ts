import { t } from '../locale/index.js';

const DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-[rf]+\s+)*.*(-[rf]+|--recursive|--force)/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[fd])/i,
  /\b(drop|truncate)\s+(database|table)/i,
  /\bchmod\s+777/i,
  /\bdd\s+if=/i,
  />\s*\/dev\/sd[a-z]/i,
];

type ClaudeStreamEvent = {
  type?: string;
  name?: string;
  result?: string;
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
};

export function parseClaudeStreamOutput(output: string): { result: string; toolCalls: string[] } {
  const toolCalls: string[] = [];
  const assistantTexts: string[] = [];
  let resultText = '';

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed) as ClaudeStreamEvent;

      if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text?.trim()) {
            assistantTexts.push(block.text.trim());
          }

          if (block.type === 'tool_use' && block.name) {
            toolCalls.push(summarizeToolCall(block.name, block.input));
          }
        }
      }

      if (event.type === 'result' && typeof event.result === 'string') {
        resultText = event.result;
      }
    } catch {
      // Ignore non-NDJSON lines from verbose output.
    }
  }

  const fallbackText = assistantTexts.join('\n\n').trim();
  const result = resultText.trim() || fallbackText || output.trim() || t('common.fallback.noResponse');
  return { result, toolCalls };
}

function summarizeToolCall(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return name;

  if (name === 'Bash' && typeof input.command === 'string') {
    const cmd = input.command.slice(0, 80);
    for (const pattern of DESTRUCTIVE_PATTERNS) {
      if (pattern.test(input.command)) {
        return `⛔ BLOCKED: ${cmd}`;
      }
    }
    return `Bash: \`${cmd}${input.command.length > 80 ? '...' : ''}\``;
  }

  if (['Read', 'Write', 'Edit'].includes(name) && typeof input.file_path === 'string') {
    const path = input.file_path.split('/').slice(-2).join('/');
    return `${name}: \`${path}\``;
  }

  if (name === 'Grep' && typeof input.pattern === 'string') {
    return `Grep: \`${input.pattern}\``;
  }

  return name;
}
