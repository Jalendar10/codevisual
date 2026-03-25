import dagre from 'dagre';
import { Edge, Node } from '@xyflow/react';
import { GraphLayoutAlgorithm } from '../../../types';

const DEFAULT_SIZE = { width: 380, height: 220 };

// Estimate node height based on content — auto-adjust for class/method count
function estimateNodeHeight(node: Node): number {
  const data = node.data as Record<string, unknown>;
  let height = 80; // base header + footer

  // Methods contribute to height
  const methodCount = (data.methodCount as number) || 0;
  height += methodCount * 18;

  // Class summaries contribute
  const classSummaries = data.classSummaries as Array<{ methods: string[]; fields?: string[]; sqlQueries?: string[] }> | undefined;
  if (classSummaries?.length) {
    for (const cls of classSummaries) {
      height += 32; // class header
      height += (cls.methods?.length || 0) * 18;
      height += (cls.fields?.length || 0) * 14;
      height += (cls.sqlQueries?.length || 0) * 16;
    }
  }

  // Data mappings contribute
  const dataMappings = data.dataMappings as unknown[] | undefined;
  if (dataMappings?.length) {
    height += 24 + Math.min(dataMappings.length, 8) * 18;
  }

  // Metric grid
  if (data.lineCount || data.byteSize) {
    height += 40;
  }

  return Math.max(DEFAULT_SIZE.height, height);
}

// Estimate node width based on label length and content
function estimateNodeWidth(node: Node): number {
  const data = node.data as Record<string, unknown>;
  const label = (data.label as string) || '';
  let width = Math.max(280, label.length * 9 + 60);

  const classSummaries = data.classSummaries as Array<{ name: string; methods: string[] }> | undefined;
  if (classSummaries?.length) {
    for (const cls of classSummaries) {
      width = Math.max(width, cls.name.length * 9 + 80);
      for (const m of cls.methods) {
        width = Math.max(width, m.length * 7 + 80);
      }
    }
  }

  return Math.min(width, 500); // cap at 500
}

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
    const width = estimateNodeWidth(node) + 40;
    const height = estimateNodeHeight(node) + 40;
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

  // Build adjacency for faster edge lookup
  const adjOut = new Map<string, string[]>();
  const adjIn = new Map<string, string[]>();
  for (const edge of edges) {
    const out = adjOut.get(edge.source) || [];
    out.push(edge.target);
    adjOut.set(edge.source, out);
    const inp = adjIn.get(edge.target) || [];
    inp.push(edge.source);
    adjIn.set(edge.target, inp);
  }

  nodes.forEach((node, index) => {
    const angle = (index / Math.max(nodes.length, 1)) * Math.PI * 2;
    state.set(node.id, {
      x: 800 + Math.cos(angle) * 500,
      y: 600 + Math.sin(angle) * 500,
      vx: 0,
      vy: 0,
    });
  });

  // Fewer iterations for large graphs → faster render
  const iterations = nodes.length > 100 ? 80 : nodes.length > 50 ? 120 : 180;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    // Use Barnes-Hut-like optimization for large graphs: skip distant pairs
    for (let i = 0; i < nodes.length; i++) {
      const sourceState = state.get(nodes[i].id)!;
      for (let j = i + 1; j < nodes.length; j++) {
        const targetState = state.get(nodes[j].id)!;
        const dx = sourceState.x - targetState.x;
        const dy = sourceState.y - targetState.y;
        const distSq = dx * dx + dy * dy;
        const distance = Math.max(1, Math.sqrt(distSq));

        // Skip very distant pairs for perf
        if (distance > 2000 && nodes.length > 60) {
          continue;
        }

        const repulsion = 18000 / distSq;
        const fx = (dx / distance) * repulsion;
        const fy = (dy / distance) * repulsion;
        sourceState.vx += fx;
        sourceState.vy += fy;
        targetState.vx -= fx;
        targetState.vy -= fy;
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
