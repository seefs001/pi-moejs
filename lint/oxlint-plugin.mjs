const noComments = {
  meta: {
    type: 'problem',
    schema: [],
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          context.report({
            loc: comment.loc,
            message: 'Comments are disallowed. Express intent through code, types, or tests.',
          });
        }
      },
    };
  },
};

export default {
  meta: {
    name: 'pi-moejs',
  },
  rules: {
    'no-comments': noComments,
  },
};
