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
  PersistedVisualState,
  TestAgentSettings,
  TestRunSummary,
} from './types';

const execAsync = promisify(exec);

let currentGraph: GraphData | undefined;
let webview: CodeFlowWebviewProvider | undefined;
let gitIntegration: GitIntegration | undefined;
let graphWatcher: vscode.Disposable | undefined;
let watcherDebounce: NodeJS.Timeout | undefined;
let pendingWatchEvent: GraphChangeEvent | undefined;
let graphRefreshInFlight = false;
let queuedGraphRefresh: GraphChangeEvent | undefined;
let hotspotCache:
  | {
      workspaceRoot: string;
      fetchedAt: number;
      scores: Record<string, number>;
    }
  | undefined;
let extensionBasePath: string | undefined;

interface GeneratedTestArtifact {
  sourceFilePath: string;
  testFilePath: string;
  generatedBy: string;
}

interface GraphChangeEvent {
  paths: string[];
  reason: 'manual' | 'watcher';
  kind?: 'change' | 'create' | 'delete';
  updatedAt: number;
}

export function activate(context: vscode.ExtensionContext) {
  extensionBasePath = context.extensionPath;
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
    }),

    // Right-click "Generate Test Cases" command — works from editor or explorer
    vscode.commands.registerCommand('codeflow.generateTests', async (uri?: vscode.Uri) => {
      const targetPath = uri?.fsPath || vscode.window.activeTextEditor?.document.uri.fsPath;
      if (!targetPath) {
        vscode.window.showWarningMessage('CodeFlow: No file or folder selected for test generation.');
        return;
      }

      if (!fs.existsSync(targetPath)) {
        vscode.window.showWarningMessage(`CodeFlow: Path not found — ${targetPath}`);
        return;
      }

      try {
        const stats = fs.statSync(targetPath);
        const settings = getTestAgentSettings();
        if (stats.isDirectory()) {
          const result = await generateTestsForFolderPath(targetPath, aiManager, settings, webview);
          vscode.window.showInformationMessage(
            `CodeFlow: Generated ${result.generated} test files for ${path.basename(targetPath)}${result.failed.length ? `, ${result.failed.length} failed` : ''}.`
          );
        } else {
          const artifact = await generateTestsForSourceFile(targetPath, aiManager, settings);
          const document = await vscode.workspace.openTextDocument(artifact.testFilePath);
          await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
          vscode.window.showInformationMessage(`CodeFlow: Generated tests at ${path.basename(artifact.testFilePath)}`);
        }
        await refreshGraphFromCurrentState();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Test generation failed.';
        vscode.window.showErrorMessage(`CodeFlow: ${message}`);
      }
    }),

    // List available Copilot models and let user pick one for settings
    vscode.commands.registerCommand('codeflow.listCopilotModels', async () => {
      try {
        const copilot = aiManager.getCopilotProvider();
        const models = await copilot.listAvailableModels();
        if (models.length === 0) {
          vscode.window.showWarningMessage('No Copilot models available. Make sure GitHub Copilot Chat is installed and signed in.');
          return;
        }

        const items = [
          { label: 'auto', description: 'Automatically pick the best available model' },
          ...models.map((m) => ({
            label: m.id || m.family || 'unknown',
            description: `Family: ${m.family || 'n/a'} | Max tokens: ${m.maxInputTokens || 'n/a'}`,
          })),
        ];

        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select an AI model for CodeFlow analysis',
          title: 'Available Copilot Models',
        });

        if (picked) {
          const config = vscode.workspace.getConfiguration('codeflow');
          await config.update('ai.model', picked.label, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(`CodeFlow: AI model set to "${picked.label}"`);
          void refreshAiStatus(aiManager);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to list models.';
        vscode.window.showErrorMessage(`CodeFlow: ${message}`);
      }
    }),

    // Refresh graph command — re-analyze the last path
    vscode.commands.registerCommand('codeflow.refreshGraph', async () => {
      await refreshGraphFromCurrentState();
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

      webview?.showAIAnalysisResult(node.id, node.data.label, analysis);
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
        throw new Error('Select a folder, file, class, method, or function node first.');
      }

      if (!['folder', 'class', 'method', 'function', 'file'].includes(node.type)) {
        throw new Error('Select a folder, file, class, method, or function node to generate tests.');
      }

      const filePath = node.data.filePath;
      if (!fs.existsSync(filePath)) {
        throw new Error('Selected path does not exist.');
      }

      const settings = getTestAgentSettings();
      if (fs.statSync(filePath).isDirectory() || node.type === 'folder') {
        const result = await generateTestsForFolderPath(filePath, aiManager, settings, webview);
        webview?.showStatus(
          result.failed.length > 0 ? 'warning' : 'success',
          `Generated ${result.generated} folder test files${result.failed.length ? `, ${result.failed.length} failed` : ''}.`
        );
      } else {
        const artifact = await generateTestsForGraphNode(node, aiManager, settings);
        const document = await vscode.workspace.openTextDocument(artifact.testFilePath);
        await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
        webview?.showStatus('success', `Generated tests at ${path.basename(artifact.testFilePath)} via ${artifact.generatedBy}.`);
      }

      await refreshGraphFromCurrentState();
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

  webview.onDidSaveTestAgentSettings(async (settings) => {
    const config = vscode.workspace.getConfiguration('codeflow');
    await config.update('testAgents.model', settings.model, vscode.ConfigurationTarget.Global);
    await config.update('testAgents.parallelMode', settings.parallelMode, vscode.ConfigurationTarget.Global);
    await config.update('testAgents.maxParallelAgents', settings.maxParallelAgents, vscode.ConfigurationTarget.Global);
    await config.update('testAgents.desiredCoveragePercent', settings.desiredCoveragePercent, vscode.ConfigurationTarget.Global);
    await config.update('testAgents.skillDirectory', settings.skillDirectory, vscode.ConfigurationTarget.Workspace);
    await config.update('testAgents.includeSecurityScenarios', settings.includeSecurityScenarios, vscode.ConfigurationTarget.Workspace);
    await config.update('testAgents.includeDataLeakChecks', settings.includeDataLeakChecks, vscode.ConfigurationTarget.Workspace);

    const normalized = getTestAgentSettings();
    const root = getWorkspaceRoot(currentGraph?.metadata.path);
    if (root) {
      await ensureAgentSkillFiles(
        root,
        normalized,
        normalized.parallelMode === 'custom' ? normalized.maxParallelAgents : 1
      );
    }
    webview?.showTestAgentSettings(normalized);
    webview?.showStatus('success', 'Saved test agent settings.');
  });

  // Refresh graph from the webview's refresh button
  webview.onDidRequestRefresh(async () => {
    await refreshGraphFromCurrentState();
  });

  webview.onDidSaveVisualState(async ({ graphPath, graphType, state }) => {
    try {
      savePersistedVisualState(graphPath, graphType, state);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save visual state.';
      webview?.showStatus('warning', message);
    }
  });

  // Send available Copilot models to the webview settings panel
  webview.onDidRequestModels(async () => {
    try {
      const copilot = aiManager.getCopilotProvider();
      const models = await copilot.listAvailableModels();
      const simplified = models.map((m) => ({
        id: m.id || m.family || 'unknown',
        family: m.family || 'n/a',
      }));
      webview?.showModels(simplified);
    } catch {
      webview?.showModels([]);
    }
  });

  // User selected a model from the webview dropdown
  webview.onDidSelectModel(async ({ modelId }) => {
    const config = vscode.workspace.getConfiguration('codeflow');
    await config.update('ai.model', modelId, vscode.ConfigurationTarget.Global);
    webview?.showStatus('success', `AI model set to "${modelId}".`);
    void refreshAiStatus(aiManager);
  });

  webview.onDidRequestRunTests(async () => {
    const root = getWorkspaceRoot();
    // Try to detect correct test command from the current graph's primary file
    const graphPath = currentGraph?.metadata.path;
    let command: string | undefined;
    if (graphPath && fs.existsSync(graphPath) && !fs.statSync(graphPath).isDirectory()) {
      command = inferTestCommandForFile(graphPath, root || path.dirname(graphPath));
    }
    if (!command && root) {
      command = inferTestCommand(root);
    }

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

  // Test Diff — compare source file with its test file and find missing scenarios
  webview.onDidRequestTestDiff(async ({ nodeId }) => {
    try {
      const node = findNode(nodeId);
      if (!node?.data.filePath) {
        throw new Error('Select a file, class, or method node first.');
      }

      const filePath = node.data.filePath;
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        throw new Error('Select a source file node, not a folder.');
      }

      const sourceContent = fs.readFileSync(filePath, 'utf8');
      const testFilePath = findExistingTestFile(filePath);

      if (!testFilePath) {
        webview?.showStatus('warning', `No test file found for ${path.basename(filePath)}. Use "Create Tests" first.`);
        return;
      }

      const testContent = fs.readFileSync(testFilePath, 'utf8');
      const ext = path.extname(filePath).toLowerCase();
      const language = ext === '.java' ? 'java' : ext === '.py' ? 'python' : ext === '.go' ? 'go'
        : ext === '.ts' || ext === '.tsx' ? 'typescript' : ext === '.js' || ext === '.jsx' ? 'javascript'
        : 'unknown';

      webview?.showStatus('info', `Analyzing test coverage gaps for ${path.basename(filePath)}…`);

      const prompt = `You are a senior test engineer. Compare the SOURCE CODE and its TEST FILE below.

Identify ALL missing test scenarios — edge cases, error paths, boundary conditions, untested methods, missing mocks, etc.

For each missing scenario, provide:
1. A clear name for the test
2. What it tests and WHY it matters
3. The actual test code to add (ready to paste)

Return ONLY the test code for the MISSING scenarios — do NOT repeat existing tests.
Group by category: unit tests, edge cases, negative tests, integration tests, boundary tests, etc.

SOURCE (${language}):
\`\`\`${language}
${sourceContent.slice(0, 12000)}
\`\`\`

EXISTING TESTS:
\`\`\`${language}
${testContent.slice(0, 12000)}
\`\`\`

Return the missing test methods/functions as executable code. No markdown fences.`;

      const missingTests = await aiManager.generateText(prompt);
      webview?.showTestDiffResult(
        path.basename(filePath),
        missingTests,
        testFilePath,
        filePath
      );
      webview?.showStatus('success', `Found missing test scenarios for ${path.basename(filePath)}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Test diff analysis failed.';
      webview?.showError(message);
    }
  });

  // Apply a suggestion — replace code in the actual file using WorkspaceEdit
  // so it goes through VS Code's undo/redo stack (Ctrl+Z to revert).
  webview.onDidApplySuggestion(async ({ filePath, line, endLine, original, suggested }) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      const uri = vscode.Uri.file(filePath);
      const document = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();

      if (original && document.getText().includes(original.trim())) {
        // Exact string match — find the range in the document
        const text = document.getText();
        const trimmed = original.trim();
        const offset = text.indexOf(trimmed);
        const startPos = document.positionAt(offset);
        const endPos = document.positionAt(offset + trimmed.length);
        edit.replace(uri, new vscode.Range(startPos, endPos), suggested.trim());
      } else if (line && endLine) {
        // Line-range replacement
        const startPos = new vscode.Position(line - 1, 0);
        const endPos = new vscode.Position(endLine - 1, document.lineAt(endLine - 1).text.length);
        edit.replace(uri, new vscode.Range(startPos, endPos), suggested.trim());
      } else if (line) {
        // Single-line replacement
        const lineObj = document.lineAt(line - 1);
        edit.replace(uri, lineObj.range, suggested.trim());
      } else {
        throw new Error('Cannot determine where to apply the suggestion — no matching code or line numbers.');
      }

      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        throw new Error('VS Code rejected the edit — the file may have changed.');
      }

      // Show the file and scroll to the changed line
      const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
      if (line) {
        const position = new vscode.Position(Math.max(0, line - 1), 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      }
      webview?.showStatus('success', `Applied suggestion to ${path.basename(filePath)} at line ${line || '?'}. Press Ctrl+Z to undo.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to apply suggestion.';
      webview?.showError(message);
    }
  });

  // Run tests for a specific file (language-aware)
  webview.onDidRunTestsForFile(async ({ filePath }) => {
    const root = getWorkspaceRoot(filePath) || path.dirname(filePath);
    const command = inferTestCommandForFile(filePath, root);

    if (!command) {
      webview?.showStatus('warning', `Could not determine how to run tests for ${path.basename(filePath)}.`);
      return;
    }

    webview?.showStatus('info', `Running: ${command}`);
    const startedAt = Date.now();

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: root,
        maxBuffer: 20 * 1024 * 1024,
        shell: process.platform === 'win32' ? undefined : '/bin/zsh',
      });
      const testResult = parseTestOutput(`${stdout}\n${stderr}`);
      const summary: TestRunSummary = {
        status: testResult.failed > 0 ? 'failed' : 'completed',
        command,
        passed: testResult.passed,
        failed: testResult.failed,
        skipped: testResult.skipped,
        durationMs: Date.now() - startedAt,
        message: testResult.failed > 0
          ? `${testResult.failed} test failures detected.`
          : `Tests passed (${testResult.passed} passing).`,
        affectedTargets: testResult.affectedTargets,
      };
      const affIds = findAffectedNodeIds(testResult.statuses);
      webview?.showTestResults(summary, testResult.statuses, affIds);
      webview?.showStatus(testResult.failed > 0 ? 'warning' : 'success', summary.message || 'Done.');
    } catch (error) {
      const stdout = typeof error === 'object' && error && 'stdout' in error ? String(error.stdout || '') : '';
      const stderr = typeof error === 'object' && error && 'stderr' in error ? String(error.stderr || '') : '';
      const combined = `${stdout}\n${stderr}`;
      const testResult = parseTestOutput(combined);
      const summary: TestRunSummary = {
        status: 'failed',
        command,
        passed: testResult.passed,
        failed: Math.max(1, testResult.failed),
        skipped: testResult.skipped,
        durationMs: Date.now() - startedAt,
        message: testResult.failed > 0
          ? `${testResult.failed} test failures.`
          : error instanceof Error ? error.message : `Command failed: ${command}`,
      };
      webview?.showTestResults(summary, testResult.statuses, []);
      webview?.showStatus('warning', summary.message || 'Test run failed.');
    }
  });

  void refreshAiStatus(aiManager);
}

