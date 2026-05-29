// @ts-nocheck
const vscode = acquireVsCodeApi();

// Active-language UI strings, injected by the host (flowboardPanel.loadWebview)
// as window.__L__. Empty object fallback keeps the board usable if absent.
const L = (typeof window !== 'undefined' && window.__L__) || {};

const flowboard = document.getElementById('flowboard'); // viewport
const world = document.getElementById('world'); // transformed layer
const svg = document.getElementById('edges');
const emptyState = document.getElementById('empty-state');
const clearBtn = document.getElementById('clear-btn');
const undoBtn = document.getElementById('undo-btn');
const addNoteBtn = document.getElementById('add-note-btn');
const modeBtn = document.getElementById('mode-btn');
const searchBtn = document.getElementById('search-btn');
const linkBtn = document.getElementById('link-btn');
const zoomLabel = document.getElementById('zoom-level');

const SVG_NS = 'http://www.w3.org/2000/svg';
const CARD_GAP_X = 60; // horizontal gap between a parent and its children
const CARD_GAP_Y = 80; // vertical stagger between sibling children
const MIN_SCALE = 0.15;
const MAX_SCALE = 3;
const FONT_SIZES = [12, 14, 18, 24, 30, 36, 48, 60, 72, 80];
const NOTE_MIN_W = 160;
const NOTE_MIN_H = 48;

// State -------------------------------------------------------------------
// Cards are keyed by a unique instance id (NOT function name): the same
// function can appear multiple times, once per call site that opened it.
/** id -> { el, id, name, x, y, childCount, data } (x/y are world coordinates) */
const cards = new Map();
/** { from, to } pairs (parent id -> child id) drawn as connecting lines */
const edges = [];
/** childId -> parent call-site index, set when expanding so the new card can record it */
const pendingChildSite = new Map();
/** id -> { el, id, x, y, fontSize, color, textEl } */
const notes = new Map();
/** Models (card or note) currently selected in 'select' mode. */
const selected = new Set();
let rootSpawnIndex = 0;
let noteSeq = 0;
let cardSeq = 0;

function genCardId() {
  return 'c' + ++cardSeq;
}

// Interaction mode: 'pan' (hand, drag canvas) or 'select' (marquee-select).
let mode = 'pan';

// Copy/paste of windows + last pointer position (client coords) for paste.
let clipboard = null;
let lastPointer = null;

// Marquee rectangle overlay (screen-space, inside the viewport).
const marquee = document.createElement('div');
marquee.className = 'marquee';
marquee.style.display = 'none';
flowboard.appendChild(marquee);

// Give the webview keyboard focus on any click that is not text editing, so
// Ctrl+C/V/Z, Ctrl+F, "1", Backspace etc. actually reach our handlers.
flowboard.addEventListener(
  'mousedown',
  (e) => {
    const t = e.target;
    if (!(t && t.closest && t.closest('[contenteditable], input, select, textarea, .card-title'))) {
      flowboard.focus({ preventScroll: true });
    }
  },
  true
);

// Camera: world point P maps to screen as  screen = pan + P * scale
let scale = 1;
let panX = 0;
let panY = 0;

function applyTransform() {
  world.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
  if (zoomLabel) {
    zoomLabel.textContent = Math.round(scale * 100) + '%';
  }
}

/** Convert a viewport (client) point into world coordinates. */
function screenToWorld(clientX, clientY) {
  const rect = flowboard.getBoundingClientRect();
  return {
    x: (clientX - rect.left - panX) / scale,
    y: (clientY - rect.top - panY) / scale
  };
}

function updateEmptyState() {
  emptyState.style.display = cards.size === 0 && notes.size === 0 ? '' : 'none';
}

// Mode + selection ---------------------------------------------------------
function clearSelection() {
  selected.forEach((m) => m.el.classList.remove('selected'));
  selected.clear();
}

function selectModel(m) {
  if (!selected.has(m)) {
    selected.add(m);
    m.el.classList.add('selected');
  }
}

function setMode(next) {
  mode = next;
  clearSelection();
  flowboard.classList.toggle('mode-select', mode === 'select');
  modeBtn.textContent = mode === 'select' ? L.modeSelect : L.modeHand;
}

function toggleMode() {
  setMode(mode === 'pan' ? 'select' : 'pan');
}

/** Select every card/note whose screen rect intersects the given client rect. */
function applyMarqueeSelection(left, top, right, bottom, additive) {
  if (!additive) {
    clearSelection();
  }
  const test = (m) => {
    const q = m.el.getBoundingClientRect();
    const hit = !(q.right < left || q.left > right || q.bottom < top || q.top > bottom);
    if (hit) {
      selectModel(m);
    }
  };
  cards.forEach(test);
  notes.forEach(test);
}

// Persistence (debounced) --------------------------------------------------
let persistTimer = null;
// Auto-save stays off until the initial restore handshake completes, so a
// freshly added card cannot overwrite a saved board before it is restored.
let canPersist = false;

// Undo history: full snapshots of past states. Only content changes
// (cards/edges/notes), not pure pan/zoom, create an undo step.
const undoStack = [];
let lastSnapshotJson = null;
let lastContentKey = null;

function snapshot() {
  return {
    cards: [...cards.values()].map((c) => Object.assign({}, c.data, { x: c.x, y: c.y })),
    edges: edges.map((e) => ({ from: e.from, to: e.to })),
    notes: [...notes.values()].map((n) => ({
      id: n.id,
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
      html: n.textEl.innerHTML,
      fontSize: n.fontSize,
      color: n.color,
      bg: n.bg,
      bold: !!n.bold
    })),
    camera: { scale: scale, panX: panX, panY: panY }
  };
}

/** Content fingerprint (ignores camera) - used to decide undo steps. */
function contentKey(s) {
  return JSON.stringify({ cards: s.cards, edges: s.edges, notes: s.notes });
}

function updateUndoButton() {
  if (undoBtn) {
    undoBtn.disabled = undoStack.length === 0;
  }
}

function persistNow() {
  const s = snapshot();
  const ck = contentKey(s);
  // Push an undo step only when content (not just the camera) changed.
  if (lastContentKey !== null && ck !== lastContentKey && lastSnapshotJson !== null) {
    undoStack.push(lastSnapshotJson);
    if (undoStack.length > 100) {
      undoStack.shift();
    }
  }
  lastContentKey = ck;
  lastSnapshotJson = JSON.stringify(s);
  vscode.postMessage({ type: 'persist', state: s });
  updateUndoButton();
}

function schedulePersist() {
  if (!canPersist) {
    return; // wait for the initial restore handshake
  }
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, 400);
}

// Solidity tokens for lightweight highlighting -----------------------------
const KEYWORDS = new Set([
  'pragma', 'solidity', 'contract', 'interface', 'library', 'abstract', 'is',
  'function', 'modifier', 'constructor', 'event', 'emit', 'struct', 'enum',
  'mapping', 'returns', 'return', 'if', 'else', 'for', 'while', 'do', 'break',
  'continue', 'require', 'assert', 'revert', 'try', 'catch', 'new', 'delete',
  'using', 'import', 'public', 'private', 'internal', 'external', 'view', 'pure',
  'payable', 'nonpayable', 'memory', 'storage', 'calldata', 'constant', 'immutable',
  'virtual', 'override', 'indexed', 'anonymous', 'unchecked', 'assembly', 'this',
  'super', 'true', 'false', 'wei', 'gwei', 'ether', 'seconds', 'minutes', 'hours',
  'days', 'weeks', 'type', 'msg', 'block', 'tx', 'now', 'abi'
]);

const TYPES = new Set([
  'address', 'bool', 'string', 'bytes', 'byte', 'uint', 'int', 'fixed', 'ufixed',
  'uint8', 'uint16', 'uint32', 'uint64', 'uint96', 'uint128', 'uint160', 'uint256',
  'int8', 'int16', 'int32', 'int64', 'int128', 'int256',
  'bytes1', 'bytes2', 'bytes4', 'bytes8', 'bytes16', 'bytes32'
]);

