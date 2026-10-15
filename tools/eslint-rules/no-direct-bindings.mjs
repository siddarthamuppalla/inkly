// ADR-0004: D1, R2 and KV are reachable only through packages/storage.
const BINDING_TYPES = new Set(["D1Database", "R2Bucket", "KVNamespace"]);
const BINDING_NAMES = new Set(["DB", "FILES", "KV"]);

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow direct D1/R2/KV access outside packages/storage (ADR-0004)",
    },
    messages: {
      type: "`{{name}}` is only allowed in packages/storage. Call a packages/storage function that takes a TenantId instead.",
      env: "`env.{{name}}` is only allowed in packages/storage. Pass `env` to a packages/storage function that takes a TenantId instead.",
    },
    schema: [],
  },
  create(context) {
    return {
      TSTypeReference(node) {
        const name =
          node.typeName.type === "Identifier" ? node.typeName.name : node.typeName.right?.name;
        if (name && BINDING_TYPES.has(name)) {
          context.report({ node, messageId: "type", data: { name } });
        }
      },
      MemberExpression(node) {
        if (
          node.object.type === "Identifier" &&
          node.object.name === "env" &&
          node.property.type === "Identifier" &&
          !node.computed &&
          BINDING_NAMES.has(node.property.name)
        ) {
          context.report({ node, messageId: "env", data: { name: node.property.name } });
        }
      },
    };
  },
};