export function deactivate() {
  disposeGraphWatcher();
  webview?.dispose();
  gitIntegration?.dispose();
}

async function refreshAiStatus(aiManager?: AIProviderManager): Promise<void> {
  if (!webview) {
    return;
  }

  const manager = aiManager || new AIProviderManager();
  const status = await manager.getCopilotStatus();

  // Include the currently configured model name
  const config = vscode.workspace.getConfiguration('codeflow');
  const modelSetting = config.get<string>('ai.model', 'auto');
  webview.updateAiStatus({ ...status, model: modelSetting });
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
  loader: () => Promise<GraphData>,
  options: {
    reveal?: boolean;
    silent?: boolean;
    changeEvent?: GraphChangeEvent;
  } = {}
): Promise<void> {
  if (options.reveal !== false) {
    webview?.show();
  }
  if (!options.silent) {
    webview?.showStatus('info', title);
    void refreshAiStatus();
  }

  try {
    const graph = options.silent
      ? await loader()
      : await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'CodeFlow Visualizer',
            cancellable: false,
          },
          async (progress) => {
            progress.report({ message: title, increment: 15 });
            const loadedGraph = await loader();
            progress.report({ message: 'Rendering graph…', increment: 100 });
            return loadedGraph;
          }
        );

    currentGraph = await enrichGraph(graph, options.changeEvent);
    const visualState = loadPersistedVisualState(currentGraph);
    configureGraphWatcher();
    webview?.updateGraph(currentGraph, visualState);
    webview?.showTestAgentSettings(getTestAgentSettings());
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

  await refreshGraphFromCurrentStateWithOptions({
    changeEvent: {
      paths: [currentGraph.metadata.path],
      reason: 'manual',
      updatedAt: Date.now(),
    },
  });
}

