import { CodeSymbol, ImportInfo, Language, ParameterInfo } from '../types';
import { BaseParser } from './baseParser';

/**
 * Parser for Java files.
 * Handles annotations, multiline signatures, constructors, interfaces, records,
 * package-private members, and common Spring endpoint/test annotations.
 */
export class JavaParser extends BaseParser {
  language: Language = 'java';
  supportedExtensions = ['.java'];

  parseContent(content: string, filePath: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    const lines = content.split('\n');
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();

      if (braceDepth !== 0) {
        braceDepth += this.countBraceDelta(lines[i]);
        continue;
      }

      if (!trimmed || this.isCommentLine(trimmed) || trimmed.startsWith('package ') || trimmed.startsWith('import ')) {
        braceDepth += this.countBraceDelta(lines[i]);
        continue;
      }

      const declaration = this.collectJavaDeclaration(lines, i);
      const normalized = this.normalizeDeclaration(declaration.text);
      const classMatch = normalized.match(
        /^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|abstract|final|static|sealed|non-sealed)\s+)*(class|interface|enum|record|@interface)\s+(\w+)(?:<[^>{;]*>)?(?:\s*\([^)]*\))?(?:\s+extends\s+([\w$.<>\[\], ?]+?))?(?:\s+implements\s+([^{};]+?))?\s*(?:\{|$)/
      );

      if (!classMatch) {
        for (let index = i; index <= declaration.endLine; index += 1) {
          braceDepth += this.countBraceDelta(lines[index]);
        }
        i = declaration.endLine;
        continue;
      }

      const declarationLine = this.findDeclarationLine(lines, i, declaration.endLine);
      const kind =
        classMatch[1] === 'interface'
          ? 'interface'
          : classMatch[1] === 'enum'
            ? 'enum'
            : 'class';
      const endLine = this.findClosingBracket(lines, declarationLine, '{', '}');
      const dependencies = [
        classMatch[3],
        ...(classMatch[4]?.split(',').map((part) => part.trim()).filter(Boolean) || []),
      ].filter(Boolean);

      symbols.push({
        id: this.generateId(filePath, classMatch[2], kind, declarationLine),
        name: classMatch[2],
        kind,
        language: this.language,
        filePath,
        startLine: i + 1,
        endLine: endLine + 1,
        lineCount: endLine - i + 1,
        children: this.parseJavaMembers(lines, declarationLine, endLine, filePath, classMatch[2]),
        imports: [],
        exports: normalized.includes('public ') ? [classMatch[2]] : [],
        dependencies,
        access: this.extractAccess(normalized),
        decorators: this.extractAnnotations(lines, i, declaration.endLine),
        docComment: this.extractDocComment(lines, i),
      });

