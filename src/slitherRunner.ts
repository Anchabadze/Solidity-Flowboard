import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * One function discovered in the project. Line numbers are 1-based and inclusive.
 */
/** A resolvable `recv.method(...)` call (recv's type is an in-project contract). */
export interface MemberCall {
  recv: string;
  method: string;
  contract: string;
}

/** A modifier applied to a function, with its definition location if found. */
export interface ResolvedModifier {
  name: string;
  file?: string;
  startLine?: number;
  contract?: string;
}

/** Location of a `modifier <name>` definition. */
interface ModifierDef {
  file: string;
  startLine: number;
  endLine: number;
  contract: string;
}

export interface FunctionInfo {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  /** Internal/this/super call names resolvable within this contract + bases. */
  calls: string[];
  /** Member calls `recv.method()` whose receiver type is an in-project contract. */
  memberCalls?: MemberCall[];
  /** Number of declared parameters (used to resolve overloads by arity). */
  paramCount?: number;
  /** Call name -> argument count at its call site, so the UI can pick the right overload. */
  callArity?: Record<string, number>;
  /** Modifier names from the signature (raw). */
  modifierNames?: string[];
  /** Modifiers resolved to their definition locations. */
  modifiers?: ResolvedModifier[];
  /** Name of the contract/interface/library that defines this function. */
  contract?: string;
  /** Raw body text (only set by getEnclosingFunction, for the first card). */
  body?: string;
}

export interface SlitherResult {
  /** functionName -> info. If two functions share a name, the first body-def wins. */
  functions: Map<string, FunctionInfo>;
  /** contractName -> (functionName -> info), only for definitions WITH a body. */
  functionsByContract: Map<string, Map<string, FunctionInfo>>;
  /** contractName -> (functionName -> ALL body-definition overloads), for arity-aware resolution. */
  overloadsByContract: Map<string, Map<string, FunctionInfo[]>>;
  /** contractName -> ordered list of its direct base contracts (the `is ...` list). */
  contractBases: Map<string, string[]>;
  /** contractName -> (varName -> typeName) for state vars / params / locals. */
  varTypesByContract: Map<string, Map<string, string>>;
  /** contractName -> (modifierName -> definition location). */
  modifiersByContract: Map<string, Map<string, ModifierDef>>;
  /** false only when the `slither` binary itself could not be found. */
  slitherAvailable: boolean;
}

/** A contract/interface/library body span and its declared base contracts. */
interface ContractRange {
  name: string;
  bases: string[];
  start: number;
  end: number;
}

// Words that look like calls (`foo(`) but are not project functions worth expanding.
const NON_CALL_WORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'returns', 'function',
  'require', 'assert', 'revert', 'emit', 'new', 'delete', 'using', 'type',
  'keccak256', 'sha256', 'ripemd160', 'ecrecover', 'addmod', 'mulmod', 'blockhash',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uint128', 'uint256',
  'int', 'int8', 'int16', 'int32', 'int64', 'int128', 'int256',
  'bytes', 'bytes1', 'bytes4', 'bytes8', 'bytes16', 'bytes32',
  'address', 'bool', 'string', 'payable', 'modifier', 'constructor', 'mapping'
]);

// Build/output dirs to skip. We do NOT skip `lib` (Foundry deps) or
// `dependencies` (Soldeer): when a dependency's source is physically present
// (e.g. OpenZeppelin under lib/), calls into it are real and worth navigating.
// `node_modules` is skipped because npm/Hardhat deps there are rarely the audit
// target and bloat the index.
const SOLIDITY_DIRS_TO_SKIP = new Set([
  'node_modules', '.git', 'out', 'artifacts', 'cache', 'coverage', 'typechain', 'typechain-types'
]);

/**
 * Recursively collect every `.sol` file under `root`.
 */
