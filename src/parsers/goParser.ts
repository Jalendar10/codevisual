import { CodeSymbol, ImportInfo, Language, ParameterInfo } from '../types';
import { BaseParser } from './baseParser';

/**
 * Parser for Go files.
 */
export class GoParser extends BaseParser {
  language: Language = 'go';
  supportedExtensions = ['.go'];

  parseContent(content: string, filePath: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith('//')) continue;

      // Structs
      const structMatch = trimmed.match(/^type\s+(\w+)\s+struct\s*\{?/);
      if (structMatch) {
        const endLine = this.findClosingBracket(lines, i, '{', '}');
        symbols.push({
          id: this.generateId(filePath, structMatch[1], 'class', i),
          name: structMatch[1],
          kind: 'class',
          language: this.language,
          filePath,
          startLine: i + 1,
          endLine: endLine + 1,
          lineCount: endLine - i + 1,
          children: [],
          imports: [],
          exports: this.isExported(structMatch[1]) ? [structMatch[1]] : [],
          dependencies: [],
          access: this.isExported(structMatch[1]) ? 'public' : 'private',
          docComment: this.extractDocComment(lines, i),
        });
        continue;
      }

      // Interfaces
      const ifaceMatch = trimmed.match(/^type\s+(\w+)\s+interface\s*\{?/);
      if (ifaceMatch) {
        const endLine = this.findClosingBracket(lines, i, '{', '}');
        symbols.push({
          id: this.generateId(filePath, ifaceMatch[1], 'interface', i),
          name: ifaceMatch[1],
          kind: 'interface',
          language: this.language,
          filePath,
          startLine: i + 1,
          endLine: endLine + 1,
          lineCount: endLine - i + 1,
          children: [],
          imports: [],
          exports: this.isExported(ifaceMatch[1]) ? [ifaceMatch[1]] : [],
          dependencies: [],
          access: this.isExported(ifaceMatch[1]) ? 'public' : 'private',
          docComment: this.extractDocComment(lines, i),
        });
        continue;
      }

      // Functions
      const funcMatch = trimmed.match(/^func\s+(?:\((\w+)\s+\*?(\w+)\)\s+)?(\w+)\s*\(([^)]*)\)(?:\s*(?:\(([^)]*)\)|(\w+(?:\.\w+)?)))?\s*\{?/);
      if (funcMatch) {
        const endLine = this.findClosingBracket(lines, i, '{', '}');
        const name = funcMatch[3];
        const receiver = funcMatch[2];
        const isTest = name.startsWith('Test') && filePath.endsWith('_test.go');
        symbols.push({
          id: this.generateId(filePath, name, receiver ? 'method' : isTest ? 'test' : 'function', i),
          name: receiver ? `${receiver}.${name}` : name,
          kind: receiver ? 'method' : isTest ? 'test' : 'function',
          language: this.language,
          filePath,
          startLine: i + 1,
          endLine: endLine + 1,
          lineCount: endLine - i + 1,
          children: [],
          imports: [],
          exports: this.isExported(name) ? [name] : [],
          dependencies: receiver ? [receiver] : [],
          access: this.isExported(name) ? 'public' : 'private',
          parameters: this.parseGoParams(funcMatch[4]),
          returnType: funcMatch[5] || funcMatch[6],
          docComment: this.extractDocComment(lines, i),
          testsTarget: isTest ? name.replace(/^Test/, '') : undefined,
        });
        continue;
      }

      // Constants
      const constMatch = trimmed.match(/^(?:const|var)\s+(\w+)\s+/);
      if (constMatch) {
        symbols.push({
          id: this.generateId(filePath, constMatch[1], trimmed.startsWith('const') ? 'constant' : 'variable', i),
          name: constMatch[1],
          kind: trimmed.startsWith('const') ? 'constant' : 'variable',
          language: this.language,
          filePath,
          startLine: i + 1,
          endLine: i + 1,
          lineCount: 1,
          children: [],
          imports: [],
          exports: this.isExported(constMatch[1]) ? [constMatch[1]] : [],
          dependencies: [],
          access: this.isExported(constMatch[1]) ? 'public' : 'private',
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

      // Single import
      const singleMatch = line.match(/^import\s+(?:(\w+)\s+)?"([^"]+)"/);
      if (singleMatch) {
        const parts = singleMatch[2].split('/');
        imports.push({
          source: singleMatch[2],
          specifiers: [singleMatch[1] || parts[parts.length - 1]],
          isDefault: true,
          isNamespace: false,
          line: i + 1,
        });
        continue;
      }

      // Import block
      if (line === 'import (') {
        for (let j = i + 1; j < lines.length; j++) {
          const importLine = lines[j].trim();
          if (importLine === ')') { i = j; break; }
          const match = importLine.match(/^(?:(\w+)\s+)?"([^"]+)"/);
          if (match) {
            const parts = match[2].split('/');
            imports.push({
              source: match[2],
              specifiers: [match[1] || parts[parts.length - 1]],
              isDefault: true,
              isNamespace: false,
              line: j + 1,
            });
          }
        }
      }
    }

    return imports;
  }

  isTestFile(filePath: string, _content: string): boolean {
    return filePath.endsWith('_test.go');
  }

  private isExported(name: string): boolean {
    return /^[A-Z]/.test(name);
  }

  private parseGoParams(paramString: string): ParameterInfo[] {
    if (!paramString.trim()) return [];
    return paramString.split(',').map(p => {
      const parts = p.trim().split(/\s+/);
      if (parts.length >= 2) {
        return { name: parts[0], type: parts.slice(1).join(' ') };
      }
      return { name: parts[0] };
    });
  }
}
