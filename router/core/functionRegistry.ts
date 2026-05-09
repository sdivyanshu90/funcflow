import type { AdapterInterface, JsonSchema } from "../adapters";
import type { CostTier, LatencyTier, RouterConfig, TaskType } from "../config";

export interface ParameterReference {
  $fromStep: number | string;
  path?: string;
}

export interface ToolExecutionContext {
  model: string;
  stream?: boolean;
  adapter?: AdapterInterface;
  previousResults: Record<number, unknown>;
  config: RouterConfig;
}

export type ToolHandler = (
  params: Record<string, unknown>,
  context: ToolExecutionContext,
) => Promise<unknown>;

export interface RegisteredFunction {
  name: string;
  description: string;
  parameters: JsonSchema;
  preferred_model?: string;
  tags: string[];
  taskType: TaskType;
  latencyTier?: LatencyTier;
  costTier?: CostTier;
  handler: ToolHandler;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  value: Record<string, unknown>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const isParameterReference = (
  value: unknown,
): value is ParameterReference =>
  isPlainObject(value) && "$fromStep" in value && typeof value.$fromStep !== "undefined";

export class FunctionRegistry {
  private readonly registry = new Map<string, RegisteredFunction>();

  register(definition: RegisteredFunction): void {
    if (this.registry.has(definition.name)) {
      throw new Error(`Function already registered: ${definition.name}`);
    }

    this.registry.set(definition.name, definition);
  }

  list(): RegisteredFunction[] {
    return [...this.registry.values()];
  }

  getByName(name: string): RegisteredFunction | undefined {
    return this.registry.get(name);
  }

  validate(name: string, params: Record<string, unknown>): ValidationResult {
    const definition = this.registry.get(name);
    if (!definition) {
      return {
        valid: false,
        errors: [`Unknown function: ${name}`],
        value: params,
      };
    }

    const result = validateAgainstSchema(definition.parameters, params, name);
    return {
      valid: result.errors.length === 0,
      errors: result.errors,
      value: isPlainObject(result.value) ? result.value : params,
    };
  }
}

interface RecursiveValidationResult {
  value: unknown;
  errors: string[];
}

const validateAgainstSchema = (
  schema: JsonSchema,
  value: unknown,
  path: string,
): RecursiveValidationResult => {
  if (isParameterReference(value)) {
    return { value, errors: [] };
  }

  switch (schema.type) {
    case "object": {
      if (!isPlainObject(value)) {
        return {
          value,
          errors: [`${path} must be an object.`],
        };
      }

      const output: Record<string, unknown> = { ...value };
      const errors: string[] = [];
      const properties = schema.properties ?? {};
      const required = schema.required ?? [];

      for (const key of required) {
        if (!(key in value) || value[key] == null || value[key] === "") {
          errors.push(`${path}.${key} is required.`);
        }
      }

      for (const [key, propertySchema] of Object.entries(properties)) {
        if (key in value) {
          const nested = validateAgainstSchema(
            propertySchema,
            value[key],
            `${path}.${key}`,
          );
          output[key] = nested.value;
          errors.push(...nested.errors);
        }
      }

      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) {
            errors.push(`${path}.${key} is not allowed.`);
          }
        }
      }

      return { value: output, errors };
    }
    case "string": {
      if (typeof value !== "string") {
        return { value, errors: [`${path} must be a string.`] };
      }

      if (schema.enum && !schema.enum.includes(value)) {
        return {
          value,
          errors: [`${path} must be one of: ${schema.enum.join(", ")}.`],
        };
      }

      return { value, errors: [] };
    }
    case "integer": {
      const parsed = typeof value === "number" ? value : Number(value);
      if (!Number.isInteger(parsed)) {
        return { value, errors: [`${path} must be an integer.`] };
      }

      return { value: parsed, errors: [] };
    }
    case "number": {
      const parsed = typeof value === "number" ? value : Number(value);
      if (Number.isNaN(parsed)) {
        return { value, errors: [`${path} must be a number.`] };
      }

      return { value: parsed, errors: [] };
    }
    case "boolean": {
      if (typeof value === "boolean") {
        return { value, errors: [] };
      }

      if (value === "true") {
        return { value: true, errors: [] };
      }

      if (value === "false") {
        return { value: false, errors: [] };
      }

      return { value, errors: [`${path} must be a boolean.`] };
    }
    case "array": {
      if (!Array.isArray(value)) {
        return { value, errors: [`${path} must be an array.`] };
      }

      const errors: string[] = [];
      const items = value.map((entry, index) => {
        if (!schema.items) {
          return entry;
        }

        const nested = validateAgainstSchema(
          schema.items,
          entry,
          `${path}[${index}]`,
        );
        errors.push(...nested.errors);
        return nested.value;
      });

      return { value: items, errors };
    }
    default:
      return { value, errors: [] };
  }
};