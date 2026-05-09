import OpenAI from "openai";

import type { RouterConfig } from "../config";
import {
  AdapterInterface,
  AdapterUnavailableError,
  safeParseToolArguments,
  type AdapterCallParams,
  type NormalizedModelResponse,
  type NormalizedToolDefinition,
  streamFromCall,
} from "./index";

export class OpenAIAdapter implements AdapterInterface {
  readonly provider = "openai" as const;
  readonly name = "OpenAI Adapter";

  private readonly client?: OpenAI;

  constructor(private readonly config: RouterConfig) {
    if (config.apiKeys.openai) {
      this.client = new OpenAI({ apiKey: config.apiKeys.openai });
    }
  }

  supportsModel(model: string): boolean {
    return (
      this.config.modelCatalog[model]?.provider === this.provider ||
      model.startsWith("gpt") ||
      model.includes("codex")
    );
  }

  async call(
    prompt: string,
    tools: NormalizedToolDefinition[] = [],
    params: AdapterCallParams = {},
  ): Promise<NormalizedModelResponse> {
    if (!this.client) {
      throw new AdapterUnavailableError(
        "OpenAI API key is not configured for OpenAIAdapter.",
      );
    }

    const model = params.model ?? this.config.vendorModels.openai;
    const completion = await this.client.chat.completions.create({
      model,
      messages: [
        ...(params.systemPrompt
          ? [{ role: "system" as const, content: params.systemPrompt }]
          : []),
        { role: "user" as const, content: prompt },
      ],
      tools: tools.length
        ? tools.map((tool) => ({
            type: "function" as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters as unknown as Record<string, unknown>,
            },
          }))
        : undefined,
      tool_choice: tools.length ? "auto" : undefined,
      temperature: params.temperature,
      max_tokens: params.maxTokens,
    });

    const choice = completion.choices[0];
    const toolCalls = (choice.message.tool_calls ?? []).map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: safeParseToolArguments(toolCall.function.arguments),
    }));

    return {
      provider: this.provider,
      model,
      text: choice.message.content ?? "",
      toolCalls,
      usage: completion.usage
        ? {
            inputTokens: completion.usage.prompt_tokens,
            outputTokens: completion.usage.completion_tokens,
            totalTokens: completion.usage.total_tokens,
          }
        : undefined,
      raw: completion,
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