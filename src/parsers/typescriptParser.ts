import { CodeSymbol, ImportInfo, Language, ParameterInfo, SymbolKind } from '../types';
import { BaseParser } from './baseParser';

/**
 * Parser for TypeScript and JavaScript files.
 * Handles .ts, .tsx, .js, .jsx, .mjs, .mts
 */
export class TypeScriptParser extends BaseParser {
  language: Language = 'typescript';
  supportedExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts'];

  parseContent(content: string, filePath: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

      // Classes
      const classMatch = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?(?:default\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+(.+?))?(?:\s*\{)?/);
      if (classMatch) {
        const endLine = this.findClosingBracket(lines, i, '{', '}');
        const symbol: CodeSymbol = {
          id: this.generateId(filePath, classMatch[1], 'class', i),
          name: classMatch[1],
          kind: 'class',
          language: this.language,
          filePath,
          startLine: i + 1,
          endLine: endLine + 1,
          lineCount: endLine - i + 1,
          children: this.parseClassMembers(lines, i, endLine, filePath),
          imports: [],
          exports: trimmed.startsWith('export') ? [classMatch[1]] : [],
          dependencies: [classMatch[2], ...(classMatch[3]?.split(',').map(s => s.trim()) || [])].filter(Boolean),
          docComment: this.extractDocComment(lines, i),
          decorators: this.extractDecorators(lines, i),
        };
        symbols.push(symbol);
        continue;
      }

      // Interfaces
      const interfaceMatch = trimmed.match(/^(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+(.+?))?(?:\s*\{)?/);
      if (interfaceMatch) {
        const endLine = this.findClosingBracket(lines, i, '{', '}');
        symbols.push({
          id: this.generateId(filePath, interfaceMatch[1], 'interface', i),
          name: interfaceMatch[1],
          kind: 'interface',
          language: this.language,
          filePath,
          startLine: i + 1,
          endLine: endLine + 1,
          lineCount: endLine - i + 1,
          children: [],
          imports: [],
          exports: trimmed.startsWith('export') ? [interfaceMatch[1]] : [],
          dependencies: interfaceMatch[2]?.split(',').map(s => s.trim()).filter(Boolean) || [],
          docComment: this.extractDocComment(lines, i),
        });
        continue;
      }

      // Type aliases
      const typeMatch = trimmed.match(/^(?:export\s+)?type\s+(\w+)/);
      if (typeMatch) {
        symbols.push({
          id: this.generateId(filePath, typeMatch[1], 'type', i),
          name: typeMatch[1],
          kind: 'type',
          language: this.language,
          filePath,
          startLine: i + 1,
          endLine: i + 1,
          lineCount: 1,
          children: [],
          imports: [],
          exports: trimmed.startsWith('export') ? [typeMatch[1]] : [],
          dependencies: [],
          docComment: this.extractDocComment(lines, i),
        });
        continue;
      }

      // Enums
      const enumMatch = trimmed.match(/^(?:export\s+)?(?:const\s+)?enum\s+(\w+)/);
      if (enumMatch) {
        const endLine = this.findClosingBracket(lines, i, '{', '}');
        symbols.push({
          id: this.generateId(filePath, enumMatch[1], 'enum', i),
          name: enumMatch[1],
          kind: 'enum',
          language: this.language,
          filePath,
          startLine: i + 1,
          endLine: endLine + 1,
          lineCount: endLine - i + 1,
          children: [],
          imports: [],
          exports: trimmed.startsWith('export') ? [enumMatch[1]] : [],
          dependencies: [],
          docComment: this.extractDocComment(lines, i),
        });
        continue;
      }

      // Functions (named, arrow, exported)
      const funcMatch = trimmed.match(
        /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^\{]+))?/
      );
      if (funcMatch) {
        const endLine = this.findClosingBracket(lines, i, '{', '}');
        symbols.push({
          id: this.generateId(filePath, funcMatch[1], 'function', i),
          name: funcMatch[1],
          kind: this.isComponentName(funcMatch[1]) && filePath.match(/\.[tj]sx$/) ? 'component' : 'function',
          language: this.language,
          filePath,
          startLine: i + 1,
          endLine: endLine + 1,
          lineCount: endLine - i + 1,
          children: [],
          imports: [],
          exports: trimmed.startsWith('export') ? [funcMatch[1]] : [],
          dependencies: [],
          isAsync: trimmed.includes('async'),
          parameters: this.parseParameters(funcMatch[2]),
          returnType: funcMatch[3]?.trim(),
          docComment: this.extractDocComment(lines, i),
          decorators: this.extractDecorators(lines, i),
        });
        continue;
      }

