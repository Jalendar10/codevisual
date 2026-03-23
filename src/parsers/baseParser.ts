import { CodeSymbol, ImportInfo, Language, ParameterInfo, SymbolKind } from '../types';

/**
 * Base parser with common parsing utilities.
 * Language-specific parsers extend this class.
 */
export abstract class BaseParser {
  abstract language: Language;
  abstract supportedExtensions: string[];

  /** Parse a file and extract symbols */
  abstract parseContent(content: string, filePath: string): CodeSymbol[];

  /** Extract imports from file content */
  abstract parseImports(content: string): ImportInfo[];

  /** Detect if this is a test file */
  abstract isTestFile(filePath: string, content: string): boolean;

  /** Generate unique ID for a symbol */
  protected generateId(filePath: string, name: string, kind: SymbolKind, line: number): string {
    return `${filePath}::${kind}::${name}::${line}`;
  }

  /** Count lines in content */
  protected countLines(content: string): number {
    return content.split('\n').length;
  }

  /** Extract doc comment above a line */
  protected extractDocComment(lines: string[], lineIndex: number): string | undefined {
    const comments: string[] = [];
    let i = lineIndex - 1;

    // Check for block comments (/** ... */)
    while (i >= 0) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('*/')) {
        i--;
        while (i >= 0 && !lines[i].trim().startsWith('/**') && !lines[i].trim().startsWith('/*')) {
          comments.unshift(lines[i].trim().replace(/^\*\s?/, ''));
          i--;
        }
        if (i >= 0) {
          const firstLine = lines[i].trim().replace(/^\/\*\*?\s?/, '');
          if (firstLine) comments.unshift(firstLine);
        }
        break;
      }
      // Check for line comments (// or #)
      else if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
        comments.unshift(trimmed.replace(/^\/\/\s?|^#\s?/, ''));
        i--;
      } else {
        break;
      }
    }

    return comments.length > 0 ? comments.join('\n') : undefined;
  }

  /** Parse parameter string into ParameterInfo array */
  protected parseParameters(paramString: string): ParameterInfo[] {
    if (!paramString.trim()) return [];

    const params: ParameterInfo[] = [];
    let depth = 0;
    let current = '';

    for (const char of paramString) {
      if (char === '(' || char === '<' || char === '[' || char === '{') depth++;
      if (char === ')' || char === '>' || char === ']' || char === '}') depth--;
      if (char === ',' && depth === 0) {
        params.push(this.parseSingleParam(current.trim()));
        current = '';
      } else {
        current += char;
      }
    }

    if (current.trim()) {
      params.push(this.parseSingleParam(current.trim()));
    }

    return params;
  }

  /** Parse a single parameter - override in subclass for language-specific parsing */
  protected parseSingleParam(param: string): ParameterInfo {
    return { name: param, type: undefined };
  }

  /** Find matching closing bracket */
  protected findClosingBracket(lines: string[], startLine: number, openChar: string, closeChar: string): number {
    let depth = 0;
    for (let i = startLine; i < lines.length; i++) {
      for (const char of lines[i]) {
        if (char === openChar) depth++;
        if (char === closeChar) {
          depth--;
          if (depth === 0) return i;
        }
      }
    }
    return lines.length - 1;
  }

  /** Check if a line is inside a string or comment */
  protected isInsideStringOrComment(line: string, position: number): boolean {
    let inString = false;
    let stringChar = '';
    let inLineComment = false;

    for (let i = 0; i < position; i++) {
      const char = line[i];
      const prev = i > 0 ? line[i - 1] : '';

      if (inLineComment) return true;
      if (char === '/' && line[i + 1] === '/' && !inString) inLineComment = true;
      if ((char === '"' || char === "'" || char === '`') && prev !== '\\') {
        if (!inString) {
          inString = true;
          stringChar = char;
        } else if (char === stringChar) {
          inString = false;
        }
      }
    }

    return inString || inLineComment;
  }

  /** Extract decorators/annotations above a line */
  protected extractDecorators(lines: string[], lineIndex: number): string[] {
    const decorators: string[] = [];
    let i = lineIndex - 1;
    while (i >= 0) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('@')) {
        decorators.unshift(trimmed);
        i--;
      } else if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
        i--;
      } else {
        break;
      }
    }
    return decorators;
  }
}
