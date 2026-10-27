import { z } from 'zod';

/**
 * Widgets are written into artifact markdown as ```widget fenced JSON. The model and the
 * student only supply data; trusted components render every widget, and expressions are
 * arithmetic only: numbers, declared parameters, operators and a closed list of functions.
 */
export type Expression =
  | { kind: 'number'; value: number }
  | { kind: 'variable'; name: string }
  | { kind: 'unary'; op: '-' | '!'; arg: Expression }
  | { kind: 'binary'; op: string; left: Expression; right: Expression }
  | { kind: 'call'; name: string; args: Expression[] };

const functions: Record<string, [number, number, (...args: number[]) => number]> = {
  sin: [1, 1, Math.sin],
  cos: [1, 1, Math.cos],
  tan: [1, 1, Math.tan],
  asin: [1, 1, Math.asin],
  acos: [1, 1, Math.acos],
  atan: [1, 1, Math.atan],
  exp: [1, 1, Math.exp],
  ln: [1, 1, Math.log],
  log: [1, 1, Math.log10],
  log2: [1, 1, Math.log2],
  sqrt: [1, 1, Math.sqrt],
  abs: [1, 1, Math.abs],
  round: [1, 1, Math.round],
  floor: [1, 1, Math.floor],
  ceil: [1, 1, Math.ceil],
  sign: [1, 1, Math.sign],
  min: [2, 8, Math.min],
  max: [2, 8, Math.max],
  pow: [2, 2, Math.pow],
  atan2: [2, 2, Math.atan2],
  clamp: [3, 3, (value, low, high) => Math.min(high, Math.max(low, value))],
};
const constants: Record<string, number> = { pi: Math.PI, e: Math.E };
const tokenPattern =
  /\s*(?:(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)|([a-zA-Z_][a-zA-Z0-9_]*)|(<=|>=|==|!=|&&|\|\||[-+*/^(),<>!]))/y;
const precedence: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '^': 8,
};

export class ExpressionError extends Error {}

export function parseExpression(source: string, variables: ReadonlySet<string>): Expression {
  if (source.length > 300) throw new ExpressionError('The expression is too long.');
  const tokens: string[] = [];
  tokenPattern.lastIndex = 0;
  while (tokenPattern.lastIndex < source.length) {
    const start = tokenPattern.lastIndex;
    const match = tokenPattern.exec(source);
    if (!match) {
      if (!source.slice(start).trim()) break;
      throw new ExpressionError(`Unsupported symbol: ${source.slice(start).trim()[0]}`);
    }
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  let position = 0,
    depth = 0;
  const peek = () => tokens[position];
  const take = (expected?: string) => {
    const token = tokens[position++];
    if (token === undefined || (expected !== undefined && token !== expected))
      throw new ExpressionError(expected ? `Expected ${expected}` : 'Incomplete expression');
    return token;
  };
  const primary = (): Expression => {
    if (++depth > 40) throw new ExpressionError('The expression is nested too deeply.');
    try {
      const token = take();
      if (token === '(') {
        const inner = binary(0);
        take(')');
        return inner;
      }
      if (token === '-' || token === '!') return { kind: 'unary', op: token, arg: binary(7) };
      if (token === '+') return binary(7);
      if (/^[\d.]/.test(token)) return { kind: 'number', value: Number(token) };
      if (/^[a-zA-Z_]/.test(token)) {
        if (peek() === '(') {
          const spec = functions[token];
          if (!spec) throw new ExpressionError(`Unknown function: ${token}`);
          take('(');
          const args: Expression[] = [];
          if (peek() !== ')')
            do args.push(binary(0));
            while (peek() === ',' && take(','));
          take(')');
          if (args.length < spec[0] || args.length > spec[1])
            throw new ExpressionError(`${token} received the wrong number of arguments`);
          return { kind: 'call', name: token, args };
        }
        if (token in constants) return { kind: 'number', value: constants[token] };
        if (!variables.has(token)) throw new ExpressionError(`Undeclared variable: ${token}`);
        return { kind: 'variable', name: token };
      }
      throw new ExpressionError(`Unexpected symbol: ${token}`);
    } finally {
      depth--;
    }
  };
  const binary = (minimum: number): Expression => {
    let left = primary();
    for (;;) {
      const op = peek();
      const level = op === undefined ? undefined : precedence[op];
      if (level === undefined || level < minimum) return left;
      take();
      // ^ is right-associative; the rest associate to the left.
      left = { kind: 'binary', op, left, right: binary(op === '^' ? level : level + 1) };
    }
  };
  const tree = binary(0);
  if (position !== tokens.length) throw new ExpressionError(`Unexpected ${tokens[position]}`);
  return tree;
}

export function evaluateExpression(
  tree: Expression,
  scope: Readonly<Record<string, number>>,
): number {
  switch (tree.kind) {
    case 'number':
      return tree.value;
    case 'variable':
      return scope[tree.name] ?? Number.NaN;
    case 'unary': {
      const value = evaluateExpression(tree.arg, scope);
      return tree.op === '-' ? -value : value ? 0 : 1;
    }
    case 'call':
      return functions[tree.name][2](...tree.args.map((arg) => evaluateExpression(arg, scope)));
    case 'binary': {
      const a = evaluateExpression(tree.left, scope);
      if (tree.op === '&&') return a && evaluateExpression(tree.right, scope) ? 1 : 0;
      if (tree.op === '||') return a || evaluateExpression(tree.right, scope) ? 1 : 0;
      const b = evaluateExpression(tree.right, scope);
      switch (tree.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return a / b;
        case '^':
          return a ** b;
        case '<':
          return +(a < b);
        case '<=':
          return +(a <= b);
        case '>':
          return +(a > b);
        case '>=':
          return +(a >= b);
        case '==':
          return +(Math.abs(a - b) < 1e-9);
        case '!=':
          return +(Math.abs(a - b) >= 1e-9);
      }
      return Number.NaN;
    }
  }
}

/** Parses once and evaluates many times; null for invalid expressions. */
export function compileExpression(source: string, variables: Iterable<string>) {
  try {
    const tree = parseExpression(source, new Set(variables));
    return (scope: Readonly<Record<string, number>>) => evaluateExpression(tree, scope);
  } catch {
    return null;
  }
}

const shortText = z.string().trim().min(1).max(300);
const longText = z.string().trim().min(1).max(4000);
const caption = z.string().trim().max(500).optional();
const segmentId = z.string().min(1).max(200).optional();
const paramId = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,23}$/);

