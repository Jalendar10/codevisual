import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { glob } from 'glob';
import { ParserFactory } from '../parsers';
import {
  CodeSymbol,
  DataFlowMapping,
  FilterOptions,
  GraphData,
  GraphEdge,
  GraphClassSummary,
  GraphMethodSummary,
  GraphNode,
  GraphNodeType,
  ImportInfo,
  LANGUAGE_MAP,
  Language,
  PackageInfo,
  PackageReference,
  ParsedFile,
  RiskLevel,
} from '../types';

interface SelectionContext {
  filePath?: string;
  startLine?: number;
}

interface FolderNodeState {
  id: string;
  path: string;
}

interface FileTestInsight {
  testFilePath?: string;
  testRelativePath?: string;
  testFileCount: number;
  testCaseCount: number;
  testLineCount: number;
  coverageEstimate: number;
  coveredMethodCount: number;
  uncoveredMethodCount: number;
  uncoveredMembers: string[];
  desiredCoveragePercent: number;
  securityLevel: RiskLevel;
  dataLeakLevel: RiskLevel;
  securityFindings: string[];
  dataLeakFindings: string[];
}

export class CodeAnalyzer {
  private parsedFiles: Map<string, ParsedFile> = new Map();

  constructor(private rootPath: string) {}

  async analyzeFolder(targetPath: string): Promise<GraphData> {
    this.parsedFiles.clear();

    const config = vscode.workspace.getConfiguration('codeflow');
    const excludePatterns = config.get<string[]>('excludePatterns', [
      'node_modules',
      '.git',
      '__pycache__',
      'dist',
      'build',
    ]);
    const maxDepth = config.get<number>('maxDepth', 12);

    const allFiles = await this.findFiles(targetPath, excludePatterns, maxDepth);
    // Keep folder analysis fast: cap at 150 files
    const MAX_FILES = 150;
    const files = allFiles.slice(0, MAX_FILES);

    // Parse files in parallel batches of 20, yielding between batches
    const BATCH_SIZE = 20;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (filePath) => {
          const parsed = await this.parseFileFast(filePath, targetPath);
          if (parsed) {
            this.parsedFiles.set(filePath, parsed);
          }
        })
      );
      // Yield event loop so VS Code stays responsive
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    return this.buildFolderGraph(targetPath, Array.from(this.parsedFiles.values()));
  }

  /**
   * Fast parser used for folder-mode scanning.
   * Reads the minimum needed: file stats, language, line count, import list,
   * and a quick regex count of classes/methods.
   * Does NOT run full symbol parsing, data-mapping extraction, or package detection.
   */
  private async parseFileFast(filePath: string, relativeRoot: string): Promise<ParsedFile | null> {
    try {
      const stat = await fsPromises.stat(filePath);
      // Skip files > 200 KB — they're usually generated or minified
      if (stat.size > 200 * 1024) {
        return null;
      }

      const language = ParserFactory.detectLanguage(filePath);
      if (language === 'unknown') {
        return null;
      }

      const buffer = await fsPromises.readFile(filePath);
      if (!this.isLikelyTextBuffer(buffer, filePath)) {
        return null;
      }
      const content = buffer.toString('utf8');
      const parser = ParserFactory.getParser(filePath);
      const imports = parser ? parser.parseImports(content) : [];
      const shouldParseDetailedSymbols = language === 'java' || language === 'python';
      const parsedSymbols = shouldParseDetailedSymbols && parser
        ? this.annotateSymbolComplexity(
            this.normalizeSymbols(parser.parseContent(content, filePath), language, filePath, 0),
            content,
            1
          )
        : [];
      const methodFlowMappings = shouldParseDetailedSymbols
        ? this.collectMethodFlowMappings(parsedSymbols, content, 1)
        : [];
      const dataMappings = shouldParseDetailedSymbols
        ? this.mergeDataMappings(this.extractDataMappings(content, language), methodFlowMappings)
        : [];
      const symbols = shouldParseDetailedSymbols
        ? this.annotateSymbolsWithMappings(parsedSymbols, dataMappings)
        : [];

      // Quick class/method extraction via lightweight regex (no AST walking)
      const quickClassSummaries = symbols.length > 0
        ? this.collectClassSummaries(symbols)
        : this.extractQuickClassSummaries(content, language);
      const classCount = quickClassSummaries.length || (content.match(/\bclass\s+\w/g) || []).length;
      const methodCount = quickClassSummaries.reduce((s, c) => s + c.methods.length, 0)
        || (content.match(/\b(?:def |function |async function )\w/g) || []).length;

      return {
        path: filePath,
        relativePath: path.relative(relativeRoot, filePath),
        name: path.basename(filePath),
        language,
        lineCount: content.split('\n').length,
        size: stat.size,
        complexity: shouldParseDetailedSymbols
          ? this.calculateFileComplexity(symbols, content)
          : this.calculateTextComplexity(content),
        symbols,
        imports,
        exports: symbols.flatMap((symbol) => symbol.exports),
        packages: [],
        packageReferences: [],
        dataMappings,
        testFile: parser ? parser.isTestFile(filePath, content) : false,
        lastModified: stat.mtimeMs,
        // Store quick class/method data for node display
        _quickClassCount: classCount,
        _quickMethodCount: methodCount,
        _quickClassSummaries: quickClassSummaries,
      } as ParsedFile & { _quickClassCount: number; _quickMethodCount: number; _quickClassSummaries: GraphClassSummary[] };
    } catch {
      return null;
    }
  }

  /**
   * Lightweight regex-based class+method extractor for folder-fast mode.
   * Returns approximate class summaries without any AST walking.
   */
  private extractQuickClassSummaries(content: string, language: string): GraphClassSummary[] {
    const lines = content.split('\n');

    // Class detection regex per language family — also handles annotated classes
    const classRex =
      language === 'python'
        ? /^\s*class\s+(\w+)(?:\(([^)]*)\))?/
        : /^\s*(?:export\s+)?(?:abstract\s+|default\s+|final\s+|sealed\s+)?(?:class|interface|enum|record)\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+(.+?))?/;

    // Method detection regex per language family
    const methodRex =
      language === 'python'
        ? /^(\s{2,})def\s+(\w+)\s*\(/
        : language === 'java' || language === 'kotlin'
          ? /^\s{2,}(?:(?:public|private|protected|static|final|abstract|synchronized|async|override|default)\s+)*(?:<[\w\s,?]+>\s+)?(\w+(?:<[^>]*>)?)\s+(\w+)\s*\(/
          : /^\s{2,}(?:(?:public|private|protected|static|async|override|abstract|readonly)\s+)*(\w+)\s*\(/;

    // Field detection for Java/Kotlin
    const fieldRex = language === 'java' || language === 'kotlin'
      ? /^\s{2,}(?:(?:public|private|protected|static|final|volatile|transient)\s+)*(\w+(?:<[^>]*>)?)\s+(\w+)\s*[;=]/
      : null;

    const SKIP_KEYWORDS = new Set([
      'if', 'for', 'while', 'switch', 'catch', 'class', 'return',
      'new', 'throw', 'typeof', 'instanceof', 'in', 'of', 'interface', 'enum',
    ]);

    const classes: { name: string; line: number; extends?: string; implements?: string[] }[] = [];
    const methods: { name: string; line: number }[] = [];
    const fields: { name: string; type: string; line: number }[] = [];
    const sqlQueries: string[] = [];

    // Detect SQL queries
    const sqlRex = /(?:SELECT|INSERT|UPDATE|DELETE)\s+.{1,60}?(?:FROM|INTO|SET)\s+(\w+)/gi;
    let sqlMatch: RegExpExecArray | null;
    while ((sqlMatch = sqlRex.exec(content)) !== null) {
      sqlQueries.push(sqlMatch[0].slice(0, 80));
    }

    lines.forEach((line, idx) => {
      const cm = classRex.exec(line);
      if (cm) {
        const extendsMatch = language === 'python' ? cm[2]?.split(',')[0]?.trim() : cm[2];
        const implementsMatch = language === 'python' ? cm[2]?.split(',').slice(1).map(s => s.trim()) : cm[3]?.split(',').map(s => s.trim());
        classes.push({
          name: cm[1],
          line: idx,
          extends: extendsMatch || undefined,
          implements: implementsMatch?.filter(Boolean),
        });
        return;
      }

      const mm = methodRex.exec(line);
      if (mm) {
        const name = language === 'python' ? mm[2] : (language === 'java' || language === 'kotlin') ? mm[2] : mm[1];
        if (name && !SKIP_KEYWORDS.has(name)) {
          methods.push({ name, line: idx });
        }
      }

      if (fieldRex) {
        const fm = fieldRex.exec(line);
        if (fm && !SKIP_KEYWORDS.has(fm[2]) && fm[2] !== 'class') {
          fields.push({ name: fm[2], type: fm[1], line: idx });
        }
      }
    });

    if (classes.length === 0) {
      return [];
    }

    return classes.map((cls, i): GraphClassSummary => {
      const nextClassLine = classes[i + 1]?.line ?? lines.length;
      const classMethods = methods
        .filter((m) => m.line > cls.line && m.line < nextClassLine)
        .map((m) => m.name)
        .slice(0, 20);
      const classFields = fields
        .filter((f) => f.line > cls.line && f.line < nextClassLine)
        .map((f) => `${f.type} ${f.name}`)
        .slice(0, 10);
      return {
        name: cls.name,
        kind: 'class',
        methods: classMethods,
        fields: classFields.length > 0 ? classFields : undefined,
        extends: cls.extends,
        implements: cls.implements?.length ? cls.implements : undefined,
        sqlQueries: sqlQueries.length > 0 ? sqlQueries.slice(0, 5) : undefined,
        lineCount: nextClassLine - cls.line,
        tests: [],
      };
    });
  }

  async analyzeFile(filePath: string): Promise<GraphData> {
    const parsed = await this.parseFile(filePath, this.rootPath);
    if (!parsed) {
      return this.emptyGraph('file', { path: filePath });
    }

    const content = fs.readFileSync(filePath, 'utf8');
    return this.buildCodeGraph(parsed, content, 'file', 1);
  }

  async analyzeSelection(
    code: string,
    languageId: string,
    context: SelectionContext = {}
  ): Promise<GraphData> {
    const parser = ParserFactory.getParserForLanguage(languageId);
    const language = ParserFactory.normalizeLanguage(languageId);

    if (!parser || language === 'unknown') {
      return this.emptyGraph('selection', { language: 'unknown' });
    }

    const syntheticPath = context.filePath || `selection.${this.extensionForLanguage(language)}`;
    const lineOffset = Math.max(0, (context.startLine || 1) - 1);
    const contentLines = code.split('\n').length;
    const parsedSymbols = this.annotateSymbolComplexity(
      this.normalizeSymbols(
        parser.parseContent(code, syntheticPath),
        language,
        syntheticPath,
        lineOffset
      ),
      code,
      context.startLine || 1
    );
    const imports = parser.parseImports(code);
    const packages: PackageInfo[] = [];
    const packageReferences = this.buildPackageReferences(language, imports, packages);
    const dataMappings = this.mergeDataMappings(
      this.extractDataMappings(code, language),
      this.collectMethodFlowMappings(parsedSymbols, code, context.startLine || 1)
    );
    const symbols = this.annotateSymbolsWithMappings(parsedSymbols, dataMappings);

    const parsed: ParsedFile = {
      path: syntheticPath,
      relativePath: path.basename(syntheticPath),
      name: path.basename(syntheticPath),
      language,
      lineCount: contentLines,
      size: Buffer.byteLength(code, 'utf8'),
      complexity: this.calculateFileComplexity(symbols, code),
      symbols,
      imports,
      exports: symbols.flatMap((symbol) => symbol.exports),
      packages,
      packageReferences,
      dataMappings,
      testFile: parser.isTestFile(syntheticPath, code),
      lastModified: Date.now(),
    };

    return this.buildCodeGraph(parsed, code, 'selection', context.startLine || 1);
  }

  static filterData(data: GraphData, filter: FilterOptions): GraphData {
    let nodes = [...data.nodes];
    let edges = [...data.edges];

    if (filter.languages?.length) {
      nodes = nodes.filter((node) => {
        return !node.data.language || filter.languages?.includes(node.data.language);
      });
    }

    if (filter.kinds?.length) {
      nodes = nodes.filter((node) => {
        return !node.data.kind || filter.kinds?.includes(node.data.kind);
      });
    }

    if (!filter.showImports) {
      edges = edges.filter((edge) => edge.type !== 'import');
    }

    if (!filter.showCallGraph) {
      edges = edges.filter((edge) => edge.type !== 'call');
    }

    if (filter.searchQuery) {
      const query = filter.searchQuery.toLowerCase();
      nodes = nodes.filter((node) => {
        const haystack = node.data.searchText || node.data.label;
        return haystack.toLowerCase().includes(query);
      });
    }

    const visibleIds = new Set(nodes.map((node) => node.id));
    edges = edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));

    return {
      ...data,
      nodes,
      edges,
    };
  }

  private async findFiles(
    scanPath: string,
    excludePatterns: string[],
    maxDepth: number
  ): Promise<string[]> {
    return glob('**/*', {
      cwd: scanPath,
      absolute: true,
      nodir: true,
      maxDepth,
      ignore: this.normalizeExcludes(excludePatterns),
    });
  }

  private normalizeExcludes(patterns: string[]): string[] {
    const normalized: string[] = [];
    for (const pattern of patterns) {
      if (pattern.includes('*') || pattern.includes('/')) {
        normalized.push(pattern);
        continue;
      }

      normalized.push(`**/${pattern}`);
      normalized.push(`**/${pattern}/**`);
    }

    return normalized;
  }

  private async parseFile(filePath: string, relativeRoot: string): Promise<ParsedFile | null> {
    const parser = ParserFactory.getParser(filePath);
    try {
      const stat = await fsPromises.stat(filePath);
      const buffer = stat.isFile() ? await fsPromises.readFile(filePath) : Buffer.alloc(0);
      const content = this.isLikelyTextBuffer(buffer, filePath) ? buffer.toString('utf8') : '';
      const language = ParserFactory.detectLanguage(filePath);
      const imports = parser ? parser.parseImports(content) : [];
      const packages = this.detectPackages(filePath);
      const parsedSymbols = parser
        ? this.annotateSymbolComplexity(
            this.normalizeSymbols(parser.parseContent(content, filePath), language, filePath, 0),
            content,
            1
          )
        : [];
      const dataMappings = this.mergeDataMappings(
        this.extractDataMappings(content, language),
        this.collectMethodFlowMappings(parsedSymbols, content, 1)
      );
      const symbols = this.annotateSymbolsWithMappings(parsedSymbols, dataMappings);

      return {
        path: filePath,
        relativePath: path.relative(relativeRoot, filePath),
        name: path.basename(filePath),
        language,
        lineCount: content ? content.split('\n').length : 0,
        size: stat.size,
        complexity: this.calculateFileComplexity(symbols, content),
        symbols,
        imports,
        exports: symbols.flatMap((symbol) => symbol.exports),
        packages,
        packageReferences: this.buildPackageReferences(language, imports, packages),
        dataMappings,
        testFile: parser ? parser.isTestFile(filePath, content) : false,
        lastModified: stat.mtimeMs,
      };
    } catch {
      return null;
    }
  }

  private normalizeSymbols(
    symbols: CodeSymbol[],
    language: Language,
    filePath: string,
    lineOffset: number
  ): CodeSymbol[] {
    return symbols.map((symbol) => this.normalizeSymbol(symbol, language, filePath, lineOffset));
  }

  private normalizeSymbol(
    symbol: CodeSymbol,
    language: Language,
    filePath: string,
    lineOffset: number
  ): CodeSymbol {
    return {
      ...symbol,
      language,
      filePath,
      startLine: symbol.startLine + lineOffset,
      endLine: symbol.endLine + lineOffset,
      children: symbol.children.map((child) =>
        this.normalizeSymbol(child, language, filePath, lineOffset)
      ),
    };
  }

  private annotateSymbolComplexity(
    symbols: CodeSymbol[],
    content: string,
    contentStartLine: number
  ): CodeSymbol[] {
    const lines = content.split('\n');
    const annotate = (symbol: CodeSymbol): CodeSymbol => {
      const children = symbol.children.map(annotate);
      let complexity: number | undefined;

      if (this.isComplexityCarrier(symbol.kind)) {
        const body = this.extractSymbolBody(lines, symbol, contentStartLine);
        complexity = this.calculateTextComplexity(body);
      } else if (children.length > 0) {
        const childComplexity = children.reduce(
          (sum, child) => sum + (child.complexity || 0),
          0
        );
        if (childComplexity > 0) {
          complexity = childComplexity;
        }
      }

      return {
        ...symbol,
        children,
        complexity,
      };
    };

    return symbols.map(annotate);
  }

  private isComplexityCarrier(kind: CodeSymbol['kind']): boolean {
    return ['function', 'method', 'hook', 'component', 'route', 'test', 'testSuite'].includes(kind);
  }

  private calculateFileComplexity(symbols: CodeSymbol[], content: string): number {
    const symbolComplexity = this.flattenSymbols(symbols)
      .filter((symbol) => this.isComplexityCarrier(symbol.kind))
      .reduce((sum, symbol) => sum + (symbol.complexity || 0), 0);

    return symbolComplexity > 0 ? symbolComplexity : this.calculateTextComplexity(content);
  }

  private calculateTextComplexity(content: string): number {
    if (!content.trim()) {
      return 0;
    }

    const normalized = content
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/#.*$/gm, '');

    const counts = [
      /\bif\b/g,
      /\belse\b(?!\s+if)/g,
      /\bfor\b/g,
      /\bwhile\b/g,
      /\bswitch\b/g,
      /\bcatch\b/g,
      /&&/g,
      /\|\|/g,
    ].reduce((sum, pattern) => sum + (normalized.match(pattern) || []).length, 0);

    return 1 + counts;
  }

  private mergeDataMappings(
    primary: DataFlowMapping[],
    additional: DataFlowMapping[]
  ): DataFlowMapping[] {
    const merged = new Map<string, DataFlowMapping>();
    for (const mapping of [...primary, ...additional]) {
      const key = [
        mapping.source,
        mapping.target,
        mapping.operation || '',
        mapping.sourceClass || '',
        mapping.sourceMethod || '',
        mapping.targetClass || '',
        mapping.targetMethod || '',
      ].join(':');
      if (!merged.has(key)) {
        merged.set(key, mapping);
      }
    }

    return Array.from(merged.values()).slice(0, 40);
  }

  private collectMethodFlowMappings(
    symbols: CodeSymbol[],
    content: string,
    contentStartLine: number
  ): DataFlowMapping[] {
    const callableKinds = new Set(['function', 'method', 'hook', 'component', 'route', 'test', 'testSuite']);
    const lines = content.split('\n');
    const callables = this.collectCallableContexts(symbols).filter((entry) =>
      callableKinds.has(entry.symbol.kind)
    );
    const mappings = new Map<string, DataFlowMapping>();

    for (const source of callables) {
      const body = this.extractSymbolBody(lines, source.symbol, contentStartLine);
      if (!body.trim()) {
        continue;
      }

      for (const target of callables) {
        if (source.symbol.id === target.symbol.id) {
          continue;
        }

        const targetName = this.simpleName(target.symbol.name);
        const callPatterns = [
          new RegExp(`\\b${this.escapeRegExp(targetName)}\\s*\\(`),
          new RegExp(`\\b(?:this|self|cls)\\.${this.escapeRegExp(targetName)}\\s*\\(`),
          new RegExp(`\\.[A-Za-z_][\\w]*\\s*\\.\\s*${this.escapeRegExp(targetName)}\\s*\\(`),
          new RegExp(`\\.[A-Za-z_][\\w]*\\.${this.escapeRegExp(targetName)}\\s*\\(`),
        ];

        if (!callPatterns.some((pattern) => pattern.test(body))) {
          continue;
        }

        const sourceLabel = this.qualifiedSymbolLabel(source.ownerClass, source.symbol.name);
        const targetLabel = this.qualifiedSymbolLabel(target.ownerClass, target.symbol.name);
        const mapping: DataFlowMapping = {
          source: sourceLabel,
          target: targetLabel,
          sourceClass: source.ownerClass,
          sourceMethod: this.simpleName(source.symbol.name),
          targetClass: target.ownerClass,
          targetMethod: this.simpleName(target.symbol.name),
          operation: 'method-flow',
          detail: 'Method-to-method flow detected from call usage',
          confidence:
            source.ownerClass && source.ownerClass === target.ownerClass ? 'high' : 'medium',
        };
        mappings.set(`${source.symbol.id}:${target.symbol.id}`, mapping);
      }
    }

    return Array.from(mappings.values());
  }

  private annotateSymbolsWithMappings(
    symbols: CodeSymbol[],
    mappings: DataFlowMapping[]
  ): CodeSymbol[] {
    const annotate = (symbol: CodeSymbol, ownerClass?: string): CodeSymbol => {
      const nextOwner =
        symbol.kind === 'class' || symbol.kind === 'interface' || symbol.kind === 'type'
          ? symbol.name
          : ownerClass;
      const children = symbol.children.map((child) => annotate(child, nextOwner));
      const relevantMappings = mappings.filter((mapping) =>
        this.mappingTouchesSymbol(mapping, symbol, ownerClass)
      );

      return {
        ...symbol,
        children,
        dataMappings: relevantMappings.length > 0 ? relevantMappings.slice(0, 16) : undefined,
      };
    };

    return symbols.map((symbol) => annotate(symbol));
  }

  private mappingTouchesSymbol(
    mapping: DataFlowMapping,
    symbol: CodeSymbol,
    ownerClass?: string
  ): boolean {
    const symbolName = this.simpleName(symbol.name);
    const symbolOwner =
      symbol.kind === 'class' || symbol.kind === 'interface' || symbol.kind === 'type'
        ? symbol.name
        : ownerClass;

    if (symbol.kind === 'class' || symbol.kind === 'interface' || symbol.kind === 'type') {
      return mapping.sourceClass === symbol.name || mapping.targetClass === symbol.name;
    }

      if (['method', 'function', 'hook', 'component', 'route', 'test', 'testSuite'].includes(symbol.kind)) {
        const matchesSource =
        mapping.sourceMethod === symbolName
        && (!mapping.sourceClass || mapping.sourceClass === symbolOwner);
      const matchesTarget =
        mapping.targetMethod === symbolName
        && (!mapping.targetClass || mapping.targetClass === symbolOwner);
      return matchesSource || matchesTarget;
    }

    return false;
  }

  private collectCallableContexts(
    symbols: CodeSymbol[],
    ownerClass?: string
  ): Array<{ symbol: CodeSymbol; ownerClass?: string }> {
    const collected: Array<{ symbol: CodeSymbol; ownerClass?: string }> = [];

    for (const symbol of symbols) {
      const nextOwner =
        symbol.kind === 'class' || symbol.kind === 'interface' || symbol.kind === 'type'
          ? symbol.name
          : ownerClass;

      if (['method', 'function', 'hook', 'component', 'route', 'test', 'testSuite'].includes(symbol.kind)) {
        collected.push({ symbol, ownerClass });
      }

      collected.push(...this.collectCallableContexts(symbol.children, nextOwner));
    }

    return collected;
  }

  private qualifiedSymbolLabel(ownerClass: string | undefined, name: string): string {
    return ownerClass ? `${ownerClass}.${this.simpleName(name)}` : this.simpleName(name);
  }

  private buildFolderGraph(rootPath: string, files: ParsedFile[]): GraphData {
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const fileIndex = new Map(files.map((file) => [file.path, file]));
    const fileInsights = this.buildFileInsights(files);
    const symbolIndex = new Map<string, GraphNode>();
    const symbolNameIndex = new Map<string, string[]>();
    const allSymbols: CodeSymbol[] = [];
    const rootId = this.folderNodeId(rootPath);

    nodes.set(
      rootId,
      this.createFolderNode({
        id: rootId,
        path: rootPath,
        name: path.basename(rootPath) || rootPath,
        parentId: undefined,
        depth: 0,
      })
    );

    for (const parsed of files) {
      const directory = path.dirname(parsed.relativePath);
      let parent: FolderNodeState = { id: rootId, path: rootPath };

      if (directory !== '.') {
        const segments = directory.split(path.sep).filter(Boolean);
        let currentPath = rootPath;

        segments.forEach((segment, index) => {
          currentPath = path.join(currentPath, segment);
          const folderId = this.folderNodeId(currentPath);

          if (!nodes.has(folderId)) {
            nodes.set(
              folderId,
              this.createFolderNode({
                id: folderId,
                path: currentPath,
                name: segment,
                parentId: parent.id,
                depth: index + 1,
              })
            );
          }

          this.addEdge(
            edges,
            this.containsEdge(parent.id, folderId, 'contains')
          );
          parent = { id: folderId, path: currentPath };
        });
      }

      const fileId = this.fileNodeId(parsed.path);
      const fileDepth = directory === '.' ? 1 : directory.split(path.sep).length + 1;
      nodes.set(fileId, this.createFileNode(parsed, parent.id, fileDepth, false, fileInsights.get(parsed.path)));
      this.addEdge(edges, this.containsEdge(parent.id, fileId, 'contains'));

      for (const symbol of parsed.symbols) {
        this.addSymbolTree({
          symbol,
          parentId: fileId,
          depth: fileDepth + 1,
          nodes,
          edges,
          symbolIndex,
          symbolNameIndex,
        });
        allSymbols.push(symbol);
      }
    }

    const showImports = vscode.workspace.getConfiguration('codeflow').get<boolean>('showImports', true);
    if (showImports) {
      for (const parsed of files) {
        for (const imp of parsed.imports) {
          const target = this.resolveImport(imp, parsed.path, fileIndex);
          if (target) {
            this.addEdge(
              edges,
              this.linkEdge(
                `import:${parsed.path}:${target}`,
                this.fileNodeId(parsed.path),
                this.fileNodeId(target),
                'import',
                imp.specifiers.join(', ')
              )
            );
          }
        }
      }
    }

    this.addInheritanceEdges(allSymbols, nodes, edges, symbolIndex, symbolNameIndex);
    this.addTestFlowEdges(allSymbols, nodes, edges, symbolNameIndex);
    for (const parsed of files) {
      if (parsed.dataMappings.length > 0) {
        this.addDataFlowArtifacts(parsed, this.fileNodeId(parsed.path), nodes, edges);
      }
    }

    this.updateTestFlowCounts(nodes, edges);
    this.updateContainerCounts(nodes, edges);
    this.updateFolderTestAggregates(nodes, edges);

    const totalLines = files.reduce((sum, file) => sum + file.lineCount, 0);
    const totalSymbols = files.reduce((sum, file) => sum + this.countSymbols(file.symbols), 0);
    const sourceInsights = Array.from(fileInsights.entries())
      .filter(([filePath]) => !(this.parsedFiles.get(filePath)?.testFile));

    return {
      nodes: Array.from(nodes.values()),
      edges: Array.from(edges.values()),
      metadata: {
        type: 'folder',
        rootPath,
        path: rootPath,
        generatedAt: Date.now(),
        totalFiles: files.length,
        totalSymbols,
        totalLines,
        totalTestFiles: sourceInsights.reduce((sum, [, insight]) => sum + insight.testFileCount, 0),
        totalTestCases: sourceInsights.reduce((sum, [, insight]) => sum + insight.testCaseCount, 0),
        totalTestLines: sourceInsights.reduce((sum, [, insight]) => sum + insight.testLineCount, 0),
        totalCoveredMembers: sourceInsights.reduce((sum, [, insight]) => sum + insight.coveredMethodCount, 0),
        totalUncoveredMembers: sourceInsights.reduce((sum, [, insight]) => sum + insight.uncoveredMethodCount, 0),
      },
    };
  }

  private buildCodeGraph(
    parsed: ParsedFile,
    content: string,
    mode: 'file' | 'selection',
    contentStartLine: number
  ): GraphData {
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const insight = this.buildFileInsight(parsed, new Set([parsed.path]), Math.max(
      80,
      Math.min(200, vscode.workspace.getConfiguration('codeflow').get<number>('testAgents.desiredCoveragePercent', 105))
    ));
    const rootNode = this.createFileNode(parsed, undefined, 0, false, insight);
    nodes.set(rootNode.id, rootNode);

    const symbolIndex = new Map<string, GraphNode>();
    const symbolNameIndex = new Map<string, string[]>();

    for (const symbol of parsed.symbols) {
      this.addSymbolTree({
        symbol,
        parentId: rootNode.id,
        depth: 1,
        nodes,
        edges,
        symbolIndex,
        symbolNameIndex,
      });
    }

    this.addImportNodes(parsed, rootNode.id, nodes, edges);
    this.addInheritanceEdges(parsed.symbols, nodes, edges, symbolIndex, symbolNameIndex);
    this.addTestFlowEdges(parsed.symbols, nodes, edges, symbolNameIndex);
    this.addCallEdges(parsed.symbols, content, contentStartLine, nodes, edges);
    this.addDataFlowArtifacts(parsed, rootNode.id, nodes, edges);
    this.updateTestFlowCounts(nodes, edges);
    this.updateContainerCounts(nodes, edges);

    return {
      nodes: Array.from(nodes.values()),
      edges: Array.from(edges.values()),
      metadata: {
        type: mode,
        rootPath: this.rootPath,
        path: parsed.path,
        language: parsed.language,
        generatedAt: Date.now(),
        totalFiles: 1,
        totalSymbols: this.countSymbols(parsed.symbols),
        totalLines: parsed.lineCount,
        totalTestFiles: insight.testFileCount,
        totalTestCases: insight.testCaseCount,
        totalTestLines: insight.testLineCount,
        totalCoveredMembers: insight.coveredMethodCount,
        totalUncoveredMembers: insight.uncoveredMethodCount,
      },
    };
  }

  private addSymbolTree(args: {
    symbol: CodeSymbol;
    parentId: string;
    depth: number;
    nodes: Map<string, GraphNode>;
    edges: Map<string, GraphEdge>;
    symbolIndex: Map<string, GraphNode>;
    symbolNameIndex: Map<string, string[]>;
  }): void {
    const { symbol, parentId, depth, nodes, edges, symbolIndex, symbolNameIndex } = args;
    const node = this.createSymbolNode(symbol, parentId, depth);
    nodes.set(node.id, node);
    symbolIndex.set(symbol.id, node);

    const nameKey = this.normalizeSymbolKey(symbol.name);
    const ids = symbolNameIndex.get(nameKey) || [];
    ids.push(symbol.id);
    symbolNameIndex.set(nameKey, ids);

    this.addEdge(edges, this.containsEdge(parentId, node.id, 'contains'));

    for (const child of symbol.children) {
      this.addSymbolTree({
        symbol: child,
        parentId: node.id,
        depth: depth + 1,
        nodes,
        edges,
        symbolIndex,
        symbolNameIndex,
      });
    }
  }

  private buildFileInsights(files: ParsedFile[]): Map<string, FileTestInsight> {
    const desiredCoveragePercent = Math.max(
      80,
      Math.min(200, vscode.workspace.getConfiguration('codeflow').get<number>('testAgents.desiredCoveragePercent', 105))
    );
    const filePaths = new Set(files.map((file) => file.path));
    const insights = new Map<string, FileTestInsight>();

    for (const parsed of files) {
      insights.set(parsed.path, this.buildFileInsight(parsed, filePaths, desiredCoveragePercent));
    }

    return insights;
  }

  private buildFileInsight(
    parsed: ParsedFile,
    filePaths: Set<string>,
    desiredCoveragePercent: number
  ): FileTestInsight {
    const content = fs.existsSync(parsed.path) ? fs.readFileSync(parsed.path, 'utf8') : '';
    const riskProfile = this.analyzeRiskProfile(content);
    const methodNames = this.collectTestableMemberNames(parsed.symbols);

    if (parsed.testFile) {
      const testCaseCount = this.countTestCases(parsed.path, content);
      return {
        testFilePath: parsed.path,
        testRelativePath: parsed.relativePath,
        testFileCount: 1,
        testCaseCount,
        testLineCount: parsed.lineCount,
        coverageEstimate: 100,
        coveredMethodCount: testCaseCount,
        uncoveredMethodCount: 0,
        uncoveredMembers: [],
        desiredCoveragePercent,
        securityLevel: riskProfile.securityLevel,
        dataLeakLevel: riskProfile.dataLeakLevel,
        securityFindings: riskProfile.securityFindings,
        dataLeakFindings: riskProfile.dataLeakFindings,
      };
    }

    const testFilePath = this.findRelatedTestFilePath(parsed.path, filePaths);
    const testContent = testFilePath && fs.existsSync(testFilePath)
      ? fs.readFileSync(testFilePath, 'utf8')
      : '';
    const linkedLineCount = testContent ? testContent.split('\n').length : 0;
    const linkedTestCaseCount = testContent ? this.countTestCases(testFilePath!, testContent) : 0;
    const coveredMethodNames = methodNames.filter((name) =>
      testContent ? new RegExp(`\\b${this.escapeRegExp(name)}\\b`, 'i').test(testContent) : false
    );
    const uncoveredMembers = methodNames.filter((name) => !coveredMethodNames.includes(name));
    const coverageEstimate = methodNames.length > 0
      ? Math.round((coveredMethodNames.length / methodNames.length) * 100)
      : (testFilePath ? 100 : 0);

    return {
      testFilePath,
      testRelativePath: testFilePath ? path.relative(this.rootPath, testFilePath) : undefined,
      testFileCount: testFilePath ? 1 : 0,
      testCaseCount: linkedTestCaseCount,
      testLineCount: linkedLineCount,
      coverageEstimate,
      coveredMethodCount: coveredMethodNames.length,
      uncoveredMethodCount: uncoveredMembers.length,
      uncoveredMembers: uncoveredMembers.slice(0, 12),
      desiredCoveragePercent,
      securityLevel: riskProfile.securityLevel,
      dataLeakLevel: riskProfile.dataLeakLevel,
      securityFindings: riskProfile.securityFindings,
      dataLeakFindings: riskProfile.dataLeakFindings,
    };
  }

  private findRelatedTestFilePath(sourceFilePath: string, knownPaths: Set<string>): string | undefined {
    const ext = path.extname(sourceFilePath);
    const dir = path.dirname(sourceFilePath);
    const base = path.basename(sourceFilePath, ext);
    const relativePath = path.relative(this.rootPath, sourceFilePath).replace(/\\/g, '/');
    const relativeWithoutExt = ext && relativePath.endsWith(ext)
      ? relativePath.slice(0, -ext.length)
      : relativePath;
    const relativeSegments = relativeWithoutExt.split('/').filter(Boolean);
    const relativeDirSegments = relativeSegments.slice(0, -1);
    const trimmedDirSegments = [...relativeDirSegments];
    const removable = new Set(['src', 'lib', 'app', 'source', 'sources']);
    while (trimmedDirSegments.length > 0 && removable.has(trimmedDirSegments[0].toLowerCase())) {
      trimmedDirSegments.shift();
    }
    if (trimmedDirSegments[0]?.toLowerCase() === 'main') {
      trimmedDirSegments.shift();
    }
    if (trimmedDirSegments[0]?.toLowerCase() === 'java' || trimmedDirSegments[0]?.toLowerCase() === 'kotlin') {
      trimmedDirSegments.shift();
    }
    const snakeBase = base
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase() || 'generated_test';
    const pascalBase = base
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join('') || 'GeneratedSpec';
    const addRootCandidate = (segments: string[], fileName: string, bucket: string[]) => {
      bucket.push(path.join(this.rootPath, ...segments, fileName));
    };
    const candidates = [
      path.join(dir, `test_${base}${ext}`),
      path.join(dir, `${base}_test${ext}`),
      path.join(dir, `${base}Test${ext}`),
      path.join(dir, `${base}Tests${ext}`),
      path.join(dir, `${base}.test${ext}`),
      path.join(dir, `${base}.spec${ext}`),
      path.join(dir, '__tests__', `${base}.test${ext}`),
      path.join(dir, '__tests__', `${base}.spec${ext}`),
      path.join(dir, `${base}Test.generated${ext}`),
      path.join(dir, `test_${base}.generated${ext}`),
      path.join(dir, `${base}_spec${ext}`),
    ];

    switch (ext.toLowerCase()) {
      case '.java': {
        addRootCandidate(['src', 'test', 'java', ...trimmedDirSegments], `${pascalBase}Test${ext}`, candidates);
        addRootCandidate(['src', 'test', 'java', ...trimmedDirSegments], `${pascalBase}Tests${ext}`, candidates);
        addRootCandidate(['test', ...trimmedDirSegments], `${pascalBase}Test${ext}`, candidates);
        addRootCandidate(['src', 'test', 'java', ...trimmedDirSegments], `${pascalBase}Test.generated${ext}`, candidates);
        break;
      }
      case '.kt':
      case '.kts': {
        addRootCandidate(['src', 'test', 'kotlin', ...trimmedDirSegments], `${pascalBase}Test${ext}`, candidates);
        addRootCandidate(['src', 'test', 'kotlin', ...trimmedDirSegments], `${pascalBase}Tests${ext}`, candidates);
        addRootCandidate(['test', ...trimmedDirSegments], `${pascalBase}Test${ext}`, candidates);
        addRootCandidate(['src', 'test', 'kotlin', ...trimmedDirSegments], `${pascalBase}Test.generated${ext}`, candidates);
        break;
      }
      case '.py': {
        addRootCandidate(['tests', ...trimmedDirSegments], `test_${snakeBase}${ext}`, candidates);
        addRootCandidate(['tests', ...trimmedDirSegments], `${snakeBase}_test${ext}`, candidates);
        addRootCandidate(['test', ...trimmedDirSegments], `test_${snakeBase}${ext}`, candidates);
        addRootCandidate(['tests', ...trimmedDirSegments], `test_${snakeBase}.generated${ext}`, candidates);
        break;
      }
      case '.ts':
      case '.tsx':
      case '.js':
      case '.jsx': {
        addRootCandidate(['test', ...trimmedDirSegments], `${base}.test${ext}`, candidates);
        addRootCandidate(['test', ...trimmedDirSegments], `${base}.spec${ext}`, candidates);
        addRootCandidate(['tests', ...trimmedDirSegments], `${base}.test${ext}`, candidates);
        addRootCandidate(['test', ...trimmedDirSegments], `${base}.test.generated${ext}`, candidates);
        break;
      }
      case '.cs': {
        addRootCandidate(['tests', ...trimmedDirSegments], `${pascalBase}Tests${ext}`, candidates);
        addRootCandidate(['test', ...trimmedDirSegments], `${pascalBase}Tests${ext}`, candidates);
        break;
      }
      case '.php': {
        addRootCandidate(['tests', ...trimmedDirSegments], `${pascalBase}Test${ext}`, candidates);
        addRootCandidate(['tests', ...trimmedDirSegments], `${pascalBase}Test.generated${ext}`, candidates);
        break;
      }
      case '.rb': {
        addRootCandidate(['spec', ...trimmedDirSegments], `${snakeBase}_spec${ext}`, candidates);
        break;
      }
      case '.swift': {
        addRootCandidate(['Tests', ...trimmedDirSegments], `${pascalBase}Tests${ext}`, candidates);
        break;
      }
      case '.dart': {
        addRootCandidate(['test', ...trimmedDirSegments], `${snakeBase}_test${ext}`, candidates);
        addRootCandidate(['test', ...trimmedDirSegments], `${snakeBase}_test.generated${ext}`, candidates);
        break;
      }
      case '.rs': {
        addRootCandidate(['tests', ...trimmedDirSegments], `${snakeBase}.rs`, candidates);
        addRootCandidate(['tests', ...trimmedDirSegments], `${snakeBase}_test.rs`, candidates);
        break;
      }
      default:
        break;
    }

    return candidates.find((candidate) => knownPaths.has(candidate) || fs.existsSync(candidate));
  }

  private countTestCases(filePath: string, content: string): number {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.py') {
      return (content.match(/^\s*def\s+test_[\w_]+\s*\(/gm) || []).length;
    }
    if (ext === '.java' || ext === '.kt' || ext === '.kts') {
      return (content.match(/@\s*(?:Test|ParameterizedTest|RepeatedTest|TestFactory)\b/g) || []).length;
    }
    if (ext === '.go') {
      return (content.match(/\bfunc\s+Test[A-Z]\w*\s*\(/g) || []).length;
    }
    if (ext === '.cs') {
      return (content.match(/\[\s*(?:Fact|Theory|TestMethod|Test)\s*\]/g) || []).length;
    }
    if (ext === '.rb') {
      return (content.match(/\bit\s+['"]/g) || []).length;
    }
    if (ext === '.swift') {
      return (content.match(/\bfunc\s+test[A-Z]\w*\s*\(/g) || []).length;
    }
    if (ext === '.dart') {
      return (content.match(/\btest\s*\(/g) || []).length;
    }
    return (content.match(/\b(?:it|test)\s*\(/g) || []).length;
  }

  private collectTestableMemberNames(symbols: CodeSymbol[]): string[] {
    return Array.from(new Set(
      this.flattenSymbols(symbols)
        .filter((symbol) => ['method', 'function', 'hook', 'component', 'route'].includes(symbol.kind))
        .map((symbol) => this.simpleName(symbol.name))
        .filter(Boolean)
    ));
  }

  private analyzeRiskProfile(content: string): {
    securityLevel: RiskLevel;
    dataLeakLevel: RiskLevel;
    securityFindings: string[];
    dataLeakFindings: string[];
  } {
    const securityFindings: string[] = [];
    const dataLeakFindings: string[] = [];

    const securityChecks: Array<[RegExp, string]> = [
      [/\beval\s*\(/i, 'Dynamic code execution detected'],
      [/\b(?:Runtime\.getRuntime\(\)\.exec|ProcessBuilder|os\.system|subprocess\.(?:Popen|run|call)|exec\s*\()/i, 'Command execution path detected'],
      [/\b(?:SELECT|INSERT|UPDATE|DELETE)\b[\s\S]{0,120}\+/i, 'String-built SQL query detected'],
      [/\byaml\.load\s*\(/i, 'Unsafe YAML load detected'],
      [/\bpickle\.loads?\s*\(/i, 'Unsafe pickle usage detected'],
      [/\binnerHTML\b/i, 'Raw HTML injection surface detected'],
      [/\b(password|secret|token|api[_-]?key)\b[\s\S]{0,40}=/i, 'Sensitive credential handling detected'],
    ];

    const dataLeakChecks: Array<[RegExp, string]> = [
      [/\b(?:console\.log|logger\.\w+|System\.out\.print|print)\s*\([\s\S]{0,120}\b(password|secret|token|ssn|email|dob|customer)\b/i, 'Sensitive data may be logged'],
      [/\b(?:response|res|ctx)\.[\s\S]{0,80}\b(password|secret|token|ssn|email|customer)\b/i, 'Sensitive data may be returned to callers'],
      [/\b(?:throw new|Exception|Error)\b[\s\S]{0,100}\b(password|secret|token|customer)\b/i, 'Sensitive data may leak through errors'],
      [/\b(?:serialize|toJson|toJSON|jsonify)\b[\s\S]{0,100}\b(password|secret|token|ssn|customer)\b/i, 'Sensitive data serialization path detected'],
    ];

    securityChecks.forEach(([pattern, message]) => {
      if (pattern.test(content)) {
        securityFindings.push(message);
      }
    });
    dataLeakChecks.forEach(([pattern, message]) => {
      if (pattern.test(content)) {
        dataLeakFindings.push(message);
      }
    });

    return {
      securityLevel: this.findingsToRiskLevel(securityFindings.length),
      dataLeakLevel: this.findingsToRiskLevel(dataLeakFindings.length),
      securityFindings: securityFindings.slice(0, 6),
      dataLeakFindings: dataLeakFindings.slice(0, 6),
    };
  }

  private findingsToRiskLevel(count: number): RiskLevel {
    if (count >= 4) {
      return 'critical';
    }
    if (count >= 3) {
      return 'high';
    }
    if (count >= 1) {
      return 'medium';
    }
    return 'low';
  }

  private addImportNodes(
    parsed: ParsedFile,
    rootId: string,
    nodes: Map<string, GraphNode>,
    edges: Map<string, GraphEdge>
  ): void {
    const fileIndex = new Map<string, ParsedFile>([[parsed.path, parsed]]);

    for (const imp of parsed.imports) {
      const resolved = this.resolveImport(imp, parsed.path, fileIndex);
      if (!resolved) {
        continue;
      }
      const nodeId = this.fileNodeId(resolved);

      if (!nodes.has(nodeId)) {
        const label = path.basename(resolved);
        const nodeType: GraphNodeType = 'module';
        nodes.set(
          nodeId,
          {
            id: nodeId,
            type: nodeType,
            position: { x: 0, y: 0 },
            style: this.nodeStyle(nodeType, 1, undefined, 0),
            data: {
              label,
              kind: 'module',
              filePath: resolved,
              relativePath: path.relative(this.rootPath, resolved),
              language: ParserFactory.detectLanguage(resolved),
              parentId: rootId,
              depth: 1,
              external: false,
              expandable: false,
              expanded: true,
              searchText: `${label} ${imp.source}`,
            },
          }
        );
      }

      this.addEdge(
        edges,
        this.linkEdge(
          `import:${rootId}:${nodeId}:${imp.source}`,
          rootId,
          nodeId,
          'import',
          imp.specifiers.join(', ')
        )
      );
    }
  }

  private addInheritanceEdges(
    symbols: CodeSymbol[],
    nodes: Map<string, GraphNode>,
    edges: Map<string, GraphEdge>,
    symbolIndex: Map<string, GraphNode>,
    symbolNameIndex: Map<string, string[]>
  ): void {
    const stack = [...symbols];

    while (stack.length > 0) {
      const symbol = stack.pop()!;
      stack.push(...symbol.children);

      if (!symbol.dependencies.length) {
        continue;
      }

      for (const dependency of symbol.dependencies) {
        const normalized = this.normalizeSymbolKey(dependency);
        const matches = symbolNameIndex.get(normalized);
        let targetId: string;
        let targetType: GraphNodeType = 'external';

        if (matches?.length) {
          targetId = matches[0];
          targetType = symbolIndex.get(targetId)?.type || 'external';
        } else {
          continue;
        }

        const edgeType =
          targetType === 'interface' || dependency.startsWith('I')
            ? 'implementation'
            : 'inheritance';

        this.addEdge(
          edges,
          this.linkEdge(
            `inheritance:${symbol.id}:${targetId}:${dependency}`,
            symbol.id,
            targetId,
            edgeType
          )
        );
      }
    }
  }

  private addCallEdges(
    symbols: CodeSymbol[],
    content: string,
    contentStartLine: number,
    nodes: Map<string, GraphNode>,
    edges: Map<string, GraphEdge>
  ): void {
    const showCallGraph = vscode.workspace.getConfiguration('codeflow').get<boolean>('showCallGraph', true);
    if (!showCallGraph) {
      return;
    }

    const callables = this.flattenSymbols(symbols).filter((symbol) =>
      ['function', 'method', 'hook', 'component', 'test'].includes(symbol.kind)
    );

    const lines = content.split('\n');
    for (const source of callables) {
      const body = this.extractSymbolBody(lines, source, contentStartLine);
      if (!body.trim()) {
        continue;
      }

      for (const target of callables) {
        if (source.id === target.id) {
          continue;
        }

        const targetName = this.simpleName(target.name);
        const callPattern = new RegExp(`\\b${this.escapeRegExp(targetName)}\\s*\\(`);
        if (!callPattern.test(body)) {
          continue;
        }

        if (!nodes.has(source.id) || !nodes.has(target.id)) {
          continue;
        }

        this.addEdge(
          edges,
          this.linkEdge(
            `call:${source.id}:${target.id}`,
            source.id,
            target.id,
            'call'
          )
        );
      }
    }
  }

  private addTestFlowEdges(
    symbols: CodeSymbol[],
    nodes: Map<string, GraphNode>,
    edges: Map<string, GraphEdge>,
    symbolNameIndex: Map<string, string[]>
  ): void {
    const tests = this.flattenSymbols(symbols).filter((symbol) =>
      symbol.kind === 'test' || symbol.kind === 'testSuite'
    );

    for (const testSymbol of tests) {
      const hint = testSymbol.testsTarget || this.inferTestTarget(testSymbol.name);
      if (!hint) {
        continue;
      }

      const normalizedHint = this.normalizeSymbolKey(hint);
      const matches = symbolNameIndex.get(normalizedHint) || [];

      for (const targetId of matches) {
        if (targetId === testSymbol.id || !nodes.has(targetId)) {
          continue;
        }

        this.addEdge(
          edges,
          this.linkEdge(
            `test:${testSymbol.id}:${targetId}`,
            testSymbol.id,
            targetId,
            'testFlow',
            'tests'
          )
        );
      }
    }
  }

  private extractSymbolBody(lines: string[], symbol: CodeSymbol, contentStartLine: number): string {
    const startIndex = Math.max(0, symbol.startLine - contentStartLine + 1);
    const endIndex = Math.min(lines.length, symbol.endLine - contentStartLine + 1);
    return lines.slice(startIndex, endIndex).join('\n');
  }

  private createFolderNode(args: {
    id: string;
    path: string;
    name: string;
    parentId?: string;
    depth: number;
  }): GraphNode {
    return {
      id: args.id,
      type: 'folder',
      position: { x: 0, y: 0 },
      style: this.nodeStyle('folder', args.depth, undefined, 0),
      data: {
        label: args.name,
        kind: 'folder',
        filePath: args.path,
        relativePath: path.relative(this.rootPath, args.path) || args.name,
        parentId: args.parentId,
        depth: args.depth,
        expandable: true,
        // Only the root folder (depth 0) starts expanded — everything else is collapsed
        // so the initial view shows only 2 levels (root + direct children).
        expanded: args.depth === 0,
        searchText: args.name,
      },
    };
  }

  private createFileNode(
    parsed: ParsedFile,
    parentId?: string,
    depth = 0,
    expanded = false,
    insight?: FileTestInsight
  ): GraphNode {
    const flattenedMembers = this.flattenSymbols(parsed.symbols);
    const topLevelMembers = parsed.symbols.filter((symbol) =>
      ['function', 'method', 'hook', 'component', 'route', 'test', 'testSuite'].includes(symbol.kind)
    );
    const memberDetails = topLevelMembers
      .map((symbol) => this.buildMethodSummary(symbol))
      .slice(0, 10);
    // In folder-fast mode symbols[] is empty; use quick regex data stored by parseFileFast.
    type FastParsed = ParsedFile & { _quickClassCount?: number; _quickMethodCount?: number; _quickClassSummaries?: GraphClassSummary[] };
    const quickParsed = parsed as FastParsed;
    const methodCount = flattenedMembers.filter((symbol) =>
      symbol.kind === 'method'
      || symbol.kind === 'function'
      || symbol.kind === 'hook'
      || symbol.kind === 'component'
      || symbol.kind === 'route'
    ).length || (quickParsed._quickMethodCount ?? 0);
    const classCount = flattenedMembers.filter((symbol) =>
      symbol.kind === 'class' || symbol.kind === 'interface' || symbol.kind === 'type' || symbol.kind === 'enum'
    ).length || (quickParsed._quickClassCount ?? 0);
    const testCount = flattenedMembers.filter((symbol) =>
      symbol.kind === 'test' || symbol.kind === 'testSuite'
    ).length;
    // Use full symbol-based summaries if available, fall back to quick regex summaries for folder mode
    const fullClassSummaries = this.collectClassSummaries(parsed.symbols);
    const classSummaries = fullClassSummaries.length > 0 ? fullClassSummaries : (quickParsed._quickClassSummaries ?? []);
    const estimatedWidth = Math.min(
      720,
      Math.max(
        460,
        340 +
          Math.max(
            parsed.name.length * 6,
            ...classSummaries.map((summary) => summary.name.length * 8),
            ...classSummaries.flatMap((s) => s.methods.map((m) => m.length * 7)),
            ...topLevelMembers.map((member) => this.simpleName(member.name).length * 6),
            0
          )
      )
    );
    // Each class block: header(44px) + label section(12px) + methods(22px each, up to 8) + divider(12px)
    const classBlockHeight = classSummaries.reduce((acc, cls) => {
      const methodRows = cls.methodDetails?.length ?? cls.methods.length;
      const flowRows = (cls.methodDetails || []).reduce(
        (sum, detail) => sum + (detail.flowsTo?.length || 0) + (detail.flowsFrom?.length || 0),
        0
      );
      return acc + 44 + 12 + Math.min(methodRows, 10) * 22 + Math.min(flowRows, 10) * 14 + 12;
    }, 0);
    const estimatedHeight =
      210 +                                               // header + metrics grid
      classBlockHeight +
      (topLevelMembers.length > 0 ? 64 : 0) +
      (parsed.dataMappings.length > 0 ? 80 : 0) +
      (parsed.packageReferences.length > 0 ? 60 : 0);

    return {
      id: this.fileNodeId(parsed.path),
      type: 'file',
      position: { x: 0, y: 0 },
      style: {
        ...this.nodeStyle('file', depth, parsed.lineCount, parsed.size),
        width: estimatedWidth,
        minHeight: estimatedHeight,
      },
      data: {
        label: parsed.name,
        kind: 'file',
        filePath: parsed.path,
        relativePath: parsed.relativePath,
        language: parsed.language,
        lineCount: parsed.lineCount,
        byteSize: parsed.size,
        complexity: parsed.complexity,
        imports: parsed.imports.map((imp) => imp.source),
        exports: parsed.exports,
        childCount: parsed.symbols.length,
        memberNames: topLevelMembers
          .map((symbol) => this.simpleName(symbol.name))
          .slice(0, 4),
        memberDetails,
        classSummaries,
        packageRefs: parsed.packageReferences.slice(0, 10),
        dataMappings: parsed.dataMappings.slice(0, 12),
        classCount,
        methodCount,
        testCount,
        testFileCount: parsed.testFile ? 0 : (insight?.testFileCount || 0),
        testCaseCount: insight?.testCaseCount || 0,
        testLineCount: insight?.testLineCount || 0,
        linkedTestFilePath: !parsed.testFile ? insight?.testFilePath : undefined,
        linkedTestRelativePath: !parsed.testFile ? insight?.testRelativePath : undefined,
        linkedTestCaseCount: !parsed.testFile ? insight?.testCaseCount : undefined,
        linkedTestLineCount: !parsed.testFile ? insight?.testLineCount : undefined,
        coverageEstimate: insight?.coverageEstimate,
        desiredCoveragePercent: insight?.desiredCoveragePercent,
        coveredMethodCount: insight?.coveredMethodCount,
        uncoveredMethodCount: insight?.uncoveredMethodCount,
        uncoveredMembers: insight?.uncoveredMembers,
        securityLevel: insight?.securityLevel,
        dataLeakLevel: insight?.dataLeakLevel,
        securityFindings: insight?.securityFindings,
        dataLeakFindings: insight?.dataLeakFindings,
        testStatus: parsed.testFile && testCount > 0 ? 'unknown' : undefined,
        parentId,
        depth,
        expandable:
          parsed.symbols.length > 0
          || parsed.dataMappings.length > 0
          || parsed.packageReferences.length > 0,
        expanded,
        searchText: `${parsed.name} ${parsed.relativePath} ${parsed.language} ${parsed.packageReferences
          .map((reference) => reference.name)
          .join(' ')} ${parsed.dataMappings
          .map((mapping) => `${mapping.source} ${mapping.target}`)
          .join(' ')}`,
      },
    };
  }

  private createSymbolNode(symbol: CodeSymbol, parentId: string, depth: number): GraphNode {
    const nodeType = this.mapSymbolToNodeType(symbol.kind);
    const flattenedChildren = this.flattenSymbols(symbol.children);
    const memberDetails = flattenedChildren
      .filter((child) => ['method', 'function', 'test', 'hook', 'component', 'route'].includes(child.kind))
      .map((child) => this.buildMethodSummary(child))
      .slice(0, 8);
    const estimatedWidth = Math.min(
      520,
      Math.max(
        300,
        240 +
          Math.max(
            symbol.name.length * 6,
            ...flattenedChildren.map((child) => this.simpleName(child.name).length * 5),
            0
          )
      )
    );
    const estimatedHeight =
      140 +
      (flattenedChildren.length > 0 ? Math.min(200, flattenedChildren.length * 22) : 0) +
      (symbol.docComment ? 40 : 0);
    return {
      id: symbol.id,
      type: nodeType,
      position: { x: 0, y: 0 },
      style: {
        ...this.nodeStyle(nodeType, depth, symbol.lineCount, 0),
        width: estimatedWidth,
        minHeight: estimatedHeight,
      },
      data: {
        label: symbol.name,
        kind: symbol.kind,
        filePath: symbol.filePath,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        relativePath: path.relative(this.rootPath, symbol.filePath),
        language: symbol.language,
        lineCount: symbol.lineCount,
        complexity: symbol.complexity,
        visibility: symbol.access,
        isAsync: symbol.isAsync,
        returnType: symbol.returnType,
        parameters: symbol.parameters,
        docComment: symbol.docComment,
        dependencies: symbol.dependencies,
        childCount: symbol.children.length,
        memberNames: flattenedChildren
          .filter((child) => ['method', 'function', 'test', 'hook', 'component', 'route'].includes(child.kind))
          .map((child) => this.simpleName(child.name))
          .slice(0, 6),
        memberDetails,
        classSummaries:
          nodeType === 'class' || nodeType === 'interface' || nodeType === 'type'
            ? [
                this.buildClassSummary(symbol),
              ]
            : undefined,
        dataMappings: symbol.dataMappings?.slice(0, 12),
        methodCount: flattenedChildren.filter((child) =>
          ['method', 'function', 'hook', 'component', 'route'].includes(child.kind)
        ).length,
        testCount: flattenedChildren.filter((child) =>
          child.kind === 'test' || child.kind === 'testSuite'
        ).length,
        testStatus: nodeType === 'test' ? 'unknown' : undefined,
        parentId,
        depth,
        expandable:
          symbol.children.length > 0
          || (symbol.dataMappings?.length || 0) > 0
          || (
            (nodeType === 'class' || nodeType === 'interface' || nodeType === 'type')
            && symbol.children.length > 0
          ),
        expanded: false,
        searchText: `${symbol.name} ${symbol.kind} ${symbol.returnType || ''} ${symbol.docComment || ''}`,
      },
    };
  }

  private nodeStyle(
    type: GraphNodeType,
    depth: number,
    lineCount?: number,
    byteSize?: number
  ): Record<string, string | number> {
    const baseWidth =
      type === 'folder'
        ? 300
        : type === 'file'
          ? 420
          : type === 'module' || type === 'external'
            ? 240
            : 320;
    const widthBoost = Math.min(140, Math.round((lineCount || 0) / 5));
    const sizeBoost = Math.min(80, Math.round((byteSize || 0) / 2000));

    return {
      width: baseWidth + widthBoost + sizeBoost,
      minHeight: type === 'folder' ? 110 : 130,
      opacity: 1,
      zIndex: Math.max(1, 20 - depth),
    };
  }

  private containsEdge(source: string, target: string, type: 'contains'): GraphEdge {
    return this.linkEdge(`contains:${source}:${target}`, source, target, type);
  }

  private linkEdge(
    id: string,
    source: string,
    target: string,
    type: GraphEdge['type'],
    label?: string
  ): GraphEdge {
    return {
      id,
      source,
      target,
      type,
      label,
      animated: type === 'import' || type === 'call' || type === 'testFlow' || type === 'dataFlow',
    };
  }

  private addEdge(edges: Map<string, GraphEdge>, edge: GraphEdge): void {
    if (!edges.has(edge.id)) {
      edges.set(edge.id, edge);
    }
  }

  private updateTestFlowCounts(
    nodes: Map<string, GraphNode>,
    edges: Map<string, GraphEdge>
  ): void {
    const nodeMap = new Map(nodes);

    for (const edge of edges.values()) {
      if (edge.type !== 'testFlow') {
        continue;
      }

      let targetId: string | undefined = edge.target;
      while (targetId) {
        const node = nodeMap.get(targetId);
        if (!node) {
          break;
        }

        const nextCount = Number(node.data.testCount || 0) + 1;
        node.data.testCount = nextCount;
        targetId = node.data.parentId;
      }
    }
  }

  private updateContainerCounts(
    nodes: Map<string, GraphNode>,
    edges: Map<string, GraphEdge>
  ): void {
    const childCounts = new Map<string, number>();

    for (const edge of edges.values()) {
      if (edge.type !== 'contains') {
        continue;
      }

      childCounts.set(edge.source, (childCounts.get(edge.source) || 0) + 1);
    }

    for (const node of nodes.values()) {
      const childCount = childCounts.get(node.id) || node.data.childCount || 0;
      node.data.childCount = childCount;

      if (node.type === 'folder') {
        node.style = {
          ...node.style,
          width: Math.max(Number(node.style?.width || 0), Math.min(360, 210 + childCount * 10)),
        };
      } else if (node.type === 'file') {
        node.style = {
          ...node.style,
          width: Math.max(Number(node.style?.width || 0), Math.min(580, 320 + childCount * 10)),
        };
      }
    }
  }

  private updateFolderTestAggregates(
    nodes: Map<string, GraphNode>,
    edges: Map<string, GraphEdge>
  ): void {
    const childrenByParent = new Map<string, string[]>();
    for (const edge of edges.values()) {
      if (edge.type !== 'contains') {
        continue;
      }
      const children = childrenByParent.get(edge.source) || [];
      children.push(edge.target);
      childrenByParent.set(edge.source, children);
    }

    const aggregateNode = (nodeId: string): {
      testFileCount: number;
      testCaseCount: number;
      testLineCount: number;
      coveredMethodCount: number;
      uncoveredMethodCount: number;
      securityLevel: RiskLevel;
      dataLeakLevel: RiskLevel;
    } => {
      const node = nodes.get(nodeId);
      if (!node) {
        return {
          testFileCount: 0,
          testCaseCount: 0,
          testLineCount: 0,
          coveredMethodCount: 0,
          uncoveredMethodCount: 0,
          securityLevel: 'low',
          dataLeakLevel: 'low',
        };
      }

      const direct = {
        testFileCount:
          node.type === 'file' && !node.data.linkedTestFilePath ? 0 : Number(node.data.testFileCount || 0),
        testCaseCount:
          node.type === 'file' && !node.data.linkedTestFilePath ? 0 : Number(node.data.testCaseCount || 0),
        testLineCount:
          node.type === 'file' && !node.data.linkedTestFilePath ? 0 : Number(node.data.testLineCount || 0),
        coveredMethodCount: Number(node.data.coveredMethodCount || 0),
        uncoveredMethodCount: Number(node.data.uncoveredMethodCount || 0),
        securityLevel: (node.data.securityLevel as RiskLevel) || 'low',
        dataLeakLevel: (node.data.dataLeakLevel as RiskLevel) || 'low',
      };

      for (const childId of childrenByParent.get(nodeId) || []) {
        const child = aggregateNode(childId);
        direct.testFileCount += child.testFileCount;
        direct.testCaseCount += child.testCaseCount;
        direct.testLineCount += child.testLineCount;
        direct.coveredMethodCount += child.coveredMethodCount;
        direct.uncoveredMethodCount += child.uncoveredMethodCount;
        direct.securityLevel = this.maxRiskLevel(direct.securityLevel, child.securityLevel);
        direct.dataLeakLevel = this.maxRiskLevel(direct.dataLeakLevel, child.dataLeakLevel);
      }

      if (node.type === 'folder') {
        node.data.testFileCount = direct.testFileCount;
        node.data.testCaseCount = direct.testCaseCount;
        node.data.testLineCount = direct.testLineCount;
        node.data.coveredMethodCount = direct.coveredMethodCount;
        node.data.uncoveredMethodCount = direct.uncoveredMethodCount;
        const totalMembers = direct.coveredMethodCount + direct.uncoveredMethodCount;
        node.data.coverageEstimate = totalMembers > 0
          ? Math.round((direct.coveredMethodCount / totalMembers) * 100)
          : 0;
        node.data.securityLevel = direct.securityLevel;
        node.data.dataLeakLevel = direct.dataLeakLevel;
      }

      return direct;
    };

    for (const node of nodes.values()) {
      if (node.type === 'folder' && !node.data.parentId) {
        aggregateNode(node.id);
      }
    }
  }

  private maxRiskLevel(current: RiskLevel, next: RiskLevel): RiskLevel {
    const rank: Record<RiskLevel, number> = {
      low: 0,
      medium: 1,
      high: 2,
      critical: 3,
    };
    return rank[next] > rank[current] ? next : current;
  }

  private resolveImport(
    imp: ImportInfo,
    fromFile: string,
    fileIndex: Map<string, ParsedFile>
  ): string | undefined {
    if (imp.source.startsWith('.')) {
      const fromDir = path.dirname(fromFile);
      const extensions = [
        '',
        ...ParserFactory.getSupportedExtensions(),
        ...ParserFactory.getSupportedExtensions().map((extension) => `/index${extension}`),
      ];

      for (const extension of extensions) {
        const resolved = path.resolve(fromDir, `${imp.source}${extension}`);
        if (fileIndex.has(resolved)) {
          return resolved;
        }

        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
          return resolved;
        }
      }

      return undefined;
    }

    return undefined;
  }

  private flattenSymbols(symbols: CodeSymbol[]): CodeSymbol[] {
    const flattened: CodeSymbol[] = [];
    const stack = [...symbols];

    while (stack.length > 0) {
      const symbol = stack.pop()!;
      flattened.push(symbol);
      stack.push(...symbol.children);
    }

    return flattened;
  }

  private countSymbols(symbols: CodeSymbol[]): number {
    return symbols.reduce((total, symbol) => total + 1 + this.countSymbols(symbol.children), 0);
  }

  private detectPackages(filePath: string): PackageInfo[] {
    const directories = this.getAncestorDirectories(filePath);

    for (const directory of directories) {
      const nodePackages = this.readNodePackages(directory);
      if (nodePackages.length > 0) {
        return nodePackages;
      }

      const requirementsPackages = this.readRequirementsPackages(directory);
      if (requirementsPackages.length > 0) {
        return requirementsPackages;
      }

      const pyprojectPackages = this.readPyprojectPackages(directory);
      if (pyprojectPackages.length > 0) {
        return pyprojectPackages;
      }

      const pomPackages = this.readPomPackages(directory);
      if (pomPackages.length > 0) {
        return pomPackages;
      }
    }

    return [];
  }

  private mapSymbolToNodeType(kind: CodeSymbol['kind']): GraphNodeType {
    switch (kind) {
      case 'class':
        return 'class';
      case 'interface':
        return 'interface';
      case 'type':
      case 'enum':
        return 'type';
      case 'test':
      case 'testSuite':
        return 'test';
      case 'variable':
      case 'constant':
        return 'variable';
      case 'method':
        return 'method';
      default:
        return 'function';
    }
  }

  private folderNodeId(folderPath: string): string {
    return `folder:${folderPath}`;
  }

  private externalImportNodeId(source: string): string {
    return `external-import:${source}`;
  }

  private fileNodeId(filePath: string): string {
    return `file:${filePath}`;
  }

  private emptyGraph(
    type: GraphData['metadata']['type'],
    partial: Partial<GraphData['metadata']>
  ): GraphData {
    return {
      nodes: [],
      edges: [],
      metadata: {
        type,
        generatedAt: Date.now(),
        totalFiles: 0,
        totalSymbols: 0,
        totalLines: 0,
        ...partial,
      },
    };
  }

  private extensionForLanguage(language: Language): string {
    const match = Object.entries(LANGUAGE_MAP).find(([, value]) => value === language);
    return match?.[0].slice(1) || 'txt';
  }

  private simpleName(name: string): string {
    return name.split('.').pop() || name;
  }

  private normalizeSymbolKey(name: string): string {
    return this.simpleName(name)
      .replace(/[_\-\s]+/g, '')
      .toLowerCase();
  }

  private inferTestTarget(name: string): string | undefined {
    const normalized = this.simpleName(name)
      .replace(/^test/i, '')
      .replace(/^[\W_]+/, '')
      .replace(/[_-]+/g, ' ')
      .trim();

    return normalized || undefined;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private collectClassSummaries(symbols: CodeSymbol[]): GraphClassSummary[] {
    return symbols
      .filter((symbol) => ['class', 'interface', 'type', 'enum'].includes(symbol.kind))
      .slice(0, 4)
      .map((symbol) => this.buildClassSummary(symbol));
  }

  private buildClassSummary(symbol: CodeSymbol): GraphClassSummary {
    const methodSymbols = symbol.children.filter((child) =>
      ['method', 'function', 'hook', 'component', 'route'].includes(child.kind)
    );
    const testSymbols = symbol.children.filter((child) =>
      child.kind === 'test' || child.kind === 'testSuite'
    );
    const fieldSymbols = symbol.children.filter((child) =>
      child.kind === 'variable' || child.kind === 'constant'
    );

    return {
      nodeId: symbol.id,
      name: symbol.name,
      kind:
        symbol.kind === 'enum'
          ? 'enum'
          : symbol.kind === 'interface'
            ? 'interface'
            : symbol.kind === 'type'
              ? 'type'
              : 'class',
      methods: methodSymbols.map((child) => this.simpleName(child.name)).slice(0, 12),
      methodDetails: methodSymbols.map((child) => this.buildMethodSummary(child)).slice(0, 12),
      tests: testSymbols.map((child) => this.simpleName(child.name)).slice(0, 6),
      fields: fieldSymbols
        .map((child) => child.returnType ? `${child.returnType} ${child.name}` : child.name)
        .slice(0, 10),
      lineCount: symbol.lineCount,
    };
  }

  private buildMethodSummary(symbol: CodeSymbol): GraphMethodSummary {
    const outgoing = (symbol.dataMappings || [])
      .filter((mapping) => mapping.sourceMethod === this.simpleName(symbol.name))
      .map((mapping) => this.mappingTargetDisplay(mapping));
    const incoming = (symbol.dataMappings || [])
      .filter((mapping) => mapping.targetMethod === this.simpleName(symbol.name))
      .map((mapping) => this.mappingSourceDisplay(mapping));

    return {
      nodeId: symbol.id,
      name: this.simpleName(symbol.name),
      kind:
        symbol.kind === 'test'
          ? 'test'
          : symbol.kind === 'hook'
            ? 'hook'
            : symbol.kind === 'component'
              ? 'component'
              : symbol.kind === 'route'
                ? 'route'
              : symbol.kind === 'function'
                ? 'function'
                : 'method',
      lineCount: symbol.lineCount,
      flowsTo: Array.from(new Set(outgoing)).slice(0, 6),
      flowsFrom: Array.from(new Set(incoming)).slice(0, 6),
    };
  }

  private buildPackageReferences(
    language: Language,
    imports: ImportInfo[],
    packages: PackageInfo[]
  ): PackageReference[] {
    const references = new Map<string, PackageReference>();

    for (const dependency of packages) {
      references.set(`${dependency.type}:${dependency.name}`, {
        name: dependency.name,
        source: dependency.name,
        kind: dependency.type,
        version: dependency.version,
      });
    }

    for (const imp of imports) {
      if (!imp.source || imp.source.startsWith('.')) {
        continue;
      }

      const kind: PackageReference['kind'] =
        language === 'java'
          ? 'java-package'
          : language === 'python'
            ? 'python-package'
            : 'import';
      references.set(`${kind}:${imp.source}`, {
        name: imp.source,
        source: imp.source,
        kind,
      });
    }

    return Array.from(references.values()).slice(0, 16);
  }

  private addDataFlowArtifacts(
    parsed: ParsedFile,
    anchorId: string,
    nodes: Map<string, GraphNode>,
    edges: Map<string, GraphEdge>
  ): void {
    for (const mapping of parsed.dataMappings) {
      const sourceMethodNodeId = this.resolveMethodNodeId(mapping, 'source', nodes);
      const targetMethodNodeId = this.resolveMethodNodeId(mapping, 'target', nodes);
      if (sourceMethodNodeId && targetMethodNodeId) {
        this.addEdge(
          edges,
          this.linkEdge(
            `methodflow:${sourceMethodNodeId}:${targetMethodNodeId}:${mapping.source}:${mapping.target}`,
            sourceMethodNodeId,
            targetMethodNodeId,
            'dataFlow',
            mapping.detail || this.mappingLabel(mapping)
          )
        );
        continue;
      }

      const isInject = mapping.operation === 'inject';
      const isCrossService = mapping.operation === 'cross-service';
      const edgeType = isInject ? 'inject' as const : 'dataFlow' as const;

      // For inject/cross-service, try to find matching class nodes in the graph
      if (isInject || isCrossService) {
        const sourceClassName = mapping.source.split('.')[0];
        // Find a class node matching the source name
        let sourceNodeId: string | undefined;
        let targetNodeId: string | undefined;
        for (const [id, node] of nodes) {
          if (node.type === 'class' && node.data.label === sourceClassName) {
            sourceNodeId = id;
          }
        }
        if (sourceNodeId) {
          this.addEdge(
            edges,
            this.linkEdge(
              `${edgeType}:${sourceNodeId}:${anchorId}:${mapping.source}`,
              sourceNodeId,
              anchorId,
              edgeType,
              mapping.detail || this.mappingLabel(mapping)
            )
          );
        }
        continue;
      }

      const sourceEntity = this.extractMappingEntity(mapping.source);
      const targetEntity = this.extractMappingEntity(mapping.target);
      const label = this.mappingLabel(mapping);

      if (sourceEntity) {
        const sourceNodeId = `table:${sourceEntity}`;
        if (!nodes.has(sourceNodeId)) {
          nodes.set(sourceNodeId, this.createExternalDataNode(sourceNodeId, sourceEntity, 'table'));
        }

        this.addEdge(
          edges,
          this.linkEdge(
            `dataflow:${sourceNodeId}:${anchorId}:${mapping.source}`,
            sourceNodeId,
            anchorId,
            'dataFlow',
            label
          )
        );
      }

      if (targetEntity) {
        const targetNodeId = `table:${targetEntity}`;
        if (!nodes.has(targetNodeId)) {
          nodes.set(targetNodeId, this.createExternalDataNode(targetNodeId, targetEntity, 'table'));
        }

        this.addEdge(
          edges,
          this.linkEdge(
            `dataflow:${anchorId}:${targetNodeId}:${mapping.target}`,
            anchorId,
            targetNodeId,
            'dataFlow',
            label
          )
        );
      }
    }
  }

  private createExternalDataNode(
    id: string,
    label: string,
    kind: 'table'
  ): GraphNode {
    return {
      id,
      type: 'external',
      position: { x: 0, y: 0 },
      style: this.nodeStyle('external', 1, undefined, 0),
      data: {
        label,
        kind,
        relativePath: label,
        external: true,
        expandable: false,
        expanded: true,
        searchText: label,
      },
    };
  }

  private extractDataMappings(content: string, language: Language): DataFlowMapping[] {
    const mappings = new Map<string, DataFlowMapping>();
    const lowered = content.toLowerCase();
    const selectMatches = Array.from(
      content.matchAll(/select\s+([\s\S]{1,180}?)\s+from\s+([a-zA-Z0-9_."`]+)/gi)
    );
    const insertMatches = Array.from(
      content.matchAll(/insert\s+into\s+([a-zA-Z0-9_."`]+)\s*\(([\s\S]{1,180}?)\)/gi)
    );
    const updateMatches = Array.from(
      content.matchAll(/update\s+([a-zA-Z0-9_."`]+)\s+set\s+([\s\S]{1,180}?)(?:\s+where|;|\n)/gi)
    );

    for (const selectMatch of selectMatches) {
      const sourceTable = this.cleanSqlIdentifier(selectMatch[2]);
      const sourceColumns = this.parseSqlColumns(selectMatch[1]);
      const downstreamWrites = [
        ...insertMatches.filter((match) => (match.index || 0) > (selectMatch.index || 0)),
        ...updateMatches.filter((match) => (match.index || 0) > (selectMatch.index || 0)),
      ].slice(0, 3);

      for (const writeMatch of downstreamWrites) {
        const targetTable = this.cleanSqlIdentifier(writeMatch[1]);
        const targetColumns = this.parseSqlColumns(writeMatch[2]);
        const pairs = this.pairColumns(sourceTable, sourceColumns, targetTable, targetColumns);

        if (pairs.length === 0) {
          const fallback: DataFlowMapping = {
            source: `${sourceTable}.*`,
            target: `${targetTable}.*`,
            operation: 'sql-flow',
            detail: `SQL data flow detected in ${language} source`,
            confidence: 'medium',
          };
          mappings.set(`${fallback.source}:${fallback.target}:${fallback.operation}`, fallback);
          continue;
        }

        for (const pair of pairs) {
          mappings.set(`${pair.source}:${pair.target}:${pair.operation}`, pair);
        }
      }
    }

    const assignmentPatterns = [
      /(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/g,
      /(\w+)\[['"]([^'"]+)['"]\]\s*=\s*(\w+)\[['"]([^'"]+)['"]\]/g,
      /(\w+)\.(set[A-Z]\w*)\((\w+)\.(get[A-Z]\w*)\(\)\)/g,
    ];

    for (const pattern of assignmentPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const mapping = this.buildAssignmentMapping(match);
        if (mapping) {
          mappings.set(`${mapping.source}:${mapping.target}:${mapping.operation}`, mapping);
        }
      }
    }

    if (lowered.includes('select ') && lowered.includes('insert into ') && mappings.size === 0) {
      mappings.set('sql:*:*', {
        source: 'sql.source',
        target: 'sql.target',
        operation: 'sql-flow',
        detail: 'SQL read/write flow detected but field pairing was low-confidence.',
        confidence: 'low',
      });
    }

    // Java/Kotlin/Spring annotation-based injection patterns
    // @Autowired, @Inject, @Resource → dependency injection data flow
    const injectPatterns = [
      /@(?:Autowired|Inject|Resource)\s*(?:\([^)]*\))?\s*(?:private|protected|public)?\s*(\w+)\s+(\w+)/g,
      /(?:private|protected|public)\s+(?:final\s+)?(\w+)\s+(\w+)\s*;\s*\/\/\s*@(?:Autowired|Inject)/g,
    ];
    for (const pattern of injectPatterns) {
      let injectMatch: RegExpExecArray | null;
      while ((injectMatch = pattern.exec(content)) !== null) {
        const serviceType = injectMatch[1];
        const fieldName = injectMatch[2];
        mappings.set(`inject:${serviceType}:${fieldName}`, {
          source: serviceType,
          target: fieldName,
          operation: 'inject',
          detail: `Dependency injection: ${serviceType} → ${fieldName}`,
          confidence: 'high',
        });
      }
    }

    // Constructor injection pattern (common in modern Spring)
    const ctorInjectRex = /(?:public|protected)\s+\w+\s*\(([\s\S]{1,500}?)\)\s*\{/g;
    let ctorMatch: RegExpExecArray | null;
    while ((ctorMatch = ctorInjectRex.exec(content)) !== null) {
      const params = ctorMatch[1].split(',');
      for (const param of params) {
        const paramMatch = param.trim().match(/(?:@\w+\s+)*(\w+)\s+(\w+)\s*$/);
        if (paramMatch) {
          const serviceType = paramMatch[1];
          const fieldName = paramMatch[2];
          if (serviceType[0] === serviceType[0].toUpperCase() && serviceType.length > 1) {
            mappings.set(`ctor-inject:${serviceType}:${fieldName}`, {
              source: serviceType,
              target: fieldName,
              operation: 'inject',
              detail: `Constructor injection: ${serviceType} → ${fieldName}`,
              confidence: 'high',
            });
          }
        }
      }
    }

    // Method calls that pass data between services: serviceA.method(serviceB.getData())
    const crossServiceCallRex = /(\w+)\.(\w+)\(\s*(\w+)\.(\w+)\(\)/g;
    let crossMatch: RegExpExecArray | null;
    while ((crossMatch = crossServiceCallRex.exec(content)) !== null) {
      if (crossMatch[1] !== crossMatch[3]) { // Different objects
        mappings.set(`xflow:${crossMatch[3]}.${crossMatch[4]}:${crossMatch[1]}.${crossMatch[2]}`, {
          source: `${crossMatch[3]}.${crossMatch[4]}`,
          target: `${crossMatch[1]}.${crossMatch[2]}`,
          operation: 'cross-service',
          detail: `Data flow: ${crossMatch[3]}.${crossMatch[4]}() → ${crossMatch[1]}.${crossMatch[2]}()`,
          confidence: 'medium',
        });
      }
    }

    return Array.from(mappings.values()).slice(0, 30);
  }

  private buildAssignmentMapping(match: RegExpExecArray): DataFlowMapping | undefined {
    if (match[2]?.startsWith('set') && match[4]?.startsWith('get')) {
      return {
        source: `${match[3]}.${this.camelFromAccessor(match[4])}`,
        target: `${match[1]}.${this.camelFromAccessor(match[2])}`,
        operation: 'setter',
        detail: 'Setter/getter assignment',
        confidence: 'medium',
      };
    }

    if (match[0].includes('[')) {
      return {
        source: `${match[3]}.${match[4]}`,
        target: `${match[1]}.${match[2]}`,
        operation: 'assignment',
        detail: 'Map or dictionary assignment',
        confidence: 'medium',
      };
    }

    return {
      source: `${match[3]}.${match[4]}`,
      target: `${match[1]}.${match[2]}`,
      operation: 'assignment',
      detail: 'Direct field assignment',
      confidence: 'medium',
    };
  }

  private pairColumns(
    sourceTable: string,
    sourceColumns: string[],
    targetTable: string,
    targetColumns: string[]
  ): DataFlowMapping[] {
    if (sourceColumns.length === 0 && targetColumns.length === 0) {
      return [];
    }

    const mappings: DataFlowMapping[] = [];
    const pairCount =
      sourceColumns.length === targetColumns.length
        ? sourceColumns.length
        : Math.min(sourceColumns.length, targetColumns.length);

    for (let index = 0; index < pairCount; index += 1) {
      const sourceColumn = sourceColumns[index] || sourceColumns[0] || '*';
      const targetColumn = targetColumns[index] || targetColumns[0] || '*';
      mappings.push({
        source: `${sourceTable}.${sourceColumn}`,
        target: `${targetTable}.${targetColumn}`,
        operation: 'sql-map',
        detail: 'SQL source to sink field mapping',
        confidence:
          sourceColumns.length === targetColumns.length && sourceColumns.length > 0
            ? 'high'
            : 'medium',
      });
    }

    return mappings;
  }

  private parseSqlColumns(columnSegment: string): string[] {
    return columnSegment
      .split(',')
      .map((column) => column.trim())
      .map((column) => {
        const aliasMatch = column.match(/\bas\s+([a-zA-Z0-9_]+)/i);
        if (aliasMatch) {
          return aliasMatch[1];
        }

        return this.cleanSqlIdentifier(column.split(/\s+/)[0] || column);
      })
      .filter(Boolean)
      .slice(0, 12);
  }

  private cleanSqlIdentifier(value: string): string {
    return value.replace(/["'`]/g, '').split('.').filter(Boolean).pop() || value;
  }

  private isLikelyTextBuffer(buffer: Buffer, filePath: string): boolean {
    const binaryExtensions = new Set([
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.bmp',
      '.ico',
      '.jar',
      '.class',
      '.war',
      '.zip',
      '.gz',
      '.pdf',
      '.mp4',
      '.mp3',
      '.woff',
      '.woff2',
      '.ttf',
    ]);
    if (binaryExtensions.has(path.extname(filePath).toLowerCase())) {
      return false;
    }

    const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
    return !sample.includes(0);
  }

  private extractMappingEntity(value: string): string | undefined {
    if (!value.includes('.')) {
      return undefined;
    }

    const [entity] = value.split('.', 1);
    const cleaned = entity.replace(/["'`]/g, '').trim();
    if (!cleaned || ['row', 'record', 'item', 'obj', 'data', 'dto', 'entity'].includes(cleaned)) {
      return undefined;
    }

    return cleaned;
  }

  private mappingLabel(mapping: DataFlowMapping): string {
    const sourceField = mapping.source.split('.').slice(1).join('.') || mapping.source;
    const targetField = mapping.target.split('.').slice(1).join('.') || mapping.target;
    return `${sourceField} -> ${targetField}`;
  }

  private mappingSourceDisplay(mapping: DataFlowMapping): string {
    return mapping.sourceMethod
      ? this.qualifiedSymbolLabel(mapping.sourceClass, mapping.sourceMethod)
      : mapping.source;
  }

  private mappingTargetDisplay(mapping: DataFlowMapping): string {
    return mapping.targetMethod
      ? this.qualifiedSymbolLabel(mapping.targetClass, mapping.targetMethod)
      : mapping.target;
  }

  private resolveMethodNodeId(
    mapping: DataFlowMapping,
    role: 'source' | 'target',
    nodes: Map<string, GraphNode>
  ): string | undefined {
    const methodName = role === 'source' ? mapping.sourceMethod : mapping.targetMethod;
    const className = role === 'source' ? mapping.sourceClass : mapping.targetClass;
    if (!methodName) {
      return undefined;
    }

    for (const node of nodes.values()) {
      if (!['method', 'function', 'test'].includes(node.type)) {
        continue;
      }

      if (this.simpleName(String(node.data.label)) !== this.simpleName(methodName)) {
        continue;
      }

      if (!className) {
        return node.id;
      }

      let parentId = typeof node.data.parentId === 'string' ? node.data.parentId : undefined;
      while (parentId) {
        const parent = nodes.get(parentId);
        if (!parent) {
          break;
        }

        if (
          ['class', 'interface', 'type'].includes(parent.type)
          && String(parent.data.label) === className
        ) {
          return node.id;
        }

        parentId = typeof parent.data.parentId === 'string' ? parent.data.parentId : undefined;
      }
    }

    return undefined;
  }

  private camelFromAccessor(accessor: string): string {
    const trimmed = accessor.replace(/^(set|get)/, '');
    return trimmed ? `${trimmed.charAt(0).toLowerCase()}${trimmed.slice(1)}` : accessor;
  }

  private getAncestorDirectories(filePath: string): string[] {
    const directories: string[] = [];
    let current = path.dirname(filePath);
    const root = path.resolve(this.rootPath);

    while (true) {
      directories.push(current);
      if (path.resolve(current) === root) {
        break;
      }

      const parent = path.dirname(current);
      if (parent === current || !path.resolve(parent).startsWith(root)) {
        break;
      }

      current = parent;
    }

    return directories;
  }

  private readNodePackages(directory: string): PackageInfo[] {
    const packageFile = path.join(directory, 'package.json');
    if (!fs.existsSync(packageFile)) {
      return [];
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };

      return [
        ...Object.entries(parsed.dependencies || {}).map(([name, version]) => ({
          name,
          version,
          type: 'dependency' as const,
        })),
        ...Object.entries(parsed.devDependencies || {}).map(([name, version]) => ({
          name,
          version,
          type: 'devDependency' as const,
        })),
        ...Object.entries(parsed.peerDependencies || {}).map(([name, version]) => ({
          name,
          version,
          type: 'peerDependency' as const,
        })),
      ];
    } catch {
      return [];
    }
  }

  private readRequirementsPackages(directory: string): PackageInfo[] {
    const requirementsFile = path.join(directory, 'requirements.txt');
    if (!fs.existsSync(requirementsFile)) {
      return [];
    }

    try {
      const packages: PackageInfo[] = [];
      for (const line of fs.readFileSync(requirementsFile, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          continue;
        }

        const match = trimmed.match(/^([a-zA-Z0-9_.-]+)(?:\[.+\])?(?:[=><!~]{1,2}(.+))?$/);
        if (!match) {
          continue;
        }

        packages.push({
          name: match[1],
          version: match[2]?.trim(),
          type: 'dependency',
        });
      }

      return packages.slice(0, 50);
    } catch {
      return [];
    }
  }

  private readPyprojectPackages(directory: string): PackageInfo[] {
    const pyprojectFile = path.join(directory, 'pyproject.toml');
    if (!fs.existsSync(pyprojectFile)) {
      return [];
    }

    try {
      const content = fs.readFileSync(pyprojectFile, 'utf8');
      const dependencyBlock = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
      if (!dependencyBlock) {
        return [];
      }

      const packages: PackageInfo[] = [];
      for (const match of dependencyBlock[1].matchAll(/['"]([^'"]+)['"]/g)) {
        const nameMatch = match[1].match(/^([a-zA-Z0-9_.-]+)/);
        if (!nameMatch) {
          continue;
        }

        packages.push({
          name: nameMatch[1],
          version: match[1].slice(nameMatch[1].length).trim() || undefined,
          type: 'dependency',
        });
      }

      return packages.slice(0, 50);
    } catch {
      return [];
    }
  }

  private readPomPackages(directory: string): PackageInfo[] {
    const pomFile = path.join(directory, 'pom.xml');
    if (!fs.existsSync(pomFile)) {
      return [];
    }

    try {
      const content = fs.readFileSync(pomFile, 'utf8');
      return Array.from(
        content.matchAll(
          /<dependency>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?(?:<version>([^<]+)<\/version>)?[\s\S]*?<\/dependency>/g
        )
      )
        .map((match) => ({
          name: match[1],
          version: match[2],
          type: 'dependency' as const,
        }))
        .slice(0, 50);
    } catch {
      return [];
    }
  }
}
