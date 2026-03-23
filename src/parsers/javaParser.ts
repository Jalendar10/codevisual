import { CodeSymbol, ImportInfo, Language, ParameterInfo } from '../types';
import { BaseParser } from './baseParser';

/**
 * Parser for Java files.
 */
export class JavaParser extends BaseParser {
  language: Language = 'java';
  supportedExtensions = ['.java'];

  parseContent(content: string, filePath: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

      // Classes & Interfaces
      const classMatch = trimmed.match(
        /^(?:(?:public|private|protected|abstract|final|static)\s+)*(?:class|interface|enum|record)\s+(\w+)(?:<[^>]*>)?(?:\s+extends\s+(\w+))?(?:\s+implements\s+(.+?))?\s*\{?/
      );
      if (classMatch) {
        const endLine = this.findClosingBracket(lines, i, '{', '}');
        const isInterface = trimmed.includes('interface');
        const isEnum = trimmed.includes('enum');
        symbols.push({
          id: this.generateId(filePath, classMatch[1], isInterface ? 'interface' : isEnum ? 'enum' : 'class', i),
          name: classMatch[1],
          kind: isInterface ? 'interface' : isEnum ? 'enum' : 'class',
          language: this.language,
          filePath,
          startLine: i + 1,
          endLine: endLine + 1,
          lineCount: endLine - i + 1,
          children: this.parseJavaMembers(lines, i, endLine, filePath),
          imports: [],
          exports: trimmed.includes('public') ? [classMatch[1]] : [],
          dependencies: [classMatch[2], ...(classMatch[3]?.split(',').map(s => s.trim()) || [])].filter(Boolean),
          access: this.extractAccess(trimmed),
          decorators: this.extractDecorators(lines, i),
          docComment: this.extractDocComment(lines, i),
        });
        continue;
      }
    }

    return symbols;
  }

  parseImports(content: string): ImportInfo[] {
    const imports: ImportInfo[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].trim().match(/^import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/);
      if (match) {
        const source = match[1];
        const parts = source.split('.');
        const specifier = parts[parts.length - 1];
        imports.push({
          source: parts.slice(0, -1).join('.'),
          specifiers: [specifier],
          isDefault: specifier !== '*',
          isNamespace: specifier === '*',
          line: i + 1,
        });
      }
    }

    return imports;
  }

  isTestFile(filePath: string, content: string): boolean {
    return /Test\.java$|Tests\.java$|IT\.java$/.test(filePath) ||
      /\b(@Test|@ParameterizedTest|junit|TestCase|assertThat)\b/.test(content.slice(0, 2000));
  }

  private parseJavaMembers(lines: string[], startLine: number, endLine: number, filePath: string): CodeSymbol[] {
    const members: CodeSymbol[] = [];
    let depth = 0;

    for (let i = startLine + 1; i < endLine; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;

      // Track brace depth to only parse top-level members
      for (const c of lines[i]) {
        if (c === '{') depth++;
        if (c === '}') depth--;
      }
      if (depth > 1) continue;

      const methodMatch = trimmed.match(
        /^(?:(?:public|private|protected|static|final|abstract|synchronized|native|default)\s+)*(?:<[\w\s,?]+>\s+)?(\w+(?:<[^>]*>)?)\s+(\w+)\s*\(([^)]*)\)/
      );
      if (methodMatch && !trimmed.includes('=') && methodMatch[2] !== 'if' && methodMatch[2] !== 'for') {
        const methodEnd = trimmed.includes('{') ? this.findClosingBracket(lines, i, '{', '}') : i;
        const isTest = this.extractDecorators(lines, i).some(d => d.includes('@Test'));
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
          access: this.extractAccess(trimmed),
          parameters: this.parseJavaParams(methodMatch[3]),
          returnType: methodMatch[1],
          decorators: this.extractDecorators(lines, i),
          docComment: this.extractDocComment(lines, i),
          testsTarget: isTest ? methodMatch[2].replace(/^test/, '') : undefined,
        });
      }
    }

    return members;
  }

  private parseJavaParams(paramString: string): ParameterInfo[] {
    if (!paramString.trim()) return [];
    return paramString.split(',').map(p => {
      const parts = p.trim().split(/\s+/);
      return {
        name: parts[parts.length - 1],
        type: parts.slice(0, -1).join(' '),
      };
    });
  }

  private extractAccess(line: string): 'public' | 'private' | 'protected' | 'internal' {
    if (line.includes('public')) return 'public';
    if (line.includes('private')) return 'private';
    if (line.includes('protected')) return 'protected';
    return 'internal';
  }
}
