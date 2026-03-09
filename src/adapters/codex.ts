// ============================================
// OpenSwarm - Codex CLI Adapter
// Wraps `codex exec` for agent execution
// ============================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  CliAdapter,
  CliRunOptions,
  CliRunResult,
  AdapterCapabilities,
  WorkerResult,
  ReviewResult,
} from './types.js';
import type { ReviewDecision } from '../agents/agentPair.js';
import { t } from '../locale/index.js';

const execFileAsync = promisify(execFile);

// ============================================
// Codex CLI Adapter
// ============================================

export class CodexCliAdapter implements CliAdapter {
  readonly name = 'codex';

  readonly capabilities: AdapterCapabilities = {
    // Disable live streaming until Codex JSONL has a dedicated parser.
    supportsStreaming: false,
    supportsJsonOutput: true,
    supportsModelSelection: true,
    managedGit: false,
    supportedSkills: [],
  };

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('which', ['codex']);
      return true;
    } catch {
      return false;
    }
  }

  buildCommand(options: CliRunOptions): { command: string; args: string[] } {
    const promptFile = options.prompt;
    const modelFlag = options.model ? ` -m ${options.model}` : '';
    const cmd = `CLAUDECODE= codex exec --json --full-auto${modelFlag} - < "${promptFile}"`;
    return { command: cmd, args: [] };
  }

  parseWorkerOutput(raw: CliRunResult): WorkerResult {
    try {
      const resultText = extractCodexResult(raw.stdout);
      if (resultText) {
        const jsonResult = extractWorkerResultJson(resultText);
        if (jsonResult) return jsonResult;
        return extractWorkerFromText(resultText);
      }
      return extractWorkerFromText(raw.stdout);
    } catch (error) {
      console.error('[Codex Worker] Parse error:', error);
      return extractWorkerFromText(raw.stdout);
    }
  }

  parseReviewerOutput(raw: CliRunResult): ReviewResult {
    try {
      const resultText = extractCodexResult(raw.stdout);
      if (resultText) {
        const jsonResult = extractReviewerResultJson(resultText);
        if (jsonResult) return jsonResult;
        return extractReviewerFromText(resultText);
      }
      return extractReviewerFromText(raw.stdout);
    } catch (error) {
      console.error('[Codex Reviewer] Parse error:', error);
      return extractReviewerFromText(raw.stdout);
    }
  }
}

// ============================================
// Codex Output Extraction
// ============================================

function extractCodexResult(stdout: string): string | null {
  // Codex --json outputs JSONL events
  // Look for message events with assistant content
  const lines = stdout.split('\n');
  let lastMessage = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      // Codex JSONL format: look for message/result events
      if (event.type === 'message' && event.role === 'assistant') {
        if (typeof event.content === 'string') {
          lastMessage = event.content;
        } else if (Array.isArray(event.content)) {
          const textParts = event.content
            .filter((c: any) => c.type === 'text' || c.type === 'output_text')
            .map((c: any) => c.text || c.content || '')
            .join('\n');
          if (textParts) lastMessage = textParts;
        }
      }
      // Also check for output_text type
      if (event.type === 'output_text' && event.text) {
        lastMessage += event.text;
      }
      // Check for response.completed or similar final events
      if (event.type === 'response.completed' && event.response?.output) {
        const outputs = event.response.output
          .filter((o: any) => o.type === 'message' && o.role === 'assistant')
          .map((o: any) => {
            if (typeof o.content === 'string') return o.content;
            if (Array.isArray(o.content)) {
              return o.content
                .filter((c: any) => c.type === 'output_text' || c.type === 'text')
                .map((c: any) => c.text || '')
                .join('\n');
            }
            return '';
          })
          .join('\n');
        if (outputs) lastMessage = outputs;
      }
    } catch {
      // Ignore non-JSON lines in --json mode. Fallback text parsing will inspect raw stdout.
    }
  }

  return lastMessage || null;
}

// ============================================
// Worker Output Parsing
// ============================================

function extractWorkerResultJson(text: string): WorkerResult | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonText = jsonMatch ? jsonMatch[1] : null;

  if (!jsonText) {
    const objMatch = text.match(/\{\s*"success"\s*:/);
    if (!objMatch) return null;

    const startIdx = objMatch.index!;
    let depth = 0;
    let endIdx = startIdx;

    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === '{') depth++;
      if (text[i] === '}') {
        depth--;
        if (depth === 0) {
          endIdx = i + 1;
          break;
        }
      }
    }

    try {
      const parsed = JSON.parse(text.slice(startIdx, endIdx));
      return {
        success: Boolean(parsed.success),
        summary: parsed.summary || t('common.fallback.noSummary'),
        filesChanged: Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [],
        commands: Array.isArray(parsed.commands) ? parsed.commands : [],
        output: text,
        error: parsed.error,
        confidencePercent: typeof parsed.confidencePercent === 'number'
          ? parsed.confidencePercent : undefined,
        haltReason: parsed.haltReason || undefined,
      };
    } catch {
      return null;
    }
  }

  try {
    const parsed = JSON.parse(jsonText);
    return {
      success: Boolean(parsed.success),
      summary: parsed.summary || '(no summary)',
      filesChanged: Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [],
      commands: Array.isArray(parsed.commands) ? parsed.commands : [],
      output: text,
      error: parsed.error,
      confidencePercent: typeof parsed.confidencePercent === 'number'
        ? parsed.confidencePercent : undefined,
      haltReason: parsed.haltReason || undefined,
    };
  } catch {
    return null;
  }
}

function extractWorkerFromText(text: string): WorkerResult {
  const hasError = /error|fail|exception|cannot/i.test(text);
  const hasSuccess = /success|completed|done|finished/i.test(text);

  const filePatterns = [
    /(?:changed?|modified?|created?|updated?):\s*(.+\.(?:ts|js|py|json|yaml|yml|md))/gi,
    /(?:src|lib|test|tests)\/[\w/\-.]+\.(?:ts|js|py)/gi,
  ];

  const filesChanged: string[] = [];
  for (const pattern of filePatterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      const file = m[1] || m[0];
      if (!filesChanged.includes(file)) {
        filesChanged.push(file);
      }
    }
  }

  const cmdPattern = /(?:`|\$)\s*((?:npm|pnpm|yarn|git|python|pytest|tsc|eslint)\s+[^\n`]+)/gi;
  const commands: string[] = [];
  const cmdMatches = text.matchAll(cmdPattern);
  for (const m of cmdMatches) {
    if (!commands.includes(m[1])) {
      commands.push(m[1].trim());
    }
  }

  return {
    success: hasSuccess && !hasError,
    summary: extractSummary(text),
    filesChanged: filesChanged.slice(0, 10),
    commands: commands.slice(0, 10),
    output: text,
    error: hasError ? extractErrorMessage(text) : undefined,
  };
}

function extractSummary(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 10);
  if (lines.length === 0) return t('common.fallback.noSummary');
  const summary = lines[0].trim();
  return summary.length > 200 ? summary.slice(0, 200) + '...' : summary;
}

function extractErrorMessage(text: string): string {
  const errorMatch = text.match(/(?:error|exception|failed?):\s*(.+)/i);
  if (errorMatch) return errorMatch[1].slice(0, 200);
  const lines = text.split('\n').filter((l) => /error|fail/i.test(l));
  if (lines.length > 0) return lines[0].slice(0, 200);
  return 'Unknown error';
}

// ============================================
// Reviewer Output Parsing
// ============================================

function extractReviewerResultJson(text: string): ReviewResult | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
    const objMatch = text.match(/\{\s*"decision"\s*:/);
    if (!objMatch) return null;

    const startIdx = objMatch.index!;
    let depth = 0;
    let endIdx = startIdx;

    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === '{') depth++;
      if (text[i] === '}') {
        depth--;
        if (depth === 0) {
          endIdx = i + 1;
          break;
        }
      }
    }

    try {
      const parsed = JSON.parse(text.slice(startIdx, endIdx));
      return normalizeReviewResult(parsed);
    } catch {
      return null;
    }
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    return normalizeReviewResult(parsed);
  } catch {
    return null;
  }
}

function normalizeReviewResult(parsed: any): ReviewResult {
  let decision: ReviewDecision = 'revise';
  if (['approve', 'revise', 'reject'].includes(parsed.decision)) {
    decision = parsed.decision as ReviewDecision;
  } else if (parsed.decision) {
    const normalized = parsed.decision.toLowerCase();
    if (normalized.includes('approv') || normalized.includes('pass')) {
      decision = 'approve';
    } else if (normalized.includes('reject') || normalized.includes('fail')) {
      decision = 'reject';
    }
  }

  return {
    decision,
    feedback: parsed.feedback || t('common.fallback.noFeedback'),
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
  };
}

function extractReviewerFromText(text: string): ReviewResult {
  let decision: ReviewDecision = 'revise';
  const lowerText = text.toLowerCase();

  if (lowerText.includes('approve') || lowerText.includes('lgtm')) {
    decision = 'approve';
  } else if (lowerText.includes('reject')) {
    decision = 'reject';
  } else if (lowerText.includes('revise') || lowerText.includes('improve')) {
    decision = 'revise';
  }

  const issues: string[] = [];
  const issuePatterns = [
    /(?:issue|problem|error):\s*(.+)/gi,
    /(?:missing):\s*(.+)/gi,
    /- (?:fix|resolve):\s*(.+)/gi,
  ];

  for (const pattern of issuePatterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      if (m[1] && !issues.includes(m[1].trim())) {
        issues.push(m[1].trim().slice(0, 200));
      }
    }
  }

  const suggestions: string[] = [];
  const suggestionPatterns = [
    /(?:suggest|recommend):\s*(.+)/gi,
    /(?:consider):\s*(.+)/gi,
    /(?:should):\s*(.+)/gi,
  ];

  for (const pattern of suggestionPatterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      if (m[1] && !suggestions.includes(m[1].trim())) {
        suggestions.push(m[1].trim().slice(0, 200));
      }
    }
  }

  return {
    decision,
    feedback: extractFeedback(text),
    issues: issues.slice(0, 5),
    suggestions: suggestions.slice(0, 5),
  };
}

function extractFeedback(text: string): string {
  const lines = text.split('\n').filter((l) => {
    const trimmed = l.trim();
    return trimmed.length > 20 && !trimmed.startsWith('#') && !trimmed.startsWith('```');
  });

  if (lines.length === 0) return t('common.fallback.noFeedback');
  const feedback = lines[0].trim();
  return feedback.length > 300 ? feedback.slice(0, 300) + '...' : feedback;
}
