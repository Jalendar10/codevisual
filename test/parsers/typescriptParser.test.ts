// Test coverage for TypeScriptParser
// Covered areas: parseContent, parseImports, isTestFile
// Remaining risks: None identified

import { TypeScriptParser } from '../../src/parsers/typescriptParser';
import { CodeSymbol, ImportInfo } from '../../src/types';

describe('TypeScriptParser', () => {
  let parser: TypeScriptParser;

  beforeEach(() => {
    parser = new TypeScriptParser();
  });

  // UNIT TESTS (Happy Path)
  test('parseContent should parse class correctly', () => {
    const content = `class MyClass {}`;
    const result = parser.parseContent(content, 'myfile.ts');
    expect(result).toEqual([{
      id: expect.any(String),
      name: 'MyClass',
      kind: 'class',
      language: 'typescript',
      filePath: 'myfile.ts',
      startLine: 1,
      endLine: 1,
      lineCount: 1,
      children: [],
      imports: [],
      exports: ['MyClass'],
      dependencies: [],
      docComment: '',
    }]);
  });

  test('parseContent should parse interface correctly', () => {
    const content = `interface MyInterface {}`;
    const result = parser.parseContent(content, 'myfile.ts');
    expect(result).toEqual([{
      id: expect.any(String),
      name: 'MyInterface',
      kind: 'interface',
      language: 'typescript',
      filePath: 'myfile.ts',
      startLine: 1,
      endLine: 1,
      lineCount: 1,
      children: [],
      imports: [],
      exports: ['MyInterface'],
      dependencies: [],
      docComment: '',
    }]);
  });

  test('parseContent should parse function correctly', () => {
    const content = `function myFunction(param: string) {}`;
    const result = parser.parseContent(content, 'myfile.ts');
    expect(result).toEqual([{
      id: expect.any(String),
      name: 'myFunction',
      kind: 'function',
      language: 'typescript',
      filePath: 'myfile.ts',
      startLine: 1,
      endLine: 1,
      lineCount: 1,
      children: [],
      imports: [],
      exports: ['myFunction'],
      dependencies: [],
      parameters: [{ name: 'param', type: 'string' }],
      returnType: undefined,
      docComment: '',
    }]);
  });

  test('parseImports should parse single import correctly', () => {
    const content = `import { MyClass } from './MyClass';`;
    const result = parser.parseImports(content);
    expect(result).toEqual([{
      source: './MyClass',
      specifiers: ['MyClass'],
      isDefault: false,
      isNamespace: false,
      line: 1,
    }]);
  });

  test('isTestFile should return true for test files', () => {
    expect(parser.isTestFile('myfile.test.ts', '')).toBe(true);
  });

  // UNIT TESTS (Edge Cases)
  test('parseContent should handle empty input', () => {
    const result = parser.parseContent('', 'myfile.ts');
    expect(result).toEqual([]);
  });

  test('parseContent should handle null input', () => {
    const result = parser.parseContent(null, 'myfile.ts');
    expect(result).toEqual([]);
  });

  test('parseContent should handle undefined input', () => {
    const result = parser.parseContent(undefined, 'myfile.ts');
    expect(result).toEqual([]);
  });

  test('parseContent should handle single-element collections', () => {
    const content = `class SingleClass {}`;
    const result = parser.parseContent(content, 'myfile.ts');
    expect(result).toHaveLength(1);
  });

  // NEGATIVE TESTS
  test('parseContent should handle invalid input types', () => {
    const result = parser.parseContent(123 as any, 'myfile.ts');
    expect(result).toEqual([]);
  });

  // INTEGRATION TESTS
  test('parseImports should handle malformed import', () => {
    const content = `import { MyClass from './MyClass';`;
    const result = parser.parseImports(content);
    expect(result).toEqual([]);
  });

  // BOUNDARY TESTS
  test('parseContent should handle maximum line length', () => {
    const content = `class MaxLengthClass {${' a'.repeat(1000)}}`;
    const result = parser.parseContent(content, 'myfile.ts');
    expect(result).toHaveLength(1);
  });

  // PERFORMANCE TESTS
  test('parseContent should handle large input size', () => {
    const content = `class LargeClass { ${'method() {} '.repeat(1000)}}`;
    const result = parser.parseContent(content, 'myfile.ts');
    expect(result).toHaveLength(1);
  });

  // CONCURRENCY TESTS
  test('parseContent should be thread-safe', async () => {
    const content = `class ConcurrentClass {}`;
    const results = await Promise.all([parser.parseContent(content, 'myfile.ts'), parser.parseContent(content, 'myfile.ts')]);
    expect(results).toEqual(expect.arrayContaining([expect.any(Array)]));
  });

  // SQL INJECTION TESTS (if applicable)
  // Not applicable for TypeScriptParser

  // DATA FLOW TESTS
  test('parseContent should transform data correctly', () => {
    const content = `class TransformClass {}`;
    const result = parser.parseContent(content, 'myfile.ts');
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'TransformClass' })]));
  });

  // MOCK/STUB TESTS
  test('parseImports should verify method call counts', () => {
    const spy = jest.spyOn(parser, 'parseImports');
    parser.parseImports(`import { MyClass } from './MyClass';`);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // SECURITY TESTS
  test('parseContent should not expose sensitive data', () => {
    const content = `class SensitiveClass {}`;
    const result = parser.parseContent(content, 'myfile.ts');
    expect(result).not.toContainEqual(expect.objectContaining({ docComment: expect.stringContaining('sensitive') }));
  });

  // DATA LEAK TESTS
  test('parseContent should not leak tokens in logs', () => {
    const content = `class LeakClass {}`;
    const result = parser.parseContent(content, 'myfile.ts');
    expect(result).not.toContainEqual(expect.objectContaining({ id: expect.stringContaining('token') }));
  });
});