function esc(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** From a ')' at closeIdx, return the index of its matching '(' (or -1). */
function matchParenBackwardJS(s, closeIdx) {
  let depth = 0;
  for (let i = closeIdx; i >= 0; i--) {
    if (s[i] === ')') {
      depth++;
    } else if (s[i] === '(') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Highlight Solidity source and mark CLICKABLE call tokens. A token is
 * clickable only if it resolves: an internal/this/super call resolvable in the
 * card's contract chain, or a member call `recv.method` whose receiver type is
 * an in-project contract. `model` carries `internalSet`, `memberMap`, contract.
 */
function highlightSolidity(code, model) {
  const internalSet = model.internalSet;
  const memberMap = model.memberMap;
  const cardContract = model.data.contract || '';

  const tokenRe =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\b(0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:e[0-9]+)?)\b|([A-Za-z_$][\w$]*)/g;

  let out = '';
  let last = 0;
  let m;
  while ((m = tokenRe.exec(code)) !== null) {
    out += esc(code.slice(last, m.index));
    const [full, comment, str, num, ident] = m;
    if (comment) {
      out += '<span class="tok-comment">' + esc(comment) + '</span>';
    } else if (str) {
      out += '<span class="tok-string">' + esc(str) + '</span>';
    } else if (num) {
      out += '<span class="tok-number">' + esc(num) + '</span>';
    } else if (ident) {
      if (KEYWORDS.has(ident)) {
        out += '<span class="tok-keyword">' + ident + '</span>';
      } else if (TYPES.has(ident)) {
        out += '<span class="tok-type">' + ident + '</span>';
      } else {
        const before = code.slice(0, m.index);
        const after = code.slice(m.index + ident.length);
        const isCall = /^\s*\(/.test(after);
        const isDef = /\bfunction\s+$/.test(before);
        let clickable = false;
        let isSuper = false;
        let contract = '';
        // What to resolve on click (usually the token; for `new X` it's X's constructor).
        let callName = ident;

        if (isCall && !isDef) {
          const dot = /\.\s*$/.test(before);
          if (dot) {
            const rm = /([A-Za-z_$][\w$]*)\s*\.\s*$/.exec(before);
            let recv = rm ? rm[1] : '';
            if (!recv && /\)\s*\.\s*$/.test(before)) {
              // Cast/chained receiver: `Type(expr).method` -> use the cast type.
              const trimmed = before.replace(/\s*\.\s*$/, '');
              const open = matchParenBackwardJS(trimmed, trimmed.length - 1);
              if (open !== -1) {
                const idm = /([A-Za-z_$][\w$]*)\s*$/.exec(trimmed.slice(0, open));
                if (idm) {
                  recv = idm[1];
                }
              }
            }
            if (recv === 'super') {
              if (internalSet.has(ident)) {
                clickable = true;
                isSuper = true;
                contract = cardContract;
              }
            } else if (recv === 'this') {
              if (internalSet.has(ident)) {
                clickable = true;
                contract = cardContract;
              }
            } else if (recv) {
              const t = memberMap.get(recv + ' ' + ident);
              if (t) {
                clickable = true;
                contract = t;
              }
            }
          } else if (/\bnew\s+$/.test(before) && model.newCallSet && model.newCallSet.has(ident)) {
            // `new Type(...)` -> open Type's constructor.
            clickable = true;
            contract = ident;
            callName = 'constructor';
          } else if (internalSet.has(ident)) {
            // Internal call (no receiver).
            clickable = true;
            contract = cardContract;
          }
        }

        if (clickable) {
          const arity = model.callArity ? model.callArity[ident] : undefined;
          // Unique per-occurrence id (document order within this card), so two
          // calls to the same function each get their own card.
          const site = model._site != null ? model._site : 0;
          model._site = site + 1;
          out +=
            '<span class="call" data-call="' + esc(callName) + '" data-site="' + site + '"' +
            (isSuper ? ' data-super="1"' : '') +
            (contract ? ' data-contract="' + esc(contract) + '"' : '') +
            (arity != null ? ' data-arity="' + arity + '"' : '') +
            ' title="' + esc((L.expand || '{name}').replace('{name}', ident)) + '">' + ident + '</span>';
        } else {
          out += ident; // identifiers are alphanumeric/underscore - safe
        }
      }
    }
    last = m.index + full.length;
  }
  out += esc(code.slice(last));
  return out;
}

// Cards: expand / toggle ---------------------------------------------------
/**
 * Find the open child card of `fromId` for a given call SITE (occurrence). Each
 * distinct call occurrence has its own card, so two calls to the same function
 * in one body open two cards. Falls back to matching by name only when no site
 * id is available (older/restored cards).
 */
function findChildCard(fromId, site, name) {
  for (const e of edges) {
    if (e.from !== fromId) {
      continue;
    }
    const c = cards.get(e.to);
    if (!c) {
      continue;
    }
    if (site != null) {
      if (c.parentSite === site) {
        return c;
      }
    } else if (c.name === name) {
      return c;
    }
  }
  return null;
}

/**
 * Click on a call inside card `fromId`:
 *  - if THAT call occurrence's card is already open as a child, remove it
 *    (and its subtree) - other occurrences / functions stay open;
 *  - otherwise open a new card for it, linked to this card.
 */
function activateCall(targetName, fromId, opts) {
  const site = opts && opts.site != null ? opts.site : undefined;
  const existing = findChildCard(fromId, site, targetName);
  if (existing) {
    removeSubtree(existing.id);
    schedulePersist();
    return;
  }
  // `contract` is the resolution contract: the receiver's type for member calls,
  // or the card's own contract for internal/super calls.
  const fromContract = (opts && opts.contract) || null;
  const childId = genCardId();
  // Remember which call site opened this child, so re-clicking the SAME site
  // toggles it while a different occurrence opens its own card.
  if (site != null) {
    pendingChildSite.set(childId, site);
  }
  vscode.postMessage({
    type: 'expand',
    functionName: targetName,
    fromId: fromId,
    childId: childId,
    fromContract: fromContract,
    isSuper: !!(opts && opts.isSuper),
    argCount: opts && opts.argCount != null ? opts.argCount : undefined
  });
}

/** Remove a card and its whole descendant subtree (cards form a tree). */
function removeSubtree(rootId) {
  const remove = new Set();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (remove.has(id)) {
      continue;
    }
    remove.add(id);
    edges.forEach((e) => {
      if (e.from === id) {
        stack.push(e.to);
      }
    });
  }
  remove.forEach((id) => {
    const c = cards.get(id);
    if (c) {
      selected.delete(c);
      c.el.remove();
      cards.delete(id);
    }
  });
  for (let i = edges.length - 1; i >= 0; i--) {
    if (remove.has(edges[i].from) || remove.has(edges[i].to)) {
      edges.splice(i, 1);
    }
  }
  redrawEdges();
  updateEmptyState();
}

// Card rendering -----------------------------------------------------------
function placeCard(data) {
  if (typeof data.x === 'number' && typeof data.y === 'number') {
    return { x: data.x, y: data.y };
  }
  const parent = data.parentId ? cards.get(data.parentId) : undefined;
  if (parent) {
    const x = parent.x + parent.el.offsetWidth + CARD_GAP_X;
    const y = parent.y + parent.childCount * CARD_GAP_Y;
    parent.childCount += 1;
    return { x, y };
  }
  // Root cards appear near the top-left of the CURRENT view (like notes), with a
  // small cascade so repeated additions don't perfectly overlap.
  const step = (rootSpawnIndex % 8) * 28;
  const x = (-panX + 60) / scale + step;
  const y = (-panY + 60) / scale + step;
  rootSpawnIndex += 1;
  return { x, y };
}

/**
 * Remove developer comments (// and block) while keeping code and original
 * blank lines. String literals are respected. A line that becomes empty solely
 * because it was comment-only is dropped.
 */
function stripComments(code) {
  const lines = code.split('\n');
  const out = [];
  let inBlock = false;

  for (const line of lines) {
    let res = '';
    let hadComment = false;
    let inStr = false;
    let strCh = '';
    let i = 0;

    while (i < line.length) {
      const c = line[i];
      const n = i + 1 < line.length ? line[i + 1] : '';
      if (inBlock) {
        hadComment = true;
        if (c === '*' && n === '/') {
          inBlock = false;
          i += 2;
        } else {
          i++;
        }
        continue;
      }
      if (inStr) {
        res += c;
        if (c === '\\') {
          res += n;
          i += 2;
          continue;
        }
        if (c === strCh) {
          inStr = false;
        }
        i++;
        continue;
      }
      if (c === '/' && n === '/') {
        hadComment = true;
        break; // rest of the line is a comment
      }
      if (c === '/' && n === '*') {
        inBlock = true;
        hadComment = true;
        i += 2;
        continue;
      }
      if (c === '"' || c === "'") {
        inStr = true;
        strCh = c;
        res += c;
        i++;
        continue;
      }
      res += c;
      i++;
    }

    const trimmedRight = res.replace(/\s+$/, '');
    // Drop lines that existed only to hold a comment.
    if (trimmedRight.trim() === '' && hadComment && line.trim() !== '') {
      continue;
    }
    out.push(trimmedRight);
  }

  return out.join('\n');
}

/**
 * Render a card's code line-by-line, inserting AI annotations under the
 * relevant lines when annotation mode is on. Rebinds inline call clicks.
 */
/** Detect function visibility from its (comment-stripped) signature. */
function detectFunctionVisibility(code) {
  const braceIdx = code.indexOf('{');
  const header = braceIdx === -1 ? code : code.slice(0, braceIdx);
  if (/\b(external|public)\b/.test(header)) {
    return 'public';
  }
  if (/\b(internal|private)\b/.test(header)) {
    return 'internal';
  }
  return '';
}

/** True if the function has the `payable` state mutability (not `address payable`). */
function isPayableFunction(code) {
  const braceIdx = code.indexOf('{');
  let header = braceIdx === -1 ? code : code.slice(0, braceIdx);
  header = header.replace(/address\s+payable/g, 'address'); // ignore payable-address types
  return /\bpayable\b/.test(header);
}

// Modifier names that imply access control (heuristic, matches onlyOwner/onlyRole/etc.).
const ACCESS_MODIFIER_RE =
  /^only|owner|role|admin|auth|govern|operator|manager|keeper|minter|burner|controller|guardian|whitelist|permission|restricted|gated/i;

/**
 * Detect security-relevant traits of a function from its (comment-stripped)
 * code and resolved modifiers. Returns an ordered list of {emoji, title}
 * badges shown after the function name. Order is fixed (access control first).
 */
function detectBadges(model) {
  const code = model.clean || '';
  const braceIdx = code.indexOf('{');
  const header = braceIdx === -1 ? code : code.slice(0, braceIdx);
  const body = braceIdx === -1 ? '' : code.slice(braceIdx);
  const mods = (model.data && model.data.modifiers) || [];
  const badges = [];

  // 🔐 access control: an access-control modifier, or an msg.sender comparison.
  const hasAccessModifier = mods.some((m) => ACCESS_MODIFIER_RE.test(m.name || ''));
  const hasSenderCheck = /msg\.sender\s*(==|!=)/.test(code);
  if (hasAccessModifier || hasSenderCheck) {
    badges.push({ emoji: '🔐', title: L.badgeAccess });
  }

  // 💰 payable, or pulls tokens IN via (safe)transferFrom. The `From` suffix
  // distinguishes incoming pulls (💰) from outgoing transfers (💸 below).
  const pullsTokens = /(?:safeTransferFrom|transferFrom)\s*\(/.test(body);
  if (isPayableFunction(code) || pullsTokens) {
    badges.push({ emoji: '💰', title: L.badgePayable });
  }

  // Outgoing ETH via the `{value: ...}(...)` call option applies to ANY external
  // call (e.g. `vault.deposit{value: x}(...)`), not just low-level `.call`. The
  // trailing `(` after the option group distinguishes it from a struct literal
  // `{value: x}` (which is followed by `)` or `,`, never `(`).
  const sendsValue = /\{[^{}]*\bvalue\s*:[^{}]*\}\s*\(/.test(body);
  const dataCall = /\.call\s*\(/.test(body); // low-level .call(data) - no value
  // Outgoing value: ETH send, or token transfer/safeTransfer (NOT *From, which
  // is an incoming pull handled by 💰 above).
  const sendsEth =
    sendsValue ||
    /\.transfer\s*\(/.test(body) ||
    /\bsafeTransfer\s*\(/.test(body) ||
    /\.send\s*\(/.test(body);

  // 💸 sends ETH / tokens out.
  if (sendsEth) {
    badges.push({ emoji: '💸', title: L.badgeSends });
  }

  // 📝 storage write vs 👀 view/pure - mutually exclusive.
  if (/\b(view|pure)\b/.test(header)) {
    badges.push({ emoji: '👀', title: L.badgeView });
  } else {
    badges.push({ emoji: '📝', title: L.badgeWrite });
  }

  // ⚠️ assembly (Yul block).
  if (/\bassembly\b/.test(body)) {
    badges.push({ emoji: '⚠️', title: L.badgeAssembly });
  }

  // ☢️ delegatecall.
  if (/delegatecall/.test(body)) {
    badges.push({ emoji: '☢️', title: L.badgeDelegatecall });
  }

  // 📞 low-level call with arbitrary data (only when it is not a value call).
  if (dataCall) {
    badges.push({ emoji: '📞', title: L.badgeLowcall });
  }

  // 👁 staticcall - read-only external call.
  if (/staticcall/.test(body)) {
    badges.push({ emoji: '👁', title: L.badgeStaticcall });
  }

  // ⚡ unchecked block.
  if (/\bunchecked\s*\{/.test(body)) {
    badges.push({ emoji: '⚡', title: L.badgeUnchecked });
  }

  // 🎲 block.timestamp / block.number.
  if (/block\.(timestamp|number)/.test(code)) {
    badges.push({ emoji: '🎲', title: L.badgeBlock });
  }

  // 🪪 tx.origin.
  if (/tx\.origin/.test(code)) {
    badges.push({ emoji: '🪪', title: L.badgeTxorigin });
  }

  return badges;
}

function renderCodeBody(model) {
  const codeEl = model.codeEl;

  // Function-level summary block at the top (only in annotation mode).
  if (model.summaryEl) {
    if (model.data.showAnnotations && model.data.summary) {
      model.summaryEl.textContent = model.data.summary;
      model.summaryEl.style.display = 'block';
    } else {
      model.summaryEl.style.display = 'none';
    }
  }

  if (model.data.notFound) {
    codeEl.innerHTML = '<span class="tok-comment">// ' + esc(model.data.code) + '</span>';
    return;
  }

  const annMap =
    model.data.showAnnotations && model.data.annotations
      ? new Map(model.data.annotations.map((a) => [a.line, a.comment]))
      : null;

  const lines = model.clean.split('\n');
  let html = '';
  model._site = 0; // reset per-render so call-site ids are assigned in document order
  lines.forEach((line, i) => {
    const num = i + 1;
    const lineHtml = highlightSolidity(line, model);
    html += '<div class="code-line">' + (lineHtml === '' ? '&nbsp;' : lineHtml) + '</div>';
    if (annMap && annMap.has(num)) {
      html += '<div class="ai-comment">// ↑ ' + esc(annMap.get(num)) + '</div>';
    }
  });
  codeEl.innerHTML = html;

  codeEl.querySelectorAll('.call').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      activateCall(el.dataset.call, model.id, {
        isSuper: el.dataset.super === '1',
        contract: el.dataset.contract || null,
        argCount: el.dataset.arity != null ? Number(el.dataset.arity) : undefined,
        site: el.dataset.site != null ? Number(el.dataset.site) : undefined
      });
    });
  });
}

function addCard(data, opts) {
  const restoring = opts && opts.restoring;
  updateEmptyState();

  const id = data.id || genCardId();
  const parentId = data.parentId || null;
  // Which call site in the parent opened this card (for per-occurrence toggle).
  // Fresh cards read it from pendingChildSite; restored cards from saved data.
  const parentSite =
    data.parentSite != null
      ? data.parentSite
      : pendingChildSite.has(id)
        ? pendingChildSite.get(id)
        : null;
  pendingChildSite.delete(id);

  const pos = placeCard(data);

  const card = document.createElement('div');
  card.className = 'card' + (data.notFound ? ' not-found' : '');
  card.style.left = pos.x + 'px';
  card.style.top = pos.y + 'px';
  card.dataset.name = data.name;
  card.dataset.id = id;

  // Header (drag handle)
  const header = document.createElement('div');
  header.className = 'card-header';

  const title = document.createElement('span');
  title.className = 'card-title';
  // Show Contract::function so the resolved target is always visible.
  // Structs are shown as "struct Name" (no parens) since they aren't callable.
  const prefix = data.contract ? data.contract + '::' : '';
  title.textContent =
    data.kind === 'struct' ? prefix + 'struct ' + data.name : prefix + data.name + '()';
  header.appendChild(title);

  // Code-comments button (skipped for unresolved placeholder cards).
  let annotateBtn = null;
  if (!data.notFound) {
    const actions = document.createElement('span');
    actions.className = 'card-actions';

    annotateBtn = document.createElement('button');
    annotateBtn.type = 'button';
    annotateBtn.className = 'hdr-btn';
    annotateBtn.textContent = L.annotateLabel;
    annotateBtn.title = L.annotateTitle;

    actions.appendChild(annotateBtn);
    header.appendChild(actions);
  }

  if (data.file) {
    const meta = document.createElement('span');
    meta.className = 'card-meta meta-link';
    meta.textContent = data.file + ':' + data.startLine + '-' + data.endLine;
    meta.title = L.metaOpenTitle;
    meta.addEventListener('mousedown', (e) => e.stopPropagation());
    meta.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({
        type: 'openFile',
        fsPath: data.fsPath,
        startLine: data.startLine
      });
    });
    header.appendChild(meta);
  }

  // Modifier chips, rendered ABOVE the header (part of the card, so they move
  // with it). A resolved chip links to its `modifier <name>` definition.
  if (!data.notFound && Array.isArray(data.modifiers) && data.modifiers.length) {
    const mods = document.createElement('div');
    mods.className = 'card-modifiers';
    for (const mod of data.modifiers) {
      const chip = document.createElement('span');
      chip.className = 'modifier-chip' + (mod.file ? ' chip-link' : '');
      chip.textContent = mod.name;
      if (mod.file) {
        chip.title = L.chipOpenTitle;
        chip.addEventListener('mousedown', (e) => e.stopPropagation());
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({
            type: 'openFile',
            fsPath: mod.file,
            startLine: mod.startLine
          });
        });
      } else {
        chip.title = L.chipNotFoundTitle;
      }
      mods.appendChild(chip);
    }
    card.appendChild(mods);
  }

  card.appendChild(header);

  // AI summary block (1-3 sentences about the whole function), above the code.
  const summaryEl = document.createElement('div');
  summaryEl.className = 'ai-summary';
  summaryEl.style.display = 'none';
  card.appendChild(summaryEl);

  // Code block - rendered line-by-line so per-line comments can sit under each line.
  const pre = document.createElement('pre');
  pre.className = 'card-code';
  const codeEl = document.createElement('code');
  pre.appendChild(codeEl);
  card.appendChild(pre);

  world.appendChild(card);

  const model = {
    el: card,
    id: id,
    name: data.name,
    x: pos.x,
    y: pos.y,
    childCount: 0,
    parentSite: parentSite,
    codeEl: codeEl,
    summaryEl: summaryEl,
    annotateBtn: annotateBtn,
    // Resolvable calls: internal method names + member-call map "recv method" -> type.
    internalSet: new Set(data.calls || []),
    memberMap: new Map((data.memberCalls || []).map((mc) => [mc.recv + ' ' + mc.method, mc.contract])),
    // Types constructed via `new X(...)` here, whose constructor is navigable.
    newCallSet: new Set(data.newCalls || []),
    // Call name -> argument count, to resolve overloads (same name, different arity).
    callArity: data.callArity || {},
    // Developer comments stripped; AI comments attach to these line numbers.
    clean: data.notFound ? data.code : stripComments(data.code),
    data: {
      type: 'addCard',
      id: id,
      parentId: parentId,
      parentSite: parentSite,
      name: data.name,
      code: data.code,
      calls: data.calls || [],
      memberCalls: data.memberCalls || [],
      callArity: data.callArity || {},
      newCalls: data.newCalls || [],
      modifiers: data.modifiers || [],
      kind: data.kind || null,
      file: data.file,
      fsPath: data.fsPath,
      startLine: data.startLine,
      endLine: data.endLine,
      contract: data.contract || null,
      notFound: !!data.notFound,
      summary: data.summary || null,
      annotations: data.annotations || null,
      showAnnotations: !!data.showAnnotations
    }
  };
  cards.set(id, model);
  updateEmptyState(); // re-hide the placeholder now that a card exists

  // Colour the header by visibility (external/public vs internal/private),
  // and add emoji trait badges (payable, ETH out, delegatecall, ...) after the
  // function name.
  if (!data.notFound) {
    const vis = detectFunctionVisibility(model.clean);
    if (vis === 'public') {
      header.classList.add('hdr-public');
    } else if (vis === 'internal') {
      header.classList.add('hdr-internal');
    }
    const badges = detectBadges(model);
    if (badges.length) {
      const row = document.createElement('span');
      row.className = 'hdr-badges';
      for (const b of badges) {
        const em = document.createElement('span');
        em.className = 'hdr-emoji';
        em.textContent = b.emoji;
        em.title = b.title;
        row.appendChild(em);
      }
      title.insertAdjacentElement('afterend', row);
    }
  }

  renderCodeBody(model);

  if (annotateBtn) {
    if (model.data.showAnnotations && model.data.annotations) {
      annotateBtn.classList.add('active');
    }
    annotateBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAnnotate(model);
    });
  }

  if (parentId && !restoring) {
    addEdge(parentId, id);
  }

  makeDraggable(header, model);
  redrawEdges();

  if (!restoring) {
    schedulePersist();
  }
}

