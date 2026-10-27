import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  captureDrawingSchema,
  capturePointFromView,
  capturePointToView,
  capturePixelCrop,
  captureCommentText,
  emptyCaptureDrawing,
  type CaptureDrawing,
  type CaptureObject,
} from '../shared/capture-drawing';
import { renderCapture } from '../server/capture-render';

const id = () => crypto.randomUUID();
const space = { width: 64, height: 48 };
const rect = [
  { x: 0.25, y: 0.25 },
  { x: 0.75, y: 0.75 },
];
const model = (objects: CaptureObject[] = [], crop?: CaptureDrawing['crop']): CaptureDrawing => ({
  format: 1,
  space,
  objects,
  ...(crop ? { crop } : {}),
});
const base = (covered = '#ef3120', outside = '#ffffff') => {
  const canvas = createCanvas(space.width, space.height),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = outside;
  ctx.fillRect(0, 0, space.width, space.height);
  ctx.fillStyle = covered;
  ctx.fillRect(16, 12, 32, 24);
  return canvas.toBuffer('image/png');
};
async function raster(bytes: Uint8Array) {
  const image = await loadImage(Buffer.from(bytes)),
    canvas = createCanvas(image.width, image.height),
    ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return {
    width: image.width,
    height: image.height,
    pixel: (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data],
  };
}