function walkSolFiles(root: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (SOLIDITY_DIRS_TO_SKIP.has(entry.name) || entry.name.startsWith('.')) {
        continue;
      }
      results.push(...walkSolFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.sol')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Read Foundry/Hardhat-style remappings (`remappings.txt` + `foundry.toml`) and
 * return the absolute target directories they point to, restricted to inside the
 * project. This is how dependency sources living under `node_modules` (e.g.
 * `@openzeppelin/contracts-upgradeable/` mapped into node_modules) get indexed
 * without scanning all of node_modules.
 */
function readRemappingDirs(projectPath: string): string[] {
  const lines: string[] = [];
  try {
    lines.push(...fs.readFileSync(path.join(projectPath, 'remappings.txt'), 'utf8').split(/\r?\n/));
  } catch {
    /* no remappings.txt */
  }
  try {
    const toml = fs.readFileSync(path.join(projectPath, 'foundry.toml'), 'utf8');
    const block = /remappings\s*=\s*\[([\s\S]*?)\]/.exec(toml);
    if (block) {
      for (const q of block[1].match(/["']([^"']+)["']/g) || []) {
        lines.push(q.replace(/["']/g, ''));
      }
    }
  } catch {
    /* no foundry.toml */
  }

  const root = path.resolve(projectPath);
  const dirs = new Set<string>();
  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const target = line.slice(eq + 1).trim();
    if (!target) {
      continue;
    }
    const abs = path.resolve(projectPath, target);
    // Only inside the project; the normal walk already covers lib/ etc., so
    // dedup-by-realpath in runSlither prevents double indexing.
    if (abs === root || abs.startsWith(root + path.sep)) {
      dirs.add(abs);
    }
  }
  return [...dirs];
}

/**
 * Walk a remapped dependency directory, FOLLOWING symlinks (pnpm/node_modules
 * use them) and skipping nested `node_modules` to bound transitive deps. `add`
 * dedups by real path; `visited` guards against symlink cycles.
 */
function walkRemappedDir(
  dir: string,
  add: (file: string) => void,
  visited: Set<string>,
  budget: { left: number }
): void {
  if (budget.left <= 0) {
    return;
  }
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return;
  }
  if (visited.has(real)) {
    return;
  }
  visited.add(real);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    const full = path.join(dir, entry.name);
    let st: fs.Stats;
    try {
      st = fs.statSync(full); // follows symlinks
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkRemappedDir(full, add, visited, budget);
    } else if (st.isFile() && entry.name.endsWith('.sol')) {
      if (budget.left <= 0) {
        return;
      }
      budget.left--;
      add(full);
    }
  }
}

/** Convert a character index into a 1-based line number. */
function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') {
      line++;
    }
  }
  return line;
}

/**
 * Starting at `openIdx` (which must be `open`), return the index of the matching
 * closing character, respecting strings and comments. Returns -1 if unbalanced.
 */
function findMatching(s: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  let inLine = false;
  let inBlock = false;
  let inStr = false;
  let strCh = '';
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    const n = i + 1 < s.length ? s[i + 1] : '';
    if (inLine) {
      if (c === '\n') { inLine = false; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i++; }
      continue;
    }
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === strCh) { inStr = false; }
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
    if (c === open) { depth++; }
    else if (c === close) {
      depth--;
      if (depth === 0) { return i; }
    }
  }
  return -1;
}

/**
 * From `from`, return the index of the first occurrence of any target char,
 * respecting strings and comments. Returns -1 if none found.
 */
function scanForFirst(s: string, from: number, targets: Set<string>): number {
  let inLine = false;
  let inBlock = false;
  let inStr = false;
  let strCh = '';
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    const n = i + 1 < s.length ? s[i + 1] : '';
    if (inLine) {
      if (c === '\n') { inLine = false; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i++; }
      continue;
    }
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === strCh) { inStr = false; }
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
    if (targets.has(c)) { return i; }
  }
  return -1;
}

/**
 * Replace comment characters with spaces (preserving length and newlines) so
 * regex parsing never matches keywords/braces inside comments. Strings are kept.
 */
function blankComments(s: string): string {
  const out = s.split('');
  let inLine = false;
  let inBlock = false;
  let inStr = false;
  let strCh = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const n = i + 1 < s.length ? s[i + 1] : '';
    if (inLine) {
      if (c === '\n') { inLine = false; } else { out[i] = ' '; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; out[i] = ' '; out[i + 1] = ' '; i++; }
      else if (c !== '\n') { out[i] = ' '; }
      continue;
    }
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === strCh) { inStr = false; }
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; out[i] = ' '; continue; }
    if (c === '/' && n === '*') { inBlock = true; out[i] = ' '; continue; }
    if (c === '"' || c === "'") { inStr = true; strCh = c; }
  }
  return out.join('');
}

/** One call occurrence in a body: method name + receiver (null = internal). */
interface CallSite {
  name: string;
  /** null = internal call; 'super'/'this'; '' = member with non-identifier receiver (cast/chain); else the receiver identifier. */
  recv: string | null;
  /** Number of top-level arguments passed at this call site (for overload resolution). */
  argCount: number;
}

/**
 * Count top-level, comma-separated items in a parenthesized region (arguments
 * of a call or parameters of a declaration). Respects nested ()[]{} and strings.
 * Empty/whitespace → 0.
 */
function countArgs(text: string): number {
  let depth = 0;
  let inStr = false;
  let strCh = '';
  let sawContent = false;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === strCh) { inStr = false; }
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; strCh = c; sawContent = true; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; sawContent = true; continue; }
    if (c === ')' || c === ']' || c === '}') { if (depth > 0) { depth--; } sawContent = true; continue; }
    if (c === ',' && depth === 0) { count++; continue; }
    if (!/\s/.test(c)) { sawContent = true; }
  }
  return sawContent ? count + 1 : 0;
}