function flash(el) {
  el.classList.remove('flash');
  void el.offsetWidth; // force reflow so the animation can restart
  el.classList.add('flash');
}

// AI: per-line code comments -----------------------------------------------
function setBtnBusy(btn, busy, busyLabel) {
  if (!btn) {
    return;
  }
  if (busy) {
    if (!btn.dataset.label) {
      btn.dataset.label = btn.textContent;
    }
    btn.textContent = busyLabel || '…';
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.label || btn.textContent;
    btn.dataset.label = '';
    btn.disabled = false;
  }
}

/** Toggle the per-line annotation mode for a card (requests AI on first use). */
function toggleAnnotate(model) {
  if (model.data.showAnnotations) {
    model.data.showAnnotations = false;
    model.annotateBtn.classList.remove('active');
    renderCodeBody(model);
    redrawEdges();
    schedulePersist();
    return;
  }
  if (model.data.annotations) {
    model.data.showAnnotations = true;
    model.annotateBtn.classList.add('active');
    renderCodeBody(model);
    redrawEdges();
    schedulePersist();
    return;
  }
  // No cached annotations - ask the extension to call Claude.
  setBtnBusy(model.annotateBtn, true, L.annotating);
  vscode.postMessage({
    type: 'annotate',
    id: model.id,
    name: model.name,
    code: model.clean,
    fsPath: model.data.fsPath,
    startLine: model.data.startLine,
    endLine: model.data.endLine
  });
}

