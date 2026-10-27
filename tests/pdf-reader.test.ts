import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedPage, pdfScale, readPdfZoom, steppedZoom } from '../shared/pdf-reader';

test('PDF navigation and saved zoom reject invalid positions and remain bounded', () => {
  assert.equal(boundedPage(99, 3), 3);
  assert.equal(boundedPage(-2, 3), 1);
  assert.equal(boundedPage(NaN, 3), 1);
  assert.equal(boundedPage(2.4, 3), 2);
  assert.equal(readPdfZoom(900), 300);
  assert.equal(readPdfZoom(Infinity), 'width');
  assert.equal(readPdfZoom('broken'), 'width');
});
test('fit modes use the actual page dimensions and reader space', () => {
  const page = { width: 600, height: 800 },
    space = { width: 636, height: 432 };
  assert.equal(pdfScale('width', page, space), 1);
  assert.equal(pdfScale('page', page, space), 0.5);
  assert.equal(pdfScale(150, page, space), 1.5);
  assert.equal(pdfScale('page', { width: 800, height: 600 }, space), 2 / 3);
});

test('zoom buttons step between the preset list', () => {
  assert.equal(steppedZoom(100, 1), 125);
  assert.equal(steppedZoom(150, 1), 200);
  assert.equal(steppedZoom(175, -1), 150);
  assert.equal(steppedZoom('width', -1), 75);
  assert.equal(steppedZoom(300, 1), 300);
  assert.equal(steppedZoom(25, -1), 25);
});
