import Anthropic from "@anthropic-ai/sdk";

import type { RouterConfig } from "../config";
import {
  AdapterInterface,
  AdapterUnavailableError,
  type AdapterCallParams,
  type NormalizedModelResponse,
  type NormalizedToolDefinition,
  streamFromCall,
} from "./index";

export class ClaudeAdapter implements AdapterInterface {
  readonly provider = "claude" as const;
  readonly name = "Anthropic Claude Adapter";

  private readonly client?: Anthropic;

  constructor(private readonly config: RouterConfig) {
    if (config.apiKeys.anthropic) {
      this.client = new Anthropic({ apiKey: config.apiKeys.anthropic });
    }
  }

  supportsModel(model: string): boolean {
    return (
      this.config.modelCatalog[model]?.provider === this.provider ||
      model.startsWith("claude")
    );
  }

  async call(
    prompt: string,
    tools: NormalizedToolDefinition[] = [],
    params: AdapterCallParams = {},
  ): Promise<NormalizedModelResponse> {
    if (!this.client) {
      throw new AdapterUnavailableError(
        "Anthropic API key is not configured for ClaudeAdapter.",
      );
    }

    const model = params.model ?? this.config.vendorModels.anthropic;
    const message = (await this.client.messages.create({
      model,
      max_tokens: params.maxTokens ?? 1024,
      system: params.systemPrompt,
      temperature: params.temperature,
      messages: [{ role: "user", content: prompt }],
      tools: tools.length
        ? tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: {
              type: "object" as const,
              properties: tool.parameters.properties ?? {},
              required: tool.parameters.required ?? [],
            },
          }))
        : undefined,
    })) as any;

    const text = (message.content ?? [])
      .filter((block: any) => block.type === "text")
      .map((block: any) => block.text)
      .join("\n");

    const toolCalls = (message.content ?? [])
      .filter((block: any) => block.type === "tool_use")
      .map((block: any) => ({
        id: String(block.id),
        name: String(block.name),
        arguments: (block.input ?? {}) as Record<string, unknown>,
      }));

    return {
      provider: this.provider,
      model,
      text,
      toolCalls,
      usage: {
        inputTokens: message.usage?.input_tokens,
        outputTokens: message.usage?.output_tokens,
      },
      raw: message,
    };
  }

  stream(
    prompt: string,
    tools: NormalizedToolDefinition[] = [],
    params: AdapterCallParams = {},
  ) {
    return streamFromCall(this, prompt, tools, params);
  }
}