      i = endLine;
      braceDepth = 0;
    }

    return symbols;
  }

  parseImports(content: string): ImportInfo[] {
    const imports: ImportInfo[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i += 1) {
      const match = lines[i].trim().match(/^import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/);
      if (!match) {
        continue;
      }

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

    return imports;
  }

  isTestFile(filePath: string, content: string): boolean {
    return /Test\.java$|Tests\.java$|IT\.java$/.test(filePath)
      || /\b(@Test|@ParameterizedTest|junit|TestCase|assertThat)\b/.test(content.slice(0, 2000));
  }

  protected parseSingleParam(param: string): ParameterInfo {
    const cleaned = param
      .replace(/@\w+(?:\([^)]*\))?\s*/g, ' ')
      .replace(/\b(?:final|volatile)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) {
      return { name: param };
    }

    const parts = cleaned.split(' ');
    const name = parts.pop() || cleaned;
    const vararg = parts[parts.length - 1] === '...' ? parts.pop() : undefined;
    const type = `${parts.join(' ')}${vararg ? '...' : ''}`.trim();

    return {
      name,
      type: type || undefined,
    };
  }

  private parseJavaMembers(
    lines: string[],
    startLine: number,
    endLine: number,
    filePath: string,
    className: string
  ): CodeSymbol[] {
    const members: CodeSymbol[] = [];
    let braceDepth = 1;

    for (let i = startLine + 1; i < endLine; i += 1) {
      const trimmed = lines[i].trim();
      if (!trimmed) {
        continue;
      }

      if (braceDepth !== 1) {
        braceDepth += this.countBraceDelta(lines[i]);
        continue;
      }

      if (this.isCommentLine(trimmed)) {
        continue;
      }

      const declaration = this.collectJavaDeclaration(lines, i);
      const normalized = this.normalizeDeclaration(declaration.text);
      const decorators = this.extractAnnotations(lines, i, declaration.endLine);

      const nestedClassMatch = normalized.match(
        /^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|abstract|final|static|sealed|non-sealed)\s+)*(class|interface|enum|record|@interface)\s+(\w+)(?:<[^>{;]*>)?(?:\s*\([^)]*\))?(?:\s+extends\s+([\w$.<>\[\], ?]+?))?(?:\s+implements\s+([^{};]+?))?\s*(?:\{|$)/
      );
      if (nestedClassMatch) {
        const declarationLine = this.findDeclarationLine(lines, i, declaration.endLine);
        const nestedEnd = this.findClosingBracket(lines, declarationLine, '{', '}');
        const kind =
          nestedClassMatch[1] === 'interface'
            ? 'interface'
            : nestedClassMatch[1] === 'enum'
              ? 'enum'
              : 'class';

        members.push({
          id: this.generateId(filePath, nestedClassMatch[2], kind, declarationLine),
          name: nestedClassMatch[2],
          kind,
          language: this.language,
          filePath,
          startLine: i + 1,
          endLine: nestedEnd + 1,
          lineCount: nestedEnd - i + 1,
          children: this.parseJavaMembers(lines, declarationLine, nestedEnd, filePath, nestedClassMatch[2]),
          imports: [],
          exports: normalized.includes('public ') ? [nestedClassMatch[2]] : [],
          dependencies: [
            nestedClassMatch[3],
            ...(nestedClassMatch[4]?.split(',').map((part) => part.trim()).filter(Boolean) || []),
          ].filter(Boolean),
          access: this.extractAccess(normalized),
          decorators,
          docComment: this.extractDocComment(lines, i),
        });

        braceDepth += this.countBraceDeltaForRange(lines, i, declaration.endLine);
        i = declaration.endLine;
        continue;
      }

      const methodMatch = normalized.match(
        /^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>]+>\s+)?(?:(?!class\b|interface\b|enum\b|record\b)([\w$.<>\[\], ?]+?)\s+)?(\w+)\s*\(([\s\S]*?)\)(?:\s*throws\s+[^{};]+)?\s*(?:\{|;|$)/
      );
      if (methodMatch && !normalized.includes('=')) {
        const methodName = methodMatch[2];
        const isControlKeyword = new Set(['if', 'for', 'while', 'switch', 'catch', 'return']).has(methodName);
        if (!isControlKeyword) {
          const declarationLine = this.findDeclarationLine(lines, i, declaration.endLine);
          const methodEnd = normalized.includes('{')
            ? this.findClosingBracket(lines, declarationLine, '{', '}')
            : declaration.endLine;
          const isTest = decorators.some((decorator) =>
            decorator.includes('@Test') || decorator.includes('@ParameterizedTest')
          );
          const isEndpoint = decorators.some((decorator) =>
            decorator.includes('@GetMapping')
            || decorator.includes('@PostMapping')
            || decorator.includes('@PutMapping')
            || decorator.includes('@DeleteMapping')
            || decorator.includes('@PatchMapping')
            || decorator.includes('@RequestMapping')
          );

          members.push({
            id: this.generateId(filePath, methodName, isTest ? 'test' : 'method', declarationLine),
            name: methodName,
            kind: isTest ? 'test' : isEndpoint ? 'route' as any : 'method',
            language: this.language,
            filePath,
            startLine: i + 1,
            endLine: methodEnd + 1,
            lineCount: methodEnd - i + 1,
            children: [],
            imports: [],
            exports: [],
            dependencies: [],
            access: this.extractAccess(normalized),
            parameters: this.parseParameters(methodMatch[3]),
            returnType:
              methodName === className && !methodMatch[1]
                ? className
                : methodMatch[1]?.trim(),
            decorators,
            docComment: this.extractDocComment(lines, i),
            testsTarget: isTest ? methodName.replace(/^test/, '') : undefined,
          });

          braceDepth += this.countBraceDeltaForRange(lines, i, declaration.endLine);
          i = declaration.endLine;
          continue;
        }
      }

      const fieldMatch = normalized.match(
        /^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|static|final|volatile|transient)\s+)*(?!class\b|interface\b|enum\b|record\b)([\w$.<>\[\], ?]+?)\s+(\w+)\s*(?:=|;|,)\s*/
      );
      if (fieldMatch && fieldMatch[2] !== 'return') {
        members.push({
          id: this.generateId(filePath, fieldMatch[2], 'variable', i),
          name: fieldMatch[2],
          kind: 'variable',
          language: this.language,
          filePath,
          startLine: i + 1,
          endLine: declaration.endLine + 1,
          lineCount: declaration.endLine - i + 1,
          children: [],
          imports: [],
          exports: [],
          dependencies:
            /^[A-Z]/.test(fieldMatch[1].trim()) ? [fieldMatch[1].trim()] : [],
          access: this.extractAccess(normalized),
          returnType: fieldMatch[1].trim(),
          decorators,
        });
      }

      braceDepth += this.countBraceDeltaForRange(lines, i, declaration.endLine);
      i = declaration.endLine;
    }

    return members;
  }

  private collectJavaDeclaration(
    lines: string[],
    startLine: number
  ): { text: string; endLine: number } {
    const collected: string[] = [];
    let parenDepth = 0;
    let genericDepth = 0;

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
        if (char === '(') {
          parenDepth += 1;
        } else if (char === ')') {
          parenDepth = Math.max(0, parenDepth - 1);
        } else if (char === '<') {
          genericDepth += 1;
        } else if (char === '>') {
          genericDepth = Math.max(0, genericDepth - 1);
        }
      }

      if (parenDepth === 0 && genericDepth === 0 && (trimmed.includes('{') || trimmed.endsWith(';'))) {
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

  private normalizeDeclaration(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  private findDeclarationLine(lines: string[], startLine: number, endLine: number): number {
    for (let i = endLine; i >= startLine; i -= 1) {
      const trimmed = lines[i].trim();
      if (trimmed && !trimmed.startsWith('@')) {
        return i;
      }
    }

    return startLine;
  }

  private extractAnnotations(lines: string[], startLine: number, endLine: number): string[] {
    const annotations: string[] = [];
    for (let i = startLine; i <= endLine; i += 1) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('@')) {
        annotations.push(trimmed);
      }
    }
    return annotations;
  }

  private countBraceDeltaForRange(lines: string[], startLine: number, endLine: number): number {
    let delta = 0;
    for (let i = startLine; i <= endLine; i += 1) {
      delta += this.countBraceDelta(lines[i]);
    }
    return delta;
  }

  private countBraceDelta(line: string): number {
    let delta = 0;
    for (const char of line) {
      if (char === '{') {
        delta += 1;
      } else if (char === '}') {
        delta -= 1;
      }
    }
    return delta;
  }

  private isCommentLine(trimmed: string): boolean {
    return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
  }

  private extractAccess(line: string): 'public' | 'private' | 'protected' | 'internal' {
    if (/\bpublic\b/.test(line)) {
      return 'public';
    }
    if (/\bprivate\b/.test(line)) {
      return 'private';
    }
    if (/\bprotected\b/.test(line)) {
      return 'protected';
    }
    return 'internal';
  }
}
