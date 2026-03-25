export type Language =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'java'
  | 'go'
  | 'rust'
  | 'csharp'
  | 'cpp'
  | 'c'
  | 'ruby'
  | 'php'
  | 'swift'
  | 'kotlin'
  | 'scala'
  | 'dart'
  | 'lua'
  | 'shell'
  | 'yaml'
  | 'json'
  | 'html'
  | 'css'
  | 'sql'
  | 'unknown';

export const LANGUAGE_MAP: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.py': 'python',
  '.pyw': 'python',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.h': 'c',
  '.c': 'c',
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.sc': 'scala',
  '.dart': 'dart',
  '.lua': 'lua',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'css',
  '.less': 'css',
  '.sql': 'sql',
};

export type SymbolKind =
  | 'file'
  | 'folder'
  | 'class'
  | 'interface'
  | 'function'
  | 'method'
  | 'variable'
  | 'constant'
  | 'enum'
  | 'type'
  | 'module'
  | 'package'
  | 'test'
  | 'testSuite'
  | 'import'
  | 'export'
  | 'route'
  | 'middleware'
  | 'hook'
  | 'component'
  | 'table'
  | 'column';

export interface ParameterInfo {
  name: string;
  type?: string;
  defaultValue?: string;
  isOptional?: boolean;
}

export interface CodeSymbol {
  id: string;
  name: string;
  kind: SymbolKind;
  language: Language;
  filePath: string;
  startLine: number;
  endLine: number;
  lineCount: number;
  children: CodeSymbol[];
  imports: string[];
  exports: string[];
  dependencies: string[];
  testsTarget?: string;
  access?: 'public' | 'private' | 'protected' | 'internal';
  isAsync?: boolean;
  parameters?: ParameterInfo[];
  returnType?: string;
  decorators?: string[];
  docComment?: string;
  complexity?: number;
  dataMappings?: DataFlowMapping[];
}

export interface ImportInfo {
  source: string;
  specifiers: string[];
  isDefault: boolean;
  isNamespace: boolean;
  line: number;
}

export interface PackageInfo {
  name: string;
  version?: string;
  type: 'dependency' | 'devDependency' | 'peerDependency';
}

export interface ParsedFile {
  path: string;
  relativePath: string;
  name: string;
  language: Language;
  lineCount: number;
  size: number;
  complexity: number;
  symbols: CodeSymbol[];
  imports: ImportInfo[];
  exports: string[];
  packages: PackageInfo[];
  packageReferences: PackageReference[];
  dataMappings: DataFlowMapping[];
  testFile: boolean;
  lastModified: number;
}

export type GraphNodeType =
  | 'folder'
  | 'file'
  | 'class'
  | 'function'
  | 'method'
  | 'interface'
  | 'type'
  | 'variable'
  | 'test'
  | 'module'
  | 'external';

export type GraphEdgeType =
  | 'contains'
  | 'import'
  | 'inheritance'
  | 'implementation'
  | 'call'
  | 'testFlow'
  | 'dataFlow'
  | 'reference'
  | 'sqlMapping'
  | 'inject';

export type GraphLayoutAlgorithm =
  | 'hierarchical'
  | 'force-directed'
  | 'radial'
  | 'tree';

export type GraphTestStatus =
  | 'unknown'
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed';

export interface GraphClassSummary {
  name: string;
  kind: 'class' | 'interface' | 'type' | 'enum';
  methods: string[];
  methodDetails?: GraphMethodSummary[];
  tests?: string[];
  lineCount?: number;
  fields?: string[];
  extends?: string;
  implements?: string[];
  sqlQueries?: string[];
}

export interface GraphMethodSummary {
  name: string;
  kind?: 'method' | 'function' | 'test' | 'hook' | 'component' | 'route';
  lineCount?: number;
  flowsTo?: string[];
  flowsFrom?: string[];
}

export interface DataFlowMapping {
  source: string;
  target: string;
  operation?: string;
  via?: string;
  detail?: string;
  sourceClass?: string;
  sourceMethod?: string;
  targetClass?: string;
  targetMethod?: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface PackageReference {
  name: string;
  source: string;
  kind:
    | 'import'
    | 'dependency'
    | 'devDependency'
    | 'peerDependency'
    | 'jar'
    | 'python-package'
    | 'java-package';
  version?: string;
}

export interface TestRunSummary {
  status: 'idle' | 'running' | 'completed' | 'failed';
  command?: string;
  passed: number;
  failed: number;
  skipped: number;
  durationMs?: number;
  message?: string;
  affectedTargets?: string[];
}

export interface GraphNodeData {
  [key: string]: unknown;
  label: string;
  kind?: SymbolKind;
  filePath?: string;
  relativePath?: string;
  language?: Language;
  startLine?: number;
  endLine?: number;
  lineCount?: number;
  byteSize?: number;
  visibility?: 'public' | 'private' | 'protected' | 'internal';
  isAsync?: boolean;
  isStatic?: boolean;
  returnType?: string;
  parameters?: ParameterInfo[];
  docComment?: string;
  dependencies?: string[];
  imports?: string[];
  exports?: string[];
  childCount?: number;
  memberNames?: string[];
  classSummaries?: GraphClassSummary[];
  packageRefs?: PackageReference[];
  dataMappings?: DataFlowMapping[];
  classCount?: number;
  methodCount?: number;
  testCount?: number;
  complexity?: number;
  complexityRank?: number;
  hotspotScore?: number;
  hotspotRank?: number;
  overlayMode?: 'none' | 'complexity' | 'hotspot';
  heatRank?: number;
  impactRole?: 'selected' | 'upstream' | 'downstream' | 'both';
  testStatus?: GraphTestStatus;
  expandable?: boolean;
  expanded?: boolean;
  parentId?: string;
  depth?: number;
  external?: boolean;
  changed?: boolean;
  summary?: string;
  searchText?: string;
}

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  position: { x: number; y: number };
  data: GraphNodeData;
  style?: Record<string, string | number>;
  hidden?: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: GraphEdgeType;
  label?: string;
  animated?: boolean;
  style?: Record<string, string | number>;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata: {
    type: 'folder' | 'file' | 'selection';
    rootPath?: string;
    path?: string;
    language?: Language;
    generatedAt: number;
    totalFiles: number;
    totalSymbols: number;
    totalLines: number;
    changeEvent?: {
      paths: string[];
      reason: 'manual' | 'watcher';
      kind?: 'change' | 'create' | 'delete';
      updatedAt: number;
    };
  };
}