async function refreshGraphFromCurrentStateWithOptions(
  options: {
    changeEvent?: GraphChangeEvent;
    silent?: boolean;
    reveal?: boolean;
  } = {}
): Promise<void> {
  if (!currentGraph?.metadata.path) {
    return;
  }

  if (graphRefreshInFlight) {
    queuedGraphRefresh = mergeGraphChangeEvents(queuedGraphRefresh, options.changeEvent);
    return;
  }

  graphRefreshInFlight = true;
  try {
    await performGraphRefresh(options);
  } finally {
    graphRefreshInFlight = false;
    if (queuedGraphRefresh) {
      const queued = queuedGraphRefresh;
      queuedGraphRefresh = undefined;
      void refreshGraphFromCurrentStateWithOptions({
        changeEvent: queued,
        silent: true,
        reveal: false,
      });
    }
  }
}

async function performGraphRefresh(options: {
  changeEvent?: GraphChangeEvent;
  silent?: boolean;
  reveal?: boolean;
}): Promise<void> {
  if (!currentGraph?.metadata.path) {
    return;
  }

  const targetPath = currentGraph.metadata.path;
  if (currentGraph.metadata.type === 'folder') {
    await renderGraph('Refreshing folder graph…', async () => {
      const analyzer = new CodeAnalyzer(getWorkspaceRoot(targetPath) || targetPath);
      return analyzer.analyzeFolder(targetPath);
    }, options);
    return;
  }

  if (currentGraph.metadata.type === 'file') {
    await renderGraph('Refreshing file graph…', async () => {
      const analyzer = new CodeAnalyzer(getWorkspaceRoot(targetPath) || path.dirname(targetPath));
      return analyzer.analyzeFile(targetPath);
    }, options);
  }
}

function disposeGraphWatcher(): void {
  if (watcherDebounce) {
    clearTimeout(watcherDebounce);
    watcherDebounce = undefined;
  }
  pendingWatchEvent = undefined;
  graphWatcher?.dispose();
  graphWatcher = undefined;
}

function configureGraphWatcher(): void {
  disposeGraphWatcher();

  if (!currentGraph || currentGraph.metadata.type === 'selection') {
    return;
  }

  const config = vscode.workspace.getConfiguration('codeflow');
  if (!config.get<boolean>('liveRefresh', true)) {
    return;
  }

  const targetPath = currentGraph.metadata.path;
  if (!targetPath || !fs.existsSync(targetPath)) {
    return;
  }

  const stat = fs.statSync(targetPath);
  const watcher =
    stat.isDirectory()
      ? vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(targetPath), '**/*')
        )
      : vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(path.dirname(targetPath)), path.basename(targetPath))
        );

  watcher.onDidChange((uri) => queueWatcherRefresh(uri, 'change'));
  watcher.onDidCreate((uri) => queueWatcherRefresh(uri, 'create'));
  watcher.onDidDelete((uri) => queueWatcherRefresh(uri, 'delete'));
  graphWatcher = watcher;
}

function queueWatcherRefresh(uri: vscode.Uri, kind: 'change' | 'create' | 'delete'): void {
  if (!currentGraph?.metadata.path || currentGraph.metadata.type === 'selection') {
    return;
  }

  const filePath = uri.fsPath;
  const targetPath = currentGraph.metadata.path;
  if (isPersistedVisualStatePath(filePath, targetPath, currentGraph.metadata.type)) {
    return;
  }
  if (!isWithinAnalyzedTarget(filePath, targetPath, currentGraph.metadata.type)) {
    return;
  }

  pendingWatchEvent = mergeGraphChangeEvents(pendingWatchEvent, {
    paths: [filePath],
    reason: 'watcher',
    kind,
    updatedAt: Date.now(),
  });

  if (watcherDebounce) {
    clearTimeout(watcherDebounce);
  }

  watcherDebounce = setTimeout(() => {
    const pending = pendingWatchEvent;
    pendingWatchEvent = undefined;
    watcherDebounce = undefined;
    if (!pending) {
      return;
    }
    void refreshGraphFromCurrentStateWithOptions({
      changeEvent: pending,
      silent: true,
      reveal: false,
    });
  }, 350);
}

function isWithinAnalyzedTarget(
  filePath: string,
  targetPath: string,
  graphType: GraphData['metadata']['type']
): boolean {
  if (graphType === 'file') {
    return normalizePath(filePath) === normalizePath(targetPath);
  }

  if (graphType === 'folder') {
    const relative = path.relative(targetPath, filePath);
    return !!relative && !relative.startsWith('..') || normalizePath(filePath) === normalizePath(targetPath);
  }

  return false;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function visualStateKey(graphPath: string, graphType: GraphData['metadata']['type']): string {
  return `${graphType}:${normalizePath(graphPath)}`;
}

function resolveVisualStateDirectory(
  graphPath: string,
  graphType: GraphData['metadata']['type']
): string | undefined {
  if (graphType === 'selection') {
    return undefined;
  }

  if (graphType === 'folder') {
    return graphPath;
  }

  return getWorkspaceRoot(graphPath) || path.dirname(graphPath);
}

function resolveVisualStateFilePath(
  graphPath: string,
  graphType: GraphData['metadata']['type']
): string | undefined {
  const directory = resolveVisualStateDirectory(graphPath, graphType);
  return directory ? path.join(directory, '.cv') : undefined;
}

function isPersistedVisualStatePath(
  filePath: string,
  graphPath: string,
  graphType: GraphData['metadata']['type']
): boolean {
  const visualStatePath = resolveVisualStateFilePath(graphPath, graphType);
  return !!visualStatePath && normalizePath(filePath) === normalizePath(visualStatePath);
}

function loadPersistedVisualState(graph: GraphData): PersistedVisualState | undefined {
  const graphPath = graph.metadata.path;
  if (!graphPath) {
    return undefined;
  }

  const filePath = resolveVisualStateFilePath(graphPath, graph.metadata.type);
  if (!filePath || !fs.existsSync(filePath)) {
    return undefined;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      graphs?: Record<string, PersistedVisualState>;
    };
    const state = raw.graphs?.[visualStateKey(graphPath, graph.metadata.type)];
    return state || undefined;
  } catch {
    return undefined;
  }
}