// Text notes ---------------------------------------------------------------
// Last selection made inside some note's editable text. Toolbar controls steal
// focus, so we remember it to apply formatting to that exact selection.
let noteSel = null;
document.addEventListener('selectionchange', () => {
  const s = window.getSelection();
  if (!s || !s.rangeCount) {
    return;
  }
  const r = s.getRangeAt(0);
  const node = r.startContainer;
  const host = node.nodeType === 1 ? node : node.parentElement;
  const nt = host && host.closest ? host.closest('.note-text') : null;
  if (nt) {
    noteSel = { textEl: nt, range: r.cloneRange(), collapsed: r.collapsed };
  }
});

function wrapSelectionFontSize(px) {
  const s = window.getSelection();
  if (!s.rangeCount) {
    return;
  }
  const range = s.getRangeAt(0);
  if (range.collapsed) {
    return;
  }
  const span = document.createElement('span');
  span.style.fontSize = px + 'px';
  try {
    range.surroundContents(span);
  } catch (e) {
    const frag = range.extractContents();
    span.appendChild(frag);
    range.insertNode(span);
  }
  s.removeAllRanges();
}

/** Apply a format to the active selection inside the note, else to the whole note. */
function noteApply(model, kind, value) {
  const useSel = noteSel && noteSel.textEl === model.textEl && !noteSel.collapsed;
  if (useSel) {
    model.textEl.focus();
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(noteSel.range);
    document.execCommand('styleWithCSS', false, true);
    if (kind === 'bold') {
      document.execCommand('bold');
    } else if (kind === 'color') {
      document.execCommand('foreColor', false, value);
    } else if (kind === 'size') {
      wrapSelectionFontSize(value);
    }
    const ns = window.getSelection();
    if (ns.rangeCount) {
      const nr = ns.getRangeAt(0);
      noteSel = { textEl: model.textEl, range: nr.cloneRange(), collapsed: nr.collapsed };
    }
  } else if (kind === 'bold') {
    model.bold = !model.bold;
    model.textEl.style.fontWeight = model.bold ? 'bold' : 'normal';
  } else if (kind === 'color') {
    model.color = value;
    model.textEl.style.color = value;
  } else if (kind === 'size') {
    model.fontSize = value;
    model.textEl.style.fontSize = value + 'px';
  }
  schedulePersist();
}

