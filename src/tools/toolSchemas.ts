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
