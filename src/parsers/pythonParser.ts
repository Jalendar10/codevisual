import { CodeSymbol, ImportInfo, Language, ParameterInfo, SymbolKind } from '../types';
import { BaseParser } from './baseParser';

/**
 * Parser for Python files.
 * Handles .py, .pyw files
 */
export class PythonParser extends BaseParser {
  language: Language = 'python';
  supportedExtensions = ['.py', '.pyw'];

  parseContent(content: string, filePath: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    const lines = content.split('\n');
    const indentStack: { indent: number; endLine: number }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const indent = line.length - line.trimStart().length;

      if (!trimmed || trimmed.startsWith('#')) continue;

      // Classes
      const classMatch = trimmed.match(/^class\s+(\w+)(?:\(([^)]*)\))?\s*:/);
      if (classMatch) {
        const endLine = this.findPythonBlockEnd(lines, i, indent);
        const bases = classMatch[2]?.split(',').map(s => s.trim()).filter(Boolean) || [];
        symbols.push({
          id: this.generateId(filePath, classMatch[1], 'class', i),
          name: classMatch[1],
          kind: 'class',
          language: this.language,
          filePath,
          startLine: i + 1,
          endLine: endLine + 1,
          lineCount: endLine - i + 1,
          children: this.parseClassBody(lines, i, endLine, indent, filePath),
          imports: [],
          exports: [],
          dependencies: bases,
          decorators: this.extractDecorators(lines, i),
          docComment: this.extractPythonDocstring(lines, i + 1),
        });
        continue;
      }

