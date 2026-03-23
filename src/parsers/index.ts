import { Language, LANGUAGE_MAP } from '../types';
import { BaseParser } from './baseParser';
import { TypeScriptParser } from './typescriptParser';
import { PythonParser } from './pythonParser';
import { JavaParser } from './javaParser';
import { GoParser } from './goParser';
import { GenericParser } from './genericParser';
import * as path from 'path';

/**
 * Parser Factory — returns the correct parser for any file.
 * Supports 20+ languages with dedicated or generic parsers.
 */
export class ParserFactory {
  private static parsers: Map<Language, BaseParser> = new Map();

  static {
    // Dedicated parsers
    this.parsers.set('typescript', new TypeScriptParser());
    this.parsers.set('javascript', new TypeScriptParser()); // JS uses same parser
    this.parsers.set('python', new PythonParser());
    this.parsers.set('java', new JavaParser());
    this.parsers.set('go', new GoParser());

    // Generic parsers for other languages
    this.parsers.set('rust', new GenericParser('rust', ['.rs']));
    this.parsers.set('csharp', new GenericParser('csharp', ['.cs']));
    this.parsers.set('cpp', new GenericParser('cpp', ['.cpp', '.cc', '.cxx', '.hpp', '.h']));
    this.parsers.set('c', new GenericParser('c', ['.c', '.h']));
    this.parsers.set('ruby', new GenericParser('ruby', ['.rb', '.rake']));
    this.parsers.set('php', new GenericParser('php', ['.php']));
    this.parsers.set('swift', new GenericParser('swift', ['.swift']));
    this.parsers.set('kotlin', new GenericParser('kotlin', ['.kt', '.kts']));
    this.parsers.set('scala', new GenericParser('scala', ['.scala', '.sc']));
    this.parsers.set('dart', new GenericParser('dart', ['.dart']));
    this.parsers.set('lua', new GenericParser('lua', ['.lua']));
    this.parsers.set('shell', new GenericParser('shell', ['.sh', '.bash', '.zsh']));
    this.parsers.set('yaml', new GenericParser('yaml', ['.yaml', '.yml']));
    this.parsers.set('json', new GenericParser('json', ['.json']));
    this.parsers.set('html', new GenericParser('html', ['.html', '.htm']));
    this.parsers.set('css', new GenericParser('css', ['.css', '.scss', '.less']));
    this.parsers.set('sql', new GenericParser('sql', ['.sql']));
  }

  /** Get the appropriate parser for a file */
  static getParser(filePath: string): BaseParser | null {
    const language = this.detectLanguage(filePath);
    if (language === 'unknown') return null;
    return this.parsers.get(language) || new GenericParser(language, [path.extname(filePath)]);
  }

  /** Get the appropriate parser for a VS Code language id or normalized language */
  static getParserForLanguage(languageId: string): BaseParser | null {
    const language = this.normalizeLanguage(languageId);
    if (language === 'unknown') {
      return null;
    }

    return this.parsers.get(language) || null;
  }

  /** Detect language from file extension */
  static detectLanguage(filePath: string): Language {
    const ext = path.extname(filePath).toLowerCase();
    return LANGUAGE_MAP[ext] || 'unknown';
  }

  static normalizeLanguage(languageId: string): Language {
    const normalized = languageId.toLowerCase();
    const mapping: Record<string, Language> = {
      typescript: 'typescript',
      typescriptreact: 'typescript',
      javascript: 'javascript',
      javascriptreact: 'javascript',
      python: 'python',
      java: 'java',
      go: 'go',
      rust: 'rust',
      csharp: 'csharp',
      cpp: 'cpp',
      c: 'c',
      ruby: 'ruby',
      php: 'php',
      swift: 'swift',
      kotlin: 'kotlin',
      scala: 'scala',
      dart: 'dart',
      lua: 'lua',
      shellscript: 'shell',
      shell: 'shell',
      yaml: 'yaml',
      json: 'json',
      html: 'html',
      css: 'css',
      scss: 'css',
      sql: 'sql',
    };

    return mapping[normalized] || 'unknown';
  }

  /** Get all supported extensions */
  static getSupportedExtensions(): string[] {
    return Object.keys(LANGUAGE_MAP);
  }

  /** Check if a file is supported */
  static isSupported(filePath: string): boolean {
    return this.detectLanguage(filePath) !== 'unknown';
  }
}

export { BaseParser } from './baseParser';
export { TypeScriptParser } from './typescriptParser';
export { PythonParser } from './pythonParser';
export { JavaParser } from './javaParser';
export { GoParser } from './goParser';
export { GenericParser } from './genericParser';