function savePersistedVisualState(
  graphPath: string,
  graphType: GraphData['metadata']['type'],
  state: PersistedVisualState
): void {
  const filePath = resolveVisualStateFilePath(graphPath, graphType);
  if (!filePath) {
    return;
  }

  const payload: {
    version: number;
    graphs: Record<string, PersistedVisualState>;
  } = fs.existsSync(filePath)
    ? (() => {
        try {
          const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
            version?: number;
            graphs?: Record<string, PersistedVisualState>;
          };
          return {
            version: typeof parsed.version === 'number' ? parsed.version : 1,
            graphs: parsed.graphs || {},
          };
        } catch {
          return { version: 1, graphs: {} };
        }
      })()
    : { version: 1, graphs: {} };

  const graphKey = visualStateKey(graphPath, graphType);
  const previousState = payload.graphs[graphKey];
  const comparablePrevious = previousState
    ? {
        ...previousState,
        savedAt: undefined,
      }
    : undefined;
  const comparableNext = {
    ...state,
    graphPath,
    graphType,
    savedAt: undefined,
  };

  if (
    comparablePrevious &&
    JSON.stringify(comparablePrevious) === JSON.stringify(comparableNext)
  ) {
    return;
  }

  payload.graphs[graphKey] = {
    ...state,
    graphPath,
    graphType,
    savedAt: Date.now(),
  };

  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function mergeGraphChangeEvents(
  current: GraphChangeEvent | undefined,
  next: GraphChangeEvent | undefined
): GraphChangeEvent | undefined {
  if (!current) {
    return next;
  }

  if (!next) {
    return current;
  }

  return {
    paths: Array.from(new Set([...current.paths, ...next.paths])),
    reason: next.reason,
    kind: current.kind === next.kind ? next.kind : undefined,
    updatedAt: Math.max(current.updatedAt, next.updatedAt),
  };
}

async function enrichGraph(
  graph: GraphData,
  changeEvent?: GraphChangeEvent
): Promise<GraphData> {
  const workspaceRoot = getWorkspaceRoot(graph.metadata.path || graph.metadata.rootPath);
  const hotspotScores = workspaceRoot ? await getHotspotScores(workspaceRoot) : {};
  const changedPaths = new Set((changeEvent?.paths || []).map(normalizePath));
  const fileHotspots = graph.nodes
    .map((node) => resolveHotspotScore(node, workspaceRoot, hotspotScores))
    .filter((score) => score > 0);
  const maxHotspotScore = fileHotspots.length ? Math.max(...fileHotspots) : 0;
  const complexityValues = graph.nodes
    .map((node) => Number(node.data.complexity) || 0)
    .filter((value) => value > 0);
  const maxComplexity = complexityValues.length ? Math.max(...complexityValues) : 0;

  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const hotspotScore = resolveHotspotScore(node, workspaceRoot, hotspotScores);
      const filePath = typeof node.data.filePath === 'string' ? node.data.filePath : undefined;
      return {
        ...node,
        data: {
          ...node.data,
          hotspotScore,
          hotspotRank: maxHotspotScore > 0 ? hotspotScore / maxHotspotScore : 0,
          complexityRank:
            maxComplexity > 0 ? (Number(node.data.complexity) || 0) / maxComplexity : 0,
          changed: filePath ? changedPaths.has(normalizePath(filePath)) : false,
        },
      };
    }),
    metadata: {
      ...graph.metadata,
      changeEvent,
    },
  };
}

function resolveHotspotScore(
  node: GraphNode,
  workspaceRoot: string | undefined,
  hotspotScores: Record<string, number>
): number {
  if (!workspaceRoot || typeof node.data.filePath !== 'string' || !node.data.filePath) {
    return 0;
  }

  const relativePath = normalizePath(path.relative(workspaceRoot, node.data.filePath));
  return hotspotScores[relativePath] || 0;
}

async function getHotspotScores(workspaceRoot: string): Promise<Record<string, number>> {
  if (!gitIntegration || getWorkspaceRoot() !== workspaceRoot) {
    return {};
  }

  if (
    hotspotCache &&
    hotspotCache.workspaceRoot === workspaceRoot &&
    Date.now() - hotspotCache.fetchedAt < 60_000
  ) {
    return hotspotCache.scores;
  }

  const scores = await gitIntegration.getHotspotScores();
  hotspotCache = {
    workspaceRoot,
    fetchedAt: Date.now(),
    scores,
  };
  return scores;
}

function getTestAgentSettings(): TestAgentSettings {
  const config = vscode.workspace.getConfiguration('codeflow');
  return {
    model: config.get<string>('testAgents.model', 'inherit') || 'inherit',
    parallelMode: config.get<'auto' | 'custom'>('testAgents.parallelMode', 'auto') || 'auto',
    maxParallelAgents: Math.max(1, config.get<number>('testAgents.maxParallelAgents', 10)),
    desiredCoveragePercent: Math.max(80, Math.min(200, config.get<number>('testAgents.desiredCoveragePercent', 105))),
    skillDirectory: config.get<string>('testAgents.skillDirectory', '.codeflow/test-agents') || '.codeflow/test-agents',
    includeSecurityScenarios: config.get<boolean>('testAgents.includeSecurityScenarios', true),
    includeDataLeakChecks: config.get<boolean>('testAgents.includeDataLeakChecks', true),
  };
}

function resolveParallelAgentCount(settings: TestAgentSettings, eligibleFileCount: number): number {
  if (eligibleFileCount <= 0) {
    return 0;
  }

  if (settings.parallelMode === 'auto') {
    return eligibleFileCount;
  }

  return Math.max(1, Math.min(settings.maxParallelAgents, eligibleFileCount));
}

function resolveTestAgentModelPreference(settings: TestAgentSettings): string | undefined {
  return settings.model && settings.model !== 'inherit' ? settings.model : undefined;
}

function inferLanguageFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.py') return 'python';
  if (ext === '.java') return 'java';
  if (ext === '.go') return 'go';
  if (ext === '.ts' || ext === '.tsx') return 'typescript';
  if (ext === '.js' || ext === '.jsx') return 'javascript';
  if (ext === '.kt' || ext === '.kts') return 'kotlin';
  if (ext === '.cs') return 'csharp';
  if (ext === '.php') return 'php';
  if (ext === '.rb') return 'ruby';
  if (ext === '.swift') return 'swift';
  if (ext === '.dart') return 'dart';
  if (ext === '.rs') return 'rust';
  if (ext === '.c' || ext === '.cc' || ext === '.cpp' || ext === '.cxx' || ext === '.h' || ext === '.hpp') return 'cpp';
  return 'unknown';
}

function isTestLikeFilePath(filePath: string): boolean {
  const normalized = normalizePath(filePath).toLowerCase();
  const base = path.basename(normalized);
  return (
    /(^test_|_test\.|\.test\.|\.spec\.|tests?\.cs$|test\.java$|tests\.java$|tests?\.swift$|_spec\.rb$)/.test(base)
    || normalized.includes('/__tests__/')
    || normalized.includes('/tests/')
  );
}

function isTestGeneratableSourceFile(filePath: string): boolean {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  if (['.txt', '.properties', '.md', '.json', '.yaml', '.yml', '.xml', '.csv', '.toml', '.ini'].includes(ext)) {
    return false;
  }

  return !isTestLikeFilePath(filePath) && inferLanguageFromPath(filePath) !== 'unknown';
}