      // Functions/Methods
      const funcMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*(.+?))?\s*:/);
      if (funcMatch) {
        const endLine = this.findPythonBlockEnd(lines, i, indent);
        const isTest = funcMatch[1].startsWith('test_') || funcMatch[1].startsWith('test');
        symbols.push({
          id: this.generateId(filePath, funcMatch[1], isTest ? 'test' : 'function', i),
          name: funcMatch[1],
          kind: isTest ? 'test' : 'function',
          language: this.language,
          filePath,
          startLine: i + 1,
          endLine: endLine + 1,
          lineCount: endLine - i + 1,
          children: [],
          imports: [],
          exports: [],
          dependencies: [],
          isAsync: trimmed.startsWith('async'),
          parameters: this.parsePythonParams(funcMatch[2]),
          returnType: funcMatch[3]?.trim(),
          decorators: this.extractDecorators(lines, i),
          docComment: this.extractPythonDocstring(lines, i + 1),
          testsTarget: isTest ? this.inferTestTarget(funcMatch[1]) : undefined,
        });
        continue;
      }

      // Module-level constants (ALL_CAPS)
      const constMatch = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*(?::\s*\w+\s*)?=/);
      if (constMatch && indent === 0) {
        symbols.push({
          id: this.generateId(filePath, constMatch[1], 'constant', i),
          name: constMatch[1],
          kind: 'constant',
          language: this.language,
          filePath,
          startLine: i + 1,
          endLine: i + 1,
          lineCount: 1,
          children: [],
          imports: [],
          exports: [],
          dependencies: [],
        });
      }
    }

    return symbols;
  }

  parseImports(content: string): ImportInfo[] {
    const imports: ImportInfo[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // from X import Y, Z
      const fromImport = line.match(/^from\s+([\w.]+)\s+import\s+(.+)/);
      if (fromImport) {
        const source = fromImport[1];
        let specifiers: string[];
        if (fromImport[2].startsWith('(')) {
          // Multi-line import
          let importStr = fromImport[2];
          while (!importStr.includes(')') && i < lines.length - 1) {
            i++;
            importStr += lines[i].trim();
          }
          specifiers = importStr.replace(/[()]/g, '').split(',').map(s => s.trim().split(' as ')[0]).filter(Boolean);
        } else {
          specifiers = fromImport[2].split(',').map(s => s.trim().split(' as ')[0]).filter(Boolean);
        }
        imports.push({ source, specifiers, isDefault: false, isNamespace: false, line: i + 1 });
        continue;
      }

      // import X
      const directImport = line.match(/^import\s+([\w.]+)(?:\s+as\s+(\w+))?/);
      if (directImport) {
        imports.push({
          source: directImport[1],
          specifiers: [directImport[2] || directImport[1]],
          isDefault: true,
          isNamespace: true,
          line: i + 1,
        });
      }
    }

    return imports;
  }

  isTestFile(filePath: string, content: string): boolean {
    const testPatterns = [
      /test_[\w]+\.py$/,
      /[\w]+_test\.py$/,
      /tests?\//,
      /conftest\.py$/,
    ];
    if (testPatterns.some(p => p.test(filePath))) return true;
    return /\b(pytest|unittest|assert|TestCase)\b/.test(content.slice(0, 2000));
  }

  private findPythonBlockEnd(lines: string[], startLine: number, startIndent: number): number {
    for (let i = startLine + 1; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) continue; // Skip blank lines

      const currentIndent = line.length - line.trimStart().length;
      if (currentIndent <= startIndent && trimmed !== '') {
        return i - 1;
      }
    }
    return lines.length - 1;
  }

  private parseClassBody(lines: string[], startLine: number, endLine: number, classIndent: number, filePath: string): CodeSymbol[] {
    const members: CodeSymbol[] = [];
    const memberIndent = classIndent + 4; // Standard Python indent

    for (let i = startLine + 1; i <= endLine; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const indent = line.length - line.trimStart().length;

      if (!trimmed || indent < memberIndent) continue;

      const methodMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*(.+?))?\s*:/);
      if (methodMatch && indent === memberIndent) {
        const methodEnd = this.findPythonBlockEnd(lines, i, indent);
        const isPrivate = methodMatch[1].startsWith('_') && !methodMatch[1].startsWith('__');
        const isDunder = methodMatch[1].startsWith('__') && methodMatch[1].endsWith('__');
        members.push({
          id: this.generateId(filePath, methodMatch[1], 'method', i),
          name: methodMatch[1],
          kind: 'method',
          language: this.language,
          filePath,
          startLine: i + 1,
          endLine: methodEnd + 1,
          lineCount: methodEnd - i + 1,
          children: [],
          imports: [],
          exports: [],
          dependencies: [],
          access: isDunder ? 'public' : isPrivate ? 'private' : 'public',
          isAsync: trimmed.startsWith('async'),
          parameters: this.parsePythonParams(methodMatch[2]),
          returnType: methodMatch[3]?.trim(),
          decorators: this.extractDecorators(lines, i),
          docComment: this.extractPythonDocstring(lines, i + 1),
        });
      }
    }
    return members;
  }

  private parsePythonParams(paramString: string): ParameterInfo[] {
    if (!paramString.trim()) return [];
    return paramString
      .split(',')
      .map(p => p.trim())
      .filter(p => p && p !== 'self' && p !== 'cls')
      .map(p => {
        const match = p.match(/^(\*{0,2}\w+)(?:\s*:\s*(.+?))?(?:\s*=\s*(.+))?$/);
        if (match) {
          return {
            name: match[1],
            type: match[2]?.trim(),
            defaultValue: match[3]?.trim(),
            isOptional: !!match[3],
          };
        }
        return { name: p };
      });
  }

  private extractPythonDocstring(lines: string[], afterDefLine: number): string | undefined {
    for (let i = afterDefLine; i < Math.min(afterDefLine + 3, lines.length); i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
        const quote = trimmed.slice(0, 3);
        if (trimmed.endsWith(quote) && trimmed.length > 6) {
          return trimmed.slice(3, -3);
        }
        // Multi-line docstring
        const parts: string[] = [trimmed.slice(3)];
        for (let j = i + 1; j < lines.length; j++) {
          const jTrimmed = lines[j].trim();
          if (jTrimmed.includes(quote)) {
            parts.push(jTrimmed.replace(quote, ''));
            return parts.join('\n').trim();
          }
          parts.push(jTrimmed);
        }
      }
    }
    return undefined;
  }

  private inferTestTarget(testName: string): string {
    return testName
      .replace(/^test_?/, '')
      .replace(/_/g, ' ')
      .trim();
  }
}
