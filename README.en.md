# StarMate AI

[简体中文](./README.zh-CN.md) · [English](./README.en.md) · [Documentation](./docs/README.md)

StarMate AI is a local-first desktop AI workspace that combines chat, autonomous agents, project management, code editing, an interactive terminal, and ComfyUI image generation in one application.

## Core Features

### Local Models and Chat

- Automatically discovers and connects to LM Studio, Ollama, and OpenAI-compatible local APIs.
- Streams final responses and visible reasoning with Markdown, code blocks, tables, formulas, links, and images.
- Provides Chat, Agent, and Image modes, with the selected mode persisted per conversation.
- Supports attachments, screenshots, full-size image previews, `@file` mentions, and editor selections.
- Collapses long messages and uses virtualized lists plus a throttled frontend output queue for long conversations.
- Includes conversation search, quick navigation, local caching, and separate input/output token statistics.

### Agent and Tools

- Includes file search, ranged reads, exact text replacement, line-range replacement, insertion, creation, deletion, moving, and command execution.
- When a location is unknown, `search_files` finds keywords and line numbers before the agent reads a focused range.
- A user selection is only an initial anchor; after reading its surrounding context, the agent may still search other files, conversation history, or the web.
- Existing files must be read before editing, while fingerprints and user-edit locks prevent overwriting concurrent user changes.
- After an exact replacement mismatch, the agent must refresh the file; repeated failed arguments are blocked and redirected to line-range replacement.
- Tool cards show the real function name, target file, operation range, duration, result, and error reason.
- Supports Read Only, Confirm Changes, Auto Edit, and Full Auto permission modes.

### Editor and Projects

- Multi-project workspaces, configurable current working directory, and a tree-based file explorer.
- File and folder creation, rename, deletion, path copying, system opening, and reveal-in-explorer actions.
- Multi-tab editing, drag-to-reorder tabs, independent search state, Markdown preview, formula rendering, and line-level diffs.
- Automatic refresh after files are changed by the agent, terminal, scripts, or external programs.
- Editor themes, minimap, word count, and real-time saving.
- Persistent interactive terminal powered by xterm.

### Web and Image Generation

- Both Chat and Agent modes can autonomously invoke web search and webpage extraction.
- Supports site-restricted searches, concurrent providers, proxy access, source tracking, and detailed failure diagnostics.
- Automatically discovers local ComfyUI workflows and exposes workflow-specific models, steps, dimensions, or aspect-ratio controls.
- Uses an independent image queue with cancellation, elapsed time, full-size preview, Save As, and reveal-in-folder actions.

### Context and Usage

- Uses context limits and token usage returned by the local model service whenever available.
- At 90% of the context window, the active local model compresses older history while preserving constraints, file state, and active tasks.
- Tracks input tokens, output tokens, invocation count, and daily calendar statistics in real time.
- Sends only the current objective by default and retrieves older conversation records on demand to avoid repeating completed work.

## Requirements

- Windows 10 or Windows 11
- Node.js 22 or newer (recommended)
- npm
- At least one local model service: LM Studio, Ollama, or an OpenAI-compatible endpoint
- An accessible ComfyUI service for image generation

## Development

```powershell
npm install
npm run dev
```

## Type Check and Build

```powershell
npm run typecheck
npm run build
```

## Build the Windows Installer

```powershell
npm run dist
```

The installer is generated in the `release` directory.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Electron development environment |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run build` | Build the main process, preload bridge, and renderer |
| `npm run pack` | Create an unpacked application directory |
| `npm run dist` | Create the Windows NSIS installer |

## Project Structure

```text
src/main/       Electron main process, agent, models, files, and ComfyUI services
src/preload/    Secure bridge exposed to the renderer
src/renderer/   React UI, state management, editor, and chat components
src/shared/     Types shared by the main process and renderer
scripts/        Icon generation and performance checks
docs/           Product and development documentation
build/          Application icon assets
```

## Local Data and Privacy

- Conversations, settings, and UI state are stored in the local application data directory.
- Workspace files are accessed only inside projects selected by the user.
- Commands and write operations are controlled by the active permission mode.
- Web search runs only when explicitly requested, required for current information, or needed to fill a verified knowledge gap.
- `.gitignore` excludes dependencies, build outputs, installers, and local caches.

## Project Status

The project is under active development. Use Git for important files and review the working tree before running Full Auto agent tasks.

