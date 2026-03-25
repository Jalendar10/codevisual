import { Handle, NodeProps, Position } from '@xyflow/react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import {
  DataFlowMapping,
  GraphClassSummary,
  GraphMethodSummary,
  GraphNodeData,
  GraphTestStatus,
  PackageReference,
} from '../../../types';

type ImpactRole = 'selected' | 'upstream' | 'downstream' | 'both';
type SelectionPathRole = 'selected' | 'ancestor';

function shortPath(fullPath?: string): string {
  if (!fullPath) {
    return '';
  }
  const parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/');
}

function nodeMeta(data: GraphNodeData): string {
  if (data.parameters?.length) {
    return `(${data.parameters.map((parameter) => parameter.name).join(', ')})`;
  }

  if (data.childCount) {
    return `${data.childCount} children`;
  }

  if (data.lineCount) {
    return `${data.lineCount} lines`;
  }

  return data.language || '';
}

function formatSize(byteSize?: number): string {
  if (!byteSize) {
    return '0 KB';
  }

  const kilobytes = byteSize / 1024;
  return kilobytes >= 100 ? `${Math.round(kilobytes)} KB` : `${kilobytes.toFixed(1)} KB`;
}

function stopNodeEvent(event: ReactMouseEvent<HTMLElement>): void {
  event.preventDefault();
  event.stopPropagation();
}

function triggerExpand(data: GraphNodeData, nodeId: string, event: ReactMouseEvent<HTMLElement>): void {
  stopNodeEvent(event);
  data.onToggleExpand?.(nodeId);
}

function triggerInspect(data: GraphNodeData, nodeId: string, event: ReactMouseEvent<HTMLElement>): void {
  stopNodeEvent(event);
  data.onInspectSymbol?.(nodeId);
}

function renderExpandButton(data: GraphNodeData, nodeId: string) {
  if (!data.expandable) {
    return null;
  }

  return (
    <button
      type="button"
      className="cf-node__expand-button nodrag nopan"
      onClick={(event) => triggerExpand(data, nodeId, event)}
      title={data.expanded === false ? 'Expand this node' : 'Collapse this node'}
    >
      {data.expanded === false ? '+' : '−'}
    </button>
  );
}

function renderInspectLabel(
  data: GraphNodeData,
  nodeId: string | undefined,
  label: string,
  className: string,
  suffix = ''
) {
  if (!nodeId || typeof data.onInspectSymbol !== 'function') {
    return <span className={className}>{label}{suffix}</span>;
  }

  return (
    <button
      type="button"
      className={`${className} cf-node__inspect-button nodrag nopan`}
      onClick={(event) => triggerInspect(data, nodeId, event)}
      title={`Inspect ${label}${suffix ? suffix.replace(/[()]/g, '') : ''} data flow`}
    >
      {label}
      {suffix}
    </button>
  );
}

function renderMemberPreview(data: GraphNodeData) {
  const members = data.memberDetails?.length
    ? data.memberDetails
    : data.memberNames?.map((name): GraphMethodSummary => ({ name })) || [];
  if (!members.length) {
    return null;
  }

  return (
    <div className="cf-node__section">
      <div className="cf-node__section-label">Loose Functions</div>
      <div className="cf-node__members">
        {members.map((member, index) =>
          member.nodeId && typeof data.onInspectSymbol === 'function' ? (
            <button
              key={`${member.name}-${index}`}
              type="button"
              className="cf-node__member-chip cf-node__member-chip--action nodrag nopan"
              onClick={(event) => triggerInspect(data, member.nodeId!, event)}
              title={`Inspect ${member.name} data flow`}
            >
              {member.name}()
            </button>
          ) : (
            <span key={`${member.name}-${index}`} className="cf-node__member-chip">
              {member.name}
            </span>
          )
        )}
      </div>
    </div>
  );
}

