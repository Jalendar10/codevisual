import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { AIProviderManager } from './ai/aiProvider';
import { CodeAnalyzer } from './analysis/codeAnalyzer';
import { GitIntegration } from './git/gitIntegration';
import { CodeFlowWebviewProvider } from './webview/WebviewProvider';
import {
  CodePreview,
  GitAnalysisResult,
  GitWebhookSettings,
  GraphData,
  GraphNode,
  GraphTestStatus,
  TestRunSummary,
} from './types';

const execAsync = promisify(exec);

let currentGraph: GraphData | undefined;
let webview: CodeFlowWebviewProvider | undefined;
let gitIntegration: GitIntegration | undefined;

export function activate(context: vscode.ExtensionContext) {
  const aiManager = new AIProviderManager();
  webview = new CodeFlowWebviewProvider(context.extensionUri);
  const workspaceRoot = getWorkspaceRoot();
  gitIntegration = workspaceRoot ? new GitIntegration(workspaceRoot, aiManager) : undefined;

  context.subscriptions.push(
    vscode.commands.registerCommand('codeflow.visualizeFolder', async (uri?: vscode.Uri) => {
      const folderPath = uri?.fsPath || (await selectFolder());
      if (!folderPath) {
        return;
      }

      await renderGraph(`Analyzing ${path.basename(folderPath)}…`, async () => {
        const analyzer = new CodeAnalyzer(getWorkspaceRoot(folderPath) || folderPath);
        return analyzer.analyzeFolder(folderPath);
      });
    }),

    // New command: type a folder path directly in an input box
    vscode.commands.registerCommand('codeflow.visualizeFolderByPath', async () => {
      const workspaceRoot = getWorkspaceRoot();
      const input = await vscode.window.showInputBox({
        prompt: 'Enter the folder path to visualize',
        placeHolder: workspaceRoot || '/path/to/folder',
        value: workspaceRoot || '',
        ignoreFocusOut: true,
      });
      if (!input?.trim()) {
        return;
      }

      const folderPath = input.trim();
      if (!fs.existsSync(folderPath)) {
        vscode.window.showErrorMessage(`CodeFlow Visualizer: Folder not found — ${folderPath}`);
        return;
      }

      await renderGraph(`Analyzing ${path.basename(folderPath)}…`, async () => {
        const analyzer = new CodeAnalyzer(getWorkspaceRoot(folderPath) || folderPath);
        return analyzer.analyzeFolder(folderPath);
      });
    }),
    vscode.commands.registerCommand('codeflow.visualizeFile', async (uri?: vscode.Uri) => {
      const filePath = uri?.fsPath || vscode.window.activeTextEditor?.document.uri.fsPath;
      if (!filePath) {
        vscode.window.showWarningMessage('CodeFlow Visualizer: No file selected.');
        return;
      }

      await renderGraph(`Analyzing ${path.basename(filePath)}…`, async () => {
        const analyzer = new CodeAnalyzer(getWorkspaceRoot(filePath) || path.dirname(filePath));
        return analyzer.analyzeFile(filePath);
      });
    }),
    vscode.commands.registerCommand('codeflow.visualizeSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage('CodeFlow Visualizer: Select some code first.');
        return;
      }

      const selectedCode = editor.document.getText(editor.selection);
      const analyzer = new CodeAnalyzer(
        getWorkspaceRoot(editor.document.uri.fsPath) || path.dirname(editor.document.uri.fsPath)
      );

      await renderGraph('Analyzing selection…', async () => {
        return analyzer.analyzeSelection(selectedCode, editor.document.languageId, {
          filePath: editor.document.uri.fsPath,
          startLine: editor.selection.start.line + 1,
        });
      });
    })
  );

  webview.onDidRequestOpenLocation(async ({ filePath, line }) => {
    if (!fs.existsSync(filePath)) {
      webview?.showError(`Path not found: ${filePath}`);
      return;
    }

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(filePath));
      webview?.showStatus(
        'info',
        `Selected ${path.basename(filePath)} in the explorer. Directories cannot be opened as text.`
      );
      return;
    }

    const document = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false, // move focus to the opened file so the user sees it
      preview: false,
    });
    if (line) {
      const position = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenter
      );
    }
    webview?.showStatus('success', `Opened ${path.basename(filePath)}${line ? ` at line ${line}` : ''}.`);
  });

  webview.onDidRequestExport(async ({ format, content, fileName }) => {
    const defaultUri = vscode.Uri.file(
      path.join(getWorkspaceRoot() || process.cwd(), fileName)
    );
    const uri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: exportFilters(format),
    });

    if (!uri) {
      return;
    }

    const bytes = decodeExportContent(content);
    await vscode.workspace.fs.writeFile(uri, bytes);
    vscode.window.showInformationMessage(
      `CodeFlow Visualizer: Exported ${path.basename(uri.fsPath)}`
    );
  });

  webview.onDidRequestAiAnalysis(async ({ nodeId }) => {
    if (!currentGraph) {
      webview?.showError('Open a graph first, then select a file, class, method, or test.');
      return;
    }

    try {
      const node = findNode(nodeId);
      if (!node?.data.filePath) {
        throw new Error('Select a file, class, or method node in the graph first.');
      }

      const filePath = node.data.filePath;
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        throw new Error(`Cannot read "${path.basename(filePath)}" — select a file node, not a folder.`);
      }
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const content = extractNodeContent(node, fileContent);
      const root = getWorkspaceRoot(filePath) || path.dirname(filePath);
      const analysis = await aiManager.analyzeCode(content, {
        filePath: path.relative(root, filePath),
        language: node.data.language,
        instructions:
          node.data.startLine && node.data.endLine
            ? `Focus on the selected ${node.data.kind || node.type} between lines ${node.data.startLine}-${node.data.endLine}.`
            : `Analyze this ${node.data.kind || node.type}.`,
      });

      webview?.showAIAnalysisResult(node.data.label, analysis);
      webview?.showStatus('success', `Copilot analyzed ${node.data.label}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AI analysis failed.';
      webview?.showError(message);
    }
  });

  webview.onDidRequestCodePreview(async ({ nodeId }) => {
    try {
      const preview = buildCodePreview(nodeId);
      if (!preview) {
        return;
      }

      webview?.showCodePreview(preview);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Code preview failed.';
      webview?.showStatus('warning', message);
    }
  });

  webview.onDidRequestTestGeneration(async ({ nodeId }) => {
    try {
      const node = findNode(nodeId);
      if (!node?.data.filePath) {
        throw new Error('Select a class, method, or function node first.');
      }

      if (!['class', 'method', 'function', 'file'].includes(node.type)) {
        throw new Error('Select a file, class, method, or function node to generate tests.');
      }

      const filePath = node.data.filePath;
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        throw new Error('CodeFlow can only generate tests for source files.');
      }

      const fileContent = fs.readFileSync(filePath, 'utf8');
      const classNode = findAncestorByType(node, ['class', 'interface', 'type']);
      const targetCode = extractNodeContent(node, fileContent);
      const classCode =
        classNode && classNode.id !== node.id ? extractNodeContent(classNode, fileContent) : undefined;
      const framework = inferTestFramework(filePath, fileContent);
      const generated = await aiManager.generateText(
        buildTestGenerationPrompt({
          framework,
          language: String(node.data.language || ''),
          relativePath: path.relative(getWorkspaceRoot(filePath) || path.dirname(filePath), filePath),
          targetLabel: String(node.data.label),
          targetKind: String(node.data.kind || node.type),
          classLabel: classNode ? String(classNode.data.label) : undefined,
          targetCode,
          classCode,
        })
      );

      const testFilePath = resolveTestFilePath(node, filePath);
      fs.mkdirSync(path.dirname(testFilePath), { recursive: true });
      fs.writeFileSync(testFilePath, stripCodeFences(generated), 'utf8');

      const document = await vscode.workspace.openTextDocument(testFilePath);
      await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
      await refreshGraphFromCurrentState();
      webview?.showStatus('success', `Generated tests at ${path.basename(testFilePath)}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Test generation failed.';
      webview?.showError(message);
    }
  });

  webview.onDidRequestGitData(async () => {
    await pushGitData();
  });

  webview.onDidRequestGitAnalysis(async () => {
    if (!gitIntegration) {
      webview?.showStatus('warning', 'Git integration is only available in a workspace folder.');
      return;
    }

    try {
      webview?.showStatus('info', 'Analyzing current git changes with Copilot...');
      const review = await gitIntegration.analyzeGitChanges();
      await pushGitData(review);
      webview?.showStatus('success', 'Git review updated.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Git analysis failed.';
      webview?.showError(message);
    }
  });

  webview.onDidSaveGitSettings(async (settings) => {
    const config = vscode.workspace.getConfiguration('codeflow');
    await config.update('git.provider', settings.provider, vscode.ConfigurationTarget.Workspace);
    await config.update('git.webhookUrl', settings.webhookUrl, vscode.ConfigurationTarget.Workspace);
    await config.update(
      'git.webhookSecret',
      settings.webhookSecret,
      vscode.ConfigurationTarget.Workspace
    );

    await pushGitData();
    webview?.showStatus(
      'success',
      `Saved ${settings.provider} webhook settings. Use this with your GitHub or GitLab webhook relay.`
    );
  });

  webview.onDidRequestRunTests(async () => {
    const root = getWorkspaceRoot();
    const command = root ? inferTestCommand(root) : undefined;

    if (!root || !command) {
      try {
        await vscode.commands.executeCommand('workbench.view.testing.focus');
        await vscode.commands.executeCommand('testing.runAll');
        webview?.showStatus(
          'info',
          'Triggered the VS Code test runner. CodeFlow could not infer a shell command for pass/fail parsing in this workspace.'
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'VS Code could not start the test run for this workspace.';
        webview?.showStatus('warning', message);
      }

      return;
    }

    const runningStatuses = createUniformTestStatuses('running');
    const runningSummary: TestRunSummary = {
      status: 'running',
      command,
      passed: 0,
      failed: 0,
      skipped: 0,
      message: `Running ${command}`,
    };
    webview?.showTestResults(runningSummary, runningStatuses, Object.keys(runningStatuses));
    webview?.showStatus('info', `Running ${command} and collecting test flow.`);

    const startedAt = Date.now();

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: root,
        maxBuffer: 20 * 1024 * 1024,
        shell: '/bin/zsh',
      });
      const testResult = parseTestOutput(`${stdout}\n${stderr}`);
      const summary: TestRunSummary = {
        status: testResult.failed > 0 ? 'failed' : 'completed',
        command,
        passed: testResult.passed,
        failed: testResult.failed,
        skipped: testResult.skipped,
        durationMs: Date.now() - startedAt,
        message:
          testResult.failed > 0
            ? `${testResult.failed} test failures detected.`
            : `Test run finished with ${testResult.passed} passing tests.`,
        affectedTargets: testResult.affectedTargets,
      };
      const affectedNodeIds = findAffectedNodeIds(testResult.statuses);

      webview?.showTestResults(summary, testResult.statuses, affectedNodeIds);
      webview?.showStatus(
        testResult.failed > 0 ? 'warning' : 'success',
        summary.message || 'Test run finished.'
      );
    } catch (error) {
      const stdout = typeof error === 'object' && error && 'stdout' in error ? String(error.stdout || '') : '';
      const stderr = typeof error === 'object' && error && 'stderr' in error ? String(error.stderr || '') : '';
      const testResult = parseTestOutput(`${stdout}\n${stderr}`);
      const summary: TestRunSummary = {
        status: 'failed',
        command,
        passed: testResult.passed,
        failed: Math.max(1, testResult.failed),
        skipped: testResult.skipped,
        durationMs: Date.now() - startedAt,
        message:
          testResult.failed > 0
            ? `${testResult.failed} test failures detected.`
            : error instanceof Error
              ? error.message
              : `Test command failed: ${command}`,
        affectedTargets: testResult.affectedTargets,
      };
      const affectedNodeIds = findAffectedNodeIds(testResult.statuses);

      webview?.showTestResults(summary, testResult.statuses, affectedNodeIds);
      webview?.showStatus('warning', summary.message || `Test command failed: ${command}`);
    }
  });

  void refreshAiStatus(aiManager);
}

