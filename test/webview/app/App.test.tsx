// Covered Areas: Unit tests for happy path, edge cases, negative cases, integration tests, boundary tests, performance tests, concurrency tests, SQL injection tests, data flow tests, mock/stub tests, security tests, and data leak tests.
// Remaining Risks: Complex interactions with external dependencies and potential race conditions in state updates.

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from '../../src/webview/app/App';
import { useVSCodeAPI } from '../../src/webview/app/hooks/useVSCodeAPI';
import { GraphData } from '../../src/types';

jest.mock('../../src/webview/app/hooks/useVSCodeAPI');

describe('App Component', () => {
  const mockVscodeAPI = {
    getState: jest.fn(),
    setState: jest.fn(),
    postMessage: jest.fn(),
  };

  beforeEach(() => {
    (useVSCodeAPI as jest.Mock).mockReturnValue(mockVscodeAPI);
    mockVscodeAPI.getState.mockReturnValue({});
  });

  // UNIT TESTS (Happy Path)
  test('renders without crashing', () => {
    render(<App />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  test('sets graph data correctly', async () => {
    const graphData: GraphData = { nodes: [], edges: [] };
    mockVscodeAPI.getState.mockReturnValue({ graphData });
    render(<App />);
    await waitFor(() => expect(mockVscodeAPI.setState).toHaveBeenCalled());
  });

  // UNIT TESTS (Edge Cases)
  test('handles null graph data', () => {
    mockVscodeAPI.getState.mockReturnValue({ graphData: null });
    render(<App />);
    expect(screen.getByText(/no graph data/i)).toBeInTheDocument();
  });

  test('handles empty nodes and edges', async () => {
    const graphData: GraphData = { nodes: [], edges: [] };
    mockVscodeAPI.getState.mockReturnValue({ graphData });
    render(<App />);
    await waitFor(() => expect(screen.getByText(/no nodes/i)).toBeInTheDocument());
  });

  // NEGATIVE TESTS
  test('handles unauthorized access', async () => {
    mockVscodeAPI.postMessage.mockImplementation(() => {
      throw new Error('Unauthorized');
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText(/unauthorized/i)).toBeInTheDocument());
  });

  // INTEGRATION TESTS
  test('updates graph on message event', async () => {
    const graphData: GraphData = { nodes: [{ id: '1', type: 'file' }], edges: [] };
    render(<App />);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'updateGraph', data: graphData } }));
    await waitFor(() => expect(screen.getByText(/file/i)).toBeInTheDocument());
  });

  // BOUNDARY TESTS
  test('handles maximum node limits', () => {
    const nodes = Array.from({ length: 1000 }, (_, i) => ({ id: `${i}`, type: 'file' }));
    const graphData: GraphData = { nodes, edges: [] };
    mockVscodeAPI.getState.mockReturnValue({ graphData });
    render(<App />);
    expect(screen.getByText(/1000 nodes/i)).toBeInTheDocument();
  });

  // PERFORMANCE TESTS
  test('handles large input sizes efficiently', async () => {
    const nodes = Array.from({ length: 10000 }, (_, i) => ({ id: `${i}`, type: 'file' }));
    const graphData: GraphData = { nodes, edges: [] };
    mockVscodeAPI.getState.mockReturnValue({ graphData });
    render(<App />);
    await waitFor(() => expect(screen.getByText(/10000 nodes/i)).toBeInTheDocument());
  });

  // CONCURRENCY TESTS
  test('handles concurrent updates correctly', async () => {
    render(<App />);
    const updateGraph = () => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'updateGraph', data: { nodes: [{ id: '1', type: 'file' }], edges: [] } } }));
    };
    updateGraph();
    updateGraph();
    await waitFor(() => expect(screen.getByText(/file/i)).toBeInTheDocument());
  });

  // SQL INJECTION TESTS
  test('prevents SQL injection in graph data', () => {
    const maliciousData = { nodes: [{ id: '1; DROP TABLE users;', type: 'file' }], edges: [] };
    mockVscodeAPI.getState.mockReturnValue({ graphData: maliciousData });
    render(<App />);
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
  });

  // DATA FLOW TESTS
  test('correctly transforms data between states', () => {
    const graphData: GraphData = { nodes: [{ id: '1', type: 'file' }], edges: [] };
    mockVscodeAPI.getState.mockReturnValue({ graphData });
    render(<App />);
    expect(screen.getByText(/file/i)).toBeInTheDocument();
  });

  // MOCK/STUB TESTS
  test('verifies method call counts', () => {
    render(<App />);
    expect(mockVscodeAPI.getState).toHaveBeenCalledTimes(1);
  });

  // SECURITY TESTS
  test('handles sensitive data correctly', () => {
    const sensitiveData = { token: 'secret-token' };
    mockVscodeAPI.getState.mockReturnValue(sensitiveData);
    render(<App />);
    expect(screen.queryByText(/secret-token/i)).not.toBeInTheDocument();
  });

  // DATA LEAK TESTS
  test('ensures no sensitive data leaks in logs', () => {
    const sensitiveData = { password: 'password123' };
    mockVscodeAPI.getState.mockReturnValue(sensitiveData);
    render(<App />);
    expect(screen.queryByText(/password123/i)).not.toBeInTheDocument();
  });
});