/** Extract every call occurrence from a function body with its receiver and arity. */
function extractCallSites(body: string): CallSite[] {
  const sites: CallSite[] = [];
  const re = /([A-Za-z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const name = m[1];
    if (NON_CALL_WORDS.has(name)) {
      continue;
    }
    // Argument count: scan from this call's '(' to its matching ')'.
    const parenIdx = re.lastIndex - 1; // index of '('
    const parenClose = findMatching(body, parenIdx, '(', ')');
    const argCount = parenClose === -1 ? 0 : countArgs(body.slice(parenIdx + 1, parenClose));

    let i = m.index - 1;
    while (i >= 0 && /\s/.test(body[i])) {
      i--;
    }
    let recv: string | null = null;
    if (i >= 0 && body[i] === '.') {
      i--;
      while (i >= 0 && /\s/.test(body[i])) {
        i--;
      }
      const end = i + 1;
      while (i >= 0 && /[\w$]/.test(body[i])) {
        i--;
      }
      recv = body.slice(i + 1, end); // identifier, or '' for a cast/chain receiver
    }
    sites.push({ name, recv, argCount });
  }
  return sites;
}

// Variable declarations: `<ContractType> [modifier] <name>` ending at ; = , )
// Captures state vars, params and locals whose type is a Capitalized identifier.
const VARDECL_RE =
  /\b([A-Z][A-Za-z0-9_$]*)\s+(?:public\s+|private\s+|internal\s+|external\s+|constant\s+|immutable\s+|override\s+|memory\s+|storage\s+|calldata\s+|payable\s+)*([a-z_$][A-Za-z0-9_$]*)\s*[;=,)]/g;

/** Scan a contract body for `Type name` declarations → varName -> typeName. */
function scanVarTypes(text: string, target: Map<string, string>): void {
  let m: RegExpExecArray | null;
  VARDECL_RE.lastIndex = 0;
  while ((m = VARDECL_RE.exec(text)) !== null) {
    const type = m[1];
    const name = m[2];
    // Later declarations (e.g. locals) override earlier (state vars) for same name.
    target.set(name, type);
  }
}

// Keywords that may appear in a function signature but are NOT modifiers.
const MOD_RESERVED = new Set([
  'public', 'private', 'internal', 'external',
  'view', 'pure', 'payable', 'nonpayable',
  'virtual', 'override', 'constant', 'immutable',
  'returns', 'function'
]);

/**
 * Extract modifier names from the signature region between the parameter list's
 * closing `)` and the body's `{` (or `;`). Skips visibility/mutability keywords
 * and the parenthesized argument groups of `returns(...)`, `override(...)`, and
 * modifier invocations `onlyRole(args)` (so inner identifiers aren't misread).
 */
function extractModifiers(region: string): string[] {
  const out: string[] = [];
  const re = /([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(region)) !== null) {
    const word = m[1];
    // Does an open-paren immediately follow (ignoring whitespace)?
    let j = re.lastIndex;
    while (j < region.length && /\s/.test(region[j])) {
      j++;
    }
    const hasArgs = region[j] === '(';
    const skipArgs = () => {
      if (hasArgs) {
        const close = findMatching(region, j, '(', ')');
        if (close !== -1) {
          re.lastIndex = close + 1;
        }
      }
    };
    if (MOD_RESERVED.has(word)) {
      skipArgs(); // skip returns(...)/override(...) so types/bases aren't read
      continue;
    }
    out.push(word);
    skipArgs(); // a modifier invocation mod(args) - skip its arguments
  }
  return out;
}

/** Parse contract/interface/library declarations: name, base list, body span. */
function parseContracts(content: string): ContractRange[] {
  const out: ContractRange[] = [];
  const re = /\b(?:abstract\s+)?(?:contract|interface|library)\s+([A-Za-z_$][\w$]*)\b([^{]*)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    const between = m[2] || '';
    const bases: string[] = [];
    const isMatch = /\bis\b([\s\S]*)$/.exec(between);
    if (isMatch) {
      let depth = 0;
      let cur = '';
      for (const ch of isMatch[1]) {
        if (ch === '(') {
          depth++;
          cur += ch;
        } else if (ch === ')') {
          depth--;
          cur += ch;
        } else if (ch === ',' && depth === 0) {
          if (cur.trim()) {
            bases.push(cur.trim());
          }
          cur = '';
        } else {
          cur += ch;
        }
      }
      if (cur.trim()) {
        bases.push(cur.trim());
      }
    }
    const baseNames = bases
      .map((b) => {
        const mm = /^([A-Za-z_$][\w$.]*)/.exec(b.trim());
        return mm ? (mm[1].split('.').pop() as string) : '';
      })
      .filter(Boolean);

    const braceOpen = m.index + m[0].length - 1; // index of '{'
    const end = findMatching(content, braceOpen, '{', '}');
    out.push({ name, bases: baseNames, start: m.index, end: end === -1 ? content.length : end });
  }
  return out;
}