      // Arrow functions assigned to const/let/var
      const arrowMatch = trimmed.match(
        /^(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+(\w+)(?:\s*:\s*[^=]+)?\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=]*)?\s*=>/
      );
      if (arrowMatch) {
        const endLine = trimmed.includes('{') ? this.findClosingBracket(lines, i, '{', '}') : this.findArrowEnd(lines, i);
        const paramMatch = trimmed.match(/=\s*(?:async\s+)?\(([^)]*)\)/);
        symbols.push({
          id: this.generateId(filePath, arrowMatch[1], 'function', i),
          name: arrowMatch[1],
          kind: this.isComponentName(arrowMatch[1]) && filePath.match(/\.[tj]sx$/) ? 'component' : 'function',
          language: this.language,
          filePath,
          startLine: i + 1,
          endLine: endLine + 1,
          lineCount: endLine - i + 1,
          children: [],
          imports: [],
          exports: trimmed.startsWith('export') ? [arrowMatch[1]] : [],
          dependencies: [],
          isAsync: trimmed.includes('async'),
          parameters: paramMatch ? this.parseParameters(paramMatch[1]) : [],
          docComment: this.extractDocComment(lines, i),
        });
        continue;
      }

      // Test suites
      const suiteMatch = trimmed.match(/^(?:describe|context)\s*\(\s*['"`](.+?)['"`]/);
      if (suiteMatch) {
        const endLine = trimmed.includes('{') ? this.findClosingBracket(lines, i, '{', '}') : i;
        symbols.push({
          id: this.generateId(filePath, suiteMatch[1], 'testSuite', i),
          name: suiteMatch[1],
          kind: 'testSuite',
          language: this.language,
          filePath,
          startLine: i + 1,
          endLine: endLine + 1,
          lineCount: endLine - i + 1,
          children: [],
          imports: [],
          exports: [],
          dependencies: [],
          docComment: this.extractDocComment(lines, i),
        });
        continue;
      }

      // Test cases
      const testMatch = trimmed.match(/^(?:it|test)\s*\(\s*['"`](.+?)['"`]/);
      if (testMatch) {
        const endLine = trimmed.includes('{') ? this.findClosingBracket(lines, i, '{', '}') : i;
        symbols.push({
          id: this.generateId(filePath, testMatch[1], 'test', i),
          name: testMatch[1],
          kind: 'test',
          language: this.language,
          filePath,
          startLine: i + 1,
          endLine: endLine + 1,
          lineCount: endLine - i + 1,
          children: [],
          imports: [],
          exports: [],
          dependencies: [],
          docComment: this.extractDocComment(lines, i),
          testsTarget: testMatch[1],
        });
        continue;
      }

      // React hooks (custom)
      const hookMatch = trimmed.match(/^(?:export\s+)?(?:const|function)\s+(use\w+)/);
      if (hookMatch && !symbols.find(s => s.name === hookMatch[1])) {
        const endLine = trimmed.includes('{') ? this.findClosingBracket(lines, i, '{', '}') : i;
        symbols.push({
          id: this.generateId(filePath, hookMatch[1], 'hook', i),
          name: hookMatch[1],
          kind: 'hook',
          language: this.language,
          filePath,
          startLine: i + 1,
          endLine: endLine + 1,
          lineCount: endLine - i + 1,
          children: [],
          imports: [],
          exports: trimmed.startsWith('export') ? [hookMatch[1]] : [],
          dependencies: [],
          docComment: this.extractDocComment(lines, i),
        });
        continue;
      }

      // Constants
      const constMatch = trimmed.match(/^(?:export\s+)?const\s+(\w+)(?:\s*:\s*([^=]+))?\s*=/);
      if (constMatch && !symbols.find(s => s.name === constMatch[1])) {
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
          exports: trimmed.startsWith('export') ? [constMatch[1]] : [],
          dependencies: [],
          docComment: this.extractDocComment(lines, i),
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

      // ES6 imports
      const importMatch = line.match(/^import\s+(.+?)\s+from\s+['"](.+?)['"]/);
      if (importMatch) {
        const specifierPart = importMatch[1];
        const source = importMatch[2];
        const specifiers: string[] = [];
        let isDefault = false;
        let isNamespace = false;

        if (specifierPart.startsWith('* as')) {
          isNamespace = true;
          specifiers.push(specifierPart.replace('* as ', ''));
        } else if (specifierPart.startsWith('{')) {
          const namedMatch = specifierPart.match(/\{([^}]+)\}/);
          if (namedMatch) {
            specifiers.push(...namedMatch[1].split(',').map(s => s.trim().split(' as ')[0]));
          }
          // Also check for default import before destructuring
          const defaultBeforeBraces = specifierPart.match(/^(\w+)\s*,\s*\{/);
          if (defaultBeforeBraces) {
            isDefault = true;
            specifiers.unshift(defaultBeforeBraces[1]);
          }
        } else {
          isDefault = true;
          specifiers.push(specifierPart.trim());
        }

        imports.push({ source, specifiers, isDefault, isNamespace, line: i + 1 });
        continue;
      }

      // Side-effect imports
      const sideEffectMatch = line.match(/^import\s+['"](.+?)['"]/);
      if (sideEffectMatch) {
        imports.push({ source: sideEffectMatch[1], specifiers: [], isDefault: false, isNamespace: false, line: i + 1 });
        continue;
      }

      // Dynamic imports
      const dynamicMatch = line.match(/import\s*\(\s*['"](.+?)['"]\s*\)/);
      if (dynamicMatch) {
        imports.push({ source: dynamicMatch[1], specifiers: [], isDefault: false, isNamespace: false, line: i + 1 });
        continue;
      }

      // CommonJS requires
      const requireMatch = line.match(/(?:const|let|var)\s+(?:(\w+)|(\{[^}]+\}))\s*=\s*require\s*\(\s*['"](.+?)['"]\s*\)/);
      if (requireMatch) {
        const specifiers = requireMatch[2]
          ? requireMatch[2].replace(/[{}]/g, '').split(',').map(s => s.trim())
          : [requireMatch[1]];
        imports.push({
          source: requireMatch[3],
          specifiers: specifiers.filter(Boolean),
          isDefault: !requireMatch[2],
          isNamespace: false,
          line: i + 1,
        });
      }
    }

    return imports;
  }

  isTestFile(filePath: string, content: string): boolean {
    const testPatterns = [
      /\.test\.[jt]sx?$/,
      /\.spec\.[jt]sx?$/,
      /__tests__\//,
      /\.stories\.[jt]sx?$/,
    ];
    if (testPatterns.some(p => p.test(filePath))) return true;
    return /\b(describe|it|test|expect|jest|mocha|chai|vitest)\b/.test(content.slice(0, 2000));
  }

  private parseClassMembers(lines: string[], startLine: number, endLine: number, filePath: string): CodeSymbol[] {
    const members: CodeSymbol[] = [];
    for (let i = startLine + 1; i < endLine; i++) {
      const line = lines[i].trim();
      // Method
      const methodMatch = line.match(
        /^(?:(public|private|protected|static|abstract|async|readonly)\s+)*(get\s+|set\s+)?(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^\{]+))?\s*\{?/
      );
      if (methodMatch && methodMatch[3] !== 'constructor' && !line.includes('=')) {
        const methodEnd = line.includes('{') ? this.findClosingBracket(lines, i, '{', '}') : i;
        const access = (methodMatch[1] as 'public' | 'private' | 'protected') || 'public';
        members.push({
          id: this.generateId(filePath, methodMatch[3], 'method', i),
          name: methodMatch[3],
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
          access,
          isAsync: line.includes('async'),
          parameters: this.parseParameters(methodMatch[4]),
          returnType: methodMatch[5]?.trim(),
          docComment: this.extractDocComment(lines, i),
        });
      }
    }
    return members;
  }

  private isComponentName(name: string): boolean {
    return /^[A-Z]/.test(name);
  }

  private findArrowEnd(lines: string[], startLine: number): number {
    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.endsWith(';') || (i > startLine && !line.endsWith(',') && !line.endsWith('('))) {
        return i;
      }
    }
    return startLine;
  }

  protected parseSingleParam(param: string): ParameterInfo {
    const match = param.match(/^(\.{3})?(\w+)(\?)?\s*(?::\s*(.+?))?(?:\s*=\s*(.+))?$/);
    if (match) {
      return {
        name: (match[1] || '') + match[2],
        type: match[4]?.trim(),
        isOptional: !!match[3] || !!match[5],
        defaultValue: match[5]?.trim(),
      };
    }
    return { name: param };
  }
}
