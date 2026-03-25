import { CodeSymbol, ImportInfo, Language, ParameterInfo } from '../types';
import { BaseParser } from './baseParser';

/**
 * Parser for Python files.
 * Handles multiline class/def signatures, decorators, async defs, nested classes,
 * tabs/spaces indentation, and common class/method layouts.
 */
export class PythonParser extends BaseParser {
  language: Language = 'python';
  supportedExtensions = ['.py', '.pyw'];

  parseContent(content: string, filePath: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      const indent = this.indentOf(line);

      if (!trimmed || trimmed.startsWith('#') || indent !== 0 || trimmed.startsWith('@')) {
        continue;
      }

      const signature = this.collectPythonSignature(lines, i);
      const normalized = signature.text.replace(/\s+/g, ' ').trim();

      const classMatch = normalized.match(/^class\s+(\w+)(?:\(([\s\S]*?)\))?\s*:/);
      if (classMatch) {
        const endLine = this.findPythonBlockEnd(lines, signature.endLine, indent);
        const bases = classMatch[2]?.split(',').map((part) => part.trim()).filter(Boolean) || [];
        symbols.push({
          id: this.generateId(filePath, classMatch[1], 'class', i),
          name: classMatch[1],
          kind: 'class',
          language: this.language,
          filePath,
          startLine: i + 1,
          endLine: endLine + 1,
          lineCount: endLine - i + 1,
          children: this.parseClassBody(lines, signature.endLine, endLine, indent, filePath),
          imports: [],
          exports: [],
          dependencies: bases,
          decorators: this.extractDecorators(lines, i),
          docComment: this.extractPythonDocstring(lines, signature.endLine + 1),
        });
        i = signature.endLine;
        continue;
      }

      const funcMatch = normalized.match(/^(async\s+)?def\s+(\w+)\s*\(([\s\S]*?)\)(?:\s*->\s*([^:]+))?\s*:/);
      if (funcMatch) {
        const endLine = this.findPythonBlockEnd(lines, signature.endLine, indent);
        const isTest = funcMatch[2].startsWith('test_') || funcMatch[2].startsWith('test');
        symbols.push({
          id: this.generateId(filePath, funcMatch[2], isTest ? 'test' : 'function', i),
          name: funcMatch[2],
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
          isAsync: !!funcMatch[1],
          parameters: this.parseParameters(funcMatch[3]).filter(
            (parameter) => parameter.name !== 'self' && parameter.name !== 'cls'
          ),
          returnType: funcMatch[4]?.trim(),
          decorators: this.extractDecorators(lines, i),
          docComment: this.extractPythonDocstring(lines, signature.endLine + 1),
          testsTarget: isTest ? this.inferTestTarget(funcMatch[2]) : undefined,
        });
        i = signature.endLine;
        continue;
      }

      const constMatch = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*(?::\s*[^=]+)?=/);
      if (constMatch) {
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

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();

      const fromImport = line.match(/^from\s+([\w.]+)\s+import\s+(.+)/);
      if (fromImport) {
        const source = fromImport[1];
        let specifiers: string[];
        if (fromImport[2].startsWith('(')) {
          let importStr = fromImport[2];
          while (!importStr.includes(')') && i < lines.length - 1) {
            i += 1;
            importStr += lines[i].trim();
          }
          specifiers = importStr
            .replace(/[()]/g, '')
            .split(',')
            .map((value) => value.trim().split(' as ')[0])
            .filter(Boolean);
        } else {
          specifiers = fromImport[2]
            .split(',')
            .map((value) => value.trim().split(' as ')[0])
            .filter(Boolean);
        }

        imports.push({ source, specifiers, isDefault: false, isNamespace: false, line: i + 1 });
        continue;
      }

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
    if (testPatterns.some((pattern) => pattern.test(filePath))) {
      return true;
    }
    return /\b(pytest|unittest|assert|TestCase)\b/.test(content.slice(0, 2000));
  }

  protected parseSingleParam(param: string): ParameterInfo {
    const cleaned = param.trim();
    const match = cleaned.match(/^(\*{0,2}\w+)(?:\s*:\s*(.+?))?(?:\s*=\s*(.+))?$/);
    if (!match) {
      return { name: cleaned };
    }

    return {
      name: match[1],
      type: match[2]?.trim(),
      defaultValue: match[3]?.trim(),
      isOptional: !!match[3],
    };
  }

  private findPythonBlockEnd(lines: string[], startLine: number, startIndent: number): number {
    for (let i = startLine + 1; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (!trimmed) {
        continue;
      }

      const currentIndent = this.indentOf(lines[i]);
      if (currentIndent <= startIndent) {
        return i - 1;
      }
    }

    return lines.length - 1;
  }