/** Return the innermost contract (by start position) whose body contains `idx`. */
function contractAt(contracts: ContractRange[], idx: number): string | undefined {
  let best: string | undefined;
  let bestStart = -1;
  for (const c of contracts) {
    if (idx >= c.start && idx <= c.end && c.start > bestStart) {
      best = c.name;
      bestStart = c.start;
    }
  }
  return best;
}

interface FunctionDef {
  info: FunctionInfo;
  sites: CallSite[];
}

/**
 * Parse one `.sol` file: record every function definition (global index +
 * per-contract index), the contract inheritance lists, variable types, and
 * the call sites of each function.
 */
function indexSolFile(
  filePath: string,
  functions: Map<string, FunctionInfo>,
  hasBody: Map<string, boolean>,
  functionsByContract: Map<string, Map<string, FunctionInfo>>,
  overloadsByContract: Map<string, Map<string, FunctionInfo[]>>,
  contractBases: Map<string, string[]>,
  varTypesByContract: Map<string, Map<string, string>>,
  modifiersByContract: Map<string, Map<string, ModifierDef>>,
  defs: FunctionDef[]
): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  // Parse against a comment-blanked copy (same length/offsets) so we never
  // match `contract`/`function`/braces inside comments.
  content = blankComments(content);

  const contracts = parseContracts(content);
  for (const c of contracts) {
    if (!contractBases.has(c.name)) {
      contractBases.set(c.name, c.bases);
    }
    // Variable types declared anywhere in this contract (state vars, params, locals).
    let vt = varTypesByContract.get(c.name);
    if (!vt) {
      vt = new Map<string, string>();
      varTypesByContract.set(c.name, vt);
    }
    scanVarTypes(content.slice(c.start, c.end), vt);
  }

  // Modifier definitions: `modifier <name>[(params)] [virtual|override(...)] { ... }`
  // (or `;` for a virtual declaration). Recorded per defining contract.
  const modRe = /\bmodifier\s+([A-Za-z_$][\w$]*)/g;
  let mod: RegExpExecArray | null;
  while ((mod = modRe.exec(content)) !== null) {
    const modName = mod[1];
    const modStart = lineOf(content, mod.index);
    const modContract = contractAt(contracts, mod.index);
    if (!modContract) {
      continue;
    }
    // Skip an optional parameter list, then find the body brace or `;`.
    let scanFrom = mod.index + mod[0].length;
    const afterName = scanForFirst(content, scanFrom, new Set(['(', '{', ';']));
    if (afterName !== -1 && content[afterName] === '(') {
      const pClose = findMatching(content, afterName, '(', ')');
      if (pClose === -1) {
        continue;
      }
      scanFrom = pClose + 1;
    }
    const modMarker = scanForFirst(content, scanFrom, new Set(['{', ';']));
    if (modMarker === -1) {
      continue;
    }
    let modEnd: number;
    if (content[modMarker] === ';') {
      modEnd = lineOf(content, modMarker);
    } else {
      const close = findMatching(content, modMarker, '{', '}');
      if (close === -1) {
        continue;
      }
      modEnd = lineOf(content, close);
    }
    let cmod = modifiersByContract.get(modContract);
    if (!cmod) {
      cmod = new Map<string, ModifierDef>();
      modifiersByContract.set(modContract, cmod);
    }
    if (!cmod.has(modName)) {
      cmod.set(modName, { file: filePath, startLine: modStart, endLine: modEnd, contract: modContract });
    }
  }

  const fnRe = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(content)) !== null) {
    const name = m[1];

    const paramOpen = m.index + m[0].length - 1; // index of '('
    const paramClose = findMatching(content, paramOpen, '(', ')');
    if (paramClose === -1) {
      continue;
    }
    const marker = scanForFirst(content, paramClose + 1, new Set(['{', ';']));
    if (marker === -1) {
      continue;
    }

    const startLine = lineOf(content, m.index);
    const isDeclaration = content[marker] === ';';
    const contract = contractAt(contracts, m.index);

    if (isDeclaration) {
      // Declarations (interfaces/abstract) only fill the global index as a
      // last resort; they are NOT used for contract-aware resolution.
      if (!functions.has(name)) {
        functions.set(name, {
          name,
          file: filePath,
          startLine,
          endLine: lineOf(content, marker),
          calls: [],
          contract
        });
        hasBody.set(name, false);
      }
      continue;
    }

    const bodyClose = findMatching(content, marker, '{', '}');
    if (bodyClose === -1) {
      continue;
    }
    const endLine = lineOf(content, bodyClose);
    const body = content.slice(marker + 1, bodyClose);
    const modifierNames = extractModifiers(content.slice(paramClose + 1, marker));
    const info: FunctionInfo = {
      name,
      file: filePath,
      startLine,
      endLine,
      calls: [],
      paramCount: countArgs(content.slice(paramOpen + 1, paramClose)),
      contract
    };
    if (modifierNames.length) {
      info.modifierNames = modifierNames;
    }
    defs.push({ info, sites: extractCallSites(body) });

    // Global index: prefer an implementation over a bare declaration.
    if (!functions.has(name) || !hasBody.get(name)) {
      functions.set(name, info);
      hasBody.set(name, true);
    }

    // Per-contract index. functionsByContract keeps the first def (name-only
    // resolution / existence checks); overloadsByContract keeps ALL of them so
    // a call can be resolved to the overload whose arity matches.
    if (contract) {
      let cm = functionsByContract.get(contract);
      if (!cm) {
        cm = new Map<string, FunctionInfo>();
        functionsByContract.set(contract, cm);
      }
      if (!cm.has(name)) {
        cm.set(name, info);
      }
      let om = overloadsByContract.get(contract);
      if (!om) {
        om = new Map<string, FunctionInfo[]>();
        overloadsByContract.set(contract, om);
      }
      const list = om.get(name);
      if (list) {
        list.push(info);
      } else {
        om.set(name, [info]);
      }
    }
  }
}

