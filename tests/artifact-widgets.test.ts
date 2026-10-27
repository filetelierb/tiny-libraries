import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileExpression,
  parseWidget,
  sanitizeWidgets,
  widgetImages,
  widgetSegments,
} from '../shared/artifact-widgets';

const block = (value: unknown) => '```widget\n' + JSON.stringify(value) + '\n```';

test('expressions evaluate arithmetic over declared parameters only', () => {
  const nyquist = compileExpression('2 * f', ['f'])!;
  assert.equal(nyquist({ f: 8 }), 16);
  assert.equal(compileExpression('fs < 2*f && f > 0', ['f', 'fs'])!({ f: 8, fs: 12 }), 1);
  assert.equal(compileExpression('clamp(x, 0, 1) + 2^3^2', ['x'])!({ x: 5 }), 513);
  assert.equal(compileExpression('alert(1)', ['x']), null);
  assert.equal(compileExpression('x.constructor', ['x']), null);
  assert.equal(compileExpression('y + 1', ['x']), null);
});

test('widgets are validated against the closed catalog', () => {
  assert.equal(
    parseWidget(
      JSON.stringify({
        type: 'steps',
        title: 'Sample',
        steps: [
          { title: 'a', body: 'b' },
          { title: 'c', body: 'd' },
        ],
      }),
    )?.type,
    'steps',
  );
  assert.equal(
    parseWidget(
      JSON.stringify({ type: 'steps', title: 'One', steps: [{ title: 'a', body: 'b' }] }),
    ),
    null,
  );
  assert.equal(
    parseWidget(
      JSON.stringify({
        type: 'chart',
        title: 'c',
        labels: ['a', 'b'],
        series: [{ name: 's', values: [1] }],
      }),
    ),
    null,
  );
  assert.equal(
    parseWidget(
      JSON.stringify({
        type: 'explorable',
        title: 'Alias',
        params: [{ id: 'f', label: 'f', min: 1, max: 20, step: 1, value: 8 }],
        outputs: [{ label: 'Nyquist', expr: 'fetch(f)' }],
      }),
    ),
    null,
  );
  assert.equal(parseWidget('{not json'), null);
  assert.equal(parseWidget(JSON.stringify({ type: 'script', code: 'x' })), null);
});

test('generated markdown keeps valid widgets and drops broken or uncited ones', () => {
  const summary = { type: 'summary', points: [{ text: 'Sample at twice f', segmentId: 's1' }] };
  const invented = { type: 'summary', points: [{ text: 'Made up', segmentId: 'nope' }] };
  const picture = { type: 'image', segmentId: 's2', alt: 'Waveform' };
  const markdown = [
    'Intro.',
    block(summary),
    block(invented),
    '```widget\n{broken\n```',
    block(picture),
    'End.',
  ].join('\n\n');
  const kept = sanitizeWidgets(markdown, new Set(['s1', 's2']));
  assert.equal(kept, ['Intro.', block(summary), 'End.'].join('\n\n'));
  const withPicture = sanitizeWidgets(markdown, new Set(['s1', 's2']), new Set(['s2']));
  assert.deepEqual(widgetImages(withPicture), ['s2']);
  assert.deepEqual(widgetSegments(withPicture), ['s1', 's2']);
});