export function deactivate() {
  webview?.dispose();
  gitIntegration?.dispose();
}

async function refreshAiStatus(aiManager?: AIProviderManager): Promise<void> {
  if (!webview) {
    return;
  }

  const manager = aiManager || new AIProviderManager();
  const status = await manager.getCopilotStatus();
  webview.updateAiStatus(status);
}

async function pushGitData(review?: GitAnalysisResult): Promise<void> {
  if (!webview) {
    return;
  }

  const commits = gitIntegration ? await gitIntegration.getRecentCommits(12) : [];
  webview.showGitData(commits, getGitSettings(), review);
}

function getGitSettings(): GitWebhookSettings {
  const config = vscode.workspace.getConfiguration('codeflow');
  return {
    provider: config.get<'github' | 'gitlab'>('git.provider', 'github'),
    webhookUrl: config.get<string>('git.webhookUrl', ''),
    webhookSecret: config.get<string>('git.webhookSecret', ''),
  };
}

async function renderGraph(
  title: string,
  loader: () => Promise<GraphData>
): Promise<void> {
  webview?.show();
  // Notify the webview immediately so it shows a loading indicator
  webview?.showStatus('info', title);
  void refreshAiStatus();

  try {
    currentGraph = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'CodeFlow Visualizer',
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: title, increment: 15 });
        const graph = await loader();
        progress.report({ message: 'Rendering graph…', increment: 100 });
        return graph;
      }
    );

    webview?.updateGraph(currentGraph);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error while generating graph.';
    webview?.showError(message);
    vscode.window.showErrorMessage(`CodeFlow Visualizer: ${message}`);
  }
}