/** Strip a Slither node label down to a bare function name. */
function baseName(label: string): string {
  let name = label.trim();
  const dot = name.lastIndexOf('.');
  if (dot !== -1) {
    name = name.slice(dot + 1);
  }
  const paren = name.indexOf('(');
  if (paren !== -1) {
    name = name.slice(0, paren);
  }
  return name.trim();
}

/**
 * Parse the DOT call-graph(s) embedded in Slither's `--json` output into a
 * map of caller -> set of callee names.
 */
function parseCallGraphEdges(json: any): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();

  const dotChunks: string[] = [];
  const printers = json?.results?.printers;
  if (Array.isArray(printers)) {
    for (const printer of printers) {
      const elements = printer?.elements;
      if (Array.isArray(elements)) {
        for (const el of elements) {
          if (typeof el?.content === 'string') {
            dotChunks.push(el.content);
          }
        }
      }
      if (typeof printer?.content === 'string') {
        dotChunks.push(printer.content);
      }
    }
  }

  for (const dot of dotChunks) {
    // Map node id -> human label, e.g. "0_foo" [label="foo"]
    const idToLabel = new Map<string, string>();
    const nodeRe = /"([^"]+)"\s*\[label\s*=\s*"([^"]*)"/g;
    let nm: RegExpExecArray | null;
    while ((nm = nodeRe.exec(dot)) !== null) {
      idToLabel.set(nm[1], nm[2]);
    }

    const edgeRe = /"([^"]+)"\s*->\s*"([^"]+)"/g;
    let em: RegExpExecArray | null;
    while ((em = edgeRe.exec(dot)) !== null) {
      const src = baseName(idToLabel.get(em[1]) ?? em[1]);
      const dst = baseName(idToLabel.get(em[2]) ?? em[2]);
      if (!src || !dst) { continue; }
      if (!edges.has(src)) { edges.set(src, new Set<string>()); }
      edges.get(src)!.add(dst);
    }
  }

  return edges;
}

/** True when the exec error means the `slither` binary was not found. */
function isCommandNotFound(err: any): boolean {
  if (!err) { return false; }
  if (err.code === 'ENOENT') { return true; }
  if (err.code === 127) { return true; }
  const text = String(err.stderr ?? err.message ?? '');
  return /not found|not recognized|no such file|command not found/i.test(text);
}

/**
 * Build the project function index, then enrich call edges with Slither's
 * resolved call graph when the binary is available.
 */
