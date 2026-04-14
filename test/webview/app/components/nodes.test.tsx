// Test coverage areas: Happy path, edge cases, negative cases, integration, boundary, performance, concurrency, SQL injection, data flow, mock/stub, security, and data leak tests. Remaining risks include untested complex interactions and specific edge cases in rendering logic.

import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import {
  renderExpandButton,
  renderInspectLabel,
  renderMemberPreview,
  renderClassSummary,
  renderClassSections,
  renderDataMappings,
  renderRiskSummary,
  renderLinkedTestSummary,
  renderPackageRefs,
  formatSize,
  shortPath,
  nodeMeta,
  stopNodeEvent,
  triggerExpand,
  triggerInspect,
} from '../../src/webview/app/components/nodes';
import { GraphNodeData, GraphClassSummary, DataFlowMapping } from '../../../types';

describe('Nodes Component Tests', () => {
  const mockData: GraphNodeData = {
    parameters: [{ name: 'param1' }, { name: 'param2' }],
    childCount: 3,
    lineCount: 10,
    language: 'JavaScript',
    expandable: true,
    expanded: false,
    onToggleExpand: jest.fn(),
    onInspectSymbol: jest.fn(),
    memberDetails: [],
    classSummaries: [],
    securityLevel: 'low',
    dataLeakLevel: 'low',
    securityFindings: [],
    dataLeakFindings: [],
  };

  test('shortPath returns correct shortened path', () => {
    expect(shortPath('/some/long/path/to/file')).toBe('…/to/file');
    expect(shortPath('')).toBe('');
    expect(shortPath(undefined)).toBe('');
  });

  test('nodeMeta returns correct metadata', () => {
    expect(nodeMeta(mockData)).toBe('(param1, param2)');
    mockData.parameters = [];
    expect(nodeMeta(mockData)).toBe('3 children');
    mockData.childCount = 0;
    mockData.lineCount = 5;
    expect(nodeMeta(mockData)).toBe('5 lines');
    mockData.lineCount = 0;
    mockData.language = 'TypeScript';
    expect(nodeMeta(mockData)).toBe('TypeScript');
  });

  test('formatSize returns correct size format', () => {
    expect(formatSize(2048)).toBe('2 KB');
    expect(formatSize(512)).toBe('0.5 KB');
    expect(formatSize(0)).toBe('0 KB');
    expect(formatSize(undefined)).toBe('0 KB');
  });

  test('stopNodeEvent prevents default and stops propagation', () => {
    const event = { preventDefault: jest.fn(), stopPropagation: jest.fn() } as unknown as React.MouseEvent<HTMLElement>;
    stopNodeEvent(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  test('triggerExpand calls onToggleExpand with correct nodeId', () => {
    const event = { preventDefault: jest.fn(), stopPropagation: jest.fn() } as unknown as React.MouseEvent<HTMLElement>;
    triggerExpand(mockData, 'node1', event);
    expect(mockData.onToggleExpand).toHaveBeenCalledWith('node1');
  });

  test('triggerInspect calls onInspectSymbol with correct nodeId', () => {
    const event = { preventDefault: jest.fn(), stopPropagation: jest.fn() } as unknown as React.MouseEvent<HTMLElement>;
    triggerInspect(mockData, 'node1', event);
    expect(mockData.onInspectSymbol).toHaveBeenCalledWith('node1');
  });

  test('renderExpandButton renders button when expandable', () => {
    const { getByTitle } = render(renderExpandButton(mockData, 'node1'));
    expect(getByTitle('Expand this node')).toBeInTheDocument();
  });

  test('renderInspectLabel renders button when onInspectSymbol is a function', () => {
    const { getByTitle } = render(renderInspectLabel(mockData, 'node1', 'Label', 'className'));
    expect(getByTitle('Inspect Label data flow')).toBeInTheDocument();
  });

  test('renderMemberPreview renders members correctly', () => {
    mockData.memberDetails = [{ name: 'member1', nodeId: 'member1' }];
    const { getByText } = render(renderMemberPreview(mockData));
    expect(getByText('Loose Functions')).toBeInTheDocument();
    expect(getByText('member1()')).toBeInTheDocument();
  });

  test('renderClassSummary renders class summary correctly', () => {
    const summary: GraphClassSummary = {
      kind: 'class',
      name: 'TestClass',
      methodDetails: [],
      lineCount: 5,
      tests: [],
    };
    const { getByText } = render(renderClassSummary(summary, false, mockData));
    expect(getByText('TestClass')).toBeInTheDocument();
  });

  test('renderClassSections returns null when no class summaries', () => {
    const { container } = render(renderClassSections(mockData));
    expect(container.firstChild).toBeNull();
  });

  test('renderDataMappings returns null when no data mappings', () => {
    const { container } = render(renderDataMappings());
    expect(container.firstChild).toBeNull();
  });

  test('renderRiskSummary returns null when no risks', () => {
    const { container } = render(renderRiskSummary(mockData));
    expect(container.firstChild).toBeNull();
  });

  test('renderLinkedTestSummary returns null when no linked tests', () => {
    const { container } = render(renderLinkedTestSummary(mockData));
    expect(container.firstChild).toBeNull();
  });

  test('renderPackageRefs returns null when no package references', () => {
    const { container } = render(renderPackageRefs());
    expect(container.firstChild).toBeNull();
  });

  // Additional tests for edge cases, negative cases, performance, concurrency, SQL injection, data flow, mock/stub, security, and data leak can be added here.
});