function addNote(opts) {
  opts = opts || {};
  const id = opts.id || 'note-' + (++noteSeq);
  if (notes.has(id)) {
    return; // avoid duplicating an already-restored note
  }
  const seqNum = parseInt(String(id).split('-')[1], 10);
  if (!isNaN(seqNum) && seqNum > noteSeq) {
    noteSeq = seqNum;
  }

  const x = typeof opts.x === 'number' ? opts.x : (-panX + 60) / scale;
  const y = typeof opts.y === 'number' ? opts.y : (-panY + 60) / scale;
  const fontSize = opts.fontSize || 18;
  const color = opts.color || '#1e1e1e';
  const bg = opts.bg || '#ffffff';
  const bold = !!opts.bold;

  const el = document.createElement('div');
  el.className = 'note';
  el.dataset.id = id;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.background = bg;
  if (typeof opts.w === 'number') {
    el.style.width = opts.w + 'px';
  }
  if (typeof opts.h === 'number') {
    el.style.height = opts.h + 'px';
  }

  const bar = document.createElement('div');
  bar.className = 'note-bar';

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'note-color';
  colorInput.value = color;
  colorInput.title = L.noteColorTitle;

  const bgInput = document.createElement('input');
  bgInput.type = 'color';
  bgInput.className = 'note-color';
  bgInput.value = bg;
  bgInput.title = L.noteBgTitle;

  const boldBtn = document.createElement('button');
  boldBtn.type = 'button';
  boldBtn.className = 'note-bold';
  boldBtn.textContent = 'B';
  boldBtn.title = L.noteBoldTitle;

  // Font size as a Word-style dropdown.
  const sizeSelect = document.createElement('select');
  sizeSelect.className = 'note-size';
  sizeSelect.title = L.noteSizeTitle;
  const sizes = FONT_SIZES.slice();
  if (!sizes.includes(fontSize)) {
    sizes.push(fontSize);
    sizes.sort((a, b) => a - b);
  }
  sizes.forEach((sv) => {
    const opt = document.createElement('option');
    opt.value = String(sv);
    opt.textContent = String(sv);
    if (sv === fontSize) {
      opt.selected = true;
    }
    sizeSelect.appendChild(opt);
  });

  const grip = document.createElement('span');
  grip.className = 'note-grip';
  grip.textContent = '⠿';
  grip.title = L.noteGripTitle;

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'note-del';
  del.textContent = '✕';
  del.title = L.noteDelTitle;

  bar.appendChild(colorInput);
  bar.appendChild(bgInput);
  bar.appendChild(boldBtn);
  bar.appendChild(sizeSelect);
  bar.appendChild(grip);
  bar.appendChild(del);

  const textEl = document.createElement('div');
  textEl.className = 'note-text';
  textEl.contentEditable = 'true';
  textEl.dataset.placeholder = L.notePlaceholder || '';
  textEl.style.fontSize = fontSize + 'px';
  textEl.style.color = color;
  textEl.style.fontWeight = bold ? 'bold' : 'normal';
  if (opts.html != null) {
    textEl.innerHTML = opts.html;
  } else if (opts.text != null) {
    textEl.innerText = opts.text;
  }

  // Bottom-right resize handle.
  const resizer = document.createElement('div');
  resizer.className = 'note-resize';
  resizer.title = L.noteResizeTitle;

  el.appendChild(bar);
  el.appendChild(textEl);
  el.appendChild(resizer);
  world.appendChild(el);

  const model = {
    el,
    id,
    x,
    y,
    fontSize,
    color,
    bg,
    bold,
    textEl,
    w: typeof opts.w === 'number' ? opts.w : undefined,
    h: typeof opts.h === 'number' ? opts.h : undefined
  };
  notes.set(id, model);

  const applyTextColor = () => noteApply(model, 'color', colorInput.value);
  colorInput.addEventListener('input', applyTextColor);
  colorInput.addEventListener('change', applyTextColor);

  const applyBg = () => {
    model.bg = bgInput.value;
    el.style.background = model.bg;
    schedulePersist();
  };
  bgInput.addEventListener('input', applyBg);
  bgInput.addEventListener('change', applyBg);

  boldBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep selection
  boldBtn.addEventListener('click', () => noteApply(model, 'bold'));

  sizeSelect.addEventListener('change', () =>
    noteApply(model, 'size', parseInt(sizeSelect.value, 10) || model.fontSize)
  );

  del.addEventListener('click', () => {
    el.remove();
    notes.delete(id);
    removeEdgesTouching(id);
    selected.delete(model);
    updateEmptyState();
    redrawEdges();
    schedulePersist();
  });
  textEl.addEventListener('input', () => schedulePersist());

  makeDraggable(bar, model);
  makeResizable(resizer, model);
  updateEmptyState();

  if (!opts.restoring) {
    textEl.focus();
    schedulePersist();
  }
}

// Edges --------------------------------------------------------------------
/** Look up a window model (card OR note) by id. */
function getModel(id) {
  return cards.get(id) || notes.get(id) || null;
}

function addEdge(from, to) {
  if (from === to) {
    return;
  }
  const exists = edges.some((e) => e.from === from && e.to === to);
  if (!exists) {
    edges.push({ from, to });
  }
}

/** Remove every edge that touches `id` (used when a window is deleted). */
function removeEdgesTouching(id) {
  for (let i = edges.length - 1; i >= 0; i--) {
    if (edges[i].from === id || edges[i].to === id) {
      edges.splice(i, 1);
    }
  }
}

// Shared arrowhead marker, created once.
(function ensureArrowMarker() {
  const defs = document.createElementNS(SVG_NS, 'defs');
  const marker = document.createElementNS(SVG_NS, 'marker');
  marker.setAttribute('id', 'arrow');
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '9');
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '7');
  marker.setAttribute('markerHeight', '7');
  marker.setAttribute('orient', 'auto-start-reverse');
  const mp = document.createElementNS(SVG_NS, 'path');
  mp.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
  mp.setAttribute('fill', '#0e639c');
  marker.appendChild(mp);
  defs.appendChild(marker);
  svg.appendChild(defs);
})();

function redrawEdges() {
  // Keep the <defs> (arrow marker); remove only drawn paths.
  while (svg.lastChild && svg.lastChild.nodeName !== 'defs') {
    svg.removeChild(svg.lastChild);
  }

  edges.forEach((edge) => {
    const a = getModel(edge.from);
    const b = getModel(edge.to);
    if (!a || !b) {
      return;
    }

    // World coordinates - the SVG lives inside #world, so it scales with it.
    const ax = a.el.offsetLeft;
    const ay = a.el.offsetTop;
    const aw = a.el.offsetWidth;
    const ah = a.el.offsetHeight;
    const bx = b.el.offsetLeft;
    const by = b.el.offsetTop;
    const bw = b.el.offsetWidth;
    const bh = b.el.offsetHeight;

    // Anchor on the facing sides; vertical centers.
    let x1;
    let x2;
    if (bx + bw / 2 >= ax + aw / 2) {
      x1 = ax + aw;
      x2 = bx;
    } else {
      x1 = ax;
      x2 = bx + bw;
    }
    const y1 = ay + ah / 2;
    const y2 = by + bh / 2;

    const midX = (x1 + x2) / 2;
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute(
      'd',
      'M ' + x1 + ' ' + y1 + ' C ' + midX + ' ' + y1 + ', ' + midX + ' ' + y2 + ', ' + x2 + ' ' + y2
    );
    path.setAttribute('class', 'edge-line');
    path.setAttribute('marker-end', 'url(#arrow)');
    svg.appendChild(path);
  });
}

// Dragging (cards and notes, in world coordinates) -------------------------
// dragItems holds every model being moved (a group when multi-selected).
let dragItems = null;
let dragStartWorld = null;

function makeDraggable(handle, model) {
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) {
      return;
    }
    if (e.target.closest('button, input, select, [contenteditable], .card-title')) {
      return; // let controls / editing / title-text-selection work
    }
    // In Select mode, clicking a window's header selects it (so it can be
    // deleted with Backspace/Del). Ctrl/Cmd adds to (or toggles) the selection
    // while keeping previously selected windows.
    if (mode === 'select') {
      const additive = e.ctrlKey || e.metaKey;
      if (additive) {
        if (selected.has(model)) {
          // Ctrl-click an already-selected window deselects it (no drag).
          selected.delete(model);
          model.el.classList.remove('selected');
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        selectModel(model); // add to the existing selection
      } else if (!selected.has(model)) {
        clearSelection();
        selectModel(model);
      }
    }
    // If this model is part of a multi-selection, move the whole group.
    const group = selected.has(model) && selected.size > 1 ? [...selected] : [model];
    dragItems = group.map((m) => ({ model: m, sx: m.x, sy: m.y }));
    dragStartWorld = screenToWorld(e.clientX, e.clientY);
    group.forEach((m) => m.el.classList.add('dragging'));
    e.preventDefault();
    e.stopPropagation();
  });
}

// Resizing notes (in world coordinates, so it tracks zoom) -----------------
let resizeModel = null;
let resizeStartW = 0;
let resizeStartH = 0;
let resizeStartWorld = null;

function makeResizable(handle, model) {
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) {
      return;
    }
    resizeModel = model;
    resizeStartW = model.el.offsetWidth;
    resizeStartH = model.el.offsetHeight;
    resizeStartWorld = screenToWorld(e.clientX, e.clientY);
    model.el.classList.add('resizing');
    e.preventDefault();
    e.stopPropagation();
  });
}

// Canvas pan (hand mode) / marquee select ----------------------------------
let panning = false;
let panStartX = 0;
let panStartY = 0;
let panOriginX = 0;
let panOriginY = 0;

let marqueeActive = false;
let marqueeStartCX = 0;
let marqueeStartCY = 0;
let marqueeMoved = false;

flowboard.addEventListener('mousedown', (e) => {
  if (e.button !== 0) {
    return;
  }
  // Interactions on a card/note are handled by their own handlers.
  if (e.target.closest('.card') || e.target.closest('.note')) {
    return;
  }
  if (mode === 'select') {
    marqueeActive = true;
    marqueeMoved = false;
    marqueeStartCX = e.clientX;
    marqueeStartCY = e.clientY;
    const rect = flowboard.getBoundingClientRect();
    marquee.style.left = e.clientX - rect.left + 'px';
    marquee.style.top = e.clientY - rect.top + 'px';
    marquee.style.width = '0px';
    marquee.style.height = '0px';
    marquee.style.display = 'block';
    e.preventDefault();
  } else {
    panning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panOriginX = panX;
    panOriginY = panY;
    flowboard.classList.add('panning');
  }
});