export async function runSlither(projectPath: string): Promise<SlitherResult> {
  // 1. Source index - reliable line ranges, works without Slither.
  const functions = new Map<string, FunctionInfo>();
  const hasBody = new Map<string, boolean>();
  const functionsByContract = new Map<string, Map<string, FunctionInfo>>();
  const overloadsByContract = new Map<string, Map<string, FunctionInfo[]>>();
  const contractBases = new Map<string, string[]>();
  const varTypesByContract = new Map<string, Map<string, string>>();
  const modifiersByContract = new Map<string, Map<string, ModifierDef>>();
  const defs: FunctionDef[] = [];

  // Gather files: the project tree (skips node_modules) PLUS the dependency
  // dirs the project's remappings point to (which may live under node_modules,
  // e.g. @openzeppelin/contracts-upgradeable). Dedup by real path so files
  // reachable both ways (lib/) are indexed once.
  const seenReal = new Set<string>();
  const filesToIndex: string[] = [];
  const addFile = (f: string) => {
    let key = f;
    try {
      key = fs.realpathSync(f);
    } catch {
      /* keep raw path */
    }
    if (!seenReal.has(key)) {
      seenReal.add(key);
      filesToIndex.push(f);
    }
  };
  for (const file of walkSolFiles(projectPath)) {
    addFile(file);
  }
  const visitedDirs = new Set<string>();
  const budget = { left: 6000 }; // safety cap on remapping-sourced files
  for (const dir of readRemappingDirs(projectPath)) {
    walkRemappedDir(dir, addFile, visitedDirs, budget);
  }

  for (const file of filesToIndex) {
    indexSolFile(
      file,
      functions,
      hasBody,
      functionsByContract,
      overloadsByContract,
      contractBases,
      varTypesByContract,
      modifiersByContract,
      defs
    );
  }

  // 2. Try Slither for accurate call resolution.
  let slitherAvailable = true;
  const outFile = path.join(os.tmpdir(), 'slither-out.json');
  try {
    fs.rmSync(outFile, { force: true });
  } catch {
    /* ignore */
  }

  let edges = new Map<string, Set<string>>();
  try {
    await execAsync(
      `slither . --print call-graph --json "${outFile}"`,
      { cwd: projectPath, maxBuffer: 1024 * 1024 * 128 }
    );
  } catch (err) {
    if (isCommandNotFound(err)) {
      slitherAvailable = false;
    }
    // Otherwise Slither ran but exited non-zero (e.g. compile warning) - the
    // JSON may still have been written, so we fall through and try to read it.
  }

  if (slitherAvailable) {
    try {
      if (fs.existsSync(outFile)) {
        const json = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        edges = parseCallGraphEdges(json);
      }
    } catch {
      /* malformed output - fall back to body-derived calls */
    }
  }

  const result: SlitherResult = {
    functions,
    functionsByContract,
    overloadsByContract,
    contractBases,
    varTypesByContract,
    modifiersByContract,
    slitherAvailable
  };

  // 3. Classify each definition's call sites (internal vs resolvable member)
  //    and resolve its modifiers to their definition locations.
  for (const { info, sites } of defs) {
    const cls = classifyCallSites(result, info.contract, sites);
    info.calls = cls.calls;
    info.memberCalls = cls.memberCalls;
    info.callArity = cls.callArity;
    info.modifiers = resolveModifiers(result, info.contract, info.modifierNames);
  }

  return result;
}

/**
 * Search a contract's base chain (super order: last-listed base first, then up)
 * for an implementation of `name`. Approximates Solidity's C3 `super` lookup.
 */
function searchBases(
  functionsByContract: Map<string, Map<string, FunctionInfo>>,
  contractBases: Map<string, string[]>,
  contract: string,
  name: string
): FunctionInfo | null {
  const visited = new Set<string>();
  const queue = [...(contractBases.get(contract) || [])].reverse();
  while (queue.length) {
    const base = queue.shift() as string;
    if (visited.has(base)) {
      continue;
    }
    visited.add(base);
    const cm = functionsByContract.get(base);
    const f = cm && cm.get(name);
    if (f) {
      return f;
    }
    const bb = contractBases.get(base);
    if (bb) {
      for (const x of [...bb].reverse()) {
        if (!visited.has(x)) {
          queue.push(x);
        }
      }
    }
  }
  return null;
}

/** True if `method` has an in-project implementation in `type` or its bases. */
function resolvableInType(result: SlitherResult, type: string, method: string): boolean {
  if (result.functionsByContract.get(type)?.has(method)) {
    return true;
  }
  return !!searchBases(result.functionsByContract, result.contractBases, type, method);
}

/** True if `name` is an in-project contract/library/interface (a usable type). */
function isProjectType(result: SlitherResult, name: string): boolean {
  return result.functionsByContract.has(name) || result.contractBases.has(name);
}

/** Find the declared type of variable `recv` visible in `contract` (+ bases). */
function lookupReceiverType(
  result: SlitherResult,
  contract: string,
  recv: string
): string | undefined {
  const visited = new Set<string>();
  const queue = [contract];
  while (queue.length) {
    const c = queue.shift() as string;
    if (visited.has(c)) {
      continue;
    }
    visited.add(c);
    const vt = result.varTypesByContract.get(c);
    if (vt && vt.has(recv)) {
      return vt.get(recv);
    }
    for (const b of result.contractBases.get(c) || []) {
      if (!visited.has(b)) {
        queue.push(b);
      }
    }
  }
  return undefined;
}

