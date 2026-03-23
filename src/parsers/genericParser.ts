import { CodeSymbol, ImportInfo, Language, ParameterInfo } from '../types';
import { BaseParser } from './baseParser';

/**
 * Generic parser using regex heuristics.
 * Works for Rust, C#, C/C++, Ruby, PHP, Swift, Kotlin, Scala, Dart, etc.
 * Provides reasonable results for any language with common patterns.
 */
export class GenericParser extends BaseParser {
  language: Language;
  supportedExtensions: string[];

  constructor(language: Language, extensions: string[]) {
    super();
    this.language = language;
    this.supportedExtensions = extensions;
  }

  // Language-specific patterns
  private readonly PATTERNS: Record<string, {
    class: RegExp[];
    function: RegExp[];
    import: RegExp[];
    test: RegExp[];
    testFile: RegExp[];
  }> = {
    rust: {
      class: [/^(?:pub\s+)?struct\s+(\w+)/, /^(?:pub\s+)?enum\s+(\w+)/, /^(?:pub\s+)?trait\s+(\w+)/],
      function: [/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*->\s*(.+?))?\s*(?:where\s+.+?)?\s*\{?/],
      import: [/^use\s+(.+?);/],
      test: [/^#\[test\]/, /^#\[tokio::test\]/],
      testFile: [/tests?\.rs$/, /tests?\//],
    },
    csharp: {
      class: [/^(?:(?:public|private|protected|internal|abstract|sealed|static|partial)\s+)*class\s+(\w+)/,
              /^(?:(?:public|private|protected|internal)\s+)*interface\s+(\w+)/,
              /^(?:(?:public|private|protected|internal)\s+)*enum\s+(\w+)/,
              /^(?:(?:public|private|protected|internal)\s+)*record\s+(\w+)/],
      function: [/^(?:(?:public|private|protected|internal|static|virtual|override|abstract|async)\s+)*(?:[\w<>\[\]?,]+\s+)(\w+)\s*\(([^)]*)\)/],
      import: [/^using\s+(?:static\s+)?(.+?);/],
      test: [/\[Test\]/, /\[Fact\]/, /\[Theory\]/],
      testFile: [/Tests?\.cs$/, /\.Tests?\//],
    },
    cpp: {
      class: [/^(?:class|struct)\s+(\w+)/],
      function: [/^(?:(?:virtual|static|inline|explicit|constexpr|const|volatile)\s+)*(?:[\w:*&<>]+\s+)+(\w+)\s*\(([^)]*)\)/],
      import: [/^#include\s+[<"](.+?)[>"]/],
      test: [/TEST\s*\(/, /TEST_F\s*\(/],
      testFile: [/test[_.]/, /_test\./],
    },
    ruby: {
      class: [/^class\s+(\w+)(?:\s*<\s*(\w+))?/, /^module\s+(\w+)/],
      function: [/^def\s+(\w+[\?!]?)\s*(?:\(([^)]*)\))?/],
      import: [/^require\s+['"](.+?)['"]/, /^require_relative\s+['"](.+?)['"]/],
      test: [/def\s+test_/, /it\s+['"]/, /describe\s+['"]/],
      testFile: [/_test\.rb$/, /_spec\.rb$/, /spec\//],
    },
    php: {
      class: [/^(?:(?:abstract|final)\s+)?class\s+(\w+)/, /^interface\s+(\w+)/, /^trait\s+(\w+)/],
      function: [/^(?:(?:public|private|protected|static)\s+)*function\s+(\w+)\s*\(([^)]*)\)/],
      import: [/^use\s+(.+?);/, /^(?:require|include)(?:_once)?\s+['"](.+?)['"]/],
      test: [/function\s+test\w+/, /@test/],
      testFile: [/Test\.php$/, /tests?\//],
    },
    swift: {
      class: [/^(?:(?:public|private|internal|open|fileprivate)\s+)?(?:final\s+)?class\s+(\w+)/,
              /^(?:(?:public|private|internal)\s+)?struct\s+(\w+)/,
              /^(?:(?:public|private|internal)\s+)?protocol\s+(\w+)/,
              /^(?:(?:public|private|internal)\s+)?enum\s+(\w+)/],
      function: [/^(?:(?:public|private|internal|open|fileprivate|static|class|override|mutating)\s+)*func\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*->\s*(.+?))?\s*\{?/],
      import: [/^import\s+(.+)/],
      test: [/func\s+test\w+/],
      testFile: [/Tests?\.swift$/, /Tests?\//],
    },
    kotlin: {
      class: [/^(?:(?:public|private|protected|internal|abstract|open|sealed|data|inner)\s+)*class\s+(\w+)/,
              /^(?:(?:public|private|protected|internal)\s+)?interface\s+(\w+)/,
              /^(?:(?:public|private|protected|internal)\s+)?enum\s+class\s+(\w+)/,
              /^(?:(?:public|private|protected|internal)\s+)?object\s+(\w+)/],
      function: [/^(?:(?:public|private|protected|internal|override|suspend|inline)\s+)*fun\s+(?:<[^>]*>\s+)?(\w+)\s*\(([^)]*)\)(?:\s*:\s*(.+?))?\s*\{?/],
      import: [/^import\s+(.+)/],
      test: [/@Test/, /fun\s+`[^`]+`/],
      testFile: [/Test\.kt$/, /Tests?\.kt$/],
    },
    scala: {
      class: [/^(?:(?:abstract|sealed|case|final)\s+)?class\s+(\w+)/,
              /^trait\s+(\w+)/,
              /^object\s+(\w+)/],
      function: [/^(?:(?:override|private|protected)\s+)?def\s+(\w+)(?:\s*\[.+?\])?\s*(?:\(([^)]*)\))?(?:\s*:\s*(.+?))?\s*[={]/],
      import: [/^import\s+(.+)/],
      test: [/def\s+test/, /"should/, /it\s+should/],
      testFile: [/Spec\.scala$/, /Test\.scala$/, /Suite\.scala$/],
    },
    dart: {
      class: [/^(?:abstract\s+)?class\s+(\w+)/, /^mixin\s+(\w+)/, /^enum\s+(\w+)/],
      function: [/^(?:(?:static|Future|Stream|void|int|double|String|bool|dynamic|List|Map|Set)\s+)*(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*async)?\s*\{?/],
      import: [/^import\s+['"](.+?)['"]/],
      test: [/test\s*\(/, /testWidgets\s*\(/],
      testFile: [/_test\.dart$/],
    },
    default: {
      class: [/^(?:class|struct|interface|type|module)\s+(\w+)/],
      function: [/^(?:function|func|def|fn|sub|proc|method)\s+(\w+)\s*\(([^)]*)\)/],
      import: [/^(?:import|require|include|use|from)\s+(.+)/],
      test: [/test|spec|assert/i],
      testFile: [/test|spec/i],
    },
  };

  parseContent(content: string, filePath: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    const lines = content.split('\n');
    const patterns = this.PATTERNS[this.language] || this.PATTERNS.default;
    let isNextTest = false;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

      // Check for test annotations
      if (patterns.test.some(p => p.test(trimmed))) {
        isNextTest = true;
        if (trimmed.match(/^\[|^@|^#\[/)) continue; // Just an annotation, skip to next line
      }

      // Classes/Structs/Interfaces
      for (const pattern of patterns.class) {
        const match = trimmed.match(pattern);
        if (match) {
          const endLine = trimmed.includes('{') ? this.findClosingBracket(lines, i, '{', '}') :
            this.findIndentBlockEnd(lines, i);
          symbols.push({
            id: this.generateId(filePath, match[1], 'class', i),
            name: match[1],
            kind: trimmed.includes('interface') || trimmed.includes('trait') || trimmed.includes('protocol') ? 'interface' : 'class',
            language: this.language,
            filePath,
            startLine: i + 1,
            endLine: endLine + 1,
            lineCount: endLine - i + 1,
            children: [],
            imports: [],
            exports: [],
            dependencies: [],
            decorators: this.extractDecorators(lines, i),
            docComment: this.extractDocComment(lines, i),
          });
          break;
        }
      }

      // Functions/Methods
      for (const pattern of patterns.function) {
        const match = trimmed.match(pattern);
        if (match && !symbols.find(s => s.name === match[1] && s.startLine === i + 1)) {
          const endLine = trimmed.includes('{') ? this.findClosingBracket(lines, i, '{', '}') :
            this.findIndentBlockEnd(lines, i);
          symbols.push({
            id: this.generateId(filePath, match[1], isNextTest ? 'test' : 'function', i),
            name: match[1],
            kind: isNextTest ? 'test' : 'function',
            language: this.language,
            filePath,
            startLine: i + 1,
            endLine: endLine + 1,
            lineCount: endLine - i + 1,
            children: [],
            imports: [],
            exports: [],
            dependencies: [],
            parameters: match[2] ? this.parseGenericParams(match[2]) : [],
            returnType: match[3]?.trim(),
            decorators: this.extractDecorators(lines, i),
            docComment: this.extractDocComment(lines, i),
            testsTarget: isNextTest ? match[1].replace(/^test_?/i, '') : undefined,
          });
          isNextTest = false;
          break;
        }
      }
    }

    return symbols;
  }

  parseImports(content: string): ImportInfo[] {
    const imports: ImportInfo[] = [];
    const lines = content.split('\n');
    const patterns = this.PATTERNS[this.language] || this.PATTERNS.default;

    for (let i = 0; i < lines.length; i++) {
      for (const pattern of patterns.import) {
        const match = lines[i].trim().match(pattern);
        if (match) {
          const source = match[1].replace(/;$/, '').trim();
          const parts = source.split(/[./\\:]+/);
          imports.push({
            source,
            specifiers: [parts[parts.length - 1]],
            isDefault: true,
            isNamespace: false,
            line: i + 1,
          });
          break;
        }
      }
    }

    return imports;
  }

  isTestFile(filePath: string, content: string): boolean {
    const patterns = this.PATTERNS[this.language] || this.PATTERNS.default;
    return patterns.testFile.some(p => p.test(filePath));
  }

  private findIndentBlockEnd(lines: string[], startLine: number): number {
    const startIndent = lines[startLine].length - lines[startLine].trimStart().length;
    for (let i = startLine + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= startIndent) return i - 1;
    }
    return lines.length - 1;
  }

  private parseGenericParams(paramString: string): ParameterInfo[] {
    if (!paramString.trim()) return [];
    return paramString.split(',').map(p => {
      const trimmed = p.trim();
      const parts = trimmed.split(/\s*:\s*|\s+/);
      return {
        name: parts[0].replace(/^&\s*(?:mut\s+)?/, ''),
        type: parts.length > 1 ? parts.slice(1).join(' ') : undefined,
      };
    });
  }
}