async function selectFolder(): Promise<string | undefined> {
  const result = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Visualize Folder Structure',
  });

  return result?.[0]?.fsPath;
}

function getWorkspaceRoot(targetPath?: string): string | undefined {
  if (targetPath) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(targetPath));
    if (workspaceFolder) {
      return workspaceFolder.uri.fsPath;
    }
  }

  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function exportFilters(format: 'png' | 'svg' | 'json'): Record<string, string[]> {
  switch (format) {
    case 'png':
      return { PNG: ['png'] };
    case 'svg':
      return { SVG: ['svg'] };
    default:
      return { JSON: ['json'] };
  }
}

function decodeExportContent(content: string): Uint8Array {
  if (content.startsWith('data:')) {
    const [, encoded] = content.split(',', 2);
    return Uint8Array.from(Buffer.from(encoded, 'base64'));
  }

  return Uint8Array.from(Buffer.from(content, 'utf8'));
}

// Keep a thin JSON export fallback available to the webview if it wants to request it later.
export function getCurrentGraph(): GraphData | undefined {
  return currentGraph;
}

export function saveInlineSnapshot(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, 'utf8');
}

function findNode(nodeId?: string): GraphNode | undefined {
  if (!nodeId || !currentGraph) {
    return undefined;
  }

  return currentGraph.nodes.find((node) => node.id === nodeId);
}

