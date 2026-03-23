import dagre from 'dagre';
import { Edge, Node } from '@xyflow/react';
import { GraphLayoutAlgorithm } from '../../../types';

const DEFAULT_SIZE = { width: 380, height: 220 };

export function applyLayout<T extends Record<string, unknown>>(
  nodes: Node<T>[],
  edges: Edge[],
  algorithm: GraphLayoutAlgorithm
): Node<T>[] {
  if (nodes.length === 0) {
    return [];
  }

  switch (algorithm) {
    case 'force-directed':
      return applyForceLayout(nodes, edges);
    case 'radial':
      return applyRadialLayout(nodes, edges);
    case 'tree':
      return applyDagreLayout(nodes, edges, 'LR', 60, 280);
    case 'hierarchical':
    default:
      return applyDagreLayout(nodes, edges, 'LR', 60, 320);
  }
}

function applyDagreLayout<T extends Record<string, unknown>>(
  nodes: Node<T>[],
  edges: Edge[],
  direction: 'TB' | 'LR',
  nodesep: number,
  ranksep: number
): Node<T>[] {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: direction,
    nodesep,
    ranksep,
    marginx: 80,
    marginy: 80,
  });

  nodes.forEach((node) => {
    const rawWidth =
      typeof node.style?.width === 'number' ? node.style.width : DEFAULT_SIZE.width;
    // Add generous padding so dagre reserves enough space for the rendered node
    const width = rawWidth + 40;
    // Use minHeight if set (the estimated render height), else fallback.
    // Add extra padding because actual rendered height often exceeds the estimate.
    const rawHeight =
      typeof node.style?.minHeight === 'number'
        ? node.style.minHeight
        : typeof node.style?.height === 'number'
          ? node.style.height
          : DEFAULT_SIZE.height;
    const height = rawHeight + 60;

    graph.setNode(node.id, { width, height });
  });

  edges.forEach((edge) => graph.setEdge(edge.source, edge.target));
  dagre.layout(graph);

  return nodes.map((node) => {
    const dagNode = graph.node(node.id);
    if (!dagNode) {
      return node;
    }
    const { width, height, x, y } = dagNode;
    return {
      ...node,
      position: {
        x: x - width / 2,
        y: y - height / 2,
      },
    };
  });
}

function applyRadialLayout<T extends Record<string, unknown>>(nodes: Node<T>[], edges: Edge[]): Node<T>[] {
  const incoming = new Set(edges.map((edge) => edge.target));
  const roots = nodes.filter((node) => !incoming.has(node.id));
  const levels = new Map<string, number>();
  const visited = new Set<string>();
  const queue = roots.map((node) => ({ id: node.id, level: 0 }));

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.id)) {
      continue;
    }

    visited.add(current.id);
    levels.set(current.id, current.level);

    edges
      .filter((edge) => edge.source === current.id)
      .forEach((edge) => {
        if (!visited.has(edge.target)) {
          queue.push({ id: edge.target, level: current.level + 1 });
        }
      });
  }

  const grouped = new Map<number, string[]>();
  levels.forEach((level, id) => {
    const ids = grouped.get(level) || [];
    ids.push(id);
    grouped.set(level, ids);
  });

  const centerX = 540;
  const centerY = 400;
  const radiusStep = 170;

  return nodes.map((node) => {
    const level = levels.get(node.id) || 0;
    const group = grouped.get(level) || [node.id];
    const index = Math.max(0, group.indexOf(node.id));
    const angle = (Math.PI * 2 * index) / Math.max(group.length, 1) - Math.PI / 2;
    const radius = level * radiusStep;

    return {
      ...node,
      position: {
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
      },
    };
  });
}

function applyForceLayout<T extends Record<string, unknown>>(nodes: Node<T>[], edges: Edge[]): Node<T>[] {
  const state = new Map<string, { x: number; y: number; vx: number; vy: number }>();

  nodes.forEach((node, index) => {
    const angle = (index / Math.max(nodes.length, 1)) * Math.PI * 2;
    state.set(node.id, {
      x: 800 + Math.cos(angle) * 500,
      y: 600 + Math.sin(angle) * 500,
      vx: 0,
      vy: 0,
    });
  });

  for (let iteration = 0; iteration < 180; iteration += 1) {
    for (const source of nodes) {
      const sourceState = state.get(source.id)!;
      for (const target of nodes) {
        if (source.id === target.id) {
          continue;
        }

        const targetState = state.get(target.id)!;
        const dx = sourceState.x - targetState.x;
        const dy = sourceState.y - targetState.y;
        const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const repulsion = 18000 / (distance * distance);
        sourceState.vx += (dx / distance) * repulsion;
        sourceState.vy += (dy / distance) * repulsion;
      }
    }

    for (const edge of edges) {
      const sourceState = state.get(edge.source);
      const targetState = state.get(edge.target);
      if (!sourceState || !targetState) {
        continue;
      }

      const dx = targetState.x - sourceState.x;
      const dy = targetState.y - sourceState.y;
      sourceState.vx += dx * 0.006;
      sourceState.vy += dy * 0.006;
      targetState.vx -= dx * 0.006;
      targetState.vy -= dy * 0.006;
    }

    state.forEach((entry) => {
      entry.x += entry.vx;
      entry.y += entry.vy;
      entry.vx *= 0.78;
      entry.vy *= 0.78;
    });
  }

  return nodes.map((node) => {
    const position = state.get(node.id)!;
    return {
      ...node,
      position: { x: position.x, y: position.y },
    };
  });
}
