import * as vscode from 'vscode';
import {
  AIAnalysisResult,
  CodePreview,
  ExtensionMessage,
  GraphData,
  GitAnalysisResult,
  GitCommitSummary,
  GitWebhookSettings,
  GraphTestStatus,
  TestRunSummary,
  WebviewMessage,
} from '../types';

export class CodeFlowWebviewProvider implements vscode.WebviewPanelSerializer {
  static readonly viewType = 'codeflow.visualizer';

  private panel: vscode.WebviewPanel | undefined;
  private panelDisposables: vscode.Disposable[] = [];
  private queue: WebviewMessage[] = [];
  private ready = false;
  private lastGraph: GraphData | undefined;
  /** The analyzed path, so we can refresh and re-analyze after deserialize. */
  private lastAnalyzedPath: string | undefined;

  private readonly openLocationEmitter = new vscode.EventEmitter<{
    filePath: string;
    line?: number;
  }>();
  private readonly exportEmitter = new vscode.EventEmitter<{
    format: 'png' | 'svg' | 'json';
    content: string;
    fileName: string;
    mimeType?: string;
  }>();
  private readonly aiAnalysisEmitter = new vscode.EventEmitter<{ nodeId?: string }>();
  private readonly runTestsEmitter = new vscode.EventEmitter<void>();
  private readonly codePreviewEmitter = new vscode.EventEmitter<{ nodeId?: string }>();
  private readonly testGenerationEmitter = new vscode.EventEmitter<{ nodeId?: string }>();
  private readonly gitDataEmitter = new vscode.EventEmitter<void>();
  private readonly gitAnalysisEmitter = new vscode.EventEmitter<void>();
  private readonly gitSettingsEmitter = new vscode.EventEmitter<GitWebhookSettings>();
  private readonly refreshEmitter = new vscode.EventEmitter<void>();
  private readonly requestModelsEmitter = new vscode.EventEmitter<void>();
  private readonly selectModelEmitter = new vscode.EventEmitter<{ modelId: string }>();
  private readonly testDiffEmitter = new vscode.EventEmitter<{ nodeId?: string }>();
  private readonly applySuggestionEmitter = new vscode.EventEmitter<{ filePath: string; line: number; endLine?: number; original: string; suggested: string }>();
  private readonly runTestsForFileEmitter = new vscode.EventEmitter<{ filePath: string }>();

  readonly onDidRequestOpenLocation = this.openLocationEmitter.event;
  readonly onDidRequestExport = this.exportEmitter.event;
  readonly onDidRequestAiAnalysis = this.aiAnalysisEmitter.event;
  readonly onDidRequestRunTests = this.runTestsEmitter.event;
  readonly onDidRequestCodePreview = this.codePreviewEmitter.event;
  readonly onDidRequestTestGeneration = this.testGenerationEmitter.event;
  readonly onDidRequestGitData = this.gitDataEmitter.event;
  readonly onDidRequestGitAnalysis = this.gitAnalysisEmitter.event;
  readonly onDidSaveGitSettings = this.gitSettingsEmitter.event;
  readonly onDidRequestRefresh = this.refreshEmitter.event;
  readonly onDidRequestModels = this.requestModelsEmitter.event;
  readonly onDidSelectModel = this.selectModelEmitter.event;
  readonly onDidRequestTestDiff = this.testDiffEmitter.event;
  readonly onDidApplySuggestion = this.applySuggestionEmitter.event;
  readonly onDidRunTestsForFile = this.runTestsForFileEmitter.event;

  constructor(private readonly extensionUri: vscode.Uri) {
    // Register the serializer so the webview restores when dragged to another
    // editor group or when VS Code restarts — fixes the blank panel bug.
    vscode.window.registerWebviewPanelSerializer(CodeFlowWebviewProvider.viewType, this);
  }

  /** Store the last analyzed path so we can restore on deserialize. */
  setAnalyzedPath(p: string): void {
    this.lastAnalyzedPath = p;
  }

  getAnalyzedPath(): string | undefined {
    return this.lastAnalyzedPath;
  }

  /**
   * Called by VS Code when restoring a previously persisted webview panel
   * (e.g. after dragging to a second window or restarting VS Code).
   */
  async deserializeWebviewPanel(panel: vscode.WebviewPanel, _state: unknown): Promise<void> {
    // Dispose any previous panel listeners (in case of rapid re-serialization).
    // Important: dispose BEFORE reassigning this.panel so the old onDidDispose
    // callback (which clears this.panel) is removed before it can fire.
    this.disposePanel();

    this.panel = panel;
    this.ready = false;
    this.queue = [];

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    };

    panel.webview.html = this.renderHtml(panel.webview);
    this.wirePanel(panel);