const explorable = z
  .object({
    type: z.literal('explorable'),
    title: shortText,
    params: z
      .array(
        z.object({
          id: paramId,
          label: shortText,
          min: z.number(),
          max: z.number(),
          step: z.number().positive(),
          value: z.number(),
          unit: z.string().max(20).optional(),
        }),
      )
      .min(1)
      .max(4),
    outputs: z
      .array(
        z.object({
          label: shortText,
          expr: z.string().min(1).max(300),
          unit: z.string().max(20).optional(),
          digits: z.number().int().min(0).max(6).default(2),
        }),
      )
      .min(1)
      .max(4),
    notes: z
      .array(
        z.object({ when: z.string().min(1).max(300), text: z.string().trim().min(1).max(400) }),
      )
      .max(6)
      .default([]),
    plot: z
      .object({
        x: paramId,
        expr: z.string().min(1).max(300),
        label: z.string().max(80).optional(),
      })
      .optional(),
    caption,
  })
  .superRefine((value, context) => {
    const ids = value.params.map((param) => param.id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: 'custom', message: 'Parameters must be unique.' });
    for (const param of value.params)
      if (param.min >= param.max || param.value < param.min || param.value > param.max)
        context.addIssue({ code: 'custom', message: `Invalid range for ${param.id}.` });
    for (const expr of [
      ...value.outputs.map((item) => item.expr),
      ...value.notes.map((item) => item.when),
      ...(value.plot ? [value.plot.expr] : []),
    ])
      if (!compileExpression(expr, ids))
        context.addIssue({ code: 'custom', message: `Invalid expression: ${expr}` });
    if (value.plot && !ids.includes(value.plot.x))
      context.addIssue({ code: 'custom', message: 'The plot axis must be a parameter.' });
  });

export const artifactWidgetSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('summary'),
      title: shortText.optional(),
      points: z
        .array(z.object({ text: z.string().trim().min(1).max(400), segmentId }))
        .min(1)
        .max(7),
      caption,
    }),
    z.object({
      type: z.literal('compare'),
      title: shortText,
      columns: z.array(shortText).min(1).max(6),
      rows: z
        .array(z.object({ label: shortText, cells: z.array(z.string().max(600)), segmentId }))
        .min(1)
        .max(20),
      caption,
    }),
    z.object({
      type: z.literal('steps'),
      title: shortText,
      steps: z
        .array(z.object({ title: shortText, body: longText, segmentId }))
        .min(2)
        .max(12),
      caption,
    }),
    z.object({
      type: z.literal('timeline'),
      title: shortText,
      events: z
        .array(
          z.object({
            label: z.string().trim().min(1).max(60),
            title: shortText,
            body: z.string().trim().max(1200).optional(),
            segmentId,
          }),
        )
        .min(2)
        .max(20),
      caption,
    }),
    z.object({
      type: z.literal('predict'),
      prompt: z.string().trim().min(8).max(600),
      choices: z.array(shortText).max(5).default([]),
      correctIndex: z.number().int().min(0).max(4).optional(),
      reveal: longText,
      caption,
    }),
    explorable,
    z.object({
      type: z.literal('chart'),
      title: shortText,
      kind: z.enum(['bar', 'line']).default('bar'),
      labels: z.array(shortText).min(1).max(30),
      series: z
        .array(z.object({ name: shortText, values: z.array(z.number()) }))
        .min(1)
        .max(4),
      unit: z.string().max(20).optional(),
      segmentId,
      caption,
    }),
    z.object({
      type: z.literal('image'),
      segmentId: z.string().min(1).max(200),
      alt: shortText,
      caption,
    }),
    z.object({
      type: z.literal('details'),
      summary: shortText,
      body: longText,
    }),
  ])
  .superRefine((widget, context) => {
    if (
      widget.type === 'chart' &&
      widget.series.some((item) => item.values.length !== widget.labels.length)
    )
      context.addIssue({ code: 'custom', message: 'Each chart series needs one value per label.' });
    if (
      widget.type === 'predict' &&
      widget.correctIndex !== undefined &&
      widget.correctIndex >= widget.choices.length
    )
      context.addIssue({ code: 'custom', message: 'The predicted answer is outside the choices.' });
    if (
      widget.type === 'compare' &&
      widget.rows.some((row) => row.cells.length !== widget.columns.length)
    )
      context.addIssue({
        code: 'custom',
        message: 'Each comparison row needs one cell per column.',
      });
  });