function extractNodeContent(node: GraphNode, fileContent: string): string {
  if (!node.data.startLine || !node.data.endLine) {
    return fileContent;
  }

  const lines = fileContent.split('\n');
  return lines.slice(node.data.startLine - 1, node.data.endLine).join('\n');
}

function buildCodePreview(nodeId?: string): CodePreview | undefined {
  const node = findNode(nodeId);
  if (!node?.data.filePath) {
    return undefined;
  }

  const filePath = node.data.filePath;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return undefined;
  }

  const fileContent = fs.readFileSync(filePath, 'utf8');
  const classNode =
    node.type === 'class' || node.type === 'interface' || node.type === 'type'
      ? node
      : findAncestorByType(node, ['class', 'interface', 'type']);

  return {
    nodeId: node.id,
    filePath,
    fileName: path.basename(filePath),
    relativePath: node.data.relativePath,
    className: classNode ? String(classNode.data.label) : undefined,
    methodName:
      node.type === 'method' || node.type === 'function' || node.type === 'test'
        ? String(node.data.label)
        : undefined,
    fileCode: truncateCodePreview(fileContent, 80, 7000),
    classCode: classNode
      ? truncateCodePreview(extractNodeContent(classNode, fileContent), 120, 7000)
      : undefined,
    methodCode:
      node.type === 'method' || node.type === 'function' || node.type === 'test'
        ? truncateCodePreview(extractNodeContent(node, fileContent), 80, 5000)
        : undefined,
  };
}