test('portable capture documents enforce identity, geometry and bounded payloads without accepting active content', () => {
  const drawing = model([{ id: id(), kind: 'pen', points: rect, color: '#007f76', width: 3 }]);
  assert.deepEqual(captureDrawingSchema.parse(JSON.parse(JSON.stringify(drawing))), drawing);
  for (const invalid of [
    { ...drawing, objects: [drawing.objects[0], drawing.objects[0]] },
    { ...drawing, objects: [{ ...drawing.objects[0], color: 'url(https://example.org/image)' }] },
    { ...drawing, objects: [{ ...drawing.objects[0], points: [{ x: Infinity, y: 0 }] }] },
    { ...drawing, crop: { x: 0.8, y: 0, width: 0.5, height: 1 } },
    { ...drawing, space: { width: 4097, height: 1 } },
    {
      ...drawing,
      objects: [{ id: id(), kind: 'redact', shape: 'rect', points: [rect[0]], width: 4 }],
    },
    {
      ...drawing,
      objects: [
        {
          id: id(),
          kind: 'text',
          point: rect[0],
          text: 'Text',
          color: '#202f36',
          fontSize: 17,
          style: 'plain',
          tail: rect[1],
        },
      ],
    },
    {
      ...drawing,
      objects: Array.from({ length: 101 }, () => ({ ...drawing.objects[0], id: id() })),
    },
    {
      ...drawing,
      objects: Array.from({ length: 2 }, () => ({
        ...drawing.objects[0],
        id: id(),
        points: Array.from({ length: 2000 }, () => rect[0]),
      })),
    },
  ])
    assert.equal(captureDrawingSchema.safeParse(invalid).success, false);
});
test('crop/view coordinate round trips keep canonical points fixed through different viewport sizes', () => {
  const crop = { x: 0.2, y: 0.25, width: 0.5, height: 0.5 };
  for (const point of [
    { x: 0, y: 0 },
    { x: 0.5, y: 0.5 },
    { x: 1, y: 1 },
  ]) {
    const roundTrip = capturePointToView(capturePointFromView(point, crop), crop);
    assert.ok(Math.abs(roundTrip.x - point.x) < 1e-10 && Math.abs(roundTrip.y - point.y) < 1e-10);
  }
  assert.deepEqual(capturePixelCrop(space, { x: 1, y: 1, width: 0, height: 0 }), {
    x: 63,
    y: 47,
    width: 1,
    height: 1,
  });
  assert.deepEqual(capturePixelCrop(space, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }), {
    x: 16,
    y: 12,
    width: 32,
    height: 24,
  });
  assert.deepEqual(emptyCaptureDrawing(space), model());
});
test('flattened crops contain neither excluded image pixels nor their influence on mosaic sampling', async () => {
  const drawing = model(
    [
      {
        id: id(),
        kind: 'mosaic',
        shape: 'rect',
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        width: 8,
        pixelSize: 10,
      },
    ],
    { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
  );
  const first = await renderCapture(base('#ffffff', '#ef3120'), drawing),
    second = await renderCapture(base('#ffffff', '#2020ff'), drawing);
  assert.equal(first.width, 32);
  assert.equal(first.height, 24);
  assert.deepEqual(first.bytes, second.bytes);
  assert.deepEqual((await raster(first.bytes)).pixel(0, 0), [255, 255, 255, 255]);
});
test('opaque redaction removes covered pixels before later filters and remains opaque above later marks', async () => {
  const drawing = model([
    { id: id(), kind: 'redact', shape: 'rect', points: rect, width: 8 },
    {
      id: id(),
      kind: 'mosaic',
      shape: 'rect',
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      width: 8,
      pixelSize: 10,
    },
    { id: id(), kind: 'pen', points: rect, width: 12, color: '#ffffff' },
  ]);
  const first = await renderCapture(base('#ef3120'), drawing),
    second = await renderCapture(base('#2020ff'), drawing);
  assert.deepEqual(first.bytes, second.bytes);
  const pixels = await raster(first.bytes);
  assert.deepEqual(pixels.pixel(32, 24), [0, 0, 0, 255]);
  assert.deepEqual(pixels.pixel(16, 12), [0, 0, 0, 255]);
});
test('overlapping brush capsules do not create holes in redaction', async () => {
  const drawing = model([
    {
      id: id(),
      kind: 'redact',
      shape: 'stroke',
      points: [
        { x: 0.25, y: 0.5 },
        { x: 0.5, y: 0.5 },
        { x: 0.75, y: 0.5 },
      ],
      width: 12,
    },
  ]);
  const pixels = await raster((await renderCapture(base(), drawing)).bytes);
  for (let x = 16; x <= 48; x++) assert.deepEqual(pixels.pixel(x, 24), [0, 0, 0, 255]);
});
test('multiple spotlight regions share one shadow and overlap without darkening each other', async () => {
  const drawing = model([
    {
      id: id(),
      kind: 'spotlight',
      shape: 'rect',
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.6, y: 0.8 },
      ],
      width: 8,
      color: '#007f76',
    },
    {
      id: id(),
      kind: 'spotlight',
      shape: 'rect',
      points: [
        { x: 0.4, y: 0.1 },
        { x: 0.9, y: 0.8 },
      ],
      width: 8,
      color: '#007f76',
    },
  ]);
  const pixels = await raster((await renderCapture(base('#ffffff'), drawing)).bytes);
  assert.deepEqual(pixels.pixel(32, 24), [255, 255, 255, 255]);
  assert.deepEqual(pixels.pixel(16, 24), [255, 255, 255, 255]);
  const shadow = pixels.pixel(0, 0);
  assert.ok(shadow[0] > 110 && shadow[0] < 140);
});
test('all drawable object kinds produce bounded deterministic pixels and preserve comment text separately', async () => {
  const drawing = model([
    {
      id: id(),
      kind: 'pen',
      points: [
        { x: 0.1, y: 0.2 },
        { x: 0.9, y: 0.2 },
      ],
      width: 3,
      color: '#007f76',
    },
    {
      id: id(),
      kind: 'highlight',
      points: [
        { x: 0.1, y: 0.3 },
        { x: 0.9, y: 0.3 },
      ],
      width: 8,
      color: '#e5913f',
    },
    {
      id: id(),
      kind: 'arrow',
      points: [
        { x: 0.1, y: 0.4 },
        { x: 0.7, y: 0.4 },
      ],
      width: 2,
      color: '#1f6bbb',
    },
    {
      id: id(),
      kind: 'text',
      point: { x: 0.2, y: 0.45 },
      text: 'α\nLine two',
      fontSize: 8,
      color: '#202f36',
      style: 'bubble',
      tail: { x: 0.1, y: 0.9 },
    },
    {
      id: id(),
      kind: 'comment',
      point: { x: 0.85, y: 0.85 },
      number: 2,
      text: 'Later comment',
      color: '#007f76',
    },
    {
      id: id(),
      kind: 'comment',
      point: { x: 0.1, y: 0.85 },
      number: 1,
      text: 'Earlier comment',
      color: '#007f76',
    },
  ]);
  const first = await renderCapture(base(), drawing),
    second = await renderCapture(base(), drawing);
  assert.deepEqual(first.bytes, second.bytes);
  assert.ok(first.bytes.length < 3 * 1024 * 1024);
  assert.equal(captureCommentText(drawing), '1. Earlier comment\n2. Later comment');
  await assert.rejects(
    renderCapture(base(), { ...drawing, space: { width: 65, height: 48 } }),
    /dimensions/,
  );
  await assert.rejects(renderCapture(new Uint8Array(100), drawing), /PNG/);
});
