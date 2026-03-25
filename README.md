# CodeFlow Visualizer

CodeFlow Visualizer is a VS Code extension that turns folders, files, and code elements into an interactive node graph.

## What It Does

- Visualizes folder structure with nested folder and file nodes
- Expands folder views down into files, classes, methods, and tests
- Sizes file nodes based on line count and file size
- Draws internal import edges between files inside a selected folder
- Visualizes classes, interfaces, functions, methods, types, and variables for a file or selection
- Adds heuristic inheritance, implementation, call-graph, and test-flow edges
- Supports pan, zoom, drag, minimap, search, expand/collapse, and layout switching
- Auto-refreshes file and folder graphs on save/create/delete with live activity flashes
- Adds complexity and git-hotspot overlays so risky areas stand out immediately
- Highlights upstream dependents and downstream dependencies when a node is selected
- Clicks through from graph nodes back to the source file in VS Code
- Exports the current graph as JSON, SVG, or PNG
- Includes two webview tabs: `Visual` and `Settings & AI`
- Uses GitHub Copilot Chat through VS Code's language model API for AI analysis

## Commands

- `CodeFlow: Visualize Folder Structure`
- `CodeFlow: Visualize File`
- `CodeFlow: Visualize Selection`

These commands are available from the explorer context menu and editor context menu.

## Tabs

- `Visual`: the interactive graph canvas and export controls
- `Settings & AI`: graph filters, test-flow controls, and Copilot analysis for the selected node

## Settings

- `codeflow.defaultLayout`
- `codeflow.theme`
- `codeflow.showImports`
- `codeflow.showCallGraph`
- `codeflow.maxDepth`
- `codeflow.excludePatterns`
- `codeflow.liveRefresh`

## Supported Languages

The extension includes dedicated parsers for:

- TypeScript / JavaScript
- Python
- Java
- Go

It also includes regex-based fallback parsing for:

- Rust
- C#
- C / C++
- Ruby
- PHP
- Swift
- Kotlin
- Scala
- Dart
- Lua
- Shell
- YAML / JSON / HTML / CSS / SQL

## Development

```bash
npm install
npm run build
```

Use `F5` in VS Code to launch an Extension Development Host.
