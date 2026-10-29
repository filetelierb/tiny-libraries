import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowSteps } from '../src/study/Diagram';
import { verticalFlowchart } from '../src/study/diagrams';

const box = { left: 0, top: 0, width: 10, height: 10 };
test('playing a flow alternates nodes and the links between them', () => {
  const nodes = ['A', 'B', 'C'].map((id) => ({ id, label: id, ...box }));
  assert.deepEqual(
    flowSteps({
      nodes,
      links: [
        { id: 'link-0', from: 'A', to: 'B', label: 'samples' },
        { id: 'link-1', from: 'B', to: 'C', label: '' },
      ],
    }).map((step) => `${step.kind}:${step.id}`),
    ['node:A', 'link:link-0', 'node:B', 'link:link-1', 'node:C'],
  );
  assert.deepEqual(
    flowSteps({ nodes, links: [] }).map((step) => step.id),
    ['A', 'B', 'C'],
  );
});

test('a left-to-right flowchart can be redrawn top to bottom', () => {
  assert.equal(verticalFlowchart('flowchart LR\n  A --> B'), 'flowchart TD\n  A --> B');
  assert.equal(verticalFlowchart('%% steps\ngraph RL\nA-->B'), '%% steps\ngraph BT\nA-->B');
  assert.equal(verticalFlowchart('flowchart TD\n  A --> B'), null);
  assert.equal(verticalFlowchart('sequenceDiagram\n  A->>B: LR'), null);
});
