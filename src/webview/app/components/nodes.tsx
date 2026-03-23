import { Handle, NodeProps, Position } from '@xyflow/react';
import {
  DataFlowMapping,
  GraphClassSummary,
  GraphNodeData,
  GraphTestStatus,
  PackageReference,
} from '../../../types';

function shortPath(fullPath?: string): string {
  if (!fullPath) {
    return '';
  }
  // Show only last 2 segments: parent/filename
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

function renderMemberPreview(data: GraphNodeData) {
  if (!data.memberNames?.length) {
    return null;
  }

  return (
    <div className="cf-node__section">
      <div className="cf-node__section-label">Loose Functions</div>
      <div className="cf-node__members">
        {data.memberNames.map((member) => (
          <span key={member} className="cf-node__member-chip">
            {member}
          </span>
        ))}
      </div>
    </div>
  );
}

function renderClassSummary(summary: GraphClassSummary) {
  return (
    <div key={`${summary.kind}-${summary.name}`} className="cf-node__class-block">
      <div className="cf-node__class-header">
        <strong>{summary.name}</strong>
        <span>{summary.kind}</span>
        {summary.lineCount ? <em>{summary.lineCount}L</em> : null}
      </div>
      <div className="cf-node__class-body">
        {summary.methods.length > 0 ? (
          summary.methods.slice(0, 6).map((method, idx) => (
            <div key={`${summary.name}-${method}`} className="cf-node__class-method">
              {method}
              {idx < summary.methods.length - 1 && idx < 5 ? (
                <span className="cf-node__method-flow"> ↓</span>
              ) : null}
            </div>
          ))
        ) : (
          <div className="cf-node__class-method is-muted">No methods detected</div>
        )}
        {summary.methods.length > 6 ? (
          <div className="cf-node__class-method is-muted">+{summary.methods.length - 6} more</div>
        ) : null}
        {summary.tests?.length ? (
          <div className="cf-node__class-tests">{summary.tests.length} test(s)</div>
        ) : null}
      </div>
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
      <div className="cf-node__class-stack">{data.classSummaries.map(renderClassSummary)}</div>
    </div>
  );
}

function renderDataMappings(dataMappings?: DataFlowMapping[]) {
  if (!dataMappings?.length) {
    return null;
  }

  return (
    <div className="cf-node__section">
      <div className="cf-node__section-label">Data Mapping</div>
      <div className="cf-node__mapping-list">
        {dataMappings.slice(0, 4).map((mapping) => (
          <div
            key={`${mapping.source}-${mapping.target}-${mapping.operation}`}
            className="cf-node__mapping-item"
          >
            <strong>{mapping.source}</strong>
            <span>↓ {mapping.operation || '→'}</span>
            <span>{mapping.target}</span>
          </div>
        ))}
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

export function FolderNode({ data, selected }: NodeProps) {
  const payload = data as GraphNodeData;
  return (
    <div className={`cf-node cf-node-folder ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} className="cf-handle" />
      <div className="cf-node__header">
        <span className="cf-node__glyph">{payload.expanded ? '▾' : '▸'}</span>
        <div className="cf-node__titles">
          <div className="cf-node__label">{payload.label}</div>
          <div className="cf-node__caption">{nodeMeta(payload)}</div>
        </div>
      </div>
      <div className="cf-node__footer">
        <span title={payload.relativePath || payload.filePath}>{shortPath(payload.relativePath || payload.filePath)}</span>
      </div>
      <Handle type="source" position={Position.Right} className="cf-handle" />
    </div>
  );
}

export function FileNode({ data, selected }: NodeProps) {
  const payload = data as GraphNodeData;
  return (
    <div className={`cf-node cf-node-file ${selected ? 'is-selected' : ''}`}>
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
      </div>
      {renderClassSections(payload)}
      {renderMemberPreview(payload)}
      {renderDataMappings(payload.dataMappings)}
      {renderPackageRefs(payload.packageRefs)}
      <div className="cf-node__footer">
        <span title={payload.relativePath || payload.filePath}>{shortPath(payload.relativePath || payload.filePath)}</span>
      </div>
      <Handle type="source" position={Position.Right} className="cf-handle" />
    </div>
  );
}

export function SymbolNode({ data, selected, type }: NodeProps) {
  const payload = data as GraphNodeData;
  return (
    <div className={`cf-node cf-node-symbol cf-node-symbol--${type} ${selected ? 'is-selected' : ''}`}>
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
      </div>
      <div className="cf-node__body">
        {payload.returnType && <span>returns {payload.returnType}</span>}
        {payload.visibility && <span>{payload.visibility}</span>}
        {payload.isAsync && <span>async</span>}
        {(payload.methodCount || 0) > 0 && <span>{payload.methodCount} methods</span>}
        {(payload.testCount || 0) > 0 && <span>{payload.testCount} tests</span>}
      </div>
      {renderClassSections(payload)}
      {renderMemberPreview(payload)}
      {renderDataMappings(payload.dataMappings)}
      {payload.docComment && <div className="cf-node__footer">{payload.docComment}</div>}
      <Handle type="source" position={Position.Right} className="cf-handle" />
    </div>
  );
}

export function ModuleNode({ data, selected }: NodeProps) {
  const payload = data as GraphNodeData;
  return (
    <div className={`cf-node cf-node-module ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} className="cf-handle" />
      <div className="cf-node__header">
        <span className="cf-node__glyph">{payload.external ? '⟡' : '⬢'}</span>
        <div className="cf-node__titles">
          <div className="cf-node__label">{payload.label}</div>
          <div className="cf-node__caption">{payload.external ? 'external dependency' : 'module'}</div>
        </div>
      </div>
      {renderPackageRefs(payload.packageRefs)}
      <div className="cf-node__footer">
        <span title={payload.relativePath || payload.filePath}>{shortPath(payload.relativePath || payload.filePath)}</span>
      </div>
      <Handle type="source" position={Position.Right} className="cf-handle" />
    </div>
  );
}