export interface FileMetrics {
  complexity: number;
  maintainability: number;
  testCoverage?: number;
  dependencies: number;
  dependents: number;
}

export interface FilterOptions {
  languages?: Language[];
  kinds?: SymbolKind[];
  showImports?: boolean;
  showCallGraph?: boolean;
  searchQuery?: string;
}

export interface AIIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
  suggestion?: string;
}

export interface AISuggestion {
  type: 'refactor' | 'performance' | 'security' | 'test' | 'documentation' | 'style';
  message: string;
  description?: string;
  file?: string;
  line?: number;
  endLine?: number;
  code?: string;
  original?: string;
  suggested?: string;
  priority: 'high' | 'medium' | 'low';
}

export interface AIAnalysisResult {
  summary: string;
  issues: AIIssue[];
  suggestions: AISuggestion[];
  codeQuality: number;
  testCoverage: string;
  securityConcerns: string[];
  timestamp: number;
  provider: string;
  model: string;
}

export interface GitChange {
  file: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  diff?: string;
}

export interface GitComment {
  file: string;
  line: number;
  message: string;
  severity: 'error' | 'warning' | 'info' | 'suggestion';
}

export interface GitAnalysisResult {
  changes: GitChange[];
  analysis: AIAnalysisResult;
  compatibilityScore: number;
  breakingChanges: string[];
  comments: GitComment[];
}

export interface CodePreview {
  nodeId: string;
  filePath: string;
  fileName: string;
  relativePath?: string;
  className?: string;
  methodName?: string;
  fileCode?: string;
  classCode?: string;
  methodCode?: string;
}

export interface GitCommitSummary {
  hash: string;
  shortHash: string;
  author: string;
  subject: string;
  date: string;
}

export interface GitWebhookSettings {
  provider: 'github' | 'gitlab';
  webhookUrl: string;
  webhookSecret: string;
}

export type WebviewMessage =
  | { type: 'updateGraph'; data: GraphData }
  | { type: 'aiAnalysis'; analysis: AIAnalysisResult; targetLabel: string }
  | { type: 'aiStatus'; available: boolean; provider: string; message: string; model?: string }
  | { type: 'aiModels'; models: Array<{ id: string; family: string }> }
  | { type: 'codePreview'; preview: CodePreview }
  | {
      type: 'testResults';
      summary: TestRunSummary;
      statuses: Record<string, GraphTestStatus>;
      affectedNodeIds: string[];
    }
  | {
      type: 'gitData';
      commits: GitCommitSummary[];
      review?: GitAnalysisResult;
      settings: GitWebhookSettings;
    }
  | { type: 'status'; level: 'info' | 'success' | 'warning' | 'error'; message: string }
  | { type: 'error'; message: string }
  | { type: 'testDiffResult'; targetLabel: string; missingScenarios: string; testFilePath?: string; sourceFilePath?: string };

export type ExtensionMessage =
  | { type: 'ready' }
  | { type: 'goToLocation'; data: { filePath: string; line?: number } }
  | { type: 'runTests' }
  | { type: 'requestCodePreview'; nodeId?: string }
  | { type: 'requestAiAnalysis'; nodeId?: string }
  | { type: 'requestTestGeneration'; nodeId?: string }
  | { type: 'requestGitData' }
  | { type: 'requestGitAnalysis' }
  | { type: 'saveGitSettings'; data: GitWebhookSettings }
  | {
      type: 'export';
      data: {
        format: 'png' | 'svg' | 'json';
        content: string;
        fileName: string;
        mimeType?: string;
      };
    }
  | { type: 'requestRefresh' }
  | { type: 'requestModels' }
  | { type: 'selectModel'; modelId: string }
  | { type: 'requestTestDiff'; nodeId?: string }
  | { type: 'applySuggestion'; filePath: string; line: number; endLine?: number; original: string; suggested: string }
  | { type: 'runTestsForFile'; filePath: string };
