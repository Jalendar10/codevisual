import dagre from 'dagre';
import { Edge, Node } from '@xyflow/react';
import { GraphLayoutAlgorithm } from '../../../types';

const DEFAULT_SIZE = { width: 340, height: 180 };

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
      return applyDagreLayout(nodes, edges, 'TB', 140, 180);
    case 'hierarchical':
    default:
      return applyDagreLayout(nodes, edges, 'TB', 150, 210);
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
    marginx: 48,
    marginy: 48,
  });

  nodes.forEach((node) => {
    const width =
      typeof node.style?.width === 'number' ? node.style.width : DEFAULT_SIZE.width;
    const height =
      typeof node.style?.minHeight === 'number'
        ? node.style.minHeight
        : typeof node.style?.height === 'number'
          ? node.style.height
          : DEFAULT_SIZE.height;

    graph.setNode(node.id, { width, height });
  });

  edges.forEach((edge) => graph.setEdge(edge.source, edge.target));
  dagre.layout(graph);

  return nodes.map((node) => {
    const { width, height, x, y } = graph.node(node.id);
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
      x: 540 + Math.cos(angle) * 260,
      y: 380 + Math.sin(angle) * 260,
      vx: 0,
      vy: 0,
    });
  });

  for (let iteration = 0; iteration < 120; iteration += 1) {
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
        const repulsion = 5200 / (distance * distance);
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
      sourceState.vx += dx * 0.008;
      sourceState.vy += dy * 0.008;
      targetState.vx -= dx * 0.008;
      targetState.vy -= dy * 0.008;
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
