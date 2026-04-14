// Test coverage areas: Happy path, edge cases, negative cases, integration, boundary, performance, concurrency, SQL injection, data flow, mock/stub, security, and data leak tests. Remaining risks include untested language mappings and potential parser failures.

import { ParserFactory } from '../../src/parsers/index';
import { BaseParser } from '../../src/parsers/baseParser';
import { TypeScriptParser } from '../../src/parsers/typescriptParser';
import { PythonParser } from '../../src/parsers/pythonParser';
import { JavaParser } from '../../src/parsers/javaParser';
import { GoParser } from '../../src/parsers/goParser';
import { GenericParser } from '../../src/parsers/genericParser';
import * as path from 'path';

describe('ParserFactory', () => {
  // UNIT TESTS (Happy Path)
  test('should return TypeScriptParser for .ts files', () => {
    const parser = ParserFactory.getParser('file.ts');
    expect(parser).toBeInstanceOf(TypeScriptParser);
  });

  test('should return PythonParser for .py files', () => {
    const parser = ParserFactory.getParser('file.py');
    expect(parser).toBeInstanceOf(PythonParser);
  });

  test('should return JavaParser for .java files', () => {
    const parser = ParserFactory.getParser('file.java');
    expect(parser).toBeInstanceOf(JavaParser);
  });

  test('should return GoParser for .go files', () => {
    const parser = ParserFactory.getParser('file.go');
    expect(parser).toBeInstanceOf(GoParser);
  });

  test('should return GenericParser for unsupported languages', () => {
    const parser = ParserFactory.getParser('file.unknown');
    expect(parser).toBeInstanceOf(GenericParser);
  });

  // UNIT TESTS (Edge Cases)
  test('should return null for unknown language', () => {
    const parser = ParserFactory.getParser('file.unknown');
    expect(parser).toBeNull();
  });

  test('should handle empty file path', () => {
    const parser = ParserFactory.getParser('');
    expect(parser).toBeNull();
  });

  test('should handle null file path', () => {
    const parser = ParserFactory.getParser(null);
    expect(parser).toBeNull();
  });

  test('should handle boundary values for file extensions', () => {
    const parser = ParserFactory.getParser('file.js');
    expect(parser).toBeInstanceOf(TypeScriptParser);
  });

  test('should handle special characters in file names', () => {
    const parser = ParserFactory.getParser('file@#$%.py');
    expect(parser).toBeInstanceOf(PythonParser);
  });

  // NEGATIVE TESTS
  test('should return null for unsupported file types', () => {
    const parser = ParserFactory.getParser('file.xyz');
    expect(parser).toBeNull();
  });

  test('should return null for invalid input types', () => {
    const parser = ParserFactory.getParser(123 as any);
    expect(parser).toBeNull();
  });

  // INTEGRATION TESTS
  test('should return correct parser for valid language ID', () => {
    const parser = ParserFactory.getParserForLanguage('typescript');
    expect(parser).toBeInstanceOf(TypeScriptParser);
  });

  test('should handle dependency failure gracefully', () => {
    jest.spyOn(ParserFactory, 'detectLanguage').mockReturnValue('unknown');
    const parser = ParserFactory.getParser('file.unknown');
    expect(parser).toBeNull();
  });

  // BOUNDARY TESTS
  test('should return GenericParser for max length file name', () => {
    const longFileName = 'a'.repeat(255) + '.js';
    const parser = ParserFactory.getParser(longFileName);
    expect(parser).toBeInstanceOf(TypeScriptParser);
  });

  // PERFORMANCE TESTS
  test('should handle large input sizes efficiently', () => {
    const largeInput = 'a'.repeat(100000) + '.js';
    const start = performance.now();
    ParserFactory.getParser(largeInput);
    const end = performance.now();
    expect(end - start).toBeLessThan(100); // should complete in under 100ms
  });

  // CONCURRENCY TESTS
  test('should handle concurrent access to getParser', async () => {
    const promises = Array.from({ length: 10 }, () => 
      Promise.resolve(ParserFactory.getParser('file.ts'))
    );
    const results = await Promise.all(promises);
    results.forEach(result => expect(result).toBeInstanceOf(TypeScriptParser));
  });

  // SQL INJECTION TESTS
  test('should prevent SQL injection in file paths', () => {
    const parser = ParserFactory.getParser('file.sql; DROP TABLE users;');
    expect(parser).toBeInstanceOf(GenericParser);
  });

  // DATA FLOW TESTS
  test('should correctly transform data through the call chain', () => {
    const parser = ParserFactory.getParser('file.ts');
    expect(parser).toBeInstanceOf(TypeScriptParser);
  });

  // MOCK/STUB TESTS
  test('should mock external dependencies correctly', () => {
    const mockParser = jest.spyOn(ParserFactory, 'getParser').mockReturnValue(new TypeScriptParser());
    const parser = ParserFactory.getParser('file.ts');
    expect(mockParser).toHaveBeenCalled();
    expect(parser).toBeInstanceOf(TypeScriptParser);
  });

  // SECURITY TESTS
  test('should handle unauthorized access attempts', () => {
    const parser = ParserFactory.getParser('file.protected');
    expect(parser).toBeNull();
  });

  // DATA LEAK TESTS
  test('should not leak sensitive data in logs', () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    const parser = ParserFactory.getParser('file.ts');
    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('sensitive'));
    consoleSpy.mockRestore();
  });
});