function isWithinFolder(filePath: string, folderPath: string): boolean {
  const relative = path.relative(folderPath, filePath);
  return normalizePath(filePath) === normalizePath(folderPath)
    || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

async function collectEligibleSourceFiles(folderPath: string): Promise<string[]> {
  const normalizedFolder = normalizePath(folderPath);
  const candidatePaths =
    currentGraph?.metadata.type === 'folder'
    && currentGraph.metadata.path
    && normalizePath(currentGraph.metadata.path) === normalizedFolder
      ? currentGraph.nodes
          .filter((node) => node.type === 'file' && typeof node.data.filePath === 'string')
          .map((node) => node.data.filePath as string)
      : (
        await new CodeAnalyzer(getWorkspaceRoot(folderPath) || folderPath)
          .analyzeFolder(folderPath)
      ).nodes
          .filter((node) => node.type === 'file' && typeof node.data.filePath === 'string')
          .map((node) => node.data.filePath as string);

  return Array.from(new Set(candidatePaths))
    .filter((filePath) => isWithinFolder(filePath, folderPath))
    .filter((filePath) => isTestGeneratableSourceFile(filePath))
    .sort((left, right) => left.localeCompare(right));
}

async function ensureAgentSkillFiles(
  workspaceRoot: string,
  settings: TestAgentSettings,
  count: number
): Promise<string[]> {
  const renderedTemplate = renderTestAgentSkillTemplate(loadDefaultTestAgentSkillTemplate(), settings);
  const skillDirectory = path.isAbsolute(settings.skillDirectory)
    ? settings.skillDirectory
    : path.join(workspaceRoot, settings.skillDirectory);
  fs.mkdirSync(skillDirectory, { recursive: true });

  const files: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const agentName = `agent-${String(index + 1).padStart(2, '0')}`;
    const filePath = path.join(skillDirectory, `${agentName}.skill.md`);
    const contents = renderedTemplate.replace(/{{agentName}}/g, agentName);
    if (!fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf8') !== contents) {
      fs.writeFileSync(filePath, contents, 'utf8');
    }
    files.push(filePath);
  }

  const defaultFilePath = path.join(skillDirectory, 'default.skill.md');
  const defaultContents = renderedTemplate.replace(/{{agentName}}/g, 'default-agent');
  if (!fs.existsSync(defaultFilePath) || fs.readFileSync(defaultFilePath, 'utf8') !== defaultContents) {
    fs.writeFileSync(defaultFilePath, defaultContents, 'utf8');
  }

  return files;
}

function loadDefaultTestAgentSkillTemplate(): string {
  const templatePath = extensionBasePath
    ? path.join(extensionBasePath, 'templates', 'test-agent-skill.md')
    : undefined;
  if (templatePath && fs.existsSync(templatePath)) {
    return fs.readFileSync(templatePath, 'utf8');
  }

  return [
    '# CodeFlow Test Agent Skill',
    '',
    'Agent: {{agentName}}',
    '- Generate deterministic tests for the assigned file only.',
    '- Push coverage to at least {{desiredCoveragePercent}}% logical scenario depth.',
    '- Security scenarios: {{includeSecurityScenarios}}.',
    '- Data leak checks: {{includeDataLeakChecks}}.',
    '- Cover happy path, edge cases, failure modes, concurrency, data integrity, and regression risks.',
    '- Call out covered and uncovered areas at the top of the generated test file.',
  ].join('\n');
}

function renderTestAgentSkillTemplate(template: string, settings: TestAgentSettings): string {
  return template
    .replace(/{{desiredCoveragePercent}}/g, String(settings.desiredCoveragePercent))
    .replace(/{{includeSecurityScenarios}}/g, settings.includeSecurityScenarios ? 'enabled' : 'disabled')
    .replace(/{{includeDataLeakChecks}}/g, settings.includeDataLeakChecks ? 'enabled' : 'disabled');
}

async function generateTestsForSourceFile(
  sourceFilePath: string,
  aiManager: AIProviderManager,
  settings: TestAgentSettings,
  agentOverride?: { agentName?: string; skillFilePath?: string }
): Promise<GeneratedTestArtifact> {
  const fileContent = fs.readFileSync(sourceFilePath, 'utf8');
  const language = inferLanguageFromPath(sourceFilePath);
  if (language === 'unknown') {
    throw new Error(`Unsupported source language for ${path.basename(sourceFilePath)}.`);
  }

  const framework = inferTestFramework(sourceFilePath, fileContent);
  const root = getWorkspaceRoot(sourceFilePath) || path.dirname(sourceFilePath);
  const skillFilePath = agentOverride?.skillFilePath || (await ensureAgentSkillFiles(root, settings, 1))[0];
  const skillInstructions = fs.readFileSync(skillFilePath, 'utf8');
  const ext = path.extname(sourceFilePath).toLowerCase();
  const testFilePath = resolveTestFilePathFromSource(sourceFilePath);
  const styleReference = findTestStyleReference(sourceFilePath);
  const generated = await aiManager.generateText(
    buildTestGenerationPrompt({
      framework,
      language,
      relativePath: path.relative(root, sourceFilePath),
      outputRelativePath: path.relative(root, testFilePath),
      targetLabel: path.basename(sourceFilePath, ext),
      targetKind: 'file',
      targetCode: fileContent.slice(0, 15000),
      desiredCoveragePercent: settings.desiredCoveragePercent,
      agentName: agentOverride?.agentName || 'agent-01',
      skillInstructions,
      includeSecurityScenarios: settings.includeSecurityScenarios,
      includeDataLeakChecks: settings.includeDataLeakChecks,
      styleReferencePath: styleReference ? path.relative(root, styleReference.filePath) : undefined,
      styleReferenceSnippet: styleReference?.snippet,
    }),
    {
      modelPreference: resolveTestAgentModelPreference(settings),
    }
  );

  fs.mkdirSync(path.dirname(testFilePath), { recursive: true });
  fs.writeFileSync(testFilePath, stripCodeFences(generated), 'utf8');

  return {
    sourceFilePath,
    testFilePath,
    generatedBy: agentOverride?.agentName || 'agent-01',
  };
}

async function generateTestsForGraphNode(
  node: GraphNode,
  aiManager: AIProviderManager,
  settings: TestAgentSettings
): Promise<GeneratedTestArtifact> {
  const filePath = node.data.filePath!;
  const fileContent = fs.readFileSync(filePath, 'utf8');
  const classNode = findAncestorByType(node, ['class', 'interface', 'type']);
  const targetCode = extractNodeContent(node, fileContent);
  const classCode =
    classNode && classNode.id !== node.id ? extractNodeContent(classNode, fileContent) : undefined;
  const framework = inferTestFramework(filePath, fileContent);
  const root = getWorkspaceRoot(filePath) || path.dirname(filePath);
  const skillFilePath = (await ensureAgentSkillFiles(root, settings, 1))[0];
  const skillInstructions = fs.readFileSync(skillFilePath, 'utf8');
  const testFilePath = resolveTestFilePath(node, filePath);
  const styleReference = findTestStyleReference(filePath);
  const generated = await aiManager.generateText(
    buildTestGenerationPrompt({
      framework,
      language: String(node.data.language || inferLanguageFromPath(filePath)),
      relativePath: path.relative(root, filePath),
      outputRelativePath: path.relative(root, testFilePath),
      targetLabel: String(node.data.label),
      targetKind: String(node.data.kind || node.type),
      classLabel: classNode ? String(classNode.data.label) : undefined,
      targetCode,
      classCode,
      desiredCoveragePercent: settings.desiredCoveragePercent,
      agentName: 'agent-01',
      skillInstructions,
      includeSecurityScenarios: settings.includeSecurityScenarios,
      includeDataLeakChecks: settings.includeDataLeakChecks,
      styleReferencePath: styleReference ? path.relative(root, styleReference.filePath) : undefined,
      styleReferenceSnippet: styleReference?.snippet,
    }),
    {
      modelPreference: resolveTestAgentModelPreference(settings),
    }
  );

  fs.mkdirSync(path.dirname(testFilePath), { recursive: true });
  fs.writeFileSync(testFilePath, stripCodeFences(generated), 'utf8');

  return {
    sourceFilePath: filePath,
    testFilePath,
    generatedBy: 'agent-01',
  };
}

