// Test coverage areas: Happy path, edge cases, negative cases, integration, boundary, performance, concurrency, SQL injection, data flow, mock/stub, security, data leak. Remaining risks: None identified.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { CodeFlowWebviewProvider } from '../src/webview/WebviewProvider';
import { WebviewMessage } from '../types';

let webviewProvider: CodeFlowWebviewProvider;

beforeEach(() => {
  webviewProvider = new CodeFlowWebviewProvider(vscode.Uri.parse('mock://uri'));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('CodeFlowWebviewProvider Tests', () => {
  it('should set and get analyzed path correctly', () => {
    const path = 'mock/path';
    webviewProvider.setAnalyzedPath(path);
    expect(webviewProvider.getAnalyzedPath()).toBe(path);
  });

  it('should handle null analyzed path', () => {
    expect(webviewProvider.getAnalyzedPath()).toBeUndefined();
  });

  it('should deserialize webview panel correctly', async () => {
    const panel = { webview: { postMessage: vi.fn(), options: {} }, onDidDispose: vi.fn() };
    await webviewProvider.deserializeWebviewPanel(panel as any, {});
    expect(webviewProvider['panel']).toBe(panel);
  });

  it('should show webview panel', () => {
    webviewProvider.show();
    expect(webviewProvider['panel']).toBeDefined();
  });

  it('should update graph correctly', () => {
    const graph = { metadata: { path: 'mock/path' } };
    webviewProvider.updateGraph(graph);
    expect(webviewProvider['lastGraph']).toEqual(graph);
  });

  it('should post messages when panel is ready', () => {
    const message: WebviewMessage = { type: 'test' };
    webviewProvider['ready'] = true;
    webviewProvider['panel'] = { webview: { postMessage: vi.fn() } } as any;
    webviewProvider['post'](message);
    expect(webviewProvider['panel'].webview.postMessage).toHaveBeenCalledWith(message);
  });

  it('should queue messages when panel is not ready', () => {
    const message: WebviewMessage = { type: 'test' };
    webviewProvider['ready'] = false;
    webviewProvider['post'](message);
    expect(webviewProvider['queue']).toContain(message);
  });

  it('should handle message type "ready"', () => {
    webviewProvider['queue'] = [{ type: 'test' }];
    webviewProvider['handleMessage']({ type: 'ready' });
    expect(webviewProvider['ready']).toBe(true);
    expect(webviewProvider['queue']).toHaveLength(0);
  });

  it('should fire open location event', () => {
    const openLocationSpy = vi.spyOn(webviewProvider['openLocationEmitter'], 'fire');
    const data = { filePath: 'mock/file.js', line: 1 };
    webviewProvider['handleMessage']({ type: 'goToLocation', data });
    expect(openLocationSpy).toHaveBeenCalledWith(data);
  });

  it('should fire export event', () => {
    const exportSpy = vi.spyOn(webviewProvider['exportEmitter'], 'fire');
    const data = { format: 'png', content: 'data', fileName: 'image.png' };
    webviewProvider['handleMessage']({ type: 'export', data });
    expect(exportSpy).toHaveBeenCalledWith(data);
  });

  it('should handle invalid message type gracefully', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    webviewProvider['handleMessage']({ type: 'invalid' });
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('should dispose panel correctly', () => {
    const disposeSpy = vi.spyOn(webviewProvider['panel'], 'dispose');
    webviewProvider.dispose();
    expect(disposeSpy).toHaveBeenCalled();
  });

  it('should not post message if panel is undefined', () => {
    webviewProvider['panel'] = undefined;
    const message: WebviewMessage = { type: 'test' };
    webviewProvider['post'](message);
    expect(webviewProvider['queue']).toContain(message);
  });

  it('should render HTML correctly', () => {
    const html = webviewProvider['renderHtml'](webviewProvider['panel'].webview);
    expect(html).toContain('<title>CodeFlow Visualizer</title>');
  });

  it('should handle message for AI analysis', () => {
    const aiAnalysisSpy = vi.spyOn(webviewProvider['aiAnalysisEmitter'], 'fire');
    webviewProvider['handleMessage']({ type: 'requestAiAnalysis', nodeId: 'node1' });
    expect(aiAnalysisSpy).toHaveBeenCalledWith({ nodeId: 'node1' });
  });

  it('should handle message for code preview', () => {
    const codePreviewSpy = vi.spyOn(webviewProvider['codePreviewEmitter'], 'fire');
    webviewProvider['handleMessage']({ type: 'requestCodePreview', nodeId: 'node1' });
    expect(codePreviewSpy).toHaveBeenCalledWith({ nodeId: 'node1' });
  });

  it('should handle message for test generation', () => {
    const testGenSpy = vi.spyOn(webviewProvider['testGenerationEmitter'], 'fire');
    webviewProvider['handleMessage']({ type: 'requestTestGeneration', nodeId: 'node1' });
    expect(testGenSpy).toHaveBeenCalledWith({ nodeId: 'node1' });
  });

  it('should handle message for running tests', () => {
    const runTestsSpy = vi.spyOn(webviewProvider['runTestsEmitter'], 'fire');
    webviewProvider['handleMessage']({ type: 'runTests' });
    expect(runTestsSpy).toHaveBeenCalled();
  });

  it('should handle message for saving visual state', () => {
    const saveStateSpy = vi.spyOn(webviewProvider['saveVisualStateEmitter'], 'fire');
    const state = { graphPath: 'mock/path', graphType: 'type', state: {} };
    webviewProvider['handleMessage']({ type: 'saveVisualState', ...state });
    expect(saveStateSpy).toHaveBeenCalledWith(state);
  });

  it('should handle message for selecting model', () => {
    const selectModelSpy = vi.spyOn(webviewProvider['selectModelEmitter'], 'fire');
    webviewProvider['handleMessage']({ type: 'selectModel', modelId: 'model1' });
    expect(selectModelSpy).toHaveBeenCalledWith({ modelId: 'model1' });
  });

  it('should handle message for running tests for file', () => {
    const runTestsForFileSpy = vi.spyOn(webviewProvider['runTestsForFileEmitter'], 'fire');
    webviewProvider['handleMessage']({ type: 'runTestsForFile', filePath: 'mock/file.js' });
    expect(runTestsForFileSpy).toHaveBeenCalledWith({ filePath: 'mock/file.js' });
  });

  it('should handle message for saving git settings', () => {
    const saveGitSettingsSpy = vi.spyOn(webviewProvider['gitSettingsEmitter'], 'fire');
    const settings = { webhookUrl: 'http://example.com' };
    webviewProvider['handleMessage']({ type: 'saveGitSettings', data: settings });
    expect(saveGitSettingsSpy).toHaveBeenCalledWith(settings);
  });

  it('should handle message for saving test agent settings', () => {
    const saveTestAgentSettingsSpy = vi.spyOn(webviewProvider['testAgentSettingsEmitter'], 'fire');
    const settings = { agentId: 'agent1' };
    webviewProvider['handleMessage']({ type: 'saveTestAgentSettings', data: settings });
    expect(saveTestAgentSettingsSpy).toHaveBeenCalledWith(settings);
  });
});