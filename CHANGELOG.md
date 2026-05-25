# Change Log

## 1.0.1

- Documentation: installation instructions for Open VSX — search-and-install in Cursor/VSCodium/Windsurf/Gitpod, and VSIX download for Visual Studio Code.

## 1.0.0

Initial release.

- **Send to Flowboard** — right-click a Solidity function to drop it on a draggable canvas as a card with its full body.
- **Expand the call flow** — click highlighted calls to open callees as connected cards, with contract- and type-aware (`super`, member calls, inheritance) strict resolution.
- **Emoji trait badges** in card headers (access control, value in/out, storage writes, `delegatecall`, low-level/static calls, `unchecked`, `block.*`, `tx.origin`, view/pure) with tooltips.
- **Modifier chips** above each card, clickable to the modifier definition.
- **AI code comments** (optional) via the Claude Code CLI — per-line explanations and a summary, codebase-aware.
- **Canvas tools** — pan/zoom, Hand/Select modes, marquee selection, connecting lines, text notes, search (`Ctrl+F`), undo, copy/paste, delete, and per-workspace auto-save.
- **Bilingual UI** — English (default) or Russian via `solidity-flowboard.language`.
