# Change Log

## 1.2.0

- **Value trace (alt+click a parameter)**. Hold Alt and click a parameter name in an external function — anywhere on the card, signature or body — to highlight that value across the function and propagate it down the call tree. Every child card that receives the value as a direct call argument lights up its matching parameter, even when:
  - The arg is a struct field (`buyData.token` propagates from `buyData` and lights up the child param named `token`).
  - The call uses Solidity's named-args syntax: `_emitSwapEvent({account: buyData.account, token: buyData.token, …})` matches each field by NAME against the child signature, not by position.
  - The call goes through `using X for Y`: `token.safeTransferFrom(a, b, amount)` (3 args) is resolved against the library's 4-param signature, so `amount` correctly lands on `value` instead of `to`.
  - The parameter is renamed across the chain (`amount` → `value` → `wad`). The colour stays consistent from where you clicked all the way down — each traced parameter gets its own colour, and multiple parameters can be traced at once. Alt+click an active parameter again, or press Esc, to clear. Named-args field labels (e.g. the `token:` in `token: token`) are left alone — only the value side is clickable.
- **Minimap** in the bottom-right corner — a small overview of the whole board, with cards coloured by visibility (green external/public, gray internal/private), notes in yellow, and the current viewport shown as a blue rectangle. Click anywhere on the minimap to centre the canvas there, or drag the viewport rectangle to pan in real time. Collapses to a small floating icon when not needed; collapsed/expanded state persists per workspace, and new boards start with the minimap collapsed.
- **Open flow ↔ Close flow toggle**. The same context-menu slot now adapts: "Open flow" while there are calls still to expand, "Close flow" once everything under the card is open. Close removes the whole subtree below the card in one click.
- **No-overlap placement**. New cards slide into the first free vertical position and never sit on top of existing cards or notes. The gap is sized to about one grid square at typical zoom, and the modifier-chip row that floats above each card is accounted for so chips don't crash into the card above. Re-opening a previously-closed card returns it to its original slot.
- **Open flow now re-lays the whole subtree** in call-order (DFS by `parentSite`). Manual expansions snap into their tier positions, missing cards slot into the gap left by a removed sibling instead of being appended at the bottom, and deeper columns are vertically centred around the root every time. So `open → delete one card → open again` looks identical to a fresh expansion, with the gap filled in place.
- **Zoom-out limit lowered from 15% to 5%** so big call graphs fit in one view.

## 1.1.0

- **Right-click context menu** on cards / notes / empty canvas with **Copy / Cut / Paste** (the system menu's clipboard items never worked on cards — these do).
- **Open flow**: a new context-menu action on a function card that recursively expands every clickable call from that card down through the call tree. Loop prevention is per-path (a function only stops if it's already in the current ancestor chain), so the same function legitimately reached on two different branches gets its own card on each.
- **Tier layout for Open flow**: cards are placed in depth columns (root → its calls → their calls → …) with no overlap, vertical stacking inside each column, and a wider gap between columns so the connecting arrows are visible. Each column is vertically centered around the root card.

## 1.0.7

- Variable types are now resolved per function scope (parameters + locals) instead of per contract. Fixes member-call resolution when two functions declare same-named locals of different types (e.g. a local `data` typed `LaunchData` in one function and `SwapRemainingData` in another) — `data.curve.buy(...)` now correctly opens the curve implementation.

## 1.0.6

- `using Lib for Type` / `using Lib for *` library methods are now resolved: a call like `token.safeTransfer(...)` (where `token` is `IERC20` with `using SafeERC20 for IERC20`) is clickable and opens the library function. Works for variable, cast, and struct-field receivers (e.g. `buyData.token.safeTransfer(...)` resolves through the struct field's type).

## 1.0.5

- Contract construction is navigable: `new Contract(...)` is clickable and opens the contract's `constructor`.

## 1.0.4

- Calls on an interface-typed receiver resolve to a concrete contract that implements the interface in the project (e.g. `curve.initializeCurve(...)` where `curve` is an interface type opens the implementing contract).
- Explicit cast receivers are navigable: `Type(expr).method(...)` (e.g. `LaunchToken(token).mint(...)`) is now highlighted and resolves to `Type`'s method.
- Struct literals are clickable: `Name({...})` / `Name(...)` opens the struct definition.

## 1.0.3

- Each call occurrence opens its own card: when a function is called multiple times in one body (e.g. two `_transferFrom(...)` calls), clicking each opens a separate window instead of toggling the same one.
- Direct library/contract calls by name (e.g. `Math.mulDivRoundingUp(...)`, `SafeERC20.safeTransfer(...)`) are now highlighted and navigable, not just `variable.method()` calls.

## 1.0.2

- Overloaded functions resolve correctly: a call now opens the overload whose argument count matches (e.g. `f(a)` vs `f(a, b, c)`), instead of always opening the first definition.
- Dependency sources referenced via remappings (`remappings.txt` / `foundry.toml`) are now indexed even when they live under `node_modules` (including pnpm symlinks) — so calls into them (e.g. OpenZeppelin upgradeable contracts) are highlighted and navigable.

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
