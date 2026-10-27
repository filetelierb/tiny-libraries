import type { Plugin } from 'unified';
import type { Construct, Extension, State } from 'micromark-util-types';
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';

// Tokenize in the original input: escaping and source-location offsets stay intact.
const latex: Construct = {
  name: 'latexDelimited',
  tokenize(effects, ok, nok) {
    let closer: number;
    const consume = (code: number) => {
      effects.enter('latexData' as never);
      effects.consume(code);
      effects.exit('latexData' as never);
    };
    const start: State = (code) => {
      effects.enter('latexDelimited' as never);
      consume(code!);
      return open;
    };
    const open: State = (code) => {
      if (code !== 40 && code !== 91) return nok(code);
      closer = code === 40 ? 41 : 93;
      consume(code);
      return body;
    };
    const body: State = (code) => {
      if (code === null) return nok(code);
      if (code === -5 || code === -4 || code === -3) {
        effects.enter('lineEnding');
        effects.consume(code);
        effects.exit('lineEnding');
        return body;
      }
      consume(code);
      return code === 92 ? close : body;
    };
    const close: State = (code) => {
      if (code === null) return nok(code);
      consume(code);
      if (code !== closer) return body;
      effects.exit('latexDelimited' as never);
      return ok;
    };
    return start;
  },
};
const fromMarkdown: FromMarkdownExtension = {
  enter: {
    latexDelimited(token) {
      this.enter({ type: 'inlineMath', value: '' }, token);
    },
  },
  exit: {
    latexDelimited(token) {
      const raw = this.sliceSerialize(token),
        node = this.stack[this.stack.length - 1];
      if (node.type !== 'inlineMath') return;
      node.value = raw.slice(2, -2).trim();
      node.data = {
        hName: 'code',
        hProperties: {
          className: ['language-math', raw[1] === '[' ? 'math-display' : 'math-inline'],
        },
        hChildren: [{ type: 'text', value: node.value }],
      };
      this.exit(token);
    },
  },
};
export const remarkLatexDelimiters: Plugin = function () {
  const data = this.data() as {
    micromarkExtensions?: Extension[];
    fromMarkdownExtensions?: FromMarkdownExtension[];
  };
  (data.micromarkExtensions ||= []).push({ text: { 92: latex } });
  (data.fromMarkdownExtensions ||= []).push(fromMarkdown);
};