    // Re-send the last graph so the restored panel isn't blank.
    // The message is queued until the webview fires 'ready'.
    if (this.lastGraph) {
      this.post({ type: 'updateGraph', data: this.lastGraph });
    }
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }

    this.ready = false;
    this.queue = [];
    this.panel = vscode.window.createWebviewPanel(
      CodeFlowWebviewProvider.viewType,
      'CodeFlow Visualizer',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
      }
    );

    this.panel.webview.html = this.renderHtml(this.panel.webview);
    this.wirePanel(this.panel);
  }

  /** Common wiring for both show() and deserializeWebviewPanel(). */
  private wirePanel(panel: vscode.WebviewPanel): void {
    // Capture a reference so the dispose handler only clears state if
    // the disposed panel is still the current one.  When a panel is dragged
    // to another window VS Code disposes the old panel and calls
    // deserializeWebviewPanel() with a new one — without this guard the
    // old panel's onDidDispose would null out the freshly assigned panel.
    const panelRef = panel;

    panel.webview.onDidReceiveMessage(
      (message: ExtensionMessage) => this.handleMessage(message),
      undefined,
      this.panelDisposables
    );

    panel.onDidDispose(
      () => {
        if (this.panel === panelRef) {
          this.panel = undefined;
          this.ready = false;
          this.queue = [];
        }
        this.disposePanel();
      },
      undefined,
      this.panelDisposables
    );
  }

  updateGraph(graph: GraphData): void {
    this.lastGraph = graph;
    if (graph.metadata.path) {
      this.lastAnalyzedPath = graph.metadata.path;
    }
    this.post({ type: 'updateGraph', data: graph });
  }

  updateAiStatus(status: { available: boolean; provider: string; message: string; model?: string }): void {
    this.post({ type: 'aiStatus', ...status });
  }

  showAIAnalysisResult(targetLabel: string, analysis: AIAnalysisResult): void {
    this.post({ type: 'aiAnalysis', targetLabel, analysis });
  }

  showCodePreview(preview: CodePreview): void {
    this.post({ type: 'codePreview', preview });
  }

  showTestResults(
    summary: TestRunSummary,
    statuses: Record<string, GraphTestStatus>,
    affectedNodeIds: string[]
  ): void {
    this.post({ type: 'testResults', summary, statuses, affectedNodeIds });
  }

  showStatus(level: 'info' | 'success' | 'warning' | 'error', message: string): void {
    this.post({ type: 'status', level, message });
  }

  showGitData(
    commits: GitCommitSummary[],
    settings: GitWebhookSettings,
    review?: GitAnalysisResult
  ): void {
    this.post({ type: 'gitData', commits, settings, review });
  }

  showModels(models: Array<{ id: string; family: string }>): void {
    this.post({ type: 'aiModels', models });
  }

  showTestDiffResult(targetLabel: string, missingScenarios: string, testFilePath?: string, sourceFilePath?: string): void {
    this.post({ type: 'testDiffResult', targetLabel, missingScenarios, testFilePath, sourceFilePath });
  }

  showError(message: string): void {
    this.post({ type: 'error', message });
  }

  private disposePanel(): void {
    this.panelDisposables.forEach((d) => d.dispose());
    this.panelDisposables = [];
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposePanel();
    this.openLocationEmitter.dispose();
    this.exportEmitter.dispose();
    this.aiAnalysisEmitter.dispose();
    this.runTestsEmitter.dispose();
    this.codePreviewEmitter.dispose();
    this.testGenerationEmitter.dispose();
    this.gitDataEmitter.dispose();
    this.gitAnalysisEmitter.dispose();
    this.gitSettingsEmitter.dispose();
    this.refreshEmitter.dispose();
    this.requestModelsEmitter.dispose();
    this.selectModelEmitter.dispose();
    this.testDiffEmitter.dispose();
    this.applySuggestionEmitter.dispose();
    this.runTestsForFileEmitter.dispose();
  }

  private handleMessage(message: ExtensionMessage): void {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        while (this.queue.length > 0) {
          const payload = this.queue.shift();
          if (payload) {
            this.panel?.webview.postMessage(payload);
          }
        }
        break;
      case 'goToLocation':
        this.openLocationEmitter.fire(message.data);
        break;
      case 'export':
        this.exportEmitter.fire(message.data);
        break;
      case 'requestAiAnalysis':
        this.aiAnalysisEmitter.fire({ nodeId: message.nodeId });
        break;
      case 'requestCodePreview':
        this.codePreviewEmitter.fire({ nodeId: message.nodeId });
        break;
      case 'requestTestGeneration':
        this.testGenerationEmitter.fire({ nodeId: message.nodeId });
        break;
      case 'runTests':
        this.runTestsEmitter.fire();
        break;
      case 'requestGitData':
        this.gitDataEmitter.fire();
        break;
      case 'requestGitAnalysis':
        this.gitAnalysisEmitter.fire();
        break;
      case 'saveGitSettings':
        this.gitSettingsEmitter.fire(message.data);
        break;
      case 'requestRefresh':
        this.refreshEmitter.fire();
        break;
      case 'requestModels':
        this.requestModelsEmitter.fire();
        break;
      case 'selectModel':
        this.selectModelEmitter.fire({ modelId: (message as any).modelId });
        break;
      case 'requestTestDiff':
        this.testDiffEmitter.fire({ nodeId: (message as any).nodeId });
        break;
      case 'applySuggestion':
        this.applySuggestionEmitter.fire(message as any);
        break;
      case 'runTestsForFile':
        this.runTestsForFileEmitter.fire({ filePath: (message as any).filePath });
        break;
    }
  }

  private post(message: WebviewMessage): void {
    if (!this.panel) {
      return;
    }

    if (!this.ready) {
      this.queue.push(message);
      return;
    }

    this.panel.webview.postMessage(message);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'webview.js')
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="
        default-src 'none';
        img-src ${webview.cspSource} data:;
        style-src ${webview.cspSource} 'unsafe-inline';
        script-src 'nonce-${nonce}';
        font-src ${webview.cspSource};
      "
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CodeFlow Visualizer</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

function getNonce(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let value = '';
  for (let index = 0; index < 32; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}