function findAncestorByType(
  node: GraphNode,
  acceptedTypes: Array<GraphNode['type']>
): GraphNode | undefined {
  if (!currentGraph) {
    return undefined;
  }

  const nodeMap = new Map(currentGraph.nodes.map((entry) => [entry.id, entry]));
  let parentId = node.data.parentId;

  while (parentId) {
    const parent = nodeMap.get(parentId);
    if (!parent) {
      return undefined;
    }

    if (acceptedTypes.includes(parent.type)) {
      return parent;
    }

    parentId = parent.data.parentId;
  }

  return undefined;
}

function truncateCodePreview(code: string, maxLines: number, maxChars: number): string {
  const lines = code.split('\n').slice(0, maxLines).join('\n');
  if (lines.length <= maxChars) {
    return lines;
  }

  return `${lines.slice(0, maxChars)}\n/* …truncated… */`;
}

async function refreshGraphFromCurrentState(): Promise<void> {
  if (!currentGraph?.metadata.path) {
    return;
  }

  const targetPath = currentGraph.metadata.path;
  if (currentGraph.metadata.type === 'folder') {
    await renderGraph('Refreshing folder graph…', async () => {
      const analyzer = new CodeAnalyzer(getWorkspaceRoot(targetPath) || targetPath);
      return analyzer.analyzeFolder(targetPath);
    });
    return;
  }

  if (currentGraph.metadata.type === 'file') {
    await renderGraph('Refreshing file graph…', async () => {
      const analyzer = new CodeAnalyzer(getWorkspaceRoot(targetPath) || path.dirname(targetPath));
      return analyzer.analyzeFile(targetPath);
    });
  }
}

function buildTestGenerationPrompt(args: {
  framework: string;
  language: string;
  relativePath: string;
  targetLabel: string;
  targetKind: string;
  classLabel?: string;
  targetCode: string;
  classCode?: string;
}): string {
  return `Generate ${args.framework} test cases for this ${args.targetKind}.

Return ONLY the test file source code. Do not include markdown fences.
Requirements:
- Cover success cases, edge cases, and at least one failure path.
- Keep imports realistic for the existing file path.
- If dependencies need mocking, include the mock setup.
- Prefer readable test names.

File: ${args.relativePath}
Target: ${args.targetLabel}
Class: ${args.classLabel || 'n/a'}
Language: ${args.language}
Framework: ${args.framework}

${args.classCode ? `Enclosing class:\n${args.classCode}\n\n` : ''}Target code:\n${args.targetCode}`;
}

function inferTestFramework(filePath: string, fileContent: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.py') {
    return 'pytest';
  }

  if (ext === '.java') {
    return 'JUnit 5';
  }

  if (ext === '.go') {
    return 'Go testing';
  }

  if (/vitest/i.test(fileContent)) {
    return 'Vitest';
  }

  return 'Jest';
}