/**
 * Classify call sites of a function in `contract` into:
 * - `calls`: internal / this / super method names resolvable in the contract chain;
 * - `memberCalls`: `recv.method()` where recv's type is an in-project contract
 *   and the method resolves there.
 */
export function classifyCallSites(
  result: SlitherResult,
  contract: string | undefined,
  sites: CallSite[]
): { calls: string[]; memberCalls: MemberCall[]; callArity: Record<string, number> } {
  const calls = new Set<string>();
  const memberCalls: MemberCall[] = [];
  const seen = new Set<string>();
  const callArity: Record<string, number> = {};

  for (const s of sites) {
    if (s.recv === null || s.recv === 'this') {
      // Internal call.
      if (contract && resolvableInType(result, contract, s.name)) {
        calls.add(s.name);
        callArity[s.name] = s.argCount;
      }
    } else if (s.recv === 'super') {
      if (contract && searchBases(result.functionsByContract, result.contractBases, contract, s.name)) {
        calls.add(s.name);
        callArity[s.name] = s.argCount;
      }
    } else if (s.recv) {
      // Member call `recv.method()`. `recv` is either a variable (use its
      // declared type) or a library/contract name called directly, e.g.
      // `Math.mulDivRoundingUp(...)` or `SafeERC20.safeTransfer(...)`.
      let type = contract ? lookupReceiverType(result, contract, s.recv) : undefined;
      if (!type && isProjectType(result, s.recv)) {
        type = s.recv;
      }
      if (type && resolvableInType(result, type, s.name)) {
        const key = s.recv + ' ' + s.name;
        if (!seen.has(key)) {
          seen.add(key);
          memberCalls.push({ recv: s.recv, method: s.name, contract: type });
        }
        callArity[s.name] = s.argCount;
      }
    }
  }
  return { calls: [...calls], memberCalls, callArity };
}

/** Classify the call sites of an arbitrary body (used for the first card). */
export function classifyCalls(
  result: SlitherResult,
  contract: string | undefined,
  body: string
): { calls: string[]; memberCalls: MemberCall[]; callArity: Record<string, number> } {
  return classifyCallSites(result, contract, extractCallSites(body));
}

/**
 * Resolve a call to its FunctionInfo using contract context.
 * - `super.X` from contract C → the implementation in C's base chain.
 * - `X` from C → C's own implementation, else a base's.
 * When `strict` (member/internal calls from the UI), there is NO global
 * fallback - an unresolved call returns null rather than a same-named function
 * from an unrelated contract.
 */
/** Pick the overload whose parameter count matches `argCount` (else null). */
function pickOverload(list: FunctionInfo[] | undefined, argCount: number): FunctionInfo | null {
  if (!list) {
    return null;
  }
  return list.find((f) => f.paramCount === argCount) || null;
}

/** Search the base chain for an overload of `name` with matching arity. */
function searchOverloadBases(
  overloadsByContract: Map<string, Map<string, FunctionInfo[]>>,
  contractBases: Map<string, string[]>,
  contract: string,
  name: string,
  argCount: number
): FunctionInfo | null {
  const visited = new Set<string>();
  const queue = [...(contractBases.get(contract) || [])].reverse();
  while (queue.length) {
    const base = queue.shift() as string;
    if (visited.has(base)) {
      continue;
    }
    visited.add(base);
    const ov = pickOverload(overloadsByContract.get(base)?.get(name), argCount);
    if (ov) {
      return ov;
    }
    for (const x of [...(contractBases.get(base) || [])].reverse()) {
      if (!visited.has(x)) {
        queue.push(x);
      }
    }
  }
  return null;
}

export function resolveCall(
  result: SlitherResult,
  name: string,
  fromContract?: string,
  isSuper?: boolean,
  strict?: boolean,
  argCount?: number
): FunctionInfo | null {
  const { functions, functionsByContract, overloadsByContract, contractBases } = result;
  if (fromContract) {
    // Arity-aware: when the call site's argument count is known, prefer the
    // overload whose parameter count matches (this is how Solidity dispatches
    // overloaded functions). Falls through to name-only resolution otherwise.
    if (argCount != null) {
      if (!isSuper) {
        const ownOv = pickOverload(overloadsByContract.get(fromContract)?.get(name), argCount);
        if (ownOv) {
          return ownOv;
        }
      }
      const baseOv = searchOverloadBases(overloadsByContract, contractBases, fromContract, name, argCount);
      if (baseOv) {
        return baseOv;
      }
    }
    if (!isSuper) {
      const own = functionsByContract.get(fromContract)?.get(name);
      if (own) {
        return own;
      }
    }
    const viaBase = searchBases(functionsByContract, contractBases, fromContract, name);
    if (viaBase) {
      return viaBase;
    }
    if (strict) {
      return null;
    }
  }
  return functions.get(name) || null;
}

