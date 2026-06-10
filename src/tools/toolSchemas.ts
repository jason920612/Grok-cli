export const schemas = {
  object: (properties: Record<string, unknown>, required: string[] = []) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false
  }),
  string: (description?: string) => ({ type: "string", description }),
  number: (description?: string) => ({ type: "number", description }),
  boolean: (description?: string) => ({ type: "boolean", description })
};

/**
 * Single-source-of-truth guard (§8). The JSON Schema (sent to the model) and the
 * Zod validator (runtime parse) are two declarations of the same contract; if
 * they drift, the API may accept inputs the runtime rejects (or vice-versa).
 *
 * Rather than regenerate the JSON schema from Zod — which cannot be verified
 * against the live xAI API in this environment — `makeTool` calls this at
 * construction to assert the two agree on property names and required fields,
 * failing fast at startup on any divergence.
 */
export function assertSchemaMatchesZod(toolName: string, jsonSchema: unknown, zodObject: unknown): void {
  const shape = zodShape(zodObject);
  if (!shape) return; // non-object validators (rare) are not cross-checked
  const zodKeys = Object.keys(shape).sort();
  const zodRequired = Object.keys(shape).filter((k) => !isOptional(shape[k])).sort();

  const js = jsonSchema as { properties?: Record<string, unknown>; required?: string[] };
  const jsonKeys = Object.keys(js?.properties ?? {}).sort();
  const jsonRequired = [...(js?.required ?? [])].sort();

  if (jsonKeys.join(",") !== zodKeys.join(",")) {
    throw new Error(`Tool "${toolName}" schema drift: JSON properties [${jsonKeys}] != Zod shape [${zodKeys}]`);
  }
  if (jsonRequired.join(",") !== zodRequired.join(",")) {
    throw new Error(`Tool "${toolName}" schema drift: JSON required [${jsonRequired}] != Zod required [${zodRequired}]`);
  }
}

function zodShape(zodObject: unknown): Record<string, unknown> | undefined {
  const z = zodObject as { shape?: Record<string, unknown>; _def?: { shape?: () => Record<string, unknown> } };
  if (z?.shape && typeof z.shape === "object") return z.shape;
  if (typeof z?._def?.shape === "function") return z._def.shape();
  return undefined;
}

function isOptional(field: unknown): boolean {
  const f = field as { isOptional?: () => boolean };
  return typeof f?.isOptional === "function" ? f.isOptional() : false;
}