async function generateTestsForFolderPath(
  folderPath: string,
  aiManager: AIProviderManager,
  settings: TestAgentSettings,
  statusTarget?: CodeFlowWebviewProvider
): Promise<{ generated: number; failed: Array<{ filePath: string; message: string }>; artifacts: GeneratedTestArtifact[] }> {
  const eligibleFiles = await collectEligibleSourceFiles(folderPath);
  if (eligibleFiles.length === 0) {
    throw new Error('No supported source files were found in this folder.');
  }

  const root = getWorkspaceRoot(folderPath) || folderPath;
  const concurrency = resolveParallelAgentCount(settings, eligibleFiles.length);
  const skillFiles = await ensureAgentSkillFiles(root, settings, concurrency);
  const queue = [...eligibleFiles];
  const artifacts: GeneratedTestArtifact[] = [];
  const failed: Array<{ filePath: string; message: string }> = [];

  await Promise.all(
    skillFiles.map((skillFilePath, index) => (async () => {
      const agentName = `agent-${String(index + 1).padStart(2, '0')}`;

      while (queue.length > 0) {
        const sourceFilePath = queue.shift();
        if (!sourceFilePath) {
          break;
        }

        try {
          statusTarget?.showStatus('info', `${agentName} generating tests for ${path.basename(sourceFilePath)}…`);
          const artifact = await generateTestsForSourceFile(sourceFilePath, aiManager, settings, {
            agentName,
            skillFilePath,
          });
          artifacts.push(artifact);
        } catch (error) {
          failed.push({
            filePath: sourceFilePath,
            message: error instanceof Error ? error.message : 'Unknown test generation failure.',
          });
        }
      }
    })())
  );

  return { generated: artifacts.length, failed, artifacts };
}

function buildTestGenerationPrompt(args: {
  framework: string;
  language: string;
  relativePath: string;
  outputRelativePath: string;
  targetLabel: string;
  targetKind: string;
  classLabel?: string;
  targetCode: string;
  classCode?: string;
  desiredCoveragePercent: number;
  agentName: string;
  skillInstructions: string;
  includeSecurityScenarios: boolean;
  includeDataLeakChecks: boolean;
  styleReferencePath?: string;
  styleReferenceSnippet?: string;
}): string {
  return `You are ${args.agentName}, a dedicated CodeFlow test generation worker.

Apply this skill file while generating tests:
${args.skillInstructions}

Generate COMPREHENSIVE ${args.framework} test cases for this ${args.targetKind} to achieve at least ${args.desiredCoveragePercent}% logical coverage.
Preserve the repository's current coding style, test naming, helper structure, fixture usage, and assertion style.
Write the test as a complete source file that will be saved at: ${args.outputRelativePath}

Return ONLY the test file source code. Do not include markdown fences.

CRITICAL REQUIREMENTS — Generate ALL of the following test categories:

1. UNIT TESTS (Happy Path):
   - Test each method with valid inputs and expected outputs
   - Test return values, state changes, and side effects

2. UNIT TESTS (Edge Cases):
   - Null/undefined/empty inputs
   - Boundary values (0, -1, MAX_INT, empty string, empty array)
   - Special characters, unicode, very long strings
   - Single-element collections

3. NEGATIVE TESTS:
   - Invalid input types and malformed data
   - Unauthorized access / permission failures
   - Resource not found scenarios
   - Invalid state transitions

4. INTEGRATION TESTS:
   - Test interactions between this code and its dependencies
   - Test dependency failure / timeout handling
   - Test data consistency across dependencies

5. BOUNDARY TESTS:
   - Min/max parameter values
   - Off-by-one conditions
   - Collection size limits (0, 1, max)

6. PERFORMANCE TESTS:
   - Test with large input sizes
   - Batch processing efficiency
   - Memory leak detection for repeated calls

7. CONCURRENCY TESTS (if applicable):
   - Thread safety / race conditions
   - Concurrent access to shared resources

8. SQL INJECTION TESTS (if SQL is present):
   - Parameterized query verification
   - SQL injection prevention

9. DATA FLOW TESTS:
   - Test data transformation correctness
   - Test mapping between DTOs, entities, and responses
   - Test data integrity through the call chain

10. MOCK/STUB TESTS:
    - Mock all external dependencies
    - Verify method call counts and arguments
    - Test error propagation from mocked dependencies

${args.includeSecurityScenarios ? `
11. SECURITY TESTS:
   - Authentication, authorization, and privilege-escalation attempts
   - Injection, unsafe deserialization, command execution, SSRF, and path traversal scenarios
   - Secret handling and sensitive log filtering` : ''}

${args.includeDataLeakChecks ? `
12. DATA LEAK TESTS:
   - Ensure tokens, passwords, customer identifiers, and regulated data never leak through logs, errors, or API responses
   - Verify masked/redacted output for sensitive data
   - Assert sanitized failure payloads and exception handling` : ''}

Generate at least 20-30 test methods where the target size justifies it. Use descriptive test names that explain the scenario.
At the top of the generated file, include a short comment block naming covered areas and remaining uncovered risks.

File: ${args.relativePath}
Output test file: ${args.outputRelativePath}
Target: ${args.targetLabel}
Class: ${args.classLabel || 'n/a'}
Language: ${args.language}
Framework: ${args.framework}

${args.styleReferencePath && args.styleReferenceSnippet ? `Style reference (${args.styleReferencePath}):\n${args.styleReferenceSnippet}\n\n` : ''}${args.classCode ? `Enclosing class:\n${args.classCode}\n\n` : ''}Target code:\n${args.targetCode}`;
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

  if (ext === '.kt' || ext === '.kts') {
    return 'JUnit 5';
  }

  if (ext === '.cs') {
    return 'xUnit';
  }

  if (ext === '.php') {
    return 'PHPUnit';
  }

  if (ext === '.rb') {
    return 'RSpec';
  }

  if (ext === '.swift') {
    return 'XCTest';
  }

  if (ext === '.dart') {
    return 'package:test';
  }

  if (ext === '.rs') {
    return 'Rust test';
  }

  if (ext === '.c' || ext === '.cc' || ext === '.cpp' || ext === '.cxx' || ext === '.h' || ext === '.hpp') {
    return 'GoogleTest';
  }

  if (/vitest/i.test(fileContent)) {
    return 'Vitest';
  }

  return 'Jest';
}

function resolveTestFilePath(node: GraphNode, sourceFilePath: string): string {
  const ext = path.extname(sourceFilePath);
  const sourceBase = path.basename(sourceFilePath, ext);
  const targetBase = sanitizeFileSegment(String(node.data.label || sourceBase));
  const preferred = buildTestFileCandidates(sourceFilePath, targetBase)[0];
  return ensureUniqueFilePath(preferred);
}

