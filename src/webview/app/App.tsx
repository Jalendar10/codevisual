import { MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Controls,
  Edge,
  MarkerType,
  MiniMap,
  Node,
  NodeMouseHandler,
  OnInit,
  ReactFlow,
  ReactFlowInstance,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import { toPng, toSvg } from 'html-to-image';
import {
  AIAnalysisResult,
  CodePreview,
  GraphData,
  GraphEdge,
  GraphClassSummary,
  GraphLayoutAlgorithm,
  GraphNode,
  GraphNodeData,
  GraphNodeType,
  GitAnalysisResult,
  GitCommitSummary,
  GitWebhookSettings,
  TestRunSummary,
  WebviewMessage,
} from '../../types';
import { FileNode, FolderNode, ModuleNode, SymbolNode } from './components/nodes';
import { useVSCodeAPI } from './hooks/useVSCodeAPI';
import { applyLayout } from './utils/layout';

type FlowNode = Node<GraphNodeData>;
type FlowEdge = Edge;
type ActiveTab = 'visual' | 'settings';
type StatusTone = 'info' | 'success' | 'warning' | 'error';
type HeatOverlayMode = 'none' | 'complexity' | 'hotspot';

const nodeTypes = {
  folder: FolderNode,
  file: FileNode,
  class: SymbolNode,
  function: SymbolNode,
  method: SymbolNode,
  interface: SymbolNode,
  type: SymbolNode,
  variable: SymbolNode,
  test: SymbolNode,
  module: ModuleNode,
  external: ModuleNode,
};

const defaultVisibility = {
  folders: true,
  files: true,
  symbols: true,
  tests: true,
  modules: true,
  imports: true,
  calls: true,
  testFlow: true,
  dataFlow: true,
};

export default function App() {
  const vscode = useVSCodeAPI();
  const state = vscode.getState<{
    layout?: GraphLayoutAlgorithm;
    activeTab?: ActiveTab;
    overlayMode?: HeatOverlayMode;
    graphData?: GraphData;
  }>();
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const selectedNodeIdRef = useRef<string | null>(null);
  const mappingFocusNodeIdRef = useRef<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Restore graph from persisted webview state so the panel isn't blank
  // when VS Code re-creates it (e.g. after dragging to another window).
  const [graph, setGraph] = useState<GraphData | null>(state?.graphData ?? null);
  const [rawNodes, setRawNodes] = useState<GraphNode[]>(state?.graphData?.nodes ?? []);
  const [rawEdges, setRawEdges] = useState<GraphEdge[]>(state?.graphData?.edges ?? []);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const [layout, setLayout] = useState<GraphLayoutAlgorithm>(
    state?.layout || 'hierarchical'
  );
  const [activeTab, setActiveTab] = useState<ActiveTab>(state?.activeTab || 'visual');
  const [overlayMode, setOverlayMode] = useState<HeatOverlayMode>(state?.overlayMode || 'none');
  const [visibility, setVisibility] = useState(defaultVisibility);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  // Incremented only when we actually want fitView (graph load / layout change).
  // Expand/collapse does NOT increment this so zooming is preserved.
  const fitViewTrigger = useRef(0);
  const fitViewGeneration = useRef(0);
  const [statusMessage, setStatusMessage] = useState<{ level: StatusTone; message: string } | null>(
    null
  );
  const [testSummary, setTestSummary] = useState<TestRunSummary | null>(null);
  const [affectedNodeIds, setAffectedNodeIds] = useState<string[]>([]);
  const [mappingFocusNodeId, setMappingFocusNodeId] = useState<string | null>(null);
  const [codePreview, setCodePreview] = useState<CodePreview | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    nodeId: string;
    x: number;
    y: number;
  } | null>(null);
  const [gitCommits, setGitCommits] = useState<GitCommitSummary[]>([]);
  const [gitReview, setGitReview] = useState<GitAnalysisResult | null>(null);
  const [gitSettings, setGitSettings] = useState<GitWebhookSettings>({
    provider: 'github',
    webhookUrl: '',
    webhookSecret: '',
  });
  const [lastAiRequestNodeId, setLastAiRequestNodeId] = useState<string | null>(null);
  const [aiModels, setAiModels] = useState<Array<{ id: string; family: string }>>([]);
  const [aiStatus, setAiStatus] = useState({
    available: false,
    provider: 'GitHub Copilot',
    message: 'Checking Copilot availability…',
    model: 'auto',
  });
  const [aiAnalysis, setAiAnalysis] = useState<{
    targetLabel: string;
    analysis: AIAnalysisResult;
  } | null>(null);
  const [testDiff, setTestDiff] = useState<{
    targetLabel: string;
    missingScenarios: string;
    testFilePath?: string;
    sourceFilePath?: string;
  } | null>(null);
  const [instance, setInstance] = useState<ReactFlowInstance<FlowNode, FlowEdge> | null>(null);

  useEffect(() => {
    vscode.setState({ layout, activeTab, overlayMode, graphData: graph ?? undefined });
  }, [activeTab, layout, overlayMode, graph, vscode]);

  useEffect(() => {
    selectedNodeIdRef.current = selectedNodeId;
  }, [selectedNodeId]);

  useEffect(() => {
    mappingFocusNodeIdRef.current = mappingFocusNodeId;
  }, [mappingFocusNodeId]);

  // Clear stale AI analysis whenever the user selects a different node
  useEffect(() => {
    setAiAnalysis(null);
  }, [selectedNodeId]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<WebviewMessage>) => {
      const message = event.data;
      if (!message) {
        return;
      }

      switch (message.type) {
        case 'updateGraph':
          {
          const preservedSelection =
            selectedNodeIdRef.current &&
            message.data.nodes.some((node) => node.id === selectedNodeIdRef.current)
              ? selectedNodeIdRef.current
              : null;
          const preservedMappingFocus =
            mappingFocusNodeIdRef.current &&
            message.data.nodes.some((node) => node.id === mappingFocusNodeIdRef.current)
              ? mappingFocusNodeIdRef.current
              : null;
          setGraph(message.data);
          setRawNodes(message.data.nodes);
          setRawEdges(message.data.edges);
          setSelectedNodeId(preservedSelection);
          setAiAnalysis(null);
          setCodePreview(null);
          setContextMenu(null);
          setMappingFocusNodeId(preservedMappingFocus);
          setAffectedNodeIds([]);
          setTestSummary(null);
          setError(null);
          setIsLoading(false);
          setStatusMessage(null);
          // Request fitView for the new graph
          if (!preservedSelection) {
            fitViewTrigger.current += 1;
          }
          break;
          }
        case 'aiAnalysis':
          setAiAnalysis({ targetLabel: message.targetLabel, analysis: message.analysis });
          setRawNodes((current) =>
            lastAiRequestNodeId
              ? current.map((node) =>
                  node.id === lastAiRequestNodeId
                    ? {
                        ...node,
                        data: {
                          ...node.data,
                          summary: message.analysis.summary,
                        },
                      }
                    : node
                )
              : current
          );
          setStatusMessage({
            level: 'success',
            message: `Copilot analysis updated for ${message.targetLabel}.`,
          });
          break;
        case 'aiStatus':
          setAiStatus({
            available: message.available,
            provider: message.provider,
            message: message.message,
            model: (message as any).model || 'auto',
          });
          break;
        case 'aiModels':
          setAiModels((message as any).models || []);
          break;
        case 'testDiffResult': {
          const tdMsg = message as any;
          setTestDiff({
            targetLabel: tdMsg.targetLabel,
            missingScenarios: tdMsg.missingScenarios,
            testFilePath: tdMsg.testFilePath,
            sourceFilePath: tdMsg.sourceFilePath,
          });
          break;
        }
        case 'codePreview':
          setCodePreview(message.preview);
          break;
        case 'testResults':
          setTestSummary(message.summary);
          setAffectedNodeIds(message.affectedNodeIds);
          setRawNodes((current) =>
            current.map((node) =>
              message.statuses[node.id]
                ? {
                    ...node,
                    data: {
                      ...node.data,
                      testStatus: message.statuses[node.id],
                    },
                  }
                : node
            )
          );
          break;
        case 'gitData':
          setGitCommits(message.commits);
          setGitReview(message.review || null);
          setGitSettings(message.settings);
          break;
        case 'status':
          setStatusMessage({ level: message.level, message: message.message });
          if (message.level === 'info') {
            setIsLoading(true);
          } else {
            setIsLoading(false);
          }
          break;
        case 'error':
          setError(message.message);
          setIsLoading(false);
          setStatusMessage({ level: 'error', message: message.message });
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    vscode.postMessage({ type: 'ready' });

    return () => window.removeEventListener('message', handleMessage);
  }, [lastAiRequestNodeId, vscode]);

  useEffect(() => {
    if (activeTab === 'settings') {
      vscode.postMessage({ type: 'requestGitData' });
      vscode.postMessage({ type: 'requestModels' });
    }
  }, [activeTab, vscode]);

  const dependencyImpact = useMemo(
    () =>
      mappingFocusNodeId
        ? emptyDependencyImpact()
        : collectDependencyImpact(selectedNodeId, rawEdges),
    [mappingFocusNodeId, rawEdges, selectedNodeId]
  );

  useEffect(() => {
    const rendered = buildRenderableGraph(
      rawNodes,
      rawEdges,
      visibility,
      searchQuery,
      layout,
      mappingFocusNodeId,
      affectedNodeIds,
      dependencyImpact,
      overlayMode
    );
    setNodes(rendered.nodes);
    setEdges(rendered.edges);

    // Only fitView when a graph-load or layout-change explicitly requested it.
    // Expand/collapse and search do NOT call fitView so the user's zoom is preserved.
    if (fitViewTrigger.current !== fitViewGeneration.current) {
      fitViewGeneration.current = fitViewTrigger.current;
      requestAnimationFrame(() => {
        instance?.fitView({ padding: 0.12, duration: 350 });
      });
    }
  }, [
    rawNodes,
    rawEdges,
    visibility,
    searchQuery,
    layout,
    mappingFocusNodeId,
    affectedNodeIds,
    dependencyImpact,
    overlayMode,
    instance,
    setEdges,
    setNodes,
  ]);

  useEffect(() => {
    if (!statusMessage) {
      return;
    }

    const timer = window.setTimeout(() => setStatusMessage(null), 5000);
    return () => window.clearTimeout(timer);
  }, [statusMessage]);

  useEffect(() => {
    const tick = graph?.metadata.changeEvent?.updatedAt;
    if (!tick) {
      return;
    }

    const timer = window.setTimeout(() => {
      setRawNodes((current) =>
        current.map((node) =>
          node.data.changed
            ? {
                ...node,
                data: {
                  ...node.data,
                  changed: false,
                },
              }
            : node
        )
      );
      setGraph((current) =>
        current
          ? {
              ...current,
              nodes: current.nodes.map((node) =>
                node.data.changed
                  ? {
                      ...node,
                      data: {
                        ...node.data,
                        changed: false,
                      },
                    }
                  : node
              ),
            }
          : current
      );
    }, 1600);

    return () => window.clearTimeout(timer);
  }, [graph?.metadata.changeEvent?.updatedAt]);

  const selectedNode = useMemo(() => {
    return rawNodes.find((node) => node.id === selectedNodeId) || null;
  }, [rawNodes, selectedNodeId]);

  const analysisTargetNode = useMemo(() => {
    if (selectedNode) {
      return selectedNode;
    }

    return (
      rawNodes.find((node) => node.type === 'file' && !node.data.parentId) ||
      rawNodes.find(
        (node) => !['folder', 'external', 'module'].includes(node.type || '')
      ) ||
      null
    );
  }, [rawNodes, selectedNode]);

  const graphStats = useMemo(() => {
    const testNodes = rawNodes.filter((node) => node.type === 'test').length;
    const fileNodes = rawNodes.filter((node) => node.type === 'file').length;
    const folderNodes = rawNodes.filter((node) => node.type === 'folder').length;
    const testEdges = rawEdges.filter((edge) => edge.type === 'testFlow').length;
    const importEdges = rawEdges.filter((edge) => edge.type === 'import').length;
    const dataFlowEdges = rawEdges.filter((edge) => edge.type === 'dataFlow' || edge.type === 'sqlMapping' || edge.type === 'inject').length;
    const packageNodes = rawNodes.filter(
      (node) => node.type === 'external' && node.data.kind === 'package'
    ).length;

    return {
      testNodes,
      fileNodes,
      folderNodes,
      testEdges,
      importEdges,
      dataFlowEdges,
      packageNodes,
    };
  }, [rawEdges, rawNodes]);

  const mappingTargetNode = useMemo(() => {
    if (!selectedNode) {
      return null;
    }

    return resolveMappingNode(selectedNode, rawNodes);
  }, [rawNodes, selectedNode]);

  const toggleVisibility = useCallback((key: keyof typeof defaultVisibility) => {
    setVisibility((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  const onNodeClick: NodeMouseHandler<FlowNode> = useCallback(
    (_event: MouseEvent, node: FlowNode) => {
      setSelectedNodeId(node.id);
      setContextMenu(null);

      if (node.data.expandable) {
        setRawNodes((current) =>
          current.map((item) =>
            item.id === node.id
              ? {
                  ...item,
                  data: {
                    ...item.data,
                    expanded: !(item.data.expanded ?? true),
                  },
                }
              : item
          )
        );
      }

      if (node.data.filePath) {
        vscode.postMessage({ type: 'requestCodePreview', nodeId: node.id });
      }
    },
    [vscode]
  );

  const onNodeDoubleClick: NodeMouseHandler<FlowNode> = useCallback(
    (_event: MouseEvent, node: FlowNode) => {
      setRawNodes((current) =>
        current.map((item) =>
          item.id === node.id
            ? {
                ...item,
                data: {
                  ...item.data,
                  expanded: !(item.data.expanded ?? true),
                },
              }
            : item
        )
      );
    },
    []
  );

  const onNodeContextMenu: NodeMouseHandler<FlowNode> = useCallback((event: MouseEvent, node: FlowNode) => {
    event.preventDefault();
    setSelectedNodeId(node.id);
    setContextMenu({
      nodeId: node.id,
      x: event.clientX,
      y: event.clientY,
    });
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
    setContextMenu(null);
  }, []);

  const fitView = useCallback(() => {
    instance?.fitView({ padding: 0.14, duration: 320 });
  }, [instance]);

  const onInit: OnInit<FlowNode, FlowEdge> = useCallback((flowInstance) => {
    setInstance(flowInstance);
  }, []);

  const handleExport = useCallback(
    async (format: 'png' | 'svg' | 'json') => {
      try {
        if (format === 'json') {
          vscode.postMessage({
            type: 'export',
            data: {
              format,
              content: JSON.stringify(
                {
                  ...graph,
                  nodes: rawNodes,
                  edges: rawEdges,
                },
                null,
                2
              ),
              fileName: exportFileName(format, graph?.metadata.type),
              mimeType: 'application/json',
            },
          });
          return;
        }

        if (!canvasRef.current) {
          setStatusMessage({
            level: 'warning',
            message: 'Open the Visual tab before exporting SVG or PNG.',
          });
          return;
        }

        const backgroundColor =
          getComputedStyle(document.documentElement)
            .getPropertyValue('--canvas-bg')
            .trim() || '#0b1120';

        const content =
          format === 'png'
            ? await toPng(canvasRef.current, {
                cacheBust: true,
                pixelRatio: 2,
                backgroundColor,
              })
            : await toSvg(canvasRef.current, {
                cacheBust: true,
                backgroundColor,
              });

        vscode.postMessage({
          type: 'export',
          data: {
            format,
            content,
            fileName: exportFileName(format, graph?.metadata.type),
            mimeType: format === 'png' ? 'image/png' : 'image/svg+xml',
          },
        });
      } catch (exportError) {
        setError(exportError instanceof Error ? exportError.message : 'Export failed.');
      }
    },
    [graph, rawEdges, rawNodes, vscode]
  );

  const runTests = useCallback(() => {
    setVisibility((current) => ({ ...current, tests: true, testFlow: true, dataFlow: true }));
    setActiveTab('visual');
    vscode.postMessage({ type: 'runTests' });
  }, [vscode]);

  const requestAiAnalysis = useCallback(() => {
    if (!analysisTargetNode || !analysisTargetNode.data.filePath) {
      setStatusMessage({
        level: 'warning',
        message: 'Select a source file, class, method, or test node in the graph first.',
      });
      return;
    }

    vscode.postMessage({ type: 'requestAiAnalysis', nodeId: analysisTargetNode.id });
    setLastAiRequestNodeId(analysisTargetNode.id);
    setStatusMessage({
      level: 'info',
      message: `Requesting Copilot analysis for ${analysisTargetNode.data.label}…`,
    });
  }, [analysisTargetNode, vscode]);

  const viewSelectedCode = useCallback(() => {
    if (!selectedNode?.data.filePath) {
      return;
    }

    vscode.postMessage({
      type: 'goToLocation',
      data: {
        filePath: selectedNode.data.filePath,
        line: selectedNode.data.startLine,
      },
    });
  }, [selectedNode, vscode]);

  const toggleMappingHighlight = useCallback(() => {
    if (!mappingTargetNode) {
      setStatusMessage({
        level: 'warning',
        message: 'Select a file, class, or method node with mapping context first.',
      });
      return;
    }

    setVisibility((current) => ({ ...current, dataFlow: true }));
    setActiveTab('visual');
    setMappingFocusNodeId((current) => (current === mappingTargetNode.id ? null : mappingTargetNode.id));
  }, [mappingTargetNode]);

  const generateTests = useCallback(
    (nodeId?: string) => {
      const targetNode =
        rawNodes.find((node) => node.id === nodeId) ||
        selectedNode ||
        analysisTargetNode;
      if (!targetNode) {
        setStatusMessage({
          level: 'warning',
          message: 'Select a class, method, or function node first.',
        });
        return;
      }

      vscode.postMessage({ type: 'requestTestGeneration', nodeId: targetNode.id });
      setContextMenu(null);
      setStatusMessage({
        level: 'info',
        message: `Generating tests for ${targetNode.data.label} with Copilot...`,
      });
    },
    [analysisTargetNode, rawNodes, selectedNode, vscode]
  );

  const requestTestDiff = useCallback(
    (nodeId?: string) => {
      const targetNode =
        rawNodes.find((node) => node.id === nodeId) ||
        selectedNode ||
        analysisTargetNode;
      if (!targetNode) {
        setStatusMessage({
          level: 'warning',
          message: 'Select a file, class, or method node first.',
        });
        return;
      }
      vscode.postMessage({ type: 'requestTestDiff', nodeId: targetNode.id } as any);
      setStatusMessage({
        level: 'info',
        message: `Analyzing test gaps for ${targetNode.data.label}…`,
      });
    },
    [analysisTargetNode, rawNodes, selectedNode, vscode]
  );

  const applySuggestion = useCallback(
    (suggestion: { line?: number; endLine?: number; original?: string; suggested?: string }) => {
      const targetPath =
        selectedNode?.data.filePath ||
        analysisTargetNode?.data.filePath;
      if (!targetPath || !suggestion.suggested) {
        setStatusMessage({ level: 'warning', message: 'No file context to apply suggestion.' });
        return;
      }
      vscode.postMessage({
        type: 'applySuggestion',
        filePath: targetPath,
        line: suggestion.line || 0,
        endLine: suggestion.endLine,
        original: suggestion.original || '',
        suggested: suggestion.suggested || '',
      } as any);
    },
    [analysisTargetNode, selectedNode, vscode]
  );

  const runTestsForSelected = useCallback(() => {
    const targetPath =
      selectedNode?.data.filePath ||
      analysisTargetNode?.data.filePath;
    if (!targetPath) {
      setStatusMessage({ level: 'warning', message: 'Select a file node to run its tests.' });
      return;
    }
    vscode.postMessage({ type: 'runTestsForFile', filePath: targetPath } as any);
  }, [analysisTargetNode, selectedNode, vscode]);

  const collapseAll = useCallback(() => {
    setRawNodes((current) =>
      current.map((node) =>
        node.data.expandable
          ? { ...node, data: { ...node.data, expanded: false } }
          : node
      )
    );
  }, []);

  const expandAll = useCallback(() => {
    setRawNodes((current) =>
      current.map((node) =>
        node.data.expandable
          ? { ...node, data: { ...node.data, expanded: true } }
          : node
      )
    );
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      appShellRef.current?.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const analyzeGitChanges = useCallback(() => {
    vscode.postMessage({ type: 'requestGitAnalysis' });
  }, [vscode]);

  const saveGitWebhookSettings = useCallback(() => {
    vscode.postMessage({ type: 'saveGitSettings', data: gitSettings });
  }, [gitSettings, vscode]);

  return (
    <div className="app-shell" ref={appShellRef}>
      <div className="topbar">
        <div className="tabbar">
          <button
            className={activeTab === 'visual' ? 'is-active' : ''}
            onClick={() => setActiveTab('visual')}
          >
            Visual
          </button>
          <button
            className={activeTab === 'settings' ? 'is-active' : ''}
            onClick={() => setActiveTab('settings')}
          >
            Settings &amp; AI
          </button>
        </div>
        <div className="topbar__stats">
          <span>{graph?.metadata.type || 'idle'} mode</span>
          <span>{graph?.metadata.totalFiles || 0} files</span>
          <span>{graph?.metadata.totalSymbols || 0} symbols</span>
          <span>{graphStats.dataFlowEdges} data flows</span>
          {overlayMode !== 'none' ? <span>{overlayMode} overlay</span> : null}
          {testSummary ? (
            <span>
              tests {testSummary.passed} pass / {testSummary.failed} fail
            </span>
          ) : null}
          {mappingTargetNode ? <span>mapping {mappingTargetNode.data.label}</span> : null}
          {!mappingFocusNodeId && selectedNodeId ? (
            <span>
              impact {dependencyImpact.upstreamNodes.size}/{dependencyImpact.downstreamNodes.size}
            </span>
          ) : null}
          {graph && graph.metadata.type !== 'selection' ? <span>live refresh</span> : null}
          <span>{edges.length} edges</span>
        </div>
      </div>

      {activeTab === 'visual' ? (
        <div className="workspace-panel">
          <div className="toolbar">
            <div className="toolbar__group">
              <span className="toolbar__title">CodeFlow</span>
              <select
                value={layout}
                onChange={(event) => {
                  setLayout(event.target.value as GraphLayoutAlgorithm);
                  fitViewTrigger.current += 1;
                }}
              >
                <option value="hierarchical">Hierarchical</option>
                <option value="force-directed">Force Directed</option>
                <option value="radial">Radial</option>
                <option value="tree">Tree</option>
              </select>
              <input
                type="search"
                placeholder="Search nodes"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
              <button onClick={fitView}>Fit View</button>
              <button onClick={collapseAll} title="Collapse all folders">Collapse</button>
              <button onClick={expandAll} title="Expand all folders">Expand</button>
              <button
                className={overlayMode === 'complexity' ? 'is-active' : ''}
                onClick={() =>
                  setOverlayMode((current) =>
                    current === 'complexity' ? 'none' : 'complexity'
                  )
                }
                title="Color nodes by estimated cyclomatic complexity"
              >
                Complexity
              </button>
              <button
                className={overlayMode === 'hotspot' ? 'is-active' : ''}
                onClick={() =>
                  setOverlayMode((current) =>
                    current === 'hotspot' ? 'none' : 'hotspot'
                  )
                }
                title="Color nodes by git change frequency"
              >
                Hotspots
              </button>
              <button
                className={visibility.folders ? 'is-active' : ''}
                onClick={() => toggleVisibility('folders')}
              >
                Folders
              </button>
              <button
                className={visibility.files ? 'is-active' : ''}
                onClick={() => toggleVisibility('files')}
              >
                Files
              </button>
              <button
                className={visibility.symbols ? 'is-active' : ''}
                onClick={() => toggleVisibility('symbols')}
              >
                Code
              </button>
              <button
                className={visibility.tests ? 'is-active' : ''}
                onClick={() => toggleVisibility('tests')}
              >
                Tests
              </button>
              <button
                className={visibility.modules ? 'is-active' : ''}
                onClick={() => toggleVisibility('modules')}
              >
                Dependencies
              </button>
              <button
                className={visibility.imports ? 'is-active' : ''}
                onClick={() => toggleVisibility('imports')}
              >
                Imports
              </button>
              <button
                className={visibility.calls ? 'is-active' : ''}
                onClick={() => toggleVisibility('calls')}
              >
                Calls
              </button>
              <button
                className={visibility.testFlow ? 'is-active' : ''}
                onClick={() => toggleVisibility('testFlow')}
              >
                Test Flow
              </button>
              <button
                className={visibility.dataFlow ? 'is-active' : ''}
                onClick={() => toggleVisibility('dataFlow')}
              >
                Data Flow
              </button>
              <button onClick={runTests}>Run Tests</button>
              <button onClick={() => vscode.postMessage({ type: 'requestRefresh' })} title="Re-analyze and refresh the graph">Refresh</button>
            </div>

            <div className="toolbar__stats">
              <button onClick={() => handleExport('json')}>JSON</button>
              <button onClick={() => handleExport('svg')}>SVG</button>
              <button onClick={() => handleExport('png')}>PNG</button>
              <button
                onClick={toggleFullscreen}
                title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
              >
                <span className="toolbar__btn-icon">{isFullscreen ? '⊡' : '⛶'}</span>
              </button>
            </div>
          </div>

          <div className="canvas-with-sidebar">
          <div className="canvas-stage" ref={canvasRef}>
            <div className="canvas-surface">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                nodeTypes={nodeTypes}
                onNodeClick={onNodeClick}
                onNodeContextMenu={onNodeContextMenu}
                onNodeDoubleClick={onNodeDoubleClick}
                onPaneClick={onPaneClick}
                onInit={onInit}
                fitView
                fitViewOptions={{ padding: 0.12 }}
                minZoom={0.04}
                maxZoom={2}
                connectionLineType={ConnectionLineType.SmoothStep}
                defaultEdgeOptions={{ type: 'smoothstep' }}
                proOptions={{ hideAttribution: true }}
              >
                <Background gap={22} size={1.2} variant={BackgroundVariant.Dots} />
                <MiniMap
                  nodeColor={(node) =>
                    nodeColor(
                      node.type as GraphNodeType,
                      overlayMode,
                      Number((node.data as GraphNodeData)?.complexityRank || 0),
                      Number((node.data as GraphNodeData)?.hotspotRank || 0)
                    )
                  }
                  zoomable
                  pannable
                />
                <Controls showInteractive={false} />
              </ReactFlow>
              {contextMenu && (
                <div
                  className="context-menu"
                  style={{ top: contextMenu.y, left: contextMenu.x }}
                  onMouseLeave={() => setContextMenu(null)}
                >
                  {(() => {
                    const menuNode = rawNodes.find((entry) => entry.id === contextMenu.nodeId) || null;
                    if (!menuNode) {
                      return null;
                    }

                    return (
                      <>
                        {['class', 'method', 'function', 'file'].includes(menuNode.type || '') ? (
                          <>
                            <button onClick={() => generateTests(contextMenu.nodeId)}>
                              Create Tests
                            </button>
                            <button onClick={() => { requestTestDiff(contextMenu.nodeId); setContextMenu(null); }}>
                              Test Diff
                            </button>
                          </>
                        ) : null}
                        {menuNode.data.filePath ? (
                          <button
                            onClick={() => {
                              setSelectedNodeId(menuNode.id);
                              setLastAiRequestNodeId(menuNode.id);
                              vscode.postMessage({ type: 'requestAiAnalysis', nodeId: menuNode.id });
                              setContextMenu(null);
                            }}
                          >
                            AI Analysis
                          </button>
                        ) : null}
                        {menuNode.data.filePath ? (
                          <button
                            onClick={() => {
                              vscode.postMessage({
                                type: 'goToLocation',
                                data: {
                                  filePath: menuNode.data.filePath,
                                  line: menuNode.data.startLine,
                                },
                              });
                              setContextMenu(null);
                            }}
                          >
                            View Code
                          </button>
                        ) : null}
                      </>
                    );
                  })()}
                </div>
              )}
            </div>

            {!graph && (
              <div className="empty-state">
                <div className="empty-state__card">
                  {isLoading ? (
                    <>
                      <div className="loading-spinner" />
                      <h2>Analyzing…</h2>
                      <p>{statusMessage?.message || 'Scanning files and building data flow graph…'}</p>
                    </>
                  ) : (
                    <>
                      <h2>CodeFlow Visualizer</h2>
                      <p>
                        Right-click a <strong>folder</strong> or <strong>file</strong> in the
                        Explorer, or use the Command Palette, to visualize code structure, data
                        flow, imports, and method calls.
                      </p>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          {selectedNode && (
            <div className="detail-sidebar">
              <h3>{selectedNode.data.label}</h3>
              <p>{selectedNode.data.kind || selectedNode.type}</p>
              <div className="detail-sidebar__meta">
                <div>
                  <span>File name</span>
                  <strong title={selectedNode.data.filePath || selectedNode.data.relativePath}>
                    {selectedNode.data.relativePath
                      ? selectedNode.data.relativePath.split('/').pop()
                      : selectedNode.data.filePath
                        ? selectedNode.data.filePath.split('/').pop()
                        : 'n/a'}
                  </strong>
                </div>
                <div>
                  <span>Full path</span>
                  <strong title={selectedNode.data.relativePath || selectedNode.data.filePath}>
                    {selectedNode.data.relativePath || selectedNode.data.filePath || 'n/a'}
                  </strong>
                </div>
                <div>
                  <span>Lines</span>
                  <strong>
                    {selectedNode.data.startLine && selectedNode.data.endLine
                      ? `${selectedNode.data.startLine}–${selectedNode.data.endLine}`
                      : selectedNode.data.lineCount || 'n/a'}
                  </strong>
                </div>
                <div>
                  <span>Language</span>
                  <strong>{selectedNode.data.language || 'n/a'}</strong>
                </div>
                <div>
                  <span>Children</span>
                  <strong>{selectedNode.data.childCount || 0}</strong>
                </div>
                <div>
                  <span>Mappings</span>
                  <strong>{selectedNode.data.dataMappings?.length || 0}</strong>
                </div>
                <div>
                  <span>Complexity</span>
                  <strong>{selectedNode.data.complexity || 0}</strong>
                </div>
                <div>
                  <span>Hotspot</span>
                  <strong>{selectedNode.data.hotspotScore || 0}</strong>
                </div>
              </div>
              <div className="detail-sidebar__actions">
                <button onClick={viewSelectedCode} disabled={!selectedNode.data.filePath}>
                  View Code
                </button>
                <button
                  onClick={requestAiAnalysis}
                  disabled={!aiStatus.available || !selectedNode.data.filePath}
                  title={
                    !aiStatus.available
                      ? aiStatus.message
                      : !selectedNode.data.filePath
                        ? 'Select a file or code node'
                        : 'Analyze with GitHub Copilot'
                  }
                >
                  AI Analysis
                </button>
                <button
                  onClick={() => generateTests(selectedNode.id)}
                  disabled={
                    !aiStatus.available ||
                    !selectedNode.data.filePath ||
                    !['class', 'method', 'function', 'file'].includes(selectedNode.type || '')
                  }
                  title={
                    !aiStatus.available
                      ? aiStatus.message
                      : !['class', 'method', 'function', 'file'].includes(selectedNode.type || '')
                        ? 'Select a file, class, method, or function node'
                        : 'Generate test file with GitHub Copilot'
                  }
                >
                  Create Tests
                </button>
                <button
                  onClick={() => requestTestDiff(selectedNode.id)}
                  disabled={
                    !aiStatus.available ||
                    !selectedNode.data.filePath ||
                    !['class', 'method', 'function', 'file'].includes(selectedNode.type || '')
                  }
                  title="Find missing test scenarios by comparing source with test file"
                >
                  Test Diff
                </button>
                <button
                  onClick={runTestsForSelected}
                  disabled={!selectedNode.data.filePath}
                  title="Run tests for this file using the correct language runner"
                >
                  Run Tests
                </button>
                <button
                  className={mappingFocusNodeId === mappingTargetNode?.id ? 'is-active' : ''}
                  onClick={toggleMappingHighlight}
                >
                  Mapping
                </button>
              </div>
              {selectedNode.data.packageRefs?.length ? (
                <div className="detail-sidebar__stack">
                  <span>Packages</span>
                  <strong>
                    {selectedNode.data.packageRefs
                      .slice(0, 8)
                      .map((ref) => ref.name)
                      .join(', ')}
                  </strong>
                </div>
              ) : null}
              {!mappingFocusNodeId &&
              (dependencyImpact.upstreamNodes.size > 0 || dependencyImpact.downstreamNodes.size > 0) ? (
                <div className="detail-sidebar__stack">
                  <span>Dependency Impact</span>
                  <strong>
                    {dependencyImpact.upstreamNodes.size} dependents upstream
                    {' · '}
                    {dependencyImpact.downstreamNodes.size} dependencies downstream
                  </strong>
                </div>
              ) : null}
              {selectedNode.data.dataMappings?.length ? (
                <div className="detail-sidebar__stack">
                  <span>Data Flow</span>
                  <strong>
                    {selectedNode.data.dataMappings
                      .slice(0, 6)
                      .map((m) => `${m.source} → ${m.target}`)
                      .join('\n')}
                  </strong>
                </div>
              ) : null}
              {selectedNode.data.classSummaries?.length ? (
                <div className="detail-sidebar__stack">
                  <span>Classes &amp; Methods</span>
                  <DetailClassSummaries summaries={selectedNode.data.classSummaries} />
                </div>
              ) : null}
              {testSummary?.affectedTargets?.length ? (
                <div className="detail-sidebar__stack">
                  <span>Executed Flow</span>
                  <strong>{testSummary.affectedTargets.slice(0, 8).join(', ')}</strong>
                </div>
              ) : null}
              {aiAnalysis ? (
                <div className="detail-sidebar__ai">
                  <div className="detail-sidebar__ai-title">AI Analysis · {aiAnalysis.targetLabel}</div>
                  <p>{aiAnalysis.analysis.summary}</p>
                  <div className="detail-sidebar__ai-scores">
                    <span>Quality: {aiAnalysis.analysis.codeQuality}/100</span>
                    <span>Issues: {aiAnalysis.analysis.issues.length}</span>
                    <span>Suggestions: {aiAnalysis.analysis.suggestions.length}</span>
                  </div>
                  {aiAnalysis.analysis.issues.slice(0, 3).map((issue, i) => (
                    <div key={`issue-${i}`} style={{ fontSize: 10, opacity: 0.85 }}>
                      ⚠ {issue.message}
                    </div>
                  ))}
                  {aiAnalysis.analysis.suggestions.slice(0, 5).map((sug, i) => (
                    <div key={`sug-${i}`} className="detail-sidebar__suggestion">
                      <div className="detail-sidebar__suggestion-header">
                        <span className={`suggestion-badge is-${sug.priority}`}>{sug.priority}</span>
                        {sug.line ? (
                          <span style={{ fontSize: 9, opacity: 0.6, marginLeft: 4 }}>
                            L{sug.line}{sug.endLine ? `–${sug.endLine}` : ''}
                          </span>
                        ) : null}
                        <strong>Suggestion {i + 1}: {sug.message}</strong>
                      </div>
                      {sug.description ? <p style={{ fontSize: 10, opacity: 0.7 }}>{sug.description}</p> : null}
                      {sug.original ? (
                        <pre className="detail-sidebar__code-diff is-original">{sug.original}</pre>
                      ) : null}
                      {(sug.suggested || sug.code) ? (
                        <pre className="detail-sidebar__code-diff is-suggested">{sug.suggested || sug.code}</pre>
                      ) : null}
                      {(sug.suggested || sug.code) ? (
                        <button
                          className="apply-btn"
                          onClick={() => applySuggestion(sug)}
                          title={`Apply this fix${sug.line ? ` at line ${sug.line}` : ''}`}
                        >
                          Apply to File{sug.line ? ` (L${sug.line})` : ''}
                        </button>
                      ) : null}
                    </div>
                  ))}
                  <button
                    className="detail-sidebar__close"
                    onClick={() => setAiAnalysis(null)}
                    style={{ marginTop: 6 }}
                  >
                    Close Analysis
                  </button>
                </div>
              ) : null}
              {testDiff && (
                <div className="detail-sidebar__ai">
                  <div className="detail-sidebar__ai-title">
                    Test Diff · {testDiff.targetLabel}
                    <button
                      className="banner-close"
                      onClick={() => setTestDiff(null)}
                      style={{ marginLeft: 'auto' }}
                      title="Close"
                    >
                      x
                    </button>
                  </div>
                  <p style={{ fontSize: 11, opacity: 0.7 }}>
                    Missing test scenarios found. Copy and add to your test file
                    {testDiff.testFilePath ? ` (${testDiff.testFilePath.split('/').pop()})` : ''}.
                  </p>
                  <pre className="detail-sidebar__code-diff is-suggested" style={{ maxHeight: 300, overflow: 'auto' }}>
                    {testDiff.missingScenarios}
                  </pre>
                  {testDiff.testFilePath ? (
                    <button
                      onClick={() => {
                        vscode.postMessage({
                          type: 'goToLocation',
                          data: { filePath: testDiff.testFilePath! },
                        });
                      }}
                    >
                      Open Test File
                    </button>
                  ) : null}
                </div>
              )}
              {codePreview?.nodeId === selectedNode.id ? (
                <div className="code-preview-grid">
                  <CodeSection
                    title={`File · ${codePreview.relativePath?.split('/').pop() || codePreview.fileName}`}
                    code={codePreview.fileCode}
                  />
                  <CodeSection
                    title={codePreview.className ? `Class · ${codePreview.className}` : ''}
                    code={codePreview.classCode}
                  />
                  <CodeSection
                    title={codePreview.methodName ? `Method · ${codePreview.methodName}` : ''}
                    code={codePreview.methodCode}
                  />
                </div>
              ) : null}
              {selectedNode.data.docComment ? (
                <div className="detail-sidebar__stack">
                  <span>Doc</span>
                  <strong style={{ fontStyle: 'italic', fontWeight: 400 }}>{selectedNode.data.docComment}</strong>
                </div>
              ) : null}
              <button
                className="detail-sidebar__close"
                onClick={() => {
                  setSelectedNodeId(null);
                  setCodePreview(null);
                  setContextMenu(null);
                }}
              >
                Close
              </button>
            </div>
          )}
          </div>
        </div>
      ) : (
        <div className="settings-shell">
          <section className="settings-card">
            <h3>Visualization</h3>
            <p>
              Folder mode now renders nested folders, files, classes, methods, and tests. Click a
              folder, file, or class node to collapse or expand it, and click a method node to load
              file, class, and method code previews in the panel.
            </p>
            <div className="settings-grid">
              <label className="settings-field">
                <span>Layout</span>
                <select
                  value={layout}
                  onChange={(event) => setLayout(event.target.value as GraphLayoutAlgorithm)}
                >
                  <option value="hierarchical">Hierarchical</option>
                  <option value="force-directed">Force Directed</option>
                  <option value="radial">Radial</option>
                  <option value="tree">Tree</option>
                </select>
              </label>
              <label className="settings-field">
                <span>Search</span>
                <input
                  type="search"
                  placeholder="Filter graph"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
              </label>
            </div>
            <div className="toggle-grid">
              {(
                [
                  ['folders', 'Folders'],
                  ['files', 'Files'],
                  ['symbols', 'Code'],
                  ['tests', 'Tests'],
                  ['modules', 'Dependencies'],
                  ['imports', 'Imports'],
                  ['calls', 'Calls'],
                  ['testFlow', 'Test Flow'],
                  ['dataFlow', 'Data Flow'],
                ] as Array<[keyof typeof defaultVisibility, string]>
              ).map(([key, label]) => (
                <button
                  key={key}
                  className={`toggle-chip ${visibility[key] ? 'is-active' : ''}`}
                  onClick={() => toggleVisibility(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="stats-grid">
              <div>
                <span>Folders</span>
                <strong>{graphStats.folderNodes}</strong>
              </div>
              <div>
                <span>Files</span>
                <strong>{graphStats.fileNodes}</strong>
              </div>
              <div>
                <span>Test Nodes</span>
                <strong>{graphStats.testNodes}</strong>
              </div>
              <div>
                <span>Test Flow Edges</span>
                <strong>{graphStats.testEdges}</strong>
              </div>
              <div>
                <span>Data Flow Edges</span>
                <strong>{graphStats.dataFlowEdges}</strong>
              </div>
              <div>
                <span>Package Nodes</span>
                <strong>{graphStats.packageNodes}</strong>
              </div>
            </div>
          </section>

          <section className="settings-card">
            <h3>Tests &amp; Data Flow</h3>
            <p>
              Test nodes are linked to likely target methods and functions. Running tests from here
              updates pass/fail state, keeps the visual tab focused on test flow, and highlights the
              static execution path CodeFlow can infer from tests into classes and methods.
            </p>
            <div className="settings-actions">
              <button onClick={runTests}>Run Tests</button>
              <button
                className={visibility.testFlow ? 'is-active' : ''}
                onClick={() => {
                  setVisibility((current) => ({
                    ...current,
                    tests: true,
                    testFlow: true,
                    dataFlow: true,
                  }));
                  setActiveTab('visual');
                }}
              >
                Show Test Flow
              </button>
            </div>
            <div className="stats-grid">
              <div>
                <span>Import Edges</span>
                <strong>{graphStats.importEdges}</strong>
              </div>
              <div>
                <span>Data Flow</span>
                <strong>{graphStats.dataFlowEdges}</strong>
              </div>
              <div>
                <span>Total Edges</span>
                <strong>{rawEdges.length}</strong>
              </div>
            </div>
            {testSummary && (
              <div className="analysis-card">
                <h4>Latest Test Run</h4>
                <p>{testSummary.message || 'Test run collected.'}</p>
                <div className="stats-grid">
                  <div>
                    <span>Passed</span>
                    <strong>{testSummary.passed}</strong>
                  </div>
                  <div>
                    <span>Failed</span>
                    <strong>{testSummary.failed}</strong>
                  </div>
                  <div>
                    <span>Skipped</span>
                    <strong>{testSummary.skipped}</strong>
                  </div>
                  <div>
                    <span>Command</span>
                    <strong>{testSummary.command || 'n/a'}</strong>
                  </div>
                </div>
                {testSummary.affectedTargets?.length ? (
                  <div className="selection-card">
                    <span>Execution Path</span>
                    <strong>{testSummary.affectedTargets.slice(0, 10).join(', ')}</strong>
                  </div>
                ) : null}
              </div>
            )}
          </section>

          <section className="settings-card">
            <h3>AI with GitHub Copilot</h3>
            <p>{aiStatus.message}</p>
            <div className="status-pill-row">
              <span className={`status-pill ${aiStatus.available ? 'is-success' : 'is-warning'}`}>
                {aiStatus.provider}
              </span>
              <span className={`status-pill ${aiStatus.available ? 'is-success' : 'is-warning'}`}>
                {aiStatus.available ? 'Available' : 'Unavailable'}
              </span>
              <span className="status-pill is-info">
                Model: {aiStatus.model || 'auto'}
              </span>
            </div>
            <div className="settings-grid">
              <label className="settings-field">
                <span>AI Model</span>
                <select
                  value={aiStatus.model || 'auto'}
                  onChange={(event) => {
                    vscode.postMessage({ type: 'selectModel', modelId: event.target.value } as any);
                  }}
                >
                  <option value="auto">auto (best available)</option>
                  {aiModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id} ({m.family})
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {aiModels.length === 0 && aiStatus.available && (
              <p style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
                Loading models… If none appear, use Command Palette → "CodeFlow: List Available Copilot Models".
              </p>
            )}
            <div className="settings-actions">
              <button onClick={requestAiAnalysis} disabled={!aiStatus.available}>
                Analyze Selected Node
              </button>
              <button onClick={() => vscode.postMessage({ type: 'requestModels' })}>
                Reload Models
              </button>
              <button onClick={() => setActiveTab('visual')}>Back To Visual</button>
            </div>
            {analysisTargetNode && (
              <div className="selection-card">
                <span>Current Target</span>
                <strong>{analysisTargetNode.data.label}</strong>
                <p>
                  {analysisTargetNode.data.kind || analysisTargetNode.type}
                  {analysisTargetNode.data.relativePath
                    ? ` · ${analysisTargetNode.data.relativePath}`
                    : ''}
                </p>
              </div>
            )}
            {aiAnalysis && (
              <div className="analysis-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h4>{aiAnalysis.targetLabel}</h4>
                  <button className="banner-close" onClick={() => setAiAnalysis(null)} title="Close">x</button>
                </div>
                <p>{aiAnalysis.analysis.summary}</p>
                <div className="stats-grid">
                  <div>
                    <span>Quality</span>
                    <strong>{aiAnalysis.analysis.codeQuality}/100</strong>
                  </div>
                  <div>
                    <span>Issues</span>
                    <strong>{aiAnalysis.analysis.issues.length}</strong>
                  </div>
                  <div>
                    <span>Suggestions</span>
                    <strong>{aiAnalysis.analysis.suggestions.length}</strong>
                  </div>
                  <div>
                    <span>Coverage</span>
                    <strong>{aiAnalysis.analysis.testCoverage}</strong>
                  </div>
                </div>
                {aiAnalysis.analysis.issues.length > 0 && (
                  <div className="analysis-list">
                    <h4>Issues</h4>
                    {aiAnalysis.analysis.issues.slice(0, 5).map((issue, index) => (
                      <div key={`${issue.message}-${index}`} className="analysis-item">
                        <strong>{issue.severity}{issue.line ? ` (L${issue.line})` : ''}</strong>
                        <span>{issue.message}</span>
                      </div>
                    ))}
                  </div>
                )}
                {aiAnalysis.analysis.suggestions.length > 0 && (
                  <div className="analysis-list">
                    <h4>Suggestions</h4>
                    {aiAnalysis.analysis.suggestions.map((suggestion, index) => (
                      <div key={`${suggestion.message}-${index}`} className="suggestion-card">
                        <div className="suggestion-card__header">
                          <span className={`suggestion-card__priority is-${suggestion.priority}`}>
                            {suggestion.priority}
                          </span>
                          <span className={`suggestion-card__type`}>{suggestion.type}</span>
                          {suggestion.line ? (
                            <span style={{ fontSize: 10, opacity: 0.5 }}>
                              L{suggestion.line}{suggestion.endLine ? `–${suggestion.endLine}` : ''}
                            </span>
                          ) : null}
                          <strong className="suggestion-card__title">Suggestion {index + 1}: {suggestion.message}</strong>
                        </div>
                        {suggestion.description ? (
                          <p className="suggestion-card__desc">{suggestion.description}</p>
                        ) : null}
                        {suggestion.original ? (
                          <div className="suggestion-card__code-block">
                            <div className="suggestion-card__code-label is-original">Original{suggestion.line ? ` (Line ${suggestion.line})` : ''}:</div>
                            <pre className="suggestion-card__code is-original">{suggestion.original}</pre>
                          </div>
                        ) : null}
                        {(suggestion.suggested || suggestion.code) ? (
                          <div className="suggestion-card__code-block">
                            <div className="suggestion-card__code-label is-suggested">Suggested:</div>
                            <pre className="suggestion-card__code is-suggested">{suggestion.suggested || suggestion.code}</pre>
                          </div>
                        ) : null}
                        {(suggestion.suggested || suggestion.code) ? (
                          <button
                            className="apply-btn"
                            onClick={() => applySuggestion(suggestion)}
                            title={`Replace code in file${suggestion.line ? ` at line ${suggestion.line}` : ''}`}
                          >
                            Apply to File{suggestion.line ? ` (L${suggestion.line})` : ''}
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="settings-card">
            <h3>Git Integration</h3>
            <p>
              Review recent commits, run AI analysis on the current diff, and store GitHub or GitLab
              webhook relay settings for merge-request or pull-request workflows.
            </p>
            <div className="settings-grid">
              <label className="settings-field">
                <span>Provider</span>
                <select
                  value={gitSettings.provider}
                  onChange={(event) =>
                    setGitSettings((current) => ({
                      ...current,
                      provider: event.target.value as GitWebhookSettings['provider'],
                    }))
                  }
                >
                  <option value="github">GitHub</option>
                  <option value="gitlab">GitLab</option>
                </select>
              </label>
              <label className="settings-field">
                <span>Webhook URL</span>
                <input
                  type="text"
                  placeholder="https://your-relay.example.com/webhook"
                  value={gitSettings.webhookUrl}
                  onChange={(event) =>
                    setGitSettings((current) => ({
                      ...current,
                      webhookUrl: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="settings-field">
                <span>Webhook Secret</span>
                <input
                  type="password"
                  placeholder="shared secret"
                  value={gitSettings.webhookSecret}
                  onChange={(event) =>
                    setGitSettings((current) => ({
                      ...current,
                      webhookSecret: event.target.value,
                    }))
                  }
                />
              </label>
            </div>
            <div className="settings-actions">
              <button onClick={saveGitWebhookSettings}>Save Webhook Settings</button>
              <button onClick={analyzeGitChanges} disabled={!aiStatus.available}>
                Analyze Current Diff
              </button>
            </div>
            {gitReview ? (
              <div className="analysis-card">
                <h4>Current Diff Review</h4>
                <p>{gitReview.analysis.summary}</p>
                <div className="stats-grid">
                  <div>
                    <span>Compatibility</span>
                    <strong>{gitReview.compatibilityScore}/100</strong>
                  </div>
                  <div>
                    <span>Quality</span>
                    <strong>{gitReview.analysis.codeQuality}/100</strong>
                  </div>
                  <div>
                    <span>Files</span>
                    <strong>{gitReview.changes.length}</strong>
                  </div>
                  <div>
                    <span>Breaking</span>
                    <strong>{gitReview.breakingChanges.length}</strong>
                  </div>
                </div>
              </div>
            ) : null}
            <div className="commit-list">
              {gitCommits.length > 0 ? (
                gitCommits.map((commit) => (
                  <div key={commit.hash} className="commit-item">
                    <strong>{commit.shortHash}</strong>
                    <span>{commit.subject}</span>
                    <em>
                      {commit.author} · {commit.date}
                    </em>
                  </div>
                ))
              ) : (
                <p>No git commits found for this workspace.</p>
              )}
            </div>
          </section>
        </div>
      )}

      {statusMessage && (
        <div className={`status-banner is-${statusMessage.level}`}>
          {statusMessage.message}
          <button className="banner-close" onClick={() => setStatusMessage(null)} title="Dismiss">x</button>
        </div>
      )}

      {error && (
        <div className="error-banner">
          {error}
          <button className="banner-close" onClick={() => setError(null)} title="Dismiss">x</button>
        </div>
      )}
    </div>
  );
}

function CodeSection({ title, code }: { title: string; code?: string }) {
  if (!code) {
    return null;
  }

  return (
    <div className="code-section">
      <div className="code-section__title">{title}</div>
      <pre>{code}</pre>
    </div>
  );
}

function DetailClassSummaries({ summaries }: { summaries: GraphClassSummary[] }) {
  return (
    <div className="detail-sidebar__class-list">
      {summaries.slice(0, 4).map((summary) => (
        <div key={`${summary.kind}-${summary.name}`} className="detail-sidebar__class-card">
          <div className="detail-sidebar__class-title">
            <em>{summary.name}</em>
            <span>{summary.kind}</span>
          </div>
          {(summary.methodDetails?.length
            ? summary.methodDetails
            : summary.methods.map((name) => ({ name, flowsTo: [], flowsFrom: [] }))).map((method) => (
            <div key={`${summary.name}-${method.name}`} className="detail-sidebar__method-line">
              <div className="detail-sidebar__method-name">{method.name}()</div>
              {method.flowsTo?.length ? (
                <div className="detail-sidebar__method-flows">
                  {method.flowsTo.slice(0, 4).map((flow) => (
                    <div key={`${summary.name}-${method.name}-to-${flow}`} className="detail-sidebar__method-flow">
                      → {flow}
                    </div>
                  ))}
                </div>
              ) : null}
              {method.flowsFrom?.length ? (
                <div className="detail-sidebar__method-flows">
                  {method.flowsFrom.slice(0, 3).map((flow) => (
                    <div key={`${summary.name}-${method.name}-from-${flow}`} className="detail-sidebar__method-flow is-inbound">
                      ← {flow}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

interface DependencyImpact {
  focusNodeId: string | null;
  upstreamNodes: Set<string>;
  downstreamNodes: Set<string>;
  upstreamEdges: Set<string>;
  downstreamEdges: Set<string>;
}

function emptyDependencyImpact(): DependencyImpact {
  return {
    focusNodeId: null,
    upstreamNodes: new Set<string>(),
    downstreamNodes: new Set<string>(),
    upstreamEdges: new Set<string>(),
    downstreamEdges: new Set<string>(),
  };
}

function collectDependencyImpact(
  selectedNodeId: string | null,
  rawEdges: GraphEdge[]
): DependencyImpact {
  if (!selectedNodeId) {
    return emptyDependencyImpact();
  }

  const dependencyEdgeTypes = new Set([
    'import',
    'call',
    'inheritance',
    'implementation',
    'reference',
    'dataFlow',
    'sqlMapping',
    'inject',
  ]);
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();

  rawEdges.forEach((edge) => {
    if (!dependencyEdgeTypes.has(edge.type)) {
      return;
    }

    const outgoingEdges = outgoing.get(edge.source) || [];
    outgoingEdges.push(edge);
    outgoing.set(edge.source, outgoingEdges);

    const incomingEdges = incoming.get(edge.target) || [];
    incomingEdges.push(edge);
    incoming.set(edge.target, incomingEdges);
  });

  const impact: DependencyImpact = {
    focusNodeId: selectedNodeId,
    upstreamNodes: new Set<string>(),
    downstreamNodes: new Set<string>(),
    upstreamEdges: new Set<string>(),
    downstreamEdges: new Set<string>(),
  };

  const downstreamQueue = [selectedNodeId];
  const downstreamVisited = new Set<string>([selectedNodeId]);
  while (downstreamQueue.length > 0) {
    const current = downstreamQueue.shift()!;
    for (const edge of outgoing.get(current) || []) {
      impact.downstreamEdges.add(edge.id);
      if (!downstreamVisited.has(edge.target)) {
        downstreamVisited.add(edge.target);
        impact.downstreamNodes.add(edge.target);
        downstreamQueue.push(edge.target);
      }
    }
  }

  const upstreamQueue = [selectedNodeId];
  const upstreamVisited = new Set<string>([selectedNodeId]);
  while (upstreamQueue.length > 0) {
    const current = upstreamQueue.shift()!;
    for (const edge of incoming.get(current) || []) {
      impact.upstreamEdges.add(edge.id);
      if (!upstreamVisited.has(edge.source)) {
        upstreamVisited.add(edge.source);
        impact.upstreamNodes.add(edge.source);
        upstreamQueue.push(edge.source);
      }
    }
  }

  return impact;
}

function buildRenderableGraph(
  rawNodes: GraphNode[],
  rawEdges: GraphEdge[],
  visibility: typeof defaultVisibility,
  searchQuery: string,
  layout: GraphLayoutAlgorithm,
  mappingFocusNodeId: string | null,
  affectedNodeIds: string[],
  dependencyImpact: DependencyImpact,
  overlayMode: HeatOverlayMode
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodeMap = new Map(rawNodes.map((node) => [node.id, node]));
  const loweredQuery = searchQuery.trim().toLowerCase();
  const matchedIds = new Set(
    rawNodes
      .filter((node) => {
        if (!loweredQuery) {
          return true;
        }

        return (node.data.searchText || node.data.label).toLowerCase().includes(loweredQuery);
      })
      .map((node) => node.id)
  );
  const affectedSet = new Set(affectedNodeIds);
  const mappingSet = collectMappingFocusIds(mappingFocusNodeId, rawEdges);
  const hasImpact = dependencyImpact.focusNodeId !== null;

  const visibleNodes = rawNodes.filter((node) => {
    if (!matchesNodeVisibility(node.type, visibility)) {
      return false;
    }

    if (isHiddenByCollapsedAncestor(node, nodeMap)) {
      return false;
    }

    return true;
  });

  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const flowNodes = visibleNodes.map<FlowNode>((node) => ({
    id: node.id,
    type: node.type,
    position: node.position,
    data: {
      ...node.data,
      overlayMode,
      heatRank:
        overlayMode === 'complexity'
          ? Number(node.data.complexityRank || 0)
          : overlayMode === 'hotspot'
            ? Number(node.data.hotspotRank || 0)
            : 0,
      impactRole:
        mappingSet.size > 0 ? undefined : resolveNodeImpactRole(node.id, dependencyImpact),
    },
    draggable: true,
    selectable: true,
    style: {
      ...node.style,
      opacity: resolveNodeOpacity(
        node.id,
        matchedIds,
        loweredQuery,
        mappingSet,
        affectedSet,
        dependencyImpact
      ),
    },
  }));

  const flowEdges = rawEdges
    .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    .filter((edge) => matchesEdgeVisibility(edge.type, visibility))
    .map<FlowEdge>((edge) => {
      const highlight =
        edgeIsHighlighted(edge, loweredQuery, matchedIds, mappingSet, affectedSet, dependencyImpact);
      const impactRole = mappingSet.size > 0 ? undefined : resolveEdgeImpactRole(edge, dependencyImpact);
      const color = edgeColor(edge.type, impactRole);

      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label,
        animated: edge.animated,
        type: 'smoothstep',
        style: {
          stroke: color,
          strokeWidth:
            impactRole
              ? 3.6
              : edge.type === 'contains'
              ? 1.4
              : edge.type === 'dataFlow' || edge.type === 'call'
                ? 2.6
                : mappingSet.has(edge.source) || mappingSet.has(edge.target)
                  ? 3.6
                  : affectedSet.has(edge.source) || affectedSet.has(edge.target)
                    ? 3.2
                    : 2.2,
          opacity: highlight
            ? 1
            : loweredQuery || mappingSet.size > 0 || affectedSet.size > 0 || hasImpact
              ? 0.14
              : edge.type === 'contains'
                ? 0.36
                : 0.72,
          strokeDasharray:
            edge.type === 'reference' || edge.type === 'testFlow' || edge.type === 'dataFlow'
              ? '6 4'
              : edge.type === 'implementation'
                ? '8 5'
                : undefined,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color,
        },
      };
    });

  return {
    nodes: applyLayout(flowNodes, flowEdges, layout),
    edges: flowEdges,
  };
}

function matchesNodeVisibility(
  type: GraphNodeType,
  visibility: typeof defaultVisibility
): boolean {
  if (type === 'folder') {
    return visibility.folders;
  }

  if (type === 'file') {
    return visibility.files;
  }

  if (type === 'module' || type === 'external') {
    return visibility.modules;
  }

  if (type === 'test') {
    return visibility.tests;
  }

  return visibility.symbols;
}

function matchesEdgeVisibility(
  type: GraphEdge['type'],
  visibility: typeof defaultVisibility
): boolean {
  if (type === 'import') {
    return visibility.imports;
  }

  if (type === 'call') {
    return visibility.calls;
  }

  if (type === 'testFlow') {
    return visibility.testFlow;
  }

  if (type === 'dataFlow' || type === 'sqlMapping' || type === 'inject') {
    return visibility.dataFlow;
  }

  return true;
}

function isHiddenByCollapsedAncestor(
  node: GraphNode,
  nodeMap: Map<string, GraphNode>
): boolean {
  let parentId = node.data.parentId;
  while (parentId) {
    const parent = nodeMap.get(parentId);
    if (!parent) {
      return false;
    }

    if (parent.data.expandable && parent.data.expanded === false) {
      return true;
    }

    parentId = parent.data.parentId;
  }

  return false;
}

function edgeColor(
  type: GraphEdge['type'],
  impactRole?: 'upstream' | 'downstream'
): string {
  if (impactRole === 'upstream') {
    return '#f06a5f';
  }

  if (impactRole === 'downstream') {
    return '#4dd7d1';
  }

  switch (type) {
    case 'contains':
      return '#f7ba3d';
    case 'import':
      return '#4dd7d1';
    case 'inheritance':
      return '#5ca4ff';
    case 'implementation':
      return '#86a3c3';
    case 'call':
      return '#f06a5f';
    case 'testFlow':
      return '#b6f05f';
    case 'dataFlow':
      return '#f6d365';
    case 'sqlMapping':
      return '#39d2c0';
    case 'inject':
      return '#f778ba';
    default:
      return '#b8d2ea';
  }
}

function nodeColor(
  type: GraphNodeType,
  overlayMode: HeatOverlayMode = 'none',
  complexityRank = 0,
  hotspotRank = 0
): string {
  if (overlayMode !== 'none') {
    return heatColorForRank(overlayMode === 'complexity' ? complexityRank : hotspotRank);
  }

  switch (type) {
    case 'folder':
      return '#f7ba3d';
    case 'file':
      return '#5ca4ff';
    case 'module':
    case 'external':
      return '#86a3c3';
    case 'class':
      return '#5ca4ff';
    case 'interface':
    case 'type':
      return '#4dd7d1';
    case 'function':
    case 'method':
      return '#f06a5f';
    case 'test':
      return '#b6f05f';
    default:
      return '#b8d2ea';
  }
}

function heatColorForRank(rank: number): string {
  const clamped = Math.max(0, Math.min(1, rank));
  if (clamped <= 0.5) {
    const progress = clamped / 0.5;
    return mixHex('#58d68d', '#f6d365', progress);
  }

  const progress = (clamped - 0.5) / 0.5;
  return mixHex('#f6d365', '#f06a5f', progress);
}

function mixHex(start: string, end: string, amount: number): string {
  const clamp = Math.max(0, Math.min(1, amount));
  const startRgb = hexToRgb(start);
  const endRgb = hexToRgb(end);
  const mixed = startRgb.map((value, index) =>
    Math.round(value + (endRgb[index] - value) * clamp)
  );
  return `rgb(${mixed[0]}, ${mixed[1]}, ${mixed[2]})`;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '');
  return [
    parseInt(normalized.slice(0, 2), 16),
    parseInt(normalized.slice(2, 4), 16),
    parseInt(normalized.slice(4, 6), 16),
  ];
}

function collectMappingFocusIds(
  mappingFocusNodeId: string | null,
  rawEdges: GraphEdge[]
): Set<string> {
  const focusIds = new Set<string>();
  if (!mappingFocusNodeId) {
    return focusIds;
  }

  // Collect all connected nodes through ANY edge type (not just dataFlow)
  // This enables "click node → see ALL mappings across classes"
  const mappingEdgeTypes = new Set([
    'dataFlow', 'call', 'inheritance', 'implementation',
    'sqlMapping', 'inject', 'testFlow', 'reference',
  ]);

  focusIds.add(mappingFocusNodeId);
  const queue = [mappingFocusNodeId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of rawEdges) {
      if (!mappingEdgeTypes.has(edge.type)) {
        continue;
      }

      if (edge.source === current && !focusIds.has(edge.target)) {
        focusIds.add(edge.target);
        queue.push(edge.target);
      }

      if (edge.target === current && !focusIds.has(edge.source)) {
        focusIds.add(edge.source);
        queue.push(edge.source);
      }
    }
  }

  return focusIds;
}

function resolveNodeOpacity(
  nodeId: string,
  matchedIds: Set<string>,
  loweredQuery: string,
  mappingSet: Set<string>,
  affectedSet: Set<string>,
  dependencyImpact: DependencyImpact
): number {
  let opacity = 1;

  if (loweredQuery) {
    opacity = matchedIds.has(nodeId) ? 1 : 0.25;
  }

  if (mappingSet.size > 0) {
    opacity = mappingSet.has(nodeId) ? 1 : Math.min(opacity, 0.22);
  }

  if (affectedSet.size > 0 && opacity > 0.22) {
    opacity = affectedSet.has(nodeId) ? 1 : Math.min(opacity, 0.32);
  }

  if (dependencyImpact.focusNodeId) {
    const inImpact =
      nodeId === dependencyImpact.focusNodeId ||
      dependencyImpact.upstreamNodes.has(nodeId) ||
      dependencyImpact.downstreamNodes.has(nodeId);
    opacity = inImpact ? 1 : Math.min(opacity, 0.2);
  }

  return opacity;
}

function edgeIsHighlighted(
  edge: GraphEdge,
  loweredQuery: string,
  matchedIds: Set<string>,
  mappingSet: Set<string>,
  affectedSet: Set<string>,
  dependencyImpact: DependencyImpact
): boolean {
  if (mappingSet.size > 0) {
    return mappingSet.has(edge.source) && mappingSet.has(edge.target);
  }

  if (dependencyImpact.focusNodeId) {
    return (
      dependencyImpact.upstreamEdges.has(edge.id) ||
      dependencyImpact.downstreamEdges.has(edge.id)
    );
  }

  if (affectedSet.size > 0) {
    return affectedSet.has(edge.source) || affectedSet.has(edge.target);
  }

  return !loweredQuery || matchedIds.has(edge.source) || matchedIds.has(edge.target);
}

function resolveNodeImpactRole(
  nodeId: string,
  dependencyImpact: DependencyImpact
): 'selected' | 'upstream' | 'downstream' | 'both' | undefined {
  if (!dependencyImpact.focusNodeId) {
    return undefined;
  }

  if (nodeId === dependencyImpact.focusNodeId) {
    return 'selected';
  }

  const isUpstream = dependencyImpact.upstreamNodes.has(nodeId);
  const isDownstream = dependencyImpact.downstreamNodes.has(nodeId);

  if (isUpstream && isDownstream) {
    return 'both';
  }

  if (isUpstream) {
    return 'upstream';
  }

  if (isDownstream) {
    return 'downstream';
  }

  return undefined;
}

function resolveEdgeImpactRole(
  edge: GraphEdge,
  dependencyImpact: DependencyImpact
): 'upstream' | 'downstream' | undefined {
  if (!dependencyImpact.focusNodeId) {
    return undefined;
  }

  if (dependencyImpact.upstreamEdges.has(edge.id)) {
    return 'upstream';
  }

  if (dependencyImpact.downstreamEdges.has(edge.id)) {
    return 'downstream';
  }

  return undefined;
}

function resolveMappingNode(selectedNode: GraphNode, rawNodes: GraphNode[]): GraphNode | null {
  if (selectedNode.data.dataMappings?.length) {
    return selectedNode;
  }

  const byFilePath = rawNodes.find(
    (node) => node.type === 'file' && node.data.filePath && node.data.filePath === selectedNode.data.filePath
  );

  return byFilePath || null;
}

function exportFileName(
  format: 'png' | 'svg' | 'json',
  graphType?: GraphData['metadata']['type']
): string {
  const suffix = graphType || 'graph';
  return `codeflow-${suffix}.${format}`;
}