function resolveTestFilePath(node: GraphNode, sourceFilePath: string): string {
  const ext = path.extname(sourceFilePath);
  const dir = path.dirname(sourceFilePath);
  const sourceBase = path.basename(sourceFilePath, ext);
  const targetBase = sanitizeFileSegment(String(node.data.label || sourceBase));

  if (ext === '.py') {
    return ensureUniqueFilePath(path.join(dir, `test_${sourceBase}.py`));
  }

  if (ext === '.java') {
    return ensureUniqueFilePath(path.join(dir, `${targetBase}Test.java`));
  }

  if (ext === '.go') {
    return ensureUniqueFilePath(path.join(dir, `${sourceBase}_test.go`));
  }

  const testDir = path.join(dir, '__tests__');
  const suffix = ext === '.tsx' ? '.tsx' : ext === '.jsx' ? '.jsx' : ext || '.ts';
  return ensureUniqueFilePath(path.join(testDir, `${targetBase}.test${suffix}`));
}

function ensureUniqueFilePath(initialPath: string): string {
  if (!fs.existsSync(initialPath)) {
    return initialPath;
  }

  const ext = path.extname(initialPath);
  const base = ext ? initialPath.slice(0, -ext.length) : initialPath;
  return `${base}.generated${ext}`;
}

function sanitizeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '').trim() || 'GeneratedSpec';
}

function stripCodeFences(value: string): string {
  return value
    .replace(/^```[a-zA-Z0-9_-]*\s*/u, '')
    .replace(/```$/u, '')
    .trim();
}

function createUniformTestStatuses(status: GraphTestStatus): Record<string, GraphTestStatus> {
  const statuses: Record<string, GraphTestStatus> = {};
  if (!currentGraph) {
    return statuses;
  }

  for (const node of currentGraph.nodes) {
    if (node.type === 'test') {
      statuses[node.id] = status;
    }
  }

  return statuses;
}

function parseTestOutput(output: string): {
  statuses: Record<string, GraphTestStatus>;
  passed: number;
  failed: number;
  skipped: number;
  affectedTargets: string[];
} {
  const statuses: Record<string, GraphTestStatus> = {};
  const lines = output.split(/\r?\n/);
  const testNodes = currentGraph?.nodes.filter((node) => node.type === 'test') || [];
  const normalizedLines = lines.map((line) => normalizeToken(line));

  for (const node of testNodes) {
    const token = normalizeToken(node.data.label || '');
    if (!token) {
      continue;
    }

    for (let index = 0; index < normalizedLines.length; index += 1) {
      const normalizedLine = normalizedLines[index];
      if (!normalizedLine.includes(token)) {
        continue;
      }

      const rawLine = lines[index].toLowerCase();
      if (/\b(failed|fail|error|✕|x)\b/.test(rawLine)) {
        statuses[node.id] = 'failed';
        break;
      }

      if (/\b(passed|pass|ok|success|✓)\b/.test(rawLine)) {
        statuses[node.id] = 'passed';
        break;
      }

      if (/\b(running|queued)\b/.test(rawLine)) {
        statuses[node.id] = 'running';
        break;
      }
    }
  }

  const aggregateCounts = parseAggregateCounts(output);
  const passed =
    aggregateCounts.passed ??
    Object.values(statuses).filter((status) => status === 'passed').length;
  const failed =
    aggregateCounts.failed ??
    Object.values(statuses).filter((status) => status === 'failed').length;
  const skipped = aggregateCounts.skipped ?? 0;
  const affectedTargets = findAffectedTargets(statuses);

  return {
    statuses,
    passed,
    failed,
    skipped,
    affectedTargets,
  };
}