document.addEventListener('mousemove', (e) => {
  if (resizeModel) {
    const cur = screenToWorld(e.clientX, e.clientY);
    const w = Math.max(NOTE_MIN_W, resizeStartW + (cur.x - resizeStartWorld.x));
    const h = Math.max(NOTE_MIN_H, resizeStartH + (cur.y - resizeStartWorld.y));
    resizeModel.w = w;
    resizeModel.h = h;
    resizeModel.el.style.width = w + 'px';
    resizeModel.el.style.height = h + 'px';
    return;
  }
  if (dragItems) {
    const cur = screenToWorld(e.clientX, e.clientY);
    const dx = cur.x - dragStartWorld.x;
    const dy = cur.y - dragStartWorld.y;
    dragItems.forEach((item) => {
      item.model.x = item.sx + dx;
      item.model.y = item.sy + dy;
      item.model.el.style.left = item.model.x + 'px';
      item.model.el.style.top = item.model.y + 'px';
    });
    redrawEdges();
    return;
  }
  if (marqueeActive) {
    const rect = flowboard.getBoundingClientRect();
    if (Math.abs(e.clientX - marqueeStartCX) > 3 || Math.abs(e.clientY - marqueeStartCY) > 3) {
      marqueeMoved = true;
    }
    const left = Math.min(marqueeStartCX, e.clientX);
    const top = Math.min(marqueeStartCY, e.clientY);
    marquee.style.left = left - rect.left + 'px';
    marquee.style.top = top - rect.top + 'px';
    marquee.style.width = Math.abs(e.clientX - marqueeStartCX) + 'px';
    marquee.style.height = Math.abs(e.clientY - marqueeStartCY) + 'px';
    return;
  }
  if (panning) {
    panX = panOriginX + (e.clientX - panStartX);
    panY = panOriginY + (e.clientY - panStartY);
    applyTransform();
  }
});

document.addEventListener('mouseup', (e) => {
  if (resizeModel) {
    resizeModel.el.classList.remove('resizing');
    resizeModel = null;
    schedulePersist();
    return;
  }
  if (dragItems) {
    dragItems.forEach((item) => item.model.el.classList.remove('dragging'));
    dragItems = null;
    schedulePersist();
    return;
  }
  if (marqueeActive) {
    marquee.style.display = 'none';
    marqueeActive = false;
    const additive = e.ctrlKey || e.metaKey;
    if (marqueeMoved) {
      const left = Math.min(marqueeStartCX, e.clientX);
      const right = Math.max(marqueeStartCX, e.clientX);
      const top = Math.min(marqueeStartCY, e.clientY);
      const bottom = Math.max(marqueeStartCY, e.clientY);
      applyMarqueeSelection(left, top, right, bottom, additive);
    } else if (!additive) {
      clearSelection(); // plain click on empty space clears the selection
    }
    return;
  }
  if (panning) {
    panning = false;
    flowboard.classList.remove('panning');
    schedulePersist();
  }
});

// Mode switching: key "1" toggles hand/select; the toolbar button mirrors it.
document.addEventListener('keydown', (e) => {
  if (e.key !== '1') {
    return;
  }
  const t = e.target;
  if (t && t.closest && t.closest('[contenteditable], input, select, textarea')) {
    return; // don't hijack "1" while typing in a note or control
  }
  toggleMode();
  e.preventDefault();
});
modeBtn.addEventListener('click', () => toggleMode());

// Zoom with the mouse wheel, centered on the cursor ------------------------
flowboard.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const rect = flowboard.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const worldX = (mx - panX) / scale;
    const worldY = (my - panY) / scale;

    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    let newScale = scale * factor;
    newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));

    panX = mx - worldX * newScale;
    panY = my - worldY * newScale;
    scale = newScale;
    applyTransform();
    schedulePersist();
  },
  { passive: false }
);

// Restore / clear ----------------------------------------------------------
function clearAll(persist) {
  cards.forEach((c) => c.el.remove());
  cards.clear();
  notes.forEach((n) => n.el.remove());
  notes.clear();
  selected.clear();
  edges.length = 0;
  rootSpawnIndex = 0;
  cardSeq = 0;
  redrawEdges();
  updateEmptyState();
  if (persist) {
    schedulePersist();
  }
}

function restoreState(state) {
  // Merge (do not wipe): a card added before this handshake must survive.
  if (state) {
    (state.cards || []).forEach((cd) => {
      // Keep cardSeq ahead of any restored id so new ids never collide.
      const n = parseInt(String(cd.id || '').replace(/^c/, ''), 10);
      if (!isNaN(n) && n > cardSeq) {
        cardSeq = n;
      }
      addCard(cd, { restoring: true });
    });
    (state.edges || []).forEach((e) => {
      if (!edges.some((x) => x.from === e.from && x.to === e.to)) {
        edges.push({ from: e.from, to: e.to });
      }
    });
    (state.notes || []).forEach((n) => addNote(Object.assign({ restoring: true }, n)));
    if (state.camera) {
      scale = state.camera.scale || 1;
      panX = state.camera.panX || 0;
      panY = state.camera.panY || 0;
    }
    applyTransform();
    redrawEdges();
    updateEmptyState();
  }
  // Restore is complete: enable auto-save and persist the merged result.
  canPersist = true;
  schedulePersist();
}

/** Replace the entire board with the given snapshot (used by undo). */
function loadSnapshot(state) {
  cards.forEach((c) => c.el.remove());
  cards.clear();
  notes.forEach((n) => n.el.remove());
  notes.clear();
  selected.clear();
  edges.length = 0;
  rootSpawnIndex = 0;
  cardSeq = 0;
  if (state) {
    (state.cards || []).forEach((cd) => {
      const n = parseInt(String(cd.id || '').replace(/^c/, ''), 10);
      if (!isNaN(n) && n > cardSeq) {
        cardSeq = n;
      }
      addCard(cd, { restoring: true });
    });
    (state.edges || []).forEach((e) => {
      if (!edges.some((x) => x.from === e.from && x.to === e.to)) {
        edges.push({ from: e.from, to: e.to });
      }
    });
    (state.notes || []).forEach((nn) => addNote(Object.assign({ restoring: true }, nn)));
    if (state.camera) {
      scale = state.camera.scale || 1;
      panX = state.camera.panX || 0;
      panY = state.camera.panY || 0;
    }
  }
  applyTransform();
  redrawEdges();
  updateEmptyState();
}

/** Undo the last content change. */
function undo() {
  if (undoStack.length === 0) {
    return;
  }
  const prevJson = undoStack.pop();
  const prev = JSON.parse(prevJson);
  loadSnapshot(prev);
  lastSnapshotJson = prevJson;
  lastContentKey = contentKey(prev);
  vscode.postMessage({ type: 'persist', state: prev });
  updateUndoButton();
}

// Toolbar ------------------------------------------------------------------
clearBtn.addEventListener('click', () => clearAll(true));
undoBtn.addEventListener('click', undo);

function onUndoKey(e) {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z' || e.keyCode === 90) && !e.shiftKey) {
    const t = e.target;
    if (t && t.closest && t.closest('[contenteditable], input, select, textarea')) {
      return; // let native undo work while editing text
    }
    e.preventDefault();
    e.stopPropagation();
    undo();
  }
}
// Listen on window in capture phase to intercept before the webview default.
window.addEventListener('keydown', onUndoKey, true);
addNoteBtn.addEventListener('click', () => addNote());

// Manual line drawing ------------------------------------------------------
let connectMode = false;
let connectSource = null; // id of the first clicked window

function setConnectMode(on) {
  connectMode = on;
  linkBtn.classList.toggle('active', on);
  flowboard.classList.toggle('mode-connect', on);
  if (!on && connectSource) {
    const m = getModel(connectSource);
    if (m) {
      m.el.classList.remove('link-source');
    }
    connectSource = null;
  }
}

linkBtn.addEventListener('click', () => setConnectMode(!connectMode));

// Capture phase: in connect mode, clicking a window picks it (no drag/pan).
flowboard.addEventListener(
  'mousedown',
  (e) => {
    if (!connectMode || e.button !== 0) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const winEl = e.target.closest('.card, .note');
    if (!winEl) {
      return; // clicked empty space - ignore (stays in connect mode)
    }
    const id = winEl.dataset.id;
    if (!id) {
      return;
    }
    if (!connectSource) {
      connectSource = id;
      winEl.classList.add('link-source');
    } else if (connectSource === id) {
      winEl.classList.remove('link-source');
      connectSource = null;
    } else {
      addEdge(connectSource, id);
      const sm = getModel(connectSource);
      if (sm) {
        sm.el.classList.remove('link-source');
      }
      connectSource = null;
      redrawEdges();
      schedulePersist();
    }
  },
  true
);

// Search (Ctrl+F) ----------------------------------------------------------
const searchPanel = document.createElement('div');
searchPanel.id = 'search-panel';
searchPanel.style.display = 'none';
const searchInput = document.createElement('input');
searchInput.id = 'search-input';
searchInput.type = 'text';
searchInput.placeholder = L.searchPlaceholder || '';
const searchResults = document.createElement('div');
searchResults.id = 'search-results';
searchPanel.appendChild(searchInput);
searchPanel.appendChild(searchResults);
document.body.appendChild(searchPanel);

/** Center the viewport on a card/note and flash it. */
function focusOnModel(model) {
  const rect = flowboard.getBoundingClientRect();
  const cx = model.x + model.el.offsetWidth / 2;
  const cy = model.y + model.el.offsetHeight / 2;
  panX = rect.width / 2 - cx * scale;
  panY = rect.height / 2 - cy * scale;
  applyTransform();
  flash(model.el);
  schedulePersist();
}