/** Search a contract's base chain for a modifier definition (super order). */
function searchModifierBases(
  modifiersByContract: Map<string, Map<string, ModifierDef>>,
  contractBases: Map<string, string[]>,
  contract: string,
  name: string
): ModifierDef | null {
  const visited = new Set<string>();
  const queue = [...(contractBases.get(contract) || [])].reverse();
  while (queue.length) {
    const base = queue.shift() as string;
    if (visited.has(base)) {
      continue;
    }
    visited.add(base);
    const def = modifiersByContract.get(base)?.get(name);
    if (def) {
      return def;
    }
    const bb = contractBases.get(base);
    if (bb) {
      for (const x of [...bb].reverse()) {
        if (!visited.has(x)) {
          queue.push(x);
        }
      }
    }
  }
  return null;
}

/**
 * Resolve modifier names to their definition locations (own contract, then base
 * chain). An unresolved modifier (e.g. inherited from out-of-scope code) is
 * still returned by name so the chip shows, but it carries no location and the
 * UI renders it as non-clickable.
 */
export function resolveModifiers(
  result: SlitherResult,
  contract: string | undefined,
  names: string[] | undefined
): ResolvedModifier[] {
  if (!names || names.length === 0) {
    return [];
  }
  const out: ResolvedModifier[] = [];
  for (const name of names) {
    let def: ModifierDef | null | undefined;
    if (contract) {
      def = result.modifiersByContract.get(contract)?.get(name);
      if (!def) {
        def = searchModifierBases(
          result.modifiersByContract,
          result.contractBases,
          contract,
          name
        );
      }
    }
    if (def) {
      out.push({ name, file: def.file, startLine: def.startLine, contract: def.contract });
    } else {
      out.push({ name });
    }
  }
  return out;
}

/**
 * Read `filePath` and return lines `startLine`..`endLine` (1-based, inclusive).
 */
export function getFunctionCode(filePath: string, startLine: number, endLine: number): string {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return '// Не удалось прочитать файл: ' + filePath;
  }
  const lines = content.split(/\r?\n/);
  const from = Math.max(0, startLine - 1);
  const to = Math.min(lines.length, endLine);
  return lines.slice(from, to).join('\n');
}

/**
 * Determine the name of the function enclosing `position` by scanning upward
 * for a `function <name>` declaration.
 */
export function getFunctionAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): string | null {
  const fnRe = /\bfunction\s+([A-Za-z_$][\w$]*)/;

  // Check the current line first, then walk upward to find the enclosing definition.
  for (let line = position.line; line >= 0; line--) {
    const text = document.lineAt(line).text;
    const match = fnRe.exec(text);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/**
 * Resolve the exact function (name + full body range + candidate calls) that
 * encloses `position` in `document`. Unlike the project-wide index, this works
 * directly on the open document so the first card always shows the real body
 * under the cursor - never a same-named interface declaration.
 */
export function getEnclosingFunction(
  document: vscode.TextDocument,
  position: vscode.Position
): FunctionInfo | null {
  const content = blankComments(document.getText());
  const offset = document.offsetAt(position);
  const contracts = parseContracts(content);

  const fnRe = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let best: FunctionInfo | null = null;
  let bestStart = -1;

  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(content)) !== null) {
    const name = m[1];
    const paramOpen = m.index + m[0].length - 1;
    const paramClose = findMatching(content, paramOpen, '(', ')');
    if (paramClose === -1) {
      continue;
    }
    const marker = scanForFirst(content, paramClose + 1, new Set(['{', ';']));
    if (marker === -1) {
      continue;
    }

    let defEnd: number;
    let body = '';
    if (content[marker] === ';') {
      defEnd = marker;
    } else {
      const bodyClose = findMatching(content, marker, '{', '}');
      if (bodyClose === -1) {
        continue;
      }
      defEnd = bodyClose;
      body = content.slice(marker + 1, bodyClose);
    }

    // The cursor must sit within the definition; prefer the innermost match.
    if (offset >= m.index && offset <= defEnd && m.index > bestStart) {
      bestStart = m.index;
      const modifierNames = extractModifiers(content.slice(paramClose + 1, marker));
      best = {
        name,
        file: document.uri.fsPath,
        startLine: lineOf(content, m.index),
        endLine: lineOf(content, defEnd),
        calls: [],
        contract: contractAt(contracts, m.index),
        modifierNames: modifierNames.length ? modifierNames : undefined,
        body: body // extension classifies calls/memberCalls against the index
      };
    }
  }

  return best;
}