export type ArtifactWidget = z.infer<typeof artifactWidgetSchema>;

/** Segment ids a widget cites; all must exist in the source. */
export function widgetCitations(widget: ArtifactWidget): string[] {
  const items: Array<{ segmentId?: string }> =
    widget.type === 'summary'
      ? widget.points
      : widget.type === 'compare'
        ? widget.rows
        : widget.type === 'steps'
          ? widget.steps
          : widget.type === 'timeline'
            ? widget.events
            : widget.type === 'chart' || widget.type === 'image'
              ? [widget]
              : [];
  return items.flatMap((item) => (item.segmentId ? [item.segmentId] : []));
}

export function parseWidget(source: string): ArtifactWidget | null {
  try {
    const result = artifactWidgetSchema.safeParse(JSON.parse(source));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

const fence = /^```widget[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm;

/**
 * Drops generated widgets that are malformed or cite unknown passages, and images whose
 * passage has no picture, so a single bad widget never discards a whole study guide.
 */
export function sanitizeWidgets(
  markdown: string,
  segmentIds: Set<string>,
  imageIds = new Set<string>(),
) {
  return markdown
    .replace(fence, (block, body: string) => {
      const widget = parseWidget(body);
      if (!widget || widgetCitations(widget).some((id) => !segmentIds.has(id))) return '';
      if (widget.type === 'image' && !imageIds.has(widget.segmentId)) return '';
      return block;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const widgetInstructions = `The artifact explanation is markdown and may embed interactive widgets as fenced blocks: a line \`\`\`widget, one JSON object, then \`\`\`. Use at most four widgets and only when they teach something prose cannot. Types: {"type":"summary","title"?,"points":[{"text","segmentId"?}]} (1-7 key points); {"type":"compare","title","columns":[...],"rows":[{"label","cells":[one per column],"segmentId"?}]}; {"type":"steps","title","steps":[{"title","body","segmentId"?}]} (2-12); {"type":"timeline","title","events":[{"label","title","body"?,"segmentId"?}]} (2-20); {"type":"predict","prompt","choices"?:[...],"correctIndex"?,"reveal"} (ask before explaining; without choices it is a reflection); {"type":"explorable","title","params":[{"id","label","min","max","step","value","unit"?}],"outputs":[{"label","expr","unit"?,"digits"?}],"notes"?:[{"when","text"}],"plot"?:{"x","expr","label"?}} where expressions use only numbers, parameter ids, + - * / ^, comparisons, && || ! and sin cos tan exp ln log sqrt abs min max pow round floor ceil clamp, pi, e; {"type":"chart","title","kind":"bar"|"line","labels":[...],"series":[{"name","values":[one per label]}],"unit"?}; {"type":"image","segmentId","alt","caption"?} only for a segment that is an image; {"type":"details","summary","body"} for optional depth. Any widget may add "caption" saying what to observe. Every segmentId must exist. Highlight ideas with callouts: a blockquote whose first line is [!key], [!warning], [!example], [!analogy] or [!definition]. Use ## chapter headings for longer explanations. Write formulas as \\( ... \\) or $$ blocks.`;

/** Segments shown by image widgets, whose pictures are stored next to the source. */
export function widgetImages(markdown: string) {
  return [...markdown.matchAll(fence)].flatMap(([, body]) => {
    const widget = parseWidget(body);
    return widget?.type === 'image' ? [widget.segmentId] : [];
  });
}
export const visualKey = (sourceId: string, version: number, segmentId: string) =>
  `visuals/${sourceId}/${version}/${encodeURIComponent(segmentId)}`;

/** Passages cited by the widgets in an artifact's markdown, in order of appearance. */
export function widgetSegments(markdown: string) {
  return [...markdown.matchAll(fence)].flatMap(([, body]) => {
    const widget = parseWidget(body);
    return widget ? widgetCitations(widget) : [];
  });
}
