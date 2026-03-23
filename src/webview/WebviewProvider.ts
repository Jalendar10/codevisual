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

export class CodeFlowWebviewProvider {
  static readonly viewType = 'codeflow.visualizer';

  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private queue: WebviewMessage[] = [];
  private ready = false;

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

  readonly onDidRequestOpenLocation = this.openLocationEmitter.event;
  readonly onDidRequestExport = this.exportEmitter.event;
  readonly onDidRequestAiAnalysis = this.aiAnalysisEmitter.event;
  readonly onDidRequestRunTests = this.runTestsEmitter.event;
  readonly onDidRequestCodePreview = this.codePreviewEmitter.event;
  readonly onDidRequestTestGeneration = this.testGenerationEmitter.event;
  readonly onDidRequestGitData = this.gitDataEmitter.event;
  readonly onDidRequestGitAnalysis = this.gitAnalysisEmitter.event;
  readonly onDidSaveGitSettings = this.gitSettingsEmitter.event;

  constructor(private readonly extensionUri: vscode.Uri) {}

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

    this.panel.webview.onDidReceiveMessage(
      (message: ExtensionMessage) => this.handleMessage(message),
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(
      () => {
        this.panel = undefined;
        this.ready = false;
        this.queue = [];
        this.disposables.forEach((disposable) => disposable.dispose());
        this.disposables = [];
      },
      undefined,
      this.disposables
    );
  }

  updateGraph(graph: GraphData): void {
    this.post({ type: 'updateGraph', data: graph });
  }

  updateAiStatus(status: { available: boolean; provider: string; message: string }): void {
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

  showError(message: string): void {
    this.post({ type: 'error', message });
  }

  dispose(): void {
    this.panel?.dispose();
    this.openLocationEmitter.dispose();
    this.exportEmitter.dispose();
    this.aiAnalysisEmitter.dispose();
    this.runTestsEmitter.dispose();
    this.codePreviewEmitter.dispose();
    this.testGenerationEmitter.dispose();
    this.gitDataEmitter.dispose();
    this.gitAnalysisEmitter.dispose();
    this.gitSettingsEmitter.dispose();
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
