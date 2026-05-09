import type { ProviderName, RouterConfig } from "../config";

export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
}

export interface NormalizedToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AdapterCallParams {
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  metadata?: Record<string, string>;
}

export interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface NormalizedModelResponse {
  provider: ProviderName;
  model: string;
  text: string;
  toolCalls: NormalizedToolCall[];
  usage?: NormalizedUsage;
  raw?: unknown;
}

export type StreamEvent =
  | { type: "content"; text: string }
  | { type: "tool_call"; toolCall: NormalizedToolCall }
  | { type: "done"; response: NormalizedModelResponse }
  | { type: "error"; error: string };

export interface AdapterInterface {
  readonly provider: ProviderName;
  readonly name: string;
  supportsModel(model: string): boolean;
  call(
    prompt: string,
    tools?: NormalizedToolDefinition[],
    params?: AdapterCallParams,
  ): Promise<NormalizedModelResponse>;
  stream?(
    prompt: string,
    tools?: NormalizedToolDefinition[],
    params?: AdapterCallParams,
  ): AsyncGenerator<StreamEvent, NormalizedModelResponse, void>;
}

export class AdapterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterUnavailableError";
  }
}

export class AdapterRegistry {
  private readonly adapters = new Map<ProviderName, AdapterInterface>();

  register(adapter: AdapterInterface): void {
    this.adapters.set(adapter.provider, adapter);
  }

  list(): AdapterInterface[] {
    return [...this.adapters.values()];
  }

  getByProvider(provider: ProviderName): AdapterInterface | undefined {
    return this.adapters.get(provider);
  }

  getForModel(
    model: string,
    config: Pick<RouterConfig, "modelCatalog">,
  ): AdapterInterface | undefined {
    const provider = config.modelCatalog[model]?.provider;
    return provider ? this.adapters.get(provider) : undefined;
  }
}

export const safeParseToolArguments = (
  value: unknown,
): Record<string, unknown> => {
  if (value == null) {
    return {};
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }

  return {};
};

export async function* streamFromCall(
  adapter: AdapterInterface,
  prompt: string,
  tools: NormalizedToolDefinition[] = [],
  params: AdapterCallParams = {},
): AsyncGenerator<StreamEvent, NormalizedModelResponse, void> {
  const response = await adapter.call(prompt, tools, params);
  if (response.text) {
    yield { type: "content", text: response.text };
  }

  for (const toolCall of response.toolCalls) {
    yield { type: "tool_call", toolCall };
  }

  yield { type: "done", response };
  return response;
}