function buildTestFileCandidates(sourceFilePath: string, targetBase?: string): string[] {
  const workspaceRoot = getWorkspaceRoot(sourceFilePath) || path.dirname(sourceFilePath);
  const ext = path.extname(sourceFilePath).toLowerCase();
  const relativePath = normalizePath(path.relative(workspaceRoot, sourceFilePath));
  const relativeWithoutExt = ext && relativePath.endsWith(ext)
    ? relativePath.slice(0, -ext.length)
    : relativePath;
  const relativeSegments = relativeWithoutExt.split('/').filter(Boolean);
  const relativeDirSegments = relativeSegments.slice(0, -1);
  const trimmedDirSegments = trimLeadingSourceSegments(relativeDirSegments);
  const baseName = targetBase || path.basename(sourceFilePath, ext);
  const safeBase = sanitizeFileSegment(baseName);
  const snakeBase = toSnakeCase(baseName);
  const pascalBase = toPascalCase(baseName);
  const genericTestRoot = pickExistingTestRoot(workspaceRoot, ['test', 'tests']);
  const pythonTestRoot = pickExistingTestRoot(workspaceRoot, ['tests', 'test']);
  const phpTestRoot = pickExistingTestRoot(workspaceRoot, ['tests', 'test']);
  const rubyTestRoot = pickExistingTestRoot(workspaceRoot, ['spec', 'tests']);
  const swiftTestRoot = pickExistingTestRoot(workspaceRoot, ['Tests', 'tests']);
  const rustTestRoot = pickExistingTestRoot(workspaceRoot, ['tests', 'test']);
  const candidates: string[] = [];

  const addRelativeCandidate = (relativeCandidate: string) => {
    const normalized = normalizePath(relativeCandidate);
    const absolute = path.join(workspaceRoot, ...normalized.split('/').filter(Boolean));
    if (!candidates.includes(absolute)) {
      candidates.push(absolute);
    }
  };

  const mappedFromSource = (
    fromSegments: string[],
    toSegments: string[],
    suffix: string
  ): string | undefined => {
    const mapped = remapRelativePath(relativeWithoutExt, fromSegments, toSegments);
    return mapped ? `${mapped}${suffix}` : undefined;
  };

  switch (ext) {
    case '.java': {
      addOptionalCandidate(addRelativeCandidate, mappedFromSource(['src', 'main', 'java'], ['src', 'test', 'java'], `Test${ext}`));
      addOptionalCandidate(addRelativeCandidate, mappedFromSource(['src', 'main'], ['src', 'test'], `Test${ext}`));
      addRelativeCandidate(path.posix.join('src', 'test', 'java', ...trimmedDirSegments, `${pascalBase}Test${ext}`));
      addRelativeCandidate(path.posix.join('src', 'test', 'java', ...trimmedDirSegments, `${pascalBase}Tests${ext}`));
      addRelativeCandidate(path.posix.join('test', ...trimmedDirSegments, `${pascalBase}Test${ext}`));
      break;
    }
    case '.kt':
    case '.kts': {
      addOptionalCandidate(addRelativeCandidate, mappedFromSource(['src', 'main', 'kotlin'], ['src', 'test', 'kotlin'], `Test${ext}`));
      addOptionalCandidate(addRelativeCandidate, mappedFromSource(['src', 'main'], ['src', 'test'], `Test${ext}`));
      addRelativeCandidate(path.posix.join('src', 'test', 'kotlin', ...trimmedDirSegments, `${pascalBase}Test${ext}`));
      addRelativeCandidate(path.posix.join('src', 'test', 'kotlin', ...trimmedDirSegments, `${pascalBase}Tests${ext}`));
      addRelativeCandidate(path.posix.join('test', ...trimmedDirSegments, `${pascalBase}Test${ext}`));
      break;
    }
    case '.py': {
      addRelativeCandidate(path.posix.join(pythonTestRoot, ...trimmedDirSegments, `test_${snakeBase}${ext}`));
      addRelativeCandidate(path.posix.join(pythonTestRoot, ...trimmedDirSegments, `${snakeBase}_test${ext}`));
      addRelativeCandidate(path.posix.join(...relativeDirSegments, 'tests', `test_${snakeBase}${ext}`));
      break;
    }
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx': {
      addRelativeCandidate(path.posix.join(genericTestRoot, ...trimmedDirSegments, `${safeBase}.test${ext}`));
      addRelativeCandidate(path.posix.join(genericTestRoot, ...trimmedDirSegments, `${safeBase}.spec${ext}`));
      addRelativeCandidate(path.posix.join(...relativeDirSegments, '__tests__', `${safeBase}.test${ext}`));
      addRelativeCandidate(path.posix.join(...relativeDirSegments, '__tests__', `${safeBase}.spec${ext}`));
      break;
    }
    case '.go': {
      addRelativeCandidate(path.posix.join(...relativeDirSegments, `${snakeBase}_test${ext}`));
      addRelativeCandidate(path.posix.join(genericTestRoot, ...trimmedDirSegments, `${snakeBase}_test${ext}`));
      break;
    }
    case '.cs': {
      addRelativeCandidate(path.posix.join(genericTestRoot, ...trimmedDirSegments, `${pascalBase}Tests${ext}`));
      addRelativeCandidate(path.posix.join(genericTestRoot, ...trimmedDirSegments, `${pascalBase}Test${ext}`));
      break;
    }
    case '.php': {
      addRelativeCandidate(path.posix.join(phpTestRoot, ...trimmedDirSegments, `${pascalBase}Test${ext}`));
      break;
    }
    case '.rb': {
      addRelativeCandidate(path.posix.join(rubyTestRoot, ...trimmedDirSegments, `${snakeBase}_spec${ext}`));
      break;
    }
    case '.swift': {
      addOptionalCandidate(addRelativeCandidate, mappedFromSource(['Sources'], ['Tests'], `Tests${ext}`));
      addRelativeCandidate(path.posix.join(swiftTestRoot, ...trimmedDirSegments, `${pascalBase}Tests${ext}`));
      break;
    }
    case '.dart': {
      addOptionalCandidate(addRelativeCandidate, mappedFromSource(['lib'], ['test'], `_test${ext}`));
      addRelativeCandidate(path.posix.join('test', ...trimmedDirSegments, `${snakeBase}_test${ext}`));
      break;
    }
    case '.rs': {
      addRelativeCandidate(path.posix.join(rustTestRoot, ...trimmedDirSegments, `${snakeBase}.rs`));
      addRelativeCandidate(path.posix.join('tests', ...trimmedDirSegments, `${snakeBase}_test.rs`));
      break;
    }
    case '.c':
    case '.cc':
    case '.cpp':
    case '.cxx':
    case '.h':
    case '.hpp': {
      addRelativeCandidate(path.posix.join(genericTestRoot, ...trimmedDirSegments, `${safeBase}.test.cpp`));
      addRelativeCandidate(path.posix.join(genericTestRoot, ...trimmedDirSegments, `${safeBase}_test.cpp`));
      break;
    }
    default: {
      addRelativeCandidate(path.posix.join(genericTestRoot, ...trimmedDirSegments, `${safeBase}.test${ext}`));
      break;
    }
  }

  return candidates;
}

function addOptionalCandidate(addCandidate: (relativeCandidate: string) => void, candidate?: string): void {
  if (candidate) {
    addCandidate(candidate);
  }
}

