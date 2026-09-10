import { Mark, mergeAttributes } from '@tiptap/core';

export const HiddenText = Mark.create({
  name: 'hiddenText',
  parseHTML() {
    return [{ tag: 'span[data-hidden-text]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-hidden-text': '' }), 0];
  },
  parseMarkdown(token, helpers) {
    return helpers.applyMark(this.name || 'hiddenText', helpers.parseInline(token.tokens || []));
  },
  renderMarkdown(node, helpers) {
    return `==!${helpers.renderChildren(node)}==`;
  },
  markdownTokenizer: {
    name: 'hiddenText',
    level: 'inline',
    start(source) {
      return source.indexOf('==!');
    },
    tokenize(source, _tokens, lexer) {
      const match = /^(==!)([\s\S]+?)(==)/.exec(source);
      if (!match) return;
      const content = match[2];
      return { type: 'hiddenText', raw: match[0], text: content, tokens: lexer.inlineTokens(content) };
    },
  },
});