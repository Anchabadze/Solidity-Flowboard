import * as os from 'os';
import { spawn } from 'child_process';
import { Lang, getStrings } from './strings';

export interface AiOptions {
  /** Path to the Claude Code CLI binary (defaults to "claude" on PATH). */
  claudePath: string;
  /** Model alias/name, or empty string for the user's default model. */
  model: string;
  /** When true, run in the project root with read-only tools for full context. */
  codebaseContext: boolean;
  /** Project root directory (used as cwd when codebaseContext is on). */
  projectRoot?: string;
  /** Active UI language - controls prompt language (so AI replies in it). */
  lang: Lang;
}

/** Where the analysed function lives - used to point the model at the file. */
export interface CodeContext {
  filePath?: string;
  startLine?: number;
  endLine?: number;
}

export interface LineAnnotation {
  line: number;
  comment: string;
}

/**
 * Invoke the locally installed Claude Code CLI in headless mode (`claude -p`).
 * The prompt is sent on stdin to avoid command-line length limits and quoting
 * issues (the binary may live on the Windows side, reached via WSL interop).
 * Returns the model's response text (the `result` field of the JSON envelope).
 */
function runClaude(prompt: string, opts: AiOptions, jsonSchema?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = getStrings(opts.lang);
    const useContext = opts.codebaseContext && !!opts.projectRoot;

    const args = ['-p', '--output-format', 'json'];
    if (opts.model) {
      args.push('--model', opts.model);
    }
    if (jsonSchema) {
      args.push('--json-schema', jsonSchema);
    }
    if (useContext) {
      // Read-only tools so the model can pull in related code, never edit it.
      args.push('--allowedTools', 'Read,Grep,Glob');
    }

    // With context: run in the project root so the model can read the codebase.
    // Without: a neutral dir (no project CLAUDE.md/settings influence). `-p`
    // skips the workspace-trust prompt either way.
    const cwd = useContext ? (opts.projectRoot as string) : os.tmpdir();
    const timeoutMs = useContext ? 300000 : 180000;

    let child;
    try {
      child = spawn(opts.claudePath || 'claude', args, {
        cwd,
        windowsHide: true
      });
    } catch (e) {
      reject(e);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(s.aiClaudeTimedOut.replace('{s}', String(Math.round(timeoutMs / 1000)))));
      }
    }, timeoutMs);

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new Error(s.aiClaudeNotFound));
      } else {
        reject(err);
      }
    });

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || s.aiClaudeExitCode.replace('{code}', String(code))));
        return;
      }
      resolve(extractResult(stdout));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Pull the model's output out of the `claude --output-format json` envelope.
 * With `--json-schema`, the structured value lands in `structured_output`
 * (and `result` is empty); otherwise the text is in `result`.
 */
function extractResult(stdout: string): string {
  const trimmed = stdout.trim();
  try {
    const env = JSON.parse(trimmed) as {
      structured_output?: unknown;
      result?: unknown;
    };
    if (env && typeof env === 'object') {
      if (env.structured_output != null) {
        const so = env.structured_output;
        return typeof so === 'string' ? so : JSON.stringify(so);
      }
      if ('result' in env) {
        const r = env.result;
        return typeof r === 'string' ? r : JSON.stringify(r);
      }
    }
  } catch {
    /* not a JSON envelope - fall through */
  }
  return trimmed;
}

/**
 * Tolerantly pull the annotations array out of a model response. Accepts both
 * `{"annotations": [...]}` (the schema we request) and a bare `[...]` array,
 * and tolerates ``` fences / surrounding prose.
 */
function extractAnnotationsArray(text: string, lang: Lang): unknown[] {
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');

  // First try parsing the whole thing.
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && Array.isArray((parsed as { annotations?: unknown[] }).annotations)) {
      return (parsed as { annotations: unknown[] }).annotations;
    }
  } catch {
    /* fall through to substring extraction */
  }

  // Fall back to slicing out the first [...] array.
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    const parsed = JSON.parse(s.slice(start, end + 1));
    if (Array.isArray(parsed)) {
      return parsed;
    }
  }
  throw new Error(getStrings(lang).aiParseFailed);
}

/** Prefix each line of `code` with a 1-based line number for the prompt. */
function numberLines(code: string): string {
  return code
    .split('\n')
    .map((line, i) => i + 1 + ': ' + line)
    .join('\n');
}

/** A sentence telling the model it may read the surrounding codebase. */
function contextNote(opts: AiOptions, ctx?: CodeContext): string {
  if (!opts.codebaseContext || !opts.projectRoot) {
    return '';
  }
  const p = getStrings(opts.lang).prompt;
  const where = ctx && ctx.filePath ? p.contextWhere(ctx.filePath, ctx.startLine, ctx.endLine) : '';
  return p.contextNote(where);
}

// Note: --json-schema requires the ROOT type to be "object".
const ANNOTATION_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    summary: { type: 'string' },
    annotations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          line: { type: 'integer' },
          comment: { type: 'string' }
        },
        required: ['line', 'comment']
      }
    }
  },
  required: ['summary', 'annotations']
});

export interface AnnotationResult {
  /** 1-3 sentence overview of what the function does and why it exists. */
  summary: string;
  /** Per-line comments for the significant lines. */
  items: LineAnnotation[];
}

/**
 * Ask the model for a function-level summary + per-line Russian explanations.
 */
export async function getAnnotations(
  code: string,
  opts: AiOptions,
  ctx?: CodeContext
): Promise<AnnotationResult> {
  const prompt = getStrings(opts.lang).prompt.annotations(numberLines(code), contextNote(opts, ctx));

  const raw = await runClaude(prompt, opts, ANNOTATION_SCHEMA);

  let summary = '';
  let arr: unknown[] = [];
  try {
    const obj = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const o = obj as { summary?: unknown; annotations?: unknown[] };
      if (typeof o.summary === 'string') {
        summary = o.summary.trim();
      }
      if (Array.isArray(o.annotations)) {
        arr = o.annotations;
      }
    } else if (Array.isArray(obj)) {
      arr = obj;
    }
  } catch {
    arr = extractAnnotationsArray(raw, opts.lang); // fallback: at least get the array
  }

  const items: LineAnnotation[] = [];
  for (const item of arr) {
    if (item && typeof item === 'object') {
      const obj = item as { line?: unknown; comment?: unknown };
      const line = typeof obj.line === 'number' ? obj.line : parseInt(String(obj.line), 10);
      const comment = typeof obj.comment === 'string' ? obj.comment : String(obj.comment ?? '');
      if (!isNaN(line) && comment.trim() !== '') {
        items.push({ line, comment: comment.trim() });
      }
    }
  }
  return { summary, items };
}
