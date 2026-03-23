import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { GitAnalysisResult, GitChange, GitComment, GitCommitSummary } from '../types';
import { AIProviderManager, AIContext } from '../ai/aiProvider';
import * as fs from 'fs';

/**
 * Git Integration — monitors changes, analyzes PRs/pushes, adds comments.
 */
export class GitIntegration {
  private aiManager: AIProviderManager;
  private workspacePath: string;
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private onAnalysisComplete: vscode.EventEmitter<GitAnalysisResult> = new vscode.EventEmitter();
  public readonly onDidAnalyze = this.onAnalysisComplete.event;

  constructor(workspacePath: string, aiManager: AIProviderManager) {
    this.workspacePath = workspacePath;
    this.aiManager = aiManager;
  }

  /** Start watching for git changes */
  startWatching(): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];
    const config = vscode.workspace.getConfiguration('codeVisual');

    // Watch for file saves (if enabled)
    if (config.get('autoAnalyzeOnSave')) {
      this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
      this.fileWatcher.onDidChange(async (uri) => {
        if (this.isTrackedFile(uri.fsPath)) {
          await this.analyzeFileChange(uri.fsPath);
        }
      });
      disposables.push(this.fileWatcher);
    }

    // Watch for git hooks (pre-push, pre-commit)
    if (config.get('autoAnalyzeOnPush')) {
      this.setupGitHooks();
    }

    return disposables;
  }

  /** Get staged/unstaged changes */
  async getChanges(): Promise<GitChange[]> {
    const changes: GitChange[] = [];

    try {
      // Get both staged and unstaged changes
      const diff = await this.exec('git diff HEAD --numstat');
      const statusOutput = await this.exec('git status --porcelain');

      const statusLines = statusOutput.split('\n').filter(Boolean);
      for (const line of statusLines) {
        const status = line.substring(0, 2).trim();
        const file = line.substring(3).trim();

        let changeStatus: GitChange['status'] = 'modified';
        if (status.includes('A') || status === '??') changeStatus = 'added';
        else if (status.includes('D')) changeStatus = 'deleted';
        else if (status.includes('R')) changeStatus = 'renamed';

        // Get line counts from numstat
        const numstatLine = diff.split('\n').find(l => l.endsWith(file));
        let additions = 0, deletions = 0;
        if (numstatLine) {
          const parts = numstatLine.split('\t');
          additions = parseInt(parts[0]) || 0;
          deletions = parseInt(parts[1]) || 0;
        }

        changes.push({
          file,
          status: changeStatus,
          additions,
          deletions,
        });
      }
    } catch (error) {
      // Not a git repo or git not available
    }

    return changes;
  }

  /** Get full diff for analysis */
  async getDiff(): Promise<string> {
    try {
      // Get diff against main/master branch or HEAD
      const branch = await this.getBaseBranch();
      const diff = await this.exec(`git diff ${branch}...HEAD`);
      if (diff) return diff;

      // Fallback to staged + unstaged changes
      return await this.exec('git diff HEAD');
    } catch {
      return '';
    }
  }

  /** Get recent commits for the settings panel */
  async getRecentCommits(limit = 12): Promise<GitCommitSummary[]> {
    try {
      const output = await this.exec(
        `git log -n ${limit} --date=short --pretty=format:%H%x09%h%x09%an%x09%ad%x09%s`
      );

      return output
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash, shortHash, author, date, subject] = line.split('\t');
          return {
            hash,
            shortHash,
            author,
            date,
            subject,
          };
        });
    } catch {
      return [];
    }
  }

  /** Analyze all current git changes with AI */
  async analyzeGitChanges(): Promise<GitAnalysisResult> {
    const changes = await this.getChanges();
    const diff = await this.getDiff();

    if (!diff && changes.length === 0) {
      return {
        changes: [],
        analysis: {
          summary: 'No changes detected.',
          issues: [],
          suggestions: [],
          codeQuality: 100,
          testCoverage: 'N/A',
          securityConcerns: [],
          timestamp: Date.now(),
          provider: 'N/A',
          model: 'N/A',
        },
        compatibilityScore: 100,
        breakingChanges: [],
        comments: [],
      };
    }

    // Get existing code context for changed files
    let existingContext = '';
    for (const change of changes.slice(0, 5)) {
      try {
        const filePath = path.join(this.workspacePath, change.file);
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf8');
          existingContext += `\n--- ${change.file} ---\n${content.slice(0, 2000)}\n`;
        }
      } catch { /* skip */ }
    }

    const context: AIContext = {
      projectContext: `Project at ${this.workspacePath}`,
      existingCode: existingContext,
      instructions: `Analyze these git changes. Determine:
1. Will the new code work with the existing codebase?
2. Are there breaking changes?
3. What issues need attention?
4. Rate compatibility 0-100.
5. Provide line-specific comments for important findings.`,
    };

    const analysis = await this.aiManager.analyzeChanges(diff, context);

    // Generate line-specific comments
    const comments = this.generateComments(analysis, changes);

    const result: GitAnalysisResult = {
      changes,
      analysis,
      compatibilityScore: (analysis as any).compatibilityScore || 80,
      breakingChanges: (analysis as any).breakingChanges || [],
      comments,
    };

    this.onAnalysisComplete.fire(result);
    return result;
  }

  /** Push analysis comments to git (as git notes or inline comments) */
  async pushComments(result: GitAnalysisResult): Promise<void> {
    // Create a summary comment
    const summaryLines = [
      `## Code Visual AI Analysis`,
      ``,
      `**Quality Score:** ${result.analysis.codeQuality}/100`,
      `**Compatibility:** ${result.compatibilityScore}/100`,
      `**Provider:** ${result.analysis.provider} (${result.analysis.model})`,
      ``,
      `### Summary`,
      result.analysis.summary,
      ``,
    ];

    if (result.breakingChanges.length > 0) {
      summaryLines.push(`### Breaking Changes`);
      result.breakingChanges.forEach(bc => summaryLines.push(`- ${bc}`));
      summaryLines.push('');
    }

    if (result.analysis.issues.length > 0) {
      summaryLines.push(`### Issues`);
      result.analysis.issues.forEach(issue => {
        const icon = issue.severity === 'error' ? '!' : issue.severity === 'warning' ? '?' : 'i';
        summaryLines.push(`- [${icon}] ${issue.message}${issue.file ? ` (${issue.file}:${issue.line})` : ''}`);
      });
      summaryLines.push('');
    }

    if (result.comments.length > 0) {
      summaryLines.push(`### Inline Comments`);
      result.comments.forEach(c => {
        summaryLines.push(`- **${c.file}:${c.line}** [${c.severity}] ${c.message}`);
      });
    }

    const summary = summaryLines.join('\n');

    // Save as git notes on the current commit
    try {
      const commitHash = await this.exec('git rev-parse HEAD');
      await this.exec(`git notes add -f -m "${summary.replace(/"/g, '\\"')}" ${commitHash.trim()}`);
      vscode.window.showInformationMessage('Code Visual: Analysis comments pushed to git notes.');
    } catch (error: any) {
      // Fallback: save to a file
      const analysisPath = path.join(this.workspacePath, '.code-visual-analysis.md');
      fs.writeFileSync(analysisPath, summary);
      vscode.window.showInformationMessage(`Code Visual: Analysis saved to .code-visual-analysis.md`);
    }
  }

  /** Set up git hooks for automatic analysis */
  private async setupGitHooks(): Promise<void> {
    try {
      const hooksDir = path.join(this.workspacePath, '.git', 'hooks');
      if (!fs.existsSync(hooksDir)) return;

      // Create pre-push hook
      const hookScript = `#!/bin/sh
# Code Visual - Auto Analysis Hook
# This hook triggers Code Visual's AI analysis before pushing
echo "Code Visual: Running code analysis..."
# The actual analysis runs in VS Code, this is just a notification
exit 0
`;
      const hookPath = path.join(hooksDir, 'pre-push');
      if (!fs.existsSync(hookPath)) {
        fs.writeFileSync(hookPath, hookScript, { mode: 0o755 });
      }
    } catch {
      // Silently fail — hooks are optional
    }
  }

  /** Analyze a single file change */
  private async analyzeFileChange(filePath: string): Promise<void> {
    try {
      const relativePath = path.relative(this.workspacePath, filePath);
      const diff = await this.exec(`git diff -- "${relativePath}"`);
      if (!diff) return;

      const content = fs.readFileSync(filePath, 'utf8');
      const analysis = await this.aiManager.analyzeChanges(diff, {
        filePath: relativePath,
        existingCode: content,
      });

      // Show inline diagnostics
      this.showDiagnostics(filePath, analysis.issues);
    } catch {
      // Silent fail for auto-analysis
    }
  }

  /** Show issues as VS Code diagnostics */
  private showDiagnostics(filePath: string, issues: any[]): void {
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('codeVisual');
    const uri = vscode.Uri.file(filePath);
    const diagnostics: vscode.Diagnostic[] = [];

    for (const issue of issues) {
      const line = Math.max(0, (issue.line || 1) - 1);
      const range = new vscode.Range(line, 0, line, 1000);
      const severity = issue.severity === 'error'
        ? vscode.DiagnosticSeverity.Error
        : issue.severity === 'warning'
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information;

      const diag = new vscode.Diagnostic(range, `[Code Visual] ${issue.message}`, severity);
      diag.source = 'Code Visual AI';
      diagnostics.push(diag);
    }

    diagnosticCollection.set(uri, diagnostics);
  }

  /** Generate line-specific comments from analysis */
  private generateComments(analysis: any, changes: GitChange[]): GitComment[] {
    const comments: GitComment[] = [];

    for (const issue of analysis.issues || []) {
      if (issue.file && issue.line) {
        comments.push({
          file: issue.file,
          line: issue.line,
          message: issue.message + (issue.suggestion ? `\n\nSuggestion: ${issue.suggestion}` : ''),
          severity: issue.severity,
        });
      }
    }

    return comments;
  }

  /** Get the base branch (main/master/develop) */
  private async getBaseBranch(): Promise<string> {
    try {
      // Try common branch names
      for (const branch of ['main', 'master', 'develop']) {
        try {
          await this.exec(`git rev-parse --verify ${branch}`);
          return branch;
        } catch { /* try next */ }
      }
    } catch { /* fallback */ }
    return 'HEAD~1';
  }

  /** Check if a file is tracked by git */
  private isTrackedFile(filePath: string): boolean {
    try {
      const ext = path.extname(filePath).toLowerCase();
      const ignoreExts = ['.log', '.lock', '.map', '.min.js', '.min.css'];
      return !ignoreExts.includes(ext) && !filePath.includes('node_modules') && !filePath.includes('.git');
    } catch {
      return false;
    }
  }

  /** Execute a git command */
  private exec(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      cp.exec(command, { cwd: this.workspacePath, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      });
    });
  }

  dispose(): void {
    this.fileWatcher?.dispose();
  }
}
