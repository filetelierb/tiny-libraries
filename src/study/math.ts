import katex from 'katex';

export const MAX_FORMULA_LENGTH = 8000;
export function renderFormula(source: string, displayMode = false) {
  if (!source.trim() || source.length > MAX_FORMULA_LENGTH) return null;
  try {
    return katex.renderToString(source, {
      displayMode,
      output: 'htmlAndMathml',
      throwOnError: true,
      trust: false,
      strict: 'ignore',
      maxSize: 20,
      maxExpand: 300,
      macros: {},
    });
  } catch {
    return null;
  }
}
