// docs/design/README.md: colors come only from apps/web/src/styles/tokens.css.
const RAW_COLOR =
  /#[0-9a-f]{3,8}\b|(?<![a-z-])(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color-mix)\(/i;

export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow raw color values in apps/web source; use design tokens" },
    messages: {
      raw: "Raw color `{{match}}`. Use a token class (bg-primary, text-muted-foreground, shadow-stamp) or var(--token); add new colors to apps/web/src/styles/tokens.css.",
    },
    schema: [],
  },
  create(context) {
    const check = (node, text) => {
      const match = typeof text === "string" ? RAW_COLOR.exec(text) : null;
      if (match) context.report({ node, messageId: "raw", data: { match: match[0] } });
    };
    return {
      Literal: (node) => check(node, node.value),
      TemplateElement: (node) => check(node, node.value.cooked),
    };
  },
};