  private parseClassBody(
    lines: string[],
    declarationEndLine: number,
    endLine: number,
    classIndent: number,
    filePath: string
  ): CodeSymbol[] {
    const members: CodeSymbol[] = [];
    const memberIndent = this.findMemberIndent(lines, declarationEndLine + 1, endLine, classIndent);

    for (let i = declarationEndLine + 1; i <= endLine; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      const indent = this.indentOf(line);

      if (!trimmed || trimmed.startsWith('#') || indent !== memberIndent || trimmed.startsWith('@')) {
        continue;
      }

      const signature = this.collectPythonSignature(lines, i);
      const normalized = signature.text.replace(/\s+/g, ' ').trim();

      const nestedClassMatch = normalized.match(/^class\s+(\w+)(?:\(([\s\S]*?)\))?\s*:/);
      if (nestedClassMatch) {
        const nestedEnd = this.findPythonBlockEnd(lines, signature.endLine, indent);
        members.push({
          id: this.generateId(filePath, nestedClassMatch[1], 'class', i),
          name: nestedClassMatch[1],
          kind: 'class',
          language: this.language,
          filePath,
          startLine: i + 1,
          endLine: nestedEnd + 1,
          lineCount: nestedEnd - i + 1,
          children: this.parseClassBody(lines, signature.endLine, nestedEnd, indent, filePath),
          imports: [],
          exports: [],
          dependencies:
            nestedClassMatch[2]?.split(',').map((part) => part.trim()).filter(Boolean) || [],
          decorators: this.extractDecorators(lines, i),
          docComment: this.extractPythonDocstring(lines, signature.endLine + 1),
        });
        i = signature.endLine;
        continue;
      }

      const methodMatch = normalized.match(/^(async\s+)?def\s+(\w+)\s*\(([\s\S]*?)\)(?:\s*->\s*([^:]+))?\s*:/);
      if (methodMatch) {
        const methodEnd = this.findPythonBlockEnd(lines, signature.endLine, indent);
        const isPrivate = methodMatch[2].startsWith('_') && !methodMatch[2].startsWith('__');
        const isDunder = methodMatch[2].startsWith('__') && methodMatch[2].endsWith('__');
        const isTest = methodMatch[2].startsWith('test_') || methodMatch[2].startsWith('test');

        members.push({
          id: this.generateId(filePath, methodMatch[2], isTest ? 'test' : 'method', i),
          name: methodMatch[2],
          kind: isTest ? 'test' : 'method',
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
          isAsync: !!methodMatch[1],
          parameters: this.parseParameters(methodMatch[3]).filter(
            (parameter) => parameter.name !== 'self' && parameter.name !== 'cls'
          ),
          returnType: methodMatch[4]?.trim(),
          decorators: this.extractDecorators(lines, i),
          docComment: this.extractPythonDocstring(lines, signature.endLine + 1),
          testsTarget: isTest ? this.inferTestTarget(methodMatch[2]) : undefined,
        });
        i = signature.endLine;
        continue;
      }

      const fieldMatch = trimmed.match(/^(\w+)\s*(?::\s*(\w[^\s=]*))?(?:\s*=\s*(.+))?$/);
      if (
        fieldMatch
        && !trimmed.startsWith('return')
        && !trimmed.startsWith('if ')
        && !trimmed.startsWith('for ')
        && !trimmed.startsWith('while ')
      ) {
        members.push({
          id: this.generateId(filePath, fieldMatch[1], 'variable', i),
          name: fieldMatch[1],
          kind: 'variable',
          language: this.language,
          filePath,
          startLine: i + 1,
          endLine: i + 1,
          lineCount: 1,
          children: [],
          imports: [],
          exports: [],
          dependencies: [],
          returnType: fieldMatch[2]?.trim(),
        });
      }
    }

    return members;
  }

  private collectPythonSignature(
    lines: string[],
    startLine: number
  ): { text: string; endLine: number } {
    const collected: string[] = [];
    let nestingDepth = 0;

    for (let i = startLine; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (!trimmed && collected.length === 0) {
        return { text: '', endLine: i };
      }

      if (!trimmed) {
        continue;
      }

      collected.push(trimmed);
      for (const char of trimmed) {
        if (char === '(' || char === '[' || char === '{') {
          nestingDepth += 1;
        } else if (char === ')' || char === ']' || char === '}') {
          nestingDepth = Math.max(0, nestingDepth - 1);
        }
      }

      if (nestingDepth === 0 && /:\s*(#.*)?$/.test(trimmed)) {
        return {
          text: collected.join(' '),
          endLine: i,
        };
      }
    }

    return {
      text: collected.join(' '),
      endLine: startLine,
    };
  }

  private findMemberIndent(
    lines: string[],
    startLine: number,
    endLine: number,
    parentIndent: number
  ): number {
    for (let i = startLine; i <= endLine; i += 1) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const indent = this.indentOf(lines[i]);
      if (indent > parentIndent) {
        return indent;
      }
    }

    return parentIndent + 4;
  }

  private indentOf(line: string): number {
    return line.length - line.trimStart().length;
  }

  private extractPythonDocstring(lines: string[], afterDefLine: number): string | undefined {
    for (let i = afterDefLine; i < Math.min(afterDefLine + 4, lines.length); i += 1) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
        const quote = trimmed.slice(0, 3);
        if (trimmed.endsWith(quote) && trimmed.length > 6) {
          return trimmed.slice(3, -3);
        }

        const parts: string[] = [trimmed.slice(3)];
        for (let j = i + 1; j < lines.length; j += 1) {
          const inner = lines[j].trim();
          if (inner.includes(quote)) {
            parts.push(inner.replace(quote, ''));
            return parts.join('\n').trim();
          }
          parts.push(inner);
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
