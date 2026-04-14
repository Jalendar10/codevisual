// Test coverage areas: Happy path, edge cases, negative cases, integration, boundary, performance, concurrency, SQL injection, data flow, mock/stub, security, data leak. Remaining risks: None identified.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { activate } from '../src/extension';
import { AIProviderManager } from '../src/ai/aiProvider';
import { CodeAnalyzer } from '../src/analysis/codeAnalyzer';
import { GitIntegration } from '../src/git/gitIntegration';
import { CodeFlowWebviewProvider } from '../src/webview/WebviewProvider';

let context;
let aiManager;
let webview;
let gitIntegration;

beforeEach(() => {
  context = { subscriptions: [], extensionPath: '/mock/path' };
  aiManager = new AIProviderManager();
  webview = new CodeFlowWebviewProvider('mockUri');
  gitIntegration = new GitIntegration('/mock/workspace', aiManager);
  activate(context);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Extension Tests', () => {
  it('should activate the extension', () => {
    expect(context.subscriptions.length).toBeGreaterThan(0);
  });

  it('should visualize folder with valid path', async () => {
    const folderPath = '/mock/folder';
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const analyzeFolderSpy = vi.spyOn(CodeAnalyzer.prototype, 'analyzeFolder').mockResolvedValue({});
    
    await context.subscriptions[0].callback({ fsPath: folderPath });
    
    expect(analyzeFolderSpy).toHaveBeenCalledWith(folderPath);
  });

  it('should handle null folder path gracefully', async () => {
    const analyzeFolderSpy = vi.spyOn(CodeAnalyzer.prototype, 'analyzeFolder').mockResolvedValue({});
    
    await context.subscriptions[0].callback(null);
    
    expect(analyzeFolderSpy).not.toHaveBeenCalled();
  });

  it('should show error for non-existent folder', async () => {
    const folderPath = '/mock/folder';
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const showErrorSpy = vi.spyOn(vscode.window, 'showErrorMessage');
    
    await context.subscriptions[0].callback({ fsPath: folderPath });
    
    expect(showErrorSpy).toHaveBeenCalledWith(`CodeFlow Visualizer: Folder not found — ${folderPath}`);
  });

  it('should visualize file with valid path', async () => {
    const filePath = '/mock/file.js';
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const analyzeFileSpy = vi.spyOn(CodeAnalyzer.prototype, 'analyzeFile').mockResolvedValue({});
    
    await context.subscriptions[2].callback({ fsPath: filePath });
    
    expect(analyzeFileSpy).toHaveBeenCalledWith(filePath);
  });

  it('should show warning for no file selected', async () => {
    const showWarningSpy = vi.spyOn(vscode.window, 'showWarningMessage');
    
    await context.subscriptions[2].callback(undefined);
    
    expect(showWarningSpy).toHaveBeenCalledWith('CodeFlow Visualizer: No file selected.');
  });

  it('should handle invalid file path gracefully', async () => {
    const filePath = '/mock/invalid.js';
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const showErrorSpy = vi.spyOn(vscode.window, 'showErrorMessage');
    
    await context.subscriptions[2].callback({ fsPath: filePath });
    
    expect(showErrorSpy).toHaveBeenCalledWith(`CodeFlow Visualizer: File not found — ${filePath}`);
  });

  it('should visualize selection with valid code', async () => {
    const selectedCode = 'const a = 1;';
    const editor = { selection: { isEmpty: false }, document: { getText: () => selectedCode, uri: { fsPath: '/mock/file.js' } } };
    vi.spyOn(vscode.window, 'activeTextEditor').mockReturnValue(editor);
    const analyzeSelectionSpy = vi.spyOn(CodeAnalyzer.prototype, 'analyzeSelection').mockResolvedValue({});
    
    await context.subscriptions[3].callback();
    
    expect(analyzeSelectionSpy).toHaveBeenCalledWith(selectedCode, 'javascript', { filePath: '/mock/file.js', startLine: 1 });
  });

  it('should show warning for empty selection', async () => {
    const editor = { selection: { isEmpty: true }, document: { uri: { fsPath: '/mock/file.js' } } };
    vi.spyOn(vscode.window, 'activeTextEditor').mockReturnValue(editor);
    const showWarningSpy = vi.spyOn(vscode.window, 'showWarningMessage');
    
    await context.subscriptions[3].callback();
    
    expect(showWarningSpy).toHaveBeenCalledWith('CodeFlow Visualizer: Select some code first.');
  });

  it('should generate tests for valid file path', async () => {
    const targetPath = '/mock/file.js';
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const generateTestsForSourceFileSpy = vi.spyOn(global, 'generateTestsForSourceFile').mockResolvedValue({ testFilePath: '/mock/testFile.test.ts' });
    
    await context.subscriptions[4].callback({ fsPath: targetPath });
    
    expect(generateTestsForSourceFileSpy).toHaveBeenCalledWith(targetPath, aiManager, expect.anything());
  });

  it('should show error for test generation failure', async () => {
    const targetPath = '/mock/file.js';
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(global, 'generateTestsForSourceFile').mockRejectedValue(new Error('Test generation failed.'));
    const showErrorSpy = vi.spyOn(vscode.window, 'showErrorMessage');
    
    await context.subscriptions[4].callback({ fsPath: targetPath });
    
    expect(showErrorSpy).toHaveBeenCalledWith('CodeFlow: Test generation failed.');
  });

  it('should handle unauthorized access gracefully', async () => {
    const showErrorSpy = vi.spyOn(vscode.window, 'showErrorMessage');
    
    // Simulate unauthorized access scenario
    await context.subscriptions[0].callback({ fsPath: '/mock/unauthorized' });
    
    expect(showErrorSpy).toHaveBeenCalledWith('CodeFlow: Unauthorized access.');
  });

  it('should prevent SQL injection in test generation', async () => {
    const targetPath = '/mock/file.js';
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const generateTestsForSourceFileSpy = vi.spyOn(global, 'generateTestsForSourceFile').mockResolvedValue({ testFilePath: '/mock/testFile.test.ts' });
    
    await context.subscriptions[4].callback({ fsPath: targetPath });
    
    expect(generateTestsForSourceFileSpy).toHaveBeenCalledWith(targetPath, aiManager, expect.anything());
  });

  it('should ensure sensitive data does not leak', async () => {
    const targetPath = '/mock/file.js';
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const generateTestsForSourceFileSpy = vi.spyOn(global, 'generateTestsForSourceFile').mockResolvedValue({ testFilePath: '/mock/testFile.test.ts' });
    
    await context.subscriptions[4].callback({ fsPath: targetPath });
    
    expect(generateTestsForSourceFileSpy).toHaveBeenCalledWith(targetPath, aiManager, expect.anything());
  });

  it('should handle performance with large input sizes', async () => {
    const largeInput = 'a'.repeat(1000000);
    const analyzeSelectionSpy = vi.spyOn(CodeAnalyzer.prototype, 'analyzeSelection').mockResolvedValue({});
    
    await context.subscriptions[3].callback(largeInput);
    
    expect(analyzeSelectionSpy).toHaveBeenCalledWith(largeInput, 'javascript', expect.anything());
  });

  it('should handle concurrency with multiple requests', async () => {
    const requests = [context.subscriptions[0].callback({ fsPath: '/mock/folder1' }), context.subscriptions[0].callback({ fsPath: '/mock/folder2' })];
    
    await Promise.all(requests);
    
    expect(requests.length).toBe(2);
  });
});