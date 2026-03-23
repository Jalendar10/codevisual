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
  const state = vscode.getState<{ layout?: GraphLayoutAlgorithm; activeTab?: ActiveTab }>();
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [graph, setGraph] = useState<GraphData | null>(null);
  const [rawNodes, setRawNodes] = useState<GraphNode[]>([]);
  const [rawEdges, setRawEdges] = useState<GraphEdge[]>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const [layout, setLayout] = useState<GraphLayoutAlgorithm>(
    state?.layout || 'hierarchical'
  );
  const [activeTab, setActiveTab] = useState<ActiveTab>(state?.activeTab || 'visual');
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
  const [aiStatus, setAiStatus] = useState({
    available: false,
    provider: 'GitHub Copilot',
    message: 'Checking Copilot availability…',
  });
  const [aiAnalysis, setAiAnalysis] = useState<{
    targetLabel: string;
    analysis: AIAnalysisResult;
  } | null>(null);
  const [instance, setInstance] = useState<ReactFlowInstance<FlowNode, FlowEdge> | null>(null);

  useEffect(() => {
    vscode.setState({ layout, activeTab });
  }, [activeTab, layout, vscode]);

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
          setGraph(message.data);
          setRawNodes(message.data.nodes);
          setRawEdges(message.data.edges);
          setSelectedNodeId(null);
          setAiAnalysis(null);
          setCodePreview(null);
          setContextMenu(null);
          setMappingFocusNodeId(null);
          setAffectedNodeIds([]);
          setTestSummary(null);
          setError(null);
          setIsLoading(false);
          setStatusMessage(null);
          // Request fitView for the new graph
          fitViewTrigger.current += 1;
          break;
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
          });
          break;
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
    }
  }, [activeTab, vscode]);

  useEffect(() => {
    const rendered = buildRenderableGraph(
      rawNodes,
      rawEdges,
      visibility,
      searchQuery,
      layout,
      mappingFocusNodeId,
      affectedNodeIds
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
    const dataFlowEdges = rawEdges.filter((edge) => edge.type === 'dataFlow').length;
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
          {testSummary ? (
            <span>
              tests {testSummary.passed} pass / {testSummary.failed} fail
            </span>
          ) : null}
          {mappingTargetNode ? <span>mapping {mappingTargetNode.data.label}</span> : null}
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
                  nodeColor={(node) => nodeColor(node.type as GraphNodeType)}
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
                          <button onClick={() => generateTests(contextMenu.nodeId)}>
                            Create Tests
                          </button>
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
                  <strong>
                    {selectedNode.data.classSummaries.slice(0, 3).map((cls) => (
                      <div key={cls.name} style={{ marginBottom: 4 }}>
                        <em style={{ color: 'var(--accent-cyan)' }}>{cls.name}</em>
                        {cls.methods.slice(0, 5).map((m) => (
                          <div key={m} style={{ paddingLeft: 8, fontSize: 10, opacity: 0.8 }}>• {m}</div>
                        ))}
                      </div>
                    ))}
                  </strong>
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
                    <span>Coverage: {aiAnalysis.analysis.testCoverage}</span>
                  </div>
                  {aiAnalysis.analysis.issues.slice(0, 3).map((issue, i) => (
                    <div key={i} style={{ fontSize: 10, opacity: 0.85 }}>
                      ⚠ {issue.message}
                    </div>
                  ))}
                </div>
              ) : null}
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
            </div>
            <div className="settings-actions">
              <button onClick={requestAiAnalysis} disabled={!aiStatus.available}>
                Analyze Selected Node
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
                <h4>{aiAnalysis.targetLabel}</h4>
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
                        <strong>{issue.severity}</strong>
                        <span>{issue.message}</span>
                      </div>
                    ))}
                  </div>
                )}
                {aiAnalysis.analysis.suggestions.length > 0 && (
                  <div className="analysis-list">
                    <h4>Suggestions</h4>
                    {aiAnalysis.analysis.suggestions.slice(0, 5).map((suggestion, index) => (
                      <div key={`${suggestion.message}-${index}`} className="analysis-item">
                        <strong>{suggestion.priority}</strong>
                        <span>{suggestion.message}</span>
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
        <div className={`status-banner is-${statusMessage.level}`}>{statusMessage.message}</div>
      )}

      {error && <div className="error-banner">{error}</div>}
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

function buildRenderableGraph(
  rawNodes: GraphNode[],
  rawEdges: GraphEdge[],
  visibility: typeof defaultVisibility,
  searchQuery: string,
  layout: GraphLayoutAlgorithm,
  mappingFocusNodeId: string | null,
  affectedNodeIds: string[]
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
    data: node.data,
    draggable: true,
    selectable: true,
    style: {
      ...node.style,
      opacity: resolveNodeOpacity(node.id, matchedIds, loweredQuery, mappingSet, affectedSet),
    },
  }));

  const flowEdges = rawEdges
    .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    .filter((edge) => matchesEdgeVisibility(edge.type, visibility))
    .map<FlowEdge>((edge) => {
      const highlight =
        edgeIsHighlighted(edge, loweredQuery, matchedIds, mappingSet, affectedSet);
      const color = edgeColor(edge.type);

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
            edge.type === 'contains'
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
            : loweredQuery || mappingSet.size > 0 || affectedSet.size > 0
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

  if (type === 'dataFlow') {
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

function edgeColor(type: GraphEdge['type']): string {
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
    default:
      return '#b8d2ea';
  }
}

function nodeColor(type: GraphNodeType): string {
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

function collectMappingFocusIds(
  mappingFocusNodeId: string | null,
  rawEdges: GraphEdge[]
): Set<string> {
  const focusIds = new Set<string>();
  if (!mappingFocusNodeId) {
    return focusIds;
  }

  focusIds.add(mappingFocusNodeId);
  const queue = [mappingFocusNodeId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of rawEdges) {
      if (edge.type !== 'dataFlow') {
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
  affectedSet: Set<string>
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

  return opacity;
}

function edgeIsHighlighted(
  edge: GraphEdge,
  loweredQuery: string,
  matchedIds: Set<string>,
  mappingSet: Set<string>,
  affectedSet: Set<string>
): boolean {
  if (mappingSet.size > 0) {
    return mappingSet.has(edge.source) && mappingSet.has(edge.target);
  }

  if (affectedSet.size > 0) {
    return affectedSet.has(edge.source) || affectedSet.has(edge.target);
  }

  return !loweredQuery || matchedIds.has(edge.source) || matchedIds.has(edge.target);
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
