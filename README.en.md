<div align="center">

# Nexus · Non-linear Conversation Canvas

**Turns an AI conversation from a single timeline into a directed acyclic graph**

[中文](README.md) · English

[**Live demo**](https://yule1048596-art.github.io/nonlinear-chat/) · Frontend only · Bring your own API key · Everything stays in your browser

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/canvas-dark.png">
  <img alt="Nexus canvas: one system node branches into two independent lines of inquiry, and both branches converge into a single follow-up node" src="docs/canvas-light.png">
</picture>

<sub>Two independent branches (rate-limiting algorithms / cache invalidation) converging into one follow-up node. The status bar shows this request will carry 5 messages plus a system prompt, roughly 313 tokens.</sub>

</div>

---

## What it is

A chat interface where the conversation isn't stacked top-to-bottom in a single column. Instead, messages live as nodes on a canvas you can pan and rearrange, connected by edges — and **a node can have more than one parent**.

When you send, the app collects every ancestor of the current node, topologically sorts them into a single message chain, and hands that to the model. The canvas is a graph; what goes over the wire is still a plain `messages` array, so any OpenAI-compatible endpoint works as-is.

## Why

Mainstream AI chat apps are linear, which causes four problems you can't design around:

| Problem | In a linear chat | Here |
| --- | --- | --- |
| **Context pollution**<br>One tangent derails the main thread | Start a new chat, lose all prior context | Pull a branch off any node; the tangent and the main thread never touch |
| **Losing good answers**<br>Regenerating overwrites the previous one | Gone | "Side-by-side regenerate" keeps the old answer and grows the new one next to it |
| **No comparison**<br>You want to weigh two approaches | Two windows, constant switching | Both branches sit side by side on the canvas |
| **No convergence**<br>Branch A and branch B each hold half the answer | Copy-paste by hand | A node can have **multiple parents**; both branches merge into one context automatically |

**That last row is the whole point.** The first three can be solved with a branching *tree*. Convergence cannot — in a tree every node has exactly one parent, so two branches can never meet again. You need a DAG.

The screenshot above is exactly this: rate-limiting on the left, cache invalidation on the right, each explored without interference, then two edges dragged into one follow-up node. The model now sees all five messages without you pasting any of the earlier answers back in.

## How it works

The canvas is a **graph**; the model needs a **sequence**. That translation lives in [`src/lib/context.ts`](src/lib/context.ts):

1. Walk up from the current node collecting **all ancestors** — reaching the same ancestor through several paths counts once
2. Topologically sort that subgraph (Kahn's algorithm) so a parent always precedes its children
3. Among simultaneously-ready nodes, prefer the earlier `createdAt` — so merged branches interleave in the order things actually happened, while causal order *within* each branch stays intact
4. `system` nodes are pulled out and merged into one system message; `note` nodes are skipped by default, as are empty and errored nodes

Step 4 has a pleasant side effect: **first generation and regeneration share one code path.** Clearing a node's content before regenerating automatically excludes it from its own context — no second implementation needed.

### Context is always visible

The thing that gets out of hand fastest in a non-linear conversation is "what am I actually sending?" So that is the **only strong visual signal** in the interface:

Select any node and everything outside its context fades and desaturates, the edges along the path turn into flowing accent-coloured lines, and the status bar reports the message count and an estimated token count.

Everything else gets out of the way. Per-node action buttons are hidden until you hover or select; so are the model name and token usage. Thirty nodes on a canvas still don't turn into a wall of buttons.

## Features

**Conversation**
- Branch from any node; branches are fully isolated from each other
- Multi-parent merging — the entire reason this is a DAG and not a tree
- Side-by-side regenerate keeps the old answer; re-sending a question that already has an answer also never overwrites it
- Streaming output, stoppable at any time (whatever arrived is kept)
- Reasoning traces (`reasoning_content`) from reasoning models are shown collapsed and excluded from the next turn's context

**Node types**
- **User** — what you say
- **AI** — the model's reply
- **System** — injected as a system prompt into every downstream branch
- **Note** — a canvas annotation, excluded from context unless you opt it in

**Canvas**
- ⌘K full-text search; Enter jumps to the node and centres it
- One-click layered auto-layout (dagre), undoable
- Collapse an entire downstream subtree; the node shows how many are hidden
- Minimap, zoom, box selection

**Safety net**
- Full undo/redo (⌘Z / ⌘⇧Z) covering deletion, linking, layout, regeneration and edits
- Consecutive typing and a single drag coalesce into one history entry — undo doesn't step back one character at a time
- Deleting a subtree tells you how many nodes went and that you can undo
- Cycles are rejected with an explanation

**Also**
- Light/dark themes, following the system by default
- Multiple model profiles — run different models on different branches to compare
- Export/import a canvas as JSON

## Quick start

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173 → **设置** (Settings, top right) → pick a provider preset → paste your API key → **测试连接** (Test connection).

Or just use the [hosted version](https://yule1048596-art.github.io/nonlinear-chat/) — nothing to install.

> **Note on UI language:** the interface is currently Chinese-only. Internationalising it is not done yet; this document is the English entry point for now.

## Supported models

Anything that implements the OpenAI `/chat/completions` protocol. Built-in presets fill in the base URL for you:

Xiaomi MiMo · OpenAI · DeepSeek · OpenRouter · SiliconFlow · Moonshot · Zhipu GLM · local Ollama

Any other base URL can be typed in manually. You can store **several profiles** and use different models on different branches.

### CORS

The browser talks to the provider directly, so the provider must allow cross-origin requests. All of the above do. Local Ollama needs an environment variable:

```bash
OLLAMA_ORIGINS=* ollama serve
```

When a connection fails, "Test connection" tells you whether it was CORS, a bad key, or a wrong base URL — not just `Failed to fetch`.

## Keyboard and mouse

| Action | Effect |
| --- | --- |
| Double-click empty canvas | New detached node |
| Right-click empty canvas | New user / system / note node |
| ⌘/Ctrl + Enter | Send from inside a user node |
| Drag a node's bottom dot → another node's top dot | Add a context source (this is the "multi-parent" bit) |
| Click the bottom dot, then the target's top dot | Same, without dragging |
| Select a node | Highlights its full context; everything else fades |
| ⌘/Ctrl + Z | Undo; add Shift to redo |
| ⌘/Ctrl + K | Search node contents and jump |
| Click a node's role badge | Switch between user / system / note (AI nodes are fixed) |
| ⊟ in the node's action bar | Collapse the downstream subtree |
| "整理" in the toolbar | Layered auto-layout, undoable |
| ◑ in the toolbar | Cycle theme: follow system → light → dark |
| 追问 / 重生 / 并排 | Follow up / regenerate in place / regenerate side by side |
| Shift + click ✕ | Delete the node and everything downstream |
| Select an edge, press Backspace | Remove that context source |

## Data and privacy

API keys, canvases and settings all live in the browser's **IndexedDB**. Nothing passes through a third-party server; requests go straight from your browser to the model provider.

The hosted build is no different — [the deployed site](https://yule1048596-art.github.io/nonlinear-chat/) contains no keys. Every visitor uses their own, stored in their own browser, isolated from everyone else's.

The trade-off: **clearing browser data wipes it all.** Export canvases you care about as JSON. Importing reassigns node ids, so the same file can be imported repeatedly without collisions.

## Stack and layout

React 19 · TypeScript · Vite · [React Flow](https://reactflow.dev) · Zustand · IndexedDB · dagre

```
src/
├── types.ts              Data model
├── lib/
│   ├── context.ts        DAG → message list + collapse visibility (core, tested)
│   ├── history.ts        Undo stack (pure functions, tested)
│   ├── tokens.ts         Token estimation (tested)
│   ├── autoLayout.ts     dagre layered layout
│   ├── llm.ts            OpenAI-compatible streaming client (SSE parsing, error attribution)
│   ├── db.ts             IndexedDB + debounced save with maxWait
│   ├── layout.ts         Collision-avoiding placement for new nodes
│   ├── theme.ts          Light/dark themes
│   └── toast.ts          Module-level notifications
├── store/useStore.ts     zustand: all graph mutations + streaming + undo
└── components/
    ├── Canvas.tsx        React Flow integration, context highlighting, cycle checks, collapse
    ├── MessageNode.tsx   Node card
    ├── SearchPalette.tsx ⌘K search
    ├── ContextMenu.tsx   Right-click / role-switch menu
    └── Toolbar.tsx / GraphDrawer.tsx / SettingsPanel.tsx / Markdown.tsx
```

## Development

```bash
npm test
```

43 tests covering DAG topological ordering, multi-parent merging, diamond deduplication, cycle detection, context trimming, collapse-visibility propagation, undo-stack coalescing and limits, and token estimation.

To debug without spending real API credits, use the fake server in the repo:

```bash
node scripts/mock-server.mjs
```

Set the base URL to `http://localhost:8787/v1` and any key. It echoes the full `messages` array it received back into the reply and prints it to the terminal — **the only reliable way to verify that a multi-parent merge produced the right context order**, since the UI can't show you what actually went over the wire.

To regenerate the README screenshots (puppeteer is deliberately not a dependency — it downloads a whole browser):

```bash
npm i -D puppeteer && node scripts/screenshot.mjs && npm un -D puppeteer
```

## Deployment

Pushing to `main` deploys automatically: [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) installs, **runs the tests**, builds, and publishes to GitHub Pages. A failing test blocks the deploy.

`base: './'` in `vite.config.ts` produces relative asset paths, so serving from a subpath like `/nonlinear-chat/` needs no extra configuration.

`npm run deploy` publishes manually via the `gh-pages` branch if you need to bypass CI (switch Settings → Pages back to branch mode first).

## Things that bit us

These all took real time to track down:

- **Snapshotting the whole node map in the undo stack is not a deep copy.** Every mutation in the store is `nodes[id] = {...old}` — never in place — so unchanged nodes are the same object across snapshots. One history entry is just an object holding N pointers.
- **Streaming must be excluded from undo history**, or a flush every 33ms floods the stack within seconds.
- **Subtree collapse in a DAG is not "hide all descendants."** A convergence node may hang off both a collapsed branch and a visible one; hiding descendants naively swallows the endpoint of a still-visible path. The correct rule propagates visibility from the roots: a node is visible iff it has at least one visible, non-collapsed parent.
- **Floating menus must be portalled to `body`.** React Flow's viewport carries a `transform`, which makes it the containing block for `position: fixed`, so a menu rendered inside a node lands in the wrong place.
- **React Flow's double-click-to-zoom calls `stopPropagation`** and swallows `onDoubleClick`. You need `zoomOnDoubleClick={false}` to implement "double-click to create a node".
- **In controlled mode React Flow does not write measured node dimensions back into your node objects** — it reports them once via an `onNodesChange` `dimensions` change. The minimap decides whether a node "has dimensions" by reading `node.measured`, so dropping that change makes the minimap render nothing at all. (Edges are unaffected; they read the internal measurements.)
- **Calling setState per streamed token drags the canvas down.** Two mitigations: node content updates are throttled to about 30fps, and React Flow's node objects are cached by id so only position/selection changes mint new objects — content changes are absorbed by `MessageNode`'s own store subscription.
- **A plain debounce never fires during streaming** (tokens keep arriving, the timer keeps resetting). `createDebouncedSaver` takes a `maxWait` and forces a write every 3 seconds.
- **Closing the page mid-stream** leaves nodes stuck in `streaming`. They're normalised to `idle` on load.
- **A hover-revealed action bar must always occupy its space**, or the node's height changes on hover and the edges twitch. Control it with `opacity`, not `display`.
- **A GitHub Pages workflow must not use `concurrency: cancel-in-progress: true`.** Cancelling a run mid-publish leaves GitHub stuck in `updating_pages`, and every later deploy then polls until it times out.

## License

[MIT](LICENSE) — use it, modify it, ship it commercially. Keep the copyright
notice; the software comes with no warranty.

## Not done yet

- Cross-canvas search (currently the active canvas only)
- Sharing / multi-device sync (needs a backend; this is purely local right now)
- Image and file input
- Exporting/importing settings (canvases already export)
- Keyboard navigation between nodes
- **Internationalising the UI itself** — the interface is Chinese-only so far