function parseAggregateCounts(output: string): {
  passed?: number;
  failed?: number;
  skipped?: number;
} {
  const lowered = output.toLowerCase();

  const mavenMatch = lowered.match(
    /tests run:\s*(\d+),\s*failures:\s*(\d+),\s*errors:\s*(\d+),\s*skipped:\s*(\d+)/
  );
  if (mavenMatch) {
    const total = Number(mavenMatch[1]);
    const failures = Number(mavenMatch[2]) + Number(mavenMatch[3]);
    const skipped = Number(mavenMatch[4]);
    return {
      passed: Math.max(0, total - failures - skipped),
      failed: failures,
      skipped,
    };
  }

  const summaryMatch = lowered.match(
    /(?:(\d+)\s+failed)?[^\n]*?(?:(\d+)\s+passed)?[^\n]*?(?:(\d+)\s+skipped)?/
  );
  if (summaryMatch && (summaryMatch[1] || summaryMatch[2] || summaryMatch[3])) {
    return {
      failed: summaryMatch[1] ? Number(summaryMatch[1]) : undefined,
      passed: summaryMatch[2] ? Number(summaryMatch[2]) : undefined,
      skipped: summaryMatch[3] ? Number(summaryMatch[3]) : undefined,
    };
  }

  return {};
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function findAffectedTargets(statuses: Record<string, GraphTestStatus>): string[] {
  if (!currentGraph) {
    return [];
  }

  const activeTestIds = Object.entries(statuses)
    .filter(([, status]) => status === 'passed' || status === 'failed')
    .map(([id]) => id);
  if (activeTestIds.length === 0) {
    return [];
  }

  const edgeMap = new Map<string, string[]>();
  for (const edge of currentGraph.edges) {
    if (edge.type !== 'testFlow' && edge.type !== 'call') {
      continue;
    }

    const list = edgeMap.get(edge.source) || [];
    list.push(edge.target);
    edgeMap.set(edge.source, list);
  }

  const nodeMap = new Map(currentGraph.nodes.map((node) => [node.id, node]));
  const visited = new Set<string>(activeTestIds);
  const queue = [...activeTestIds];
  const labels = new Set<string>();

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    const node = nodeMap.get(nodeId);
    if (node) {
      labels.add(node.data.label);
      let parentId = node.data.parentId;
      while (parentId) {
        const parent = nodeMap.get(parentId);
        if (!parent) {
          break;
        }
        labels.add(parent.data.label);
        parentId = parent.data.parentId;
      }
    }

    const targets = edgeMap.get(nodeId) || [];
    for (const target of targets) {
      if (visited.has(target)) {
        continue;
      }

      visited.add(target);
      queue.push(target);
    }
  }

  return Array.from(labels).slice(0, 24);
}

function findAffectedNodeIds(statuses: Record<string, GraphTestStatus>): string[] {
  if (!currentGraph) {
    return Object.keys(statuses);
  }

  const activeTestIds = Object.entries(statuses)
    .filter(([, status]) => status === 'passed' || status === 'failed' || status === 'running')
    .map(([id]) => id);
  const affected = new Set<string>(activeTestIds);
  const nodeMap = new Map(currentGraph.nodes.map((node) => [node.id, node]));
  const queue = [...activeTestIds];

  while (queue.length > 0) {
    const sourceId = queue.shift()!;
    for (const edge of currentGraph.edges) {
      if (edge.source !== sourceId) {
        continue;
      }

      if (edge.type !== 'testFlow' && edge.type !== 'call' && edge.type !== 'dataFlow') {
        continue;
      }

      if (!affected.has(edge.target)) {
        affected.add(edge.target);
        queue.push(edge.target);
      }
    }

    let parentId = nodeMap.get(sourceId)?.data.parentId;
    while (parentId) {
      if (affected.has(parentId)) {
        parentId = nodeMap.get(parentId)?.data.parentId;
        continue;
      }

      affected.add(parentId);
      parentId = nodeMap.get(parentId)?.data.parentId;
    }
  }

  return Array.from(affected);
}

function inferTestCommand(rootPath: string): string | undefined {
  const packageJsonPath = path.join(rootPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      const testScript = packageJson.scripts?.test;
      if (testScript && !/no test specified/i.test(testScript)) {
        return 'npm test';
      }
    } catch {
      // Ignore malformed package.json and try the next runner.
    }
  }

  if (fs.existsSync(path.join(rootPath, 'pytest.ini')) || fs.existsSync(path.join(rootPath, 'conftest.py'))) {
    return 'pytest';
  }

  if (fs.existsSync(path.join(rootPath, 'pom.xml'))) {
    return 'mvn test';
  }

  if (fs.existsSync(path.join(rootPath, 'go.mod'))) {
    return 'go test ./...';
  }

  if (fs.existsSync(path.join(rootPath, 'Cargo.toml'))) {
    return 'cargo test';
  }

  return undefined;
}