function renderClassSummary(summary: GraphClassSummary, isLast: boolean, data: GraphNodeData) {
  const shown = summary.methodDetails?.length
    ? summary.methodDetails
    : summary.methods.map((name): GraphMethodSummary => ({ name, flowsTo: [], flowsFrom: [] }));
  return (
    <div key={`${summary.kind}-${summary.name}`} className="cf-node__class-block">
      <div className="cf-node__class-header">
        <span className="cf-node__kind-badge">{summary.kind}</span>
        {renderInspectLabel(data, summary.nodeId, summary.name, 'cf-node__class-name')}
        {summary.lineCount ? <em className="cf-node__class-lines">{summary.lineCount}L</em> : null}
        {summary.tests?.length ? <span className="cf-node__class-tests-badge">✓{summary.tests.length}</span> : null}
      </div>
      {(summary.extends || summary.implements?.length) ? (
        <div className="cf-node__class-meta">
          {summary.extends ? <span className="cf-node__extends">extends {summary.extends}</span> : null}
          {summary.implements?.length ? (
            <span className="cf-node__implements">impl {summary.implements.join(', ')}</span>
          ) : null}
        </div>
      ) : null}
      {summary.fields?.length ? (
        <div className="cf-node__field-list">
          {summary.fields.slice(0, 6).map((field, idx) => (
            <div key={`${summary.name}-field-${idx}`} className="cf-node__field-row">
              <span className="cf-node__field-icon">◆</span>
              <span className="cf-node__field-name">{field}</span>
            </div>
          ))}
        </div>
      ) : null}
      {shown.length > 0 ? (
        <div className="cf-node__method-tree">
          {shown.map((method, idx) => {
            const isLastMethod = idx === shown.length - 1;
            return (
              <div key={`${summary.name}-${method.name}-${idx}`} className="cf-node__method-block">
                <div className="cf-node__method-row">
                  <span className={`cf-node__tree-branch ${isLastMethod ? 'is-last' : ''}`}>
                    {isLastMethod ? '└─' : '├─'}
                  </span>
                  {renderInspectLabel(data, method.nodeId, method.name, 'cf-node__method-name', '()')}
                </div>
                {method.flowsTo?.length ? (
                  <div className="cf-node__method-flows">
                    {method.flowsTo.slice(0, 3).map((flow) => (
                      <div key={`${summary.name}-${method.name}-to-${flow}`} className="cf-node__method-flow">
                        <span className="cf-node__method-flow-arrow">→</span>
                        <span className="cf-node__method-flow-text">{flow}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {method.flowsFrom?.length ? (
                  <div className="cf-node__method-flows">
                    {method.flowsFrom.slice(0, 2).map((flow) => (
                      <div key={`${summary.name}-${method.name}-from-${flow}`} className="cf-node__method-flow is-inbound">
                        <span className="cf-node__method-flow-arrow">←</span>
                        <span className="cf-node__method-flow-text">{flow}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="cf-node__method-empty">no methods</div>
      )}
      {summary.sqlQueries?.length ? (
        <div className="cf-node__sql-list">
          {summary.sqlQueries.slice(0, 3).map((sql, idx) => (
            <div key={`${summary.name}-sql-${idx}`} className="cf-node__sql-row">
              <span className="cf-node__sql-icon">⚡</span>
              <span className="cf-node__sql-text" title={sql}>
                {sql.length > 60 ? sql.substring(0, 60) + '…' : sql}
              </span>
            </div>
          ))}
          {summary.sqlQueries.length > 3 ? (
            <div className="cf-node__sql-row cf-node__sql-more">
              +{summary.sqlQueries.length - 3} more queries
            </div>
          ) : null}
        </div>
      ) : null}
      {!isLast && <div className="cf-node__class-divider" />}
    </div>
  );
}

function renderClassSections(data: GraphNodeData) {
  if (!data.classSummaries?.length) {
    return null;
  }

  return (
    <div className="cf-node__section">
      <div className="cf-node__section-label">Classes &amp; Methods</div>
      <div className="cf-node__class-stack">
        {data.classSummaries.map((summary, idx) =>
          renderClassSummary(summary, idx === data.classSummaries!.length - 1, data)
        )}
      </div>
    </div>
  );
}

function renderDataMappings(dataMappings?: DataFlowMapping[]) {
  if (!dataMappings?.length) {
    return null;
  }

  return (
    <div className="cf-node__section">
      <div className="cf-node__section-label">Data Flow</div>
      <div className="cf-node__mapping-list">
        {dataMappings.slice(0, 8).map((mapping, idx) => (
          <div
            key={`${mapping.source}-${mapping.target}-${mapping.operation}-${idx}`}
            className={`cf-node__mapping-item cf-node__mapping-item--${mapping.confidence || 'medium'}`}
          >
            <span className="cf-node__mapping-source">{mapping.source}</span>
            <span className="cf-node__mapping-arrow">──{mapping.operation ? ` ${mapping.operation} ` : '──'}▶</span>
            <span className="cf-node__mapping-target">{mapping.target}</span>
          </div>
        ))}
        {dataMappings.length > 8 ? (
          <div className="cf-node__mapping-more">+{dataMappings.length - 8} more flows</div>
        ) : null}
      </div>
    </div>
  );
}

function renderPackageRefs(packageRefs?: PackageReference[]) {
  if (!packageRefs?.length) {
    return null;
  }

  return (
    <div className="cf-node__section">
      <div className="cf-node__section-label">Packages</div>
      <div className="cf-node__members">
        {packageRefs.slice(0, 5).map((reference) => (
          <span
            key={`${reference.kind}-${reference.name}`}
            className="cf-node__member-chip cf-node__member-chip--package"
          >
            {reference.name}
          </span>
        ))}
      </div>
    </div>
  );
}

function testStatusLabel(status?: GraphTestStatus): string | null {
  switch (status) {
    case 'running':
      return 'running';
    case 'passed':
      return 'pass';
    case 'failed':
      return 'fail';
    case 'queued':
      return 'queued';
    default:
      return null;
  }
}

function renderTestStatus(status?: GraphTestStatus) {
  const label = testStatusLabel(status);
  if (!label) {
    return null;
  }

  return <span className={`cf-node__test-pill is-${status}`}>{label}</span>;
}

function renderAiDot(summary?: unknown) {
  if (typeof summary !== 'string' || !summary.trim()) {
    return null;
  }

  return <span className="cf-node__ai-dot" title="AI analysis available" />;
}

function impactRole(data: GraphNodeData): ImpactRole | undefined {
  return typeof data.impactRole === 'string' ? (data.impactRole as ImpactRole) : undefined;
}

function selectionPathRole(data: GraphNodeData): SelectionPathRole | undefined {
  return typeof data.selectionPathRole === 'string'
    ? (data.selectionPathRole as SelectionPathRole)
    : undefined;
}

function heatRank(data: GraphNodeData): number {
  return Math.max(0, Math.min(1, Number(data.heatRank || 0)));
}

function heatColor(rank: number): string {
  if (rank <= 0.5) {
    return mixColor('#58d68d', '#f6d365', rank / 0.5);
  }

  return mixColor('#f6d365', '#f06a5f', (rank - 0.5) / 0.5);
}

function mixColor(start: string, end: string, amount: number): string {
  const clamped = Math.max(0, Math.min(1, amount));
  const startRgb = hexToRgb(start);
  const endRgb = hexToRgb(end);
  const mixed = startRgb.map((value, index) =>
    Math.round(value + (endRgb[index] - value) * clamped)
  );
  return `rgb(${mixed[0]}, ${mixed[1]}, ${mixed[2]})`;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '');
  return [
    parseInt(normalized.slice(0, 2), 16),
    parseInt(normalized.slice(2, 4), 16),
    parseInt(normalized.slice(4, 6), 16),
  ];
}

function nodeSurfaceStyle(data: GraphNodeData): CSSProperties {
  const rank = heatRank(data);
  const overlayMode = typeof data.overlayMode === 'string' ? data.overlayMode : 'none';
  const role = impactRole(data);
  const impactColor =
    role === 'selected'
      ? 'rgba(255, 255, 255, 0.95)'
      : role === 'upstream'
        ? 'rgba(240, 106, 95, 0.94)'
        : role === 'downstream'
          ? 'rgba(77, 215, 209, 0.94)'
          : role === 'both'
            ? 'rgba(246, 211, 101, 0.94)'
            : 'rgba(255, 255, 255, 0.14)';

  return {
    ['--cf-heat-color' as string]:
      overlayMode !== 'none' && rank > 0 ? heatColor(rank) : 'transparent',
    ['--cf-heat-alpha' as string]:
      overlayMode !== 'none' ? `${0.12 + rank * 0.24}` : '0',
    ['--cf-impact-color' as string]: impactColor,
  };
}

function nodeClassName(
  baseClass: string,
  data: GraphNodeData,
  selected: boolean
): string {
  const classes = [baseClass];
  if (selected) {
    classes.push('is-selected');
  }
  if (data.changed) {
    classes.push('is-changed');
  }
  if (impactRole(data)) {
    classes.push(`is-impact-${impactRole(data)}`);
  }
  if (selectionPathRole(data) === 'ancestor') {
    classes.push('is-selection-ancestor');
  }
  if (typeof data.overlayMode === 'string' && data.overlayMode !== 'none' && heatRank(data) > 0) {
    classes.push('is-heated');
  }
  return classes.join(' ');
}

export function FolderNode({ id, data, selected }: NodeProps) {
  const payload = data as GraphNodeData;
  const isExpanded = payload.expanded !== false;
  return (
    <div className={nodeClassName('cf-node cf-node-folder', payload, selected)} style={nodeSurfaceStyle(payload)}>
      <Handle type="target" position={Position.Left} className="cf-handle" />
      <div className="cf-node__header">
        <span className="cf-node__toggle">{isExpanded ? '▾' : '▸'}</span>
        <div className="cf-node__titles">
          <div className="cf-node__label">{payload.label}</div>
          <div className="cf-node__caption">{nodeMeta(payload)}</div>
        </div>
        {renderExpandButton(payload, id)}
      </div>
      <div className="cf-node__footer">
        <span title={payload.relativePath || payload.filePath}>{shortPath(payload.relativePath || payload.filePath)}</span>
      </div>
      <Handle type="source" position={Position.Right} className="cf-handle" />
    </div>
  );
}

export function FileNode({ id, data, selected }: NodeProps) {
  const payload = data as GraphNodeData;
  const isExpanded = payload.expanded !== false;
  return (
    <div
      className={nodeClassName('cf-node cf-node-file', payload, selected)}
      style={{ width: 'auto', minWidth: 320, ...nodeSurfaceStyle(payload) }}
    >
      <Handle type="target" position={Position.Left} className="cf-handle" />
      <div className="cf-node__header">
        <span className="cf-node__glyph">◫</span>
        <div className="cf-node__titles">
          <div className="cf-node__label-row">
            <div className="cf-node__label">{payload.label}</div>
            {renderAiDot(payload.summary)}
            {renderTestStatus(payload.testStatus)}
          </div>
          <div className="cf-node__caption">{payload.language || 'file'}</div>
        </div>
        {renderExpandButton(payload, id)}
      </div>
      <div className="cf-node__metric-grid">
        <div>
          <span>Lines</span>
          <strong>{payload.lineCount || 0}</strong>
        </div>
        <div>
          <span>Size</span>
          <strong>{formatSize(payload.byteSize)}</strong>
        </div>
        <div>
          <span>Classes</span>
          <strong>{payload.classCount || 0}</strong>
        </div>
        <div>
          <span>Methods</span>
          <strong>{payload.methodCount || 0}</strong>
        </div>
        <div>
          <span>Complexity</span>
          <strong>{payload.complexity || 0}</strong>
        </div>
        <div>
          <span>Hotspot</span>
          <strong>{payload.hotspotScore || 0}</strong>
        </div>
      </div>
      {isExpanded ? (
        <>
          {renderClassSections(payload)}
          {renderMemberPreview(payload)}
          {renderDataMappings(payload.dataMappings)}
        </>
      ) : null}
      <div className="cf-node__footer">
        <span title={payload.relativePath || payload.filePath}>{shortPath(payload.relativePath || payload.filePath)}</span>
      </div>
      <Handle type="source" position={Position.Right} className="cf-handle" />
    </div>
  );
}

export function SymbolNode({ id, data, selected, type }: NodeProps) {
  const payload = data as GraphNodeData;
  const isExpanded = payload.expanded !== false;
  return (
    <div
      className={nodeClassName(`cf-node cf-node-symbol cf-node-symbol--${type}`, payload, selected)}
      style={{ width: 'auto', minWidth: 260, ...nodeSurfaceStyle(payload) }}
    >
      <Handle type="target" position={Position.Left} className="cf-handle" />
      <div className="cf-node__header">
        <span className="cf-node__pill">{payload.kind || type}</span>
        <div className="cf-node__titles">
          <div className="cf-node__label-row">
            <div className="cf-node__label">{payload.label}</div>
            {renderAiDot(payload.summary)}
            {renderTestStatus(payload.testStatus)}
          </div>
          <div className="cf-node__caption">{nodeMeta(payload)}</div>
        </div>
        {renderExpandButton(payload, id)}
      </div>
      <div className="cf-node__body">
        {payload.returnType && <span>returns {payload.returnType}</span>}
        {payload.visibility && <span>{payload.visibility}</span>}
        {payload.isAsync && <span>async</span>}
        {!!payload.complexity && <span>complexity {payload.complexity}</span>}
        {!!payload.hotspotScore && <span>hotspot {payload.hotspotScore}</span>}
        {(payload.methodCount || 0) > 0 && <span>{payload.methodCount} methods</span>}
        {(payload.testCount || 0) > 0 && <span>{payload.testCount} tests</span>}
      </div>
      {isExpanded ? (
        <>
          {renderClassSections(payload)}
          {renderMemberPreview(payload)}
          {renderDataMappings(payload.dataMappings)}
        </>
      ) : null}
      {payload.docComment && <div className="cf-node__footer">{payload.docComment}</div>}
      <Handle type="source" position={Position.Right} className="cf-handle" />
    </div>
  );
}

export function ModuleNode({ data, selected }: NodeProps) {
  const payload = data as GraphNodeData;
  return (
    <div className={nodeClassName('cf-node cf-node-module', payload, selected)} style={nodeSurfaceStyle(payload)}>
      <Handle type="target" position={Position.Left} className="cf-handle" />
      <div className="cf-node__header">
        <span className="cf-node__glyph">{payload.external ? '⟡' : '⬢'}</span>
        <div className="cf-node__titles">
          <div className="cf-node__label">{payload.label}</div>
          <div className="cf-node__caption">{payload.external ? 'external dependency' : 'module'}</div>
        </div>
      </div>
      <div className="cf-node__footer">
        <span title={payload.relativePath || payload.filePath}>{shortPath(payload.relativePath || payload.filePath)}</span>
      </div>
      <Handle type="source" position={Position.Right} className="cf-handle" />
    </div>
  );
}
