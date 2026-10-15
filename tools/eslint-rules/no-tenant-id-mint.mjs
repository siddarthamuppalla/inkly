// ADR-0004: only packages/auth mints a TenantId, after the membership check.
// Any `x as TenantId` (or `<TenantId>x`) outside packages/auth is a forged TenantId.

function namesTenantId(type) {
  if (type?.type !== "TSTypeReference") return false;
  const name = type.typeName.type === "Identifier" ? type.typeName.name : type.typeName.right?.name;
  return name === "TenantId";
}

export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow minting a TenantId outside packages/auth (ADR-0004)" },
    messages: {
      mint: 'Only packages/auth mints a TenantId. Take the TenantId from requireTenant (c.get("tenantId")) or a packages/auth function instead of casting.',
    },
    schema: [],
  },
  create(context) {
    const check = (node) => {
      if (namesTenantId(node.typeAnnotation)) context.report({ node, messageId: "mint" });
    };
    return { TSAsExpression: check, TSTypeAssertion: check };
  },
};