function runSearch(query) {
  const q = query.trim().toLowerCase();
  searchResults.innerHTML = '';
  if (!q) {
    return;
  }
  const matches = [];
  cards.forEach((m) => {
    const inName = m.name.toLowerCase().indexOf(q) !== -1;
    const inCode = (m.clean || '').toLowerCase().indexOf(q) !== -1;
    if (inName || inCode) {
      matches.push({ model: m, label: m.name + '()', sub: inName ? L.subName : L.subCode });
    }
  });
  notes.forEach((n) => {
    const t = n.textEl.innerText || '';
    if (t.toLowerCase().indexOf(q) !== -1) {
      matches.push({ model: n, label: '📝 ' + (t.slice(0, 40) || L.note), sub: L.note });
    }
  });

  if (matches.length === 0) {
    searchResults.innerHTML = '<div class="search-empty">' + esc(L.searchEmpty || '') + '</div>';
    return;
  }
  matches.slice(0, 60).forEach((mt) => {
    const item = document.createElement('div');
    item.className = 'search-item';
    item.innerHTML =
      '<span class="search-name">' +
      esc(mt.label) +
      '</span><span class="search-sub">' +
      mt.sub +
      '</span>';
    item.addEventListener('click', () => {
      focusOnModel(mt.model);
      closeSearch();
    });
    searchResults.appendChild(item);
  });
}

function openSearch() {
  searchPanel.style.display = 'block';
  searchInput.value = '';
  searchResults.innerHTML = '';
  searchInput.focus();
}

function closeSearch() {
  searchPanel.style.display = 'none';
}

function toggleSearch() {
  if (searchPanel.style.display === 'none') {
    openSearch();
  } else {
    closeSearch();
  }
}

searchBtn.addEventListener('click', toggleSearch);
searchInput.addEventListener('input', () => runSearch(searchInput.value));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeSearch();
  } else if (e.key === 'Enter') {
    const first = searchResults.querySelector('.search-item');
    if (first) {
      first.click();
    }
  }
});

// Listen on window in capture phase (same as undo) so we intercept Ctrl+F
// before the webview default. Include a keyCode fallback - in this webview
// `e.key` alone is not reliable for the shortcut.
function onSearchKey(e) {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F' || e.keyCode === 70)) {
    e.preventDefault();
    e.stopPropagation();
    toggleSearch();
  } else if (e.key === 'Escape' || e.keyCode === 27) {
    if (searchPanel.style.display !== 'none') {
      closeSearch();
    }
    if (connectMode) {
      setConnectMode(false);
    }
  }
}
window.addEventListener('keydown', onSearchKey, true);

// Delete selected cards (with their call subtrees) and notes via Backspace/Delete.
function deleteSelected() {
  if (selected.size === 0) {
    return;
  }
  const items = [...selected];
  items.forEach((m) => {
    if (cards.has(m.id)) {
      removeSubtree(m.id); // also drops descendant call cards
    } else if (notes.has(m.id)) {
      m.el.remove();
      notes.delete(m.id);
      removeEdgesTouching(m.id);
      selected.delete(m);
    }
  });
  selected.clear();
  redrawEdges();
  updateEmptyState();
  schedulePersist();
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Backspace' && e.key !== 'Delete') {
    return;
  }
  const t = e.target;
  if (t && t.closest && t.closest('[contenteditable], input, select, textarea')) {
    return; // don't hijack deletion while editing a note or typing in a field
  }
  if (selected.size === 0) {
    return;
  }
  e.preventDefault();
  deleteSelected();
});

// Copy / paste windows (Ctrl+C / Ctrl+V) ----------------------------------
flowboard.addEventListener('mousemove', (e) => {
  lastPointer = { x: e.clientX, y: e.clientY };
});

function copySelection() {
  if (selected.size === 0) {
    return;
  }
  const idSet = new Set();
  selected.forEach((m) => idSet.add(m.id));
  const items = [];
  selected.forEach((m) => {
    if (cards.has(m.id)) {
      items.push({ kind: 'card', oldId: m.id, x: m.x, y: m.y, data: JSON.parse(JSON.stringify(m.data)) });
    } else if (notes.has(m.id)) {
      items.push({
        kind: 'note',
        oldId: m.id,
        x: m.x,
        y: m.y,
        note: {
          html: m.textEl.innerHTML,
          color: m.color,
          bg: m.bg,
          fontSize: m.fontSize,
          bold: !!m.bold,
          w: m.w,
          h: m.h
        }
      });
    }
  });
  const internalEdges = edges
    .filter((e) => idSet.has(e.from) && idSet.has(e.to))
    .map((e) => ({ from: e.from, to: e.to }));
  let minX = Infinity;
  let minY = Infinity;
  items.forEach((it) => {
    if (it.x < minX) minX = it.x;
    if (it.y < minY) minY = it.y;
  });
  clipboard = { items, edges: internalEdges, minX, minY };
}

function pasteClipboard() {
  if (!clipboard || clipboard.items.length === 0) {
    return;
  }
  // Target position: world point under the cursor (or viewport center).
  let tw;
  if (lastPointer) {
    tw = screenToWorld(lastPointer.x, lastPointer.y);
  } else {
    const r = flowboard.getBoundingClientRect();
    tw = screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
  }

  const idMap = {};
  const newModels = [];
  clipboard.items.forEach((it) => {
    const nx = tw.x + (it.x - clipboard.minX);
    const ny = tw.y + (it.y - clipboard.minY);
    if (it.kind === 'card') {
      const newId = genCardId();
      idMap[it.oldId] = newId;
      const d = Object.assign({}, it.data, { id: newId, parentId: null, x: nx, y: ny });
      addCard(d, { restoring: true });
      const m = cards.get(newId);
      if (m) {
        newModels.push(m);
      }
    } else {
      const newId = 'note-' + ++noteSeq;
      idMap[it.oldId] = newId;
      addNote(Object.assign({ restoring: true, id: newId, x: nx, y: ny }, it.note));
      const m = notes.get(newId);
      if (m) {
        newModels.push(m);
      }
    }
  });

  // Recreate edges that were internal to the copied set.
  clipboard.edges.forEach((e) => {
    const f = idMap[e.from];
    const t = idMap[e.to];
    if (f && t) {
      addEdge(f, t);
    }
  });

  clearSelection();
  newModels.forEach((m) => selectModel(m));
  redrawEdges();
  updateEmptyState();
  schedulePersist();
}

window.addEventListener(
  'keydown',
  (e) => {
    if (!(e.ctrlKey || e.metaKey)) {
      return;
    }
    const t = e.target;
    if (t && t.closest && t.closest('[contenteditable], input, select, textarea')) {
      return; // native copy/paste while editing text
    }
    if (e.key === 'c' || e.key === 'C') {
      if (selected.size > 0) {
        e.preventDefault();
        copySelection();
      }
    } else if (e.key === 'v' || e.key === 'V') {
      if (clipboard) {
        e.preventDefault();
        pasteClipboard();
      }
    }
  },
  true
);

// Custom right-click menu --------------------------------------------------
// State for the "Open flow" recursive expansion: childIds we expect to receive
// from the host, and visited function keys to prevent loops and duplicates.
const flowPending = new Set();
const FLOW_MAX_CARDS = 300;

/** True if `contract::name` is already in the ancestor chain of `cardId` -
 *  i.e. expanding it would create a loop. Duplicates on OTHER branches are OK. */
function isAncestorFunction(cardId, contract, name) {
  let cur = cards.get(cardId);
  while (cur) {
    if ((cur.data.name || '') === name && (cur.data.contract || '') === contract) {
      return true;
    }
    cur = cur.data.parentId ? cards.get(cur.data.parentId) : null;
  }
  return false;
}
// Tier layout: depth -> { x, nextY, maxRight, cards }. Reset per Open Flow.
const flowColumns = new Map();
const FLOW_COL_GAP = 160; // wider gap so the connecting arrows are visible
const FLOW_ROW_GAP = 40;
let flowSettleTimer = null;

/** Center each depth-column vertically around the root card's middle. Runs
 *  once expansion stops adding new cards (settling). Keeps the root in place. */
function centerFlowColumns() {
  const col0 = flowColumns.get(0);
  if (!col0) {
    return;
  }
  const rootCard = col0.cards.values().next().value;
  if (!rootCard) {
    return;
  }
  const rootCenter = rootCard.y + (rootCard.el.offsetHeight || 0) / 2;
  flowColumns.forEach((col, depth) => {
    if (depth === 0 || col.cards.size === 0) {
      return;
    }
    let topY = Infinity;
    let bottomY = -Infinity;
    col.cards.forEach((c) => {
      const h = c.el.offsetHeight || 0;
      if (c.y < topY) topY = c.y;
      if (c.y + h > bottomY) bottomY = c.y + h;
    });
    const colHeight = bottomY - topY;
    const desiredTop = rootCenter - colHeight / 2;
    const delta = desiredTop - topY;
    if (Math.abs(delta) < 0.5) {
      return;
    }
    col.cards.forEach((c) => {
      c.y += delta;
      c.el.style.top = c.y + 'px';
    });
    col.startY += delta;
    col.nextY += delta;
  });
  redrawEdges();
  schedulePersist();
}

