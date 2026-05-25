# Solidity Flowboard

**Trace Solidity function call flows card‑by‑card on an infinite, draggable canvas — built for smart‑contract auditors.**

## What it is

When you audit a protocol, the hardest part is rarely a single function — it's *the flow*. A call enters a vault, jumps into a base contract via `super`, hops into a library, calls out to an OpenZeppelin implementation, comes back through a modifier, and three files later you've lost the thread. You end up with twenty tabs open, scrolling up and down, trying to hold the whole call graph in your head.

Solidity Flowboard turns that mental juggling into something you can *see*. Right‑click a function and it lands on a canvas as a card showing its full body. Every call inside that body is highlighted — click one and the called function opens as its own card, wired to the parent with an arrow. Keep clicking and the entire execution path lays itself out in front of you: across contracts, through inheritance, into dependencies. The flow stops jumping around your editor and becomes a single picture you can pan, zoom, annotate, and reason about.

Each card also tells you, at a glance, what the function *does to the system* — whether it moves funds, writes storage, makes low‑level or delegate calls, depends on `block.timestamp`, is gated by access control, and more — via compact emoji badges in its header.

## Who it's for

- **Security auditors** mapping attack surface and following value/permission flow across a codebase.
- **Protocol engineers** reviewing or onboarding to an unfamiliar contract system.
- **Anyone** who reviews Solidity and wants the call graph as a visual artifact instead of a stack of editor tabs.

## Installation

Solidity Flowboard is published on the [Open VSX Registry](https://open-vsx.org/extension/anchabadze/solidity-flowboard). How you install it depends on your editor.

### Cursor, VSCodium, Windsurf, Gitpod (and other Open VSX–based editors)

These editors use Open VSX as their marketplace, so you can install normally:

1. Open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Search for **Solidity Flowboard**.
3. Click **Install**. Updates arrive automatically.

### Visual Studio Code

Official VS Code only searches the Microsoft Marketplace, so install from the `.vsix` file instead (the extension itself runs exactly the same):

1. Open the extension's Open VSX page: **https://open-vsx.org/extension/anchabadze/solidity-flowboard**
2. Click **Download** to get the `.vsix` file.
3. In VS Code: Extensions view → the **`...`** menu (Views and More Actions) → **Install from VSIX…** → pick the downloaded file.

Or from the command line (use the file you downloaded):

```bash
code --install-extension /path/to/anchabadze.solidity-flowboard-<version>.vsix
```

> Updates aren't automatic with the VSIX method — re-download the latest `.vsix` from the Open VSX page to update.

After installing, complete the setup below.

---

## Requirements

### VS Code 1.80+

### Slither (required)

```bash
pip install slither-analyzer
```

Flowboard uses [Slither](https://github.com/crytic/slither)'s resolved call graph to wire functions together accurately, so it must be installed and runnable. Slither needs a **compilable** project — make sure the correct solc version and remappings are in place so that `slither .` succeeds in your project root.

### Dependency sources on disk

Navigation into a called function only works if that function's **source is physically present in the workspace**. Flowboard scans the whole project tree, including dependency folders, so calls into third‑party code resolve and become clickable:

- **Foundry** — run `forge install` so `lib/` contains the sources (e.g. OpenZeppelin under `lib/openzeppelin-contracts/`).
- **Soldeer** (a Solidity package manager) — its `dependencies/` folder is scanned the same way.
- **Hardhat / npm / pnpm** — `node_modules` isn't scanned wholesale, but dependency directories your **remappings** point to (`remappings.txt` or `foundry.toml`) are indexed even when they resolve into `node_modules` (e.g. `@openzeppelin/contracts-upgradeable/` → `node_modules/...`, including pnpm symlinks). Imports with no remapping into `node_modules` won't resolve to a card.

Other build/output directories are skipped as well: `.git`, `out`, `artifacts`, `cache`, `coverage`, `typechain`, `typechain-types`.

### Claude Code CLI (optional — only for AI code comments)

The **Code comments** feature shells out to the [Claude Code CLI](https://claude.com/claude-code) (`claude`) running in headless mode, using **your own Claude subscription** — no API key is configured in the extension. Everything else works without it; only that one button requires it. Point the extension at a non‑default binary with `solidity-flowboard.claudePath` if needed.

---

## Features

### Building the flow

- **Send to Flowboard** — right‑click any function in a `.sol` file → **Send to Flowboard**. The function appears as a card with its complete body. The first card uses the exact function under your cursor (never a same‑named interface declaration).
- **Expand calls** — every call inside a card's body that resolves to an in‑project function is highlighted. Click it to open the callee as a new card, connected to the parent by an arrow. Click the same call again to collapse that card and its descendants.
- **Contract‑ and type‑aware resolution** — calls resolve the way Solidity actually dispatches them, not by name matching:
  - `super.foo()` follows the base chain (C3‑style, most‑derived first).
  - Member calls (`receiver.method(...)`) resolve through the **declared type** of the receiver variable and its inheritance chain.
  - Resolution is **strict**: a call only opens a function that genuinely belongs to the receiver's type or its bases — it never jumps to an unrelated contract that happens to share the function name.
- **Multi‑instance cards** — the same function reached from two different callers becomes two separate cards, so each call path keeps its own context instead of collapsing into one node.
- **`file:line` link** — every card header shows its source location; click it to open the file at that line in the editor.

### Reading a function at a glance

- **Header color by visibility** — `public` / `external` functions get a green header; `internal` / `private` get a neutral header.
- **Emoji trait badges** — compact icons after the function name flag security‑relevant behavior, each with a hover tooltip:

  | Badge | Meaning |
  |-------|---------|
  | 🔐 | Access control — guarded by a modifier (`onlyOwner`, `onlyRole`, …) or an inline `msg.sender` check |
  | 💰 | Receives funds — `payable`, or pulls tokens in via `transferFrom` / `safeTransferFrom` |
  | 💸 | Sends funds out — `transfer` / `safeTransfer` / `send`, or any `{value: …}` call |
  | 📝 | Modifies state (storage write) |
  | 👀 | `view` / `pure` — read‑only |
  | ⚠️ | Contains an `assembly { }` (Yul) block |
  | ☢️ | `delegatecall` — runs foreign code in this contract's context |
  | 📞 | Low‑level `call` with arbitrary data (no value) |
  | 👁 | `staticcall` — read‑only external call |
  | ⚡ | `unchecked { }` — overflow/underflow protection disabled |
  | 🎲 | Uses `block.timestamp` / `block.number` |
  | 🪪 | Uses `tx.origin` |

- **Modifier chips** — the modifiers applied to a function are shown as chips floating above the card. A chip whose modifier is defined in the project is clickable and jumps straight to the `modifier` definition (resolved through the contract's base chain).

### AI code comments (optional)

- **Code comments** button — asks Claude (via your subscription) for a short summary of what the function does plus per‑line explanations, rendered inline under the relevant lines. Click again to hide.
- By default the model runs **in the context of the whole codebase** (read‑only `Read`/`Grep`/`Glob` access from the project root), so its comments account for called functions, parent contracts, interfaces and invariants — not just the isolated snippet. Turn this off for a faster, snippet‑only pass.

### The canvas

- **Pan & zoom** — scroll to zoom, drag empty space to pan. The current zoom level is shown in the toolbar.
- **Hand / Select modes** — press `1` to toggle. **Hand** pans the canvas; **Select** lets you marquee‑select multiple cards/notes and move them as a group.
- **Connecting lines** — the **Line** tool draws a manual arrow between two cards: click the first, then the second.
- **Text notes** — drop free‑form notes anywhere, with editable text color, background color, bold, font size, drag and resize.
- **Search** (`Ctrl+F`) — find cards by function name or by code content, and find notes by text; jump straight to a result.
- **Undo** (`Ctrl+Z`), **Copy / Paste** cards (`Ctrl+C` / `Ctrl+V`), **Delete** selection (`Backspace` / `Delete`), and **Clear** the whole board.
- **Auto‑save** — the board (cards, notes, lines, camera) is persisted per workspace and restored when you reopen it.

### Language

The UI and the AI prompt language are controlled by `solidity-flowboard.language`:

- `en` (default) — English.
- `ru` — Russian.

The setting also drives the AI: in English mode code comments come back in English, in Russian mode in Russian. Reload the window after changing the setting.

---

## Commands

| Command | Title | Where |
|---------|-------|-------|
| `solidity-flowboard.sendToFlowboard` | Send to Flowboard | Right‑click menu on a `.sol` file |
| `solidity-flowboard.openFlowboard` | Solidity Flowboard: Open Flowboard | Command Palette |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `solidity-flowboard.language` | `en` | UI and AI language: `en` (default) or `ru`. Reload after changing. |
| `solidity-flowboard.claudePath` | `claude` | Path to the Claude Code CLI used for AI code comments. |
| `solidity-flowboard.model` | (empty) | Model for AI features: an alias (`opus`, `sonnet`) or a full name; empty = the Claude Code default. |
| `solidity-flowboard.codebaseContext` | `true` | Analyze functions with read‑only access to the whole codebase (more accurate, slower, uses more subscription quota). |

---

## Usage

1. Open your contracts folder as a workspace, with Slither installed and dependency sources fetched (see **Requirements**).
2. Right‑click a function in a `.sol` file → **Send to Flowboard**.
3. Click highlighted calls to expand the flow; click modifier chips and `file:line` to jump to source; add notes and connecting lines; optionally request **Code comments**.

## Privacy

Flowboard runs entirely on your machine and sends nothing anywhere on its own. The only outbound traffic comes from the optional **Code comments** feature: when you trigger it, the selected function — and, with codebase context enabled, related files the model reads — is sent to Claude through your own locally installed Claude Code CLI. If you never use that button, no code leaves your machine.

## Build from source

```bash
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded for local development.