function remapRelativePath(relativePath: string, fromSegments: string[], toSegments: string[]): string | undefined {
  const segments = normalizePath(relativePath).split('/').filter(Boolean);
  if (segments.length < fromSegments.length) {
    return undefined;
  }

  for (let index = 0; index < fromSegments.length; index += 1) {
    if (segments[index] !== fromSegments[index]) {
      return undefined;
    }
  }

  return [...toSegments, ...segments.slice(fromSegments.length)].join('/');
}

function trimLeadingSourceSegments(segments: string[]): string[] {
  const removable = new Set(['src', 'lib', 'app', 'source', 'sources']);
  const trimmed = [...segments];
  while (trimmed.length > 0 && removable.has(trimmed[0].toLowerCase())) {
    trimmed.shift();
  }
  if (trimmed[0]?.toLowerCase() === 'main') {
    trimmed.shift();
  }
  if (trimmed[0]?.toLowerCase() === 'java' || trimmed[0]?.toLowerCase() === 'kotlin') {
    trimmed.shift();
  }
  return trimmed;
}

function pickExistingTestRoot(workspaceRoot: string, candidates: string[]): string {
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(workspaceRoot, ...candidate.split('/')))) {
      return candidate;
    }
  }
  return candidates[0];
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'generated_test';
}

function toPascalCase(value: string): string {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim();
  if (!normalized) {
    return 'GeneratedSpec';
  }

  return normalized
    .split(/\s+/)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('');
}

function findTestStyleReference(sourceFilePath: string): { filePath: string; snippet: string } | undefined {
  const ext = path.extname(sourceFilePath).toLowerCase();
  const workspaceRoot = getWorkspaceRoot(sourceFilePath) || path.dirname(sourceFilePath);
  const existingCandidate = buildTestFileCandidates(sourceFilePath).find((candidate) => fs.existsSync(candidate));
  if (existingCandidate) {
    return loadStyleReference(existingCandidate);
  }

  const searchRoots = Array.from(
    new Set([
      ...buildTestFileCandidates(sourceFilePath).map((candidate) => path.dirname(candidate)),
      path.join(workspaceRoot, 'test'),
      path.join(workspaceRoot, 'tests'),
      path.join(workspaceRoot, 'spec'),
      path.join(workspaceRoot, 'Tests'),
      path.join(workspaceRoot, 'src', 'test'),
    ])
  );

  for (const searchRoot of searchRoots) {
    const match = findFirstMatchingTestFile(searchRoot, ext, 4);
    if (match) {
      return loadStyleReference(match);
    }
  }

  return undefined;
}

function loadStyleReference(filePath: string): { filePath: string; snippet: string } {
  const content = fs.readFileSync(filePath, 'utf8');
  return {
    filePath,
    snippet: content.slice(0, 4000),
  };
}

function findFirstMatchingTestFile(directoryPath: string, extension: string, maxDepth: number): string | undefined {
  if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
    return undefined;
  }

  const ignoredDirectories = new Set(['node_modules', '.git', 'dist', 'out', 'coverage', '.next']);
  const queue: Array<{ directoryPath: string; depth: number }> = [{ directoryPath, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = fs.readdirSync(current.directoryPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const entryPath = path.join(current.directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < maxDepth && !ignoredDirectories.has(entry.name)) {
          queue.push({ directoryPath: entryPath, depth: current.depth + 1 });
        }
        continue;
      }

      if (path.extname(entry.name).toLowerCase() === extension && isTestLikeFilePath(entryPath)) {
        return entryPath;
      }
    }
  }

  return undefined;
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

function resolveTestFilePathFromSource(sourceFilePath: string): string {
  return ensureUniqueFilePath(buildTestFileCandidates(sourceFilePath)[0]);
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

  if (fs.existsSync(path.join(rootPath, 'phpunit.xml')) || fs.existsSync(path.join(rootPath, 'phpunit.xml.dist'))) {
    return 'vendor/bin/phpunit';
  }

  if (fs.existsSync(path.join(rootPath, 'pubspec.yaml'))) {
    return 'dart test';
  }

  // Ruby
  if (fs.existsSync(path.join(rootPath, 'Gemfile'))) {
    return 'bundle exec rspec';
  }

  // .NET
  if (fs.existsSync(path.join(rootPath, '*.csproj')) || fs.existsSync(path.join(rootPath, '*.sln'))) {
    return 'dotnet test';
  }

  return undefined;
}

/**
 * Find an EXISTING test file for a given source file.
 * Searches common naming conventions across languages.
 */
function findExistingTestFile(sourceFilePath: string): string | undefined {
  return buildTestFileCandidates(sourceFilePath).find((candidate) => fs.existsSync(candidate));
}

/**
 * Infer the correct test command for a specific file, based on its language/extension.
 */
function inferTestCommandForFile(filePath: string, rootPath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  const relPath = path.relative(rootPath, filePath);

  // Python
  if (ext === '.py') {
    const base = path.basename(filePath);
    if (base.startsWith('test_') || base.endsWith('_test.py')) {
      return `python -m pytest "${relPath}" -v`;
    }
    const testFile = findExistingTestFile(filePath);
    if (testFile) {
      return `python -m pytest "${path.relative(rootPath, testFile)}" -v`;
    }
    return 'python -m pytest -v';
  }

  // Java
  if (ext === '.java') {
    if (fs.existsSync(path.join(rootPath, 'gradlew'))) {
      return './gradlew test';
    }
    if (fs.existsSync(path.join(rootPath, 'pom.xml'))) {
      const className = path.basename(filePath, ext);
      return `mvn test -Dtest=${className}Test`;
    }
    return undefined;
  }

  // Go
  if (ext === '.go') {
    const goDir = path.dirname(relPath);
    return `go test -v ./${goDir}/...`;
  }

  // TypeScript / JavaScript
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts'].includes(ext)) {
    const pkgPath = path.join(rootPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const testScript = pkg.scripts?.test || '';
        if (/vitest/i.test(testScript)) {
          const testFile = findExistingTestFile(filePath);
          return testFile ? `npx vitest run "${path.relative(rootPath, testFile)}"` : 'npx vitest run';
        }
        if (/jest/i.test(testScript) || fs.existsSync(path.join(rootPath, 'jest.config.js')) || fs.existsSync(path.join(rootPath, 'jest.config.ts'))) {
          const testFile = findExistingTestFile(filePath);
          return testFile ? `npx jest "${path.relative(rootPath, testFile)}" --verbose` : 'npx jest --verbose';
        }
        if (testScript && !/no test specified/i.test(testScript)) {
          return 'npm test';
        }
      } catch {
        // ignore
      }
    }
    return 'npm test';
  }

  // Rust
  if (ext === '.rs') {
    return 'cargo test';
  }

  // Kotlin
  if (ext === '.kt' || ext === '.kts') {
    if (fs.existsSync(path.join(rootPath, 'gradlew'))) {
      return './gradlew test';
    }
    return undefined;
  }

  // C#
  if (ext === '.cs') {
    return 'dotnet test';
  }

  if (ext === '.php') {
    return 'vendor/bin/phpunit';
  }

  // Ruby
  if (ext === '.rb') {
    return 'bundle exec rspec';
  }

  if (ext === '.swift') {
    return 'xcodebuild test';
  }

  if (ext === '.dart') {
    return 'dart test';
  }

  return inferTestCommand(rootPath);
}