function scheduleFlowCentering() {
  if (flowSettleTimer) {
    clearTimeout(flowSettleTimer);
  }
  flowSettleTimer = setTimeout(() => {
    flowSettleTimer = null;
    centerFlowColumns();
  }, 150);
}

/** Place an Open-Flow card in its depth-column, stacked below earlier cards. */
function placeFlowCardAtDepth(model, depth) {
  let col = flowColumns.get(depth);
  if (!col) {
    let x;
    let startY;
    if (depth === 0) {
      x = model.x;
      startY = model.y;
    } else {
      const prev = flowColumns.get(depth - 1);
      x = (prev ? prev.maxRight : model.x) + FLOW_COL_GAP;
      // Vertical anchor: aim level columns at the same Y as column 0.
      startY = (flowColumns.get(0) && flowColumns.get(0).startY) || model.y;
    }
    col = { x: x, nextY: startY, maxRight: x, startY: startY, cards: new Set() };
    flowColumns.set(depth, col);
  }
  model.x = col.x;
  model.y = col.nextY;
  model.el.style.left = col.x + 'px';
  model.el.style.top = col.nextY + 'px';
  col.cards.add(model);
  // Advance: card height + gap; widen column's right edge by this card's width.
  const h = model.el.offsetHeight || 200;
  const w = model.el.offsetWidth || 600;
  col.nextY += h + FLOW_ROW_GAP;
  const right = col.x + w;
  if (right > col.maxRight) {
    col.maxRight = right;
  }
}

/** Recursively expand every clickable call in the given card. */
function expandCardFlow(cardId) {
  const model = cards.get(cardId);
  if (!model || model.data.notFound || !model.codeEl) {
    return;
  }
  const spans = model.codeEl.querySelectorAll('.call');
  spans.forEach((span) => {
    if (cards.size + flowPending.size >= FLOW_MAX_CARDS) {
      return;
    }
    const name = span.dataset.call;
    if (!name) {
      return;
    }
    const fromContract = span.dataset.contract || (model.data.contract || '');
    // Skip only when the target is already in the ancestor chain of this card
    // (would create a loop). Duplicates elsewhere on the board are allowed.
    if (isAncestorFunction(cardId, fromContract, name)) {
      return;
    }
    const site = span.dataset.site != null ? Number(span.dataset.site) : undefined;
    // Skip if this exact occurrence is already a child of this card.
    if (findChildCard(cardId, site, name)) {
      return;
    }
    const childId = genCardId();
    flowPending.add(childId);
    if (site != null) {
      pendingChildSite.set(childId, site);
    }
    vscode.postMessage({
      type: 'expand',
      functionName: name,
      fromId: cardId,
      childId: childId,
      fromContract: span.dataset.contract || null,
      isSuper: span.dataset.super === '1',
      argCount: span.dataset.arity != null ? Number(span.dataset.arity) : undefined
    });
  });
}

/** Open the entire call flow starting from the given card. */
function openFlow(cardId) {
  flowPending.clear();
  flowColumns.clear();
  const root = cards.get(cardId);
  if (root) {
    root.flowDepth = 0;
    // Seed column 0 with the root so column 1 is placed to its right.
    flowColumns.set(0, {
      x: root.x,
      nextY: root.y,
      maxRight: root.x + (root.el.offsetWidth || 600),
      startY: root.y,
      cards: new Set([root])
    });
  }
  expandCardFlow(cardId);
}

// The context menu element is built once and reused.
const ctxMenu = document.createElement('div');
ctxMenu.id = 'ctx-menu';
ctxMenu.style.display = 'none';
document.body.appendChild(ctxMenu);

function hideContextMenu() {
  ctxMenu.style.display = 'none';
}

function showContextMenu(x, y, items) {
  ctxMenu.innerHTML = '';
  items.forEach((it) => {
    if (it.sep) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      ctxMenu.appendChild(sep);
      return;
    }
    const el = document.createElement('div');
    el.className = 'ctx-item' + (it.disabled ? ' disabled' : '');
    el.textContent = it.label;
    if (!it.disabled) {
      el.addEventListener('mousedown', (e) => e.preventDefault());
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        hideContextMenu();
        try { it.action(); } catch (_e) { /* swallow */ }
      });
    }
    ctxMenu.appendChild(el);
  });
  // Position; clamp to viewport so the menu isn't clipped offscreen.
  ctxMenu.style.left = '0px';
  ctxMenu.style.top = '0px';
  ctxMenu.style.display = 'block';
  const r = ctxMenu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let nx = x;
  let ny = y;
  if (nx + r.width > vw) nx = Math.max(0, vw - r.width - 4);
  if (ny + r.height > vh) ny = Math.max(0, vh - r.height - 4);
  ctxMenu.style.left = nx + 'px';
  ctxMenu.style.top = ny + 'px';
}

window.addEventListener('contextmenu', (e) => {
  const t = e.target;
  // Let the native menu show for editable text (notes, inputs).
  if (t && t.closest && t.closest('[contenteditable], input, select, textarea')) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  hideContextMenu();
  const cardEl = t && t.closest ? t.closest('.card') : null;
  const noteEl = t && t.closest ? t.closest('.note') : null;
  // Remember pointer for paste positioning.
  lastPointer = { x: e.clientX, y: e.clientY };

  const items = [];
  if (cardEl) {
    const id = cardEl.dataset.id;
    const m = cards.get(id);
    if (m && !selected.has(m)) {
      clearSelection();
      selectModel(m);
    }
    items.push({ label: L.ctxCopy || 'Copy', action: () => copySelection() });
    items.push({
      label: L.ctxCut || 'Cut',
      action: () => { copySelection(); deleteSelected(); }
    });
    // "Open flow" only for real (resolved) function cards.
    if (m && !m.data.notFound) {
      items.push({ sep: true });
      items.push({ label: L.ctxOpenFlow || 'Open flow', action: () => openFlow(m.id) });
    }
  } else if (noteEl) {
    const id = noteEl.dataset.id;
    const m = notes.get(id);
    if (m && !selected.has(m)) {
      clearSelection();
      selectModel(m);
    }
    items.push({ label: L.ctxCopy || 'Copy', action: () => copySelection() });
    items.push({
      label: L.ctxCut || 'Cut',
      action: () => { copySelection(); deleteSelected(); }
    });
  } else {
    items.push({
      label: L.ctxPaste || 'Paste',
      action: () => pasteClipboard(),
      disabled: !clipboard
    });
  }
  showContextMenu(e.clientX, e.clientY, items);
}, true);

// Hide the custom menu on left-click outside it (NOT on blur — right-clicking
// can transiently blur the iframe on Windows and would close the menu instantly).
document.addEventListener('mousedown', (e) => {
  if (e.button === 2) {
    return; // right-press: handled by the contextmenu listener above
  }
  if (!(e.target && e.target.closest && e.target.closest('#ctx-menu'))) {
    hideContextMenu();
  }
}, true);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideContextMenu();
});

// Messages from the extension ----------------------------------------------
window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data) {
    return;
  }
  if (data.type === 'addCard') {
    addCard(data);
    // If this card was opened as part of an "Open flow" expansion: position it
    // in its depth-column (no overlap with siblings), then recurse.
    if (data.id && flowPending.has(data.id)) {
      flowPending.delete(data.id);
      const model = cards.get(data.id);
      const parent = data.parentId ? cards.get(data.parentId) : null;
      if (model && parent) {
        const depth = (parent.flowDepth != null ? parent.flowDepth : 0) + 1;
        model.flowDepth = depth;
        placeFlowCardAtDepth(model, depth);
        redrawEdges();
        scheduleFlowCentering();
      }
      expandCardFlow(data.id);
    }
  } else if (data.type === 'restore') {
    restoreState(data.state);
  } else if (data.type === 'annotations') {
    const model = cards.get(data.id);
    if (model) {
      setBtnBusy(model.annotateBtn, false);
      model.data.summary = data.summary || null;
      model.data.annotations = data.items || [];
      model.data.showAnnotations = true;
      if (model.annotateBtn) {
        model.annotateBtn.classList.add('active');
      }
      renderCodeBody(model);
      redrawEdges();
      schedulePersist();
    }
  } else if (data.type === 'aiError') {
    const model = cards.get(data.id);
    if (model) {
      setBtnBusy(model.annotateBtn, false);
      if (model.annotateBtn) {
        model.annotateBtn.classList.remove('active');
      }
      redrawEdges();
    }
  }
});

applyTransform();
updateUndoButton();
// Ask the extension for any previously saved board.
vscode.postMessage({ type: 'ready' });
// Safety net: if no restore reply arrives, enable auto-save anyway.
setTimeout(() => {
  if (!canPersist) {
    canPersist = true;
  }
}, 1500);
