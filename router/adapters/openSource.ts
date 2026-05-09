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

export class OpenSourceAdapter implements AdapterInterface {
  readonly provider = "open-source" as const;
  readonly name = "Open Source Adapter";

  constructor(private readonly config: RouterConfig) {}

  supportsModel(model: string): boolean {
    return this.config.modelCatalog[model]?.provider === this.provider;
  }

  async call(
    prompt: string,
    tools: NormalizedToolDefinition[] = [],
    params: AdapterCallParams = {},
  ): Promise<NormalizedModelResponse> {
    switch (this.config.openSourceBackend) {
      case "groq":
        return this.callGroq(prompt, tools, params);
      case "ollama":
        return this.callOllama(prompt, params);
      case "huggingface":
        return this.callHuggingFace(prompt, params);
      default:
        throw new AdapterUnavailableError(
          `Unsupported open-source backend: ${this.config.openSourceBackend}`,
        );
    }
  }

  stream(
    prompt: string,
    tools: NormalizedToolDefinition[] = [],
    params: AdapterCallParams = {},
  ) {
    return streamFromCall(this, prompt, tools, params);
  }

  private async callGroq(
    prompt: string,
    tools: NormalizedToolDefinition[],
    params: AdapterCallParams,
  ): Promise<NormalizedModelResponse> {
    if (!this.config.apiKeys.groq) {
      throw new AdapterUnavailableError(
        "Groq API key is not configured for OpenSourceAdapter.",
      );
    }

    const model = params.model ?? this.config.vendorModels.groq;
    const response = await fetch(
      `${this.config.endpoints.groqBaseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKeys.groq}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            ...(params.systemPrompt
              ? [{ role: "system", content: params.systemPrompt }]
              : []),
            { role: "user", content: prompt },
          ],
          tools: tools.length
            ? tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              }))
            : undefined,
          temperature: params.temperature,
          max_tokens: params.maxTokens,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Groq call failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as any;
    const choice = payload.choices?.[0]?.message ?? {};
    const toolCalls = (choice.tool_calls ?? []).map((toolCall: any) => ({
      id: String(toolCall.id),
      name: String(toolCall.function?.name ?? "unknown"),
      arguments: safeParseToolArguments(toolCall.function?.arguments),
    }));

    return {
      provider: this.provider,
      model,
      text: String(choice.content ?? ""),
      toolCalls,
      usage: payload.usage
        ? {
            inputTokens: payload.usage.prompt_tokens,
            outputTokens: payload.usage.completion_tokens,
            totalTokens: payload.usage.total_tokens,
          }
        : undefined,
      raw: payload,
    };
  }

  private async callOllama(
    prompt: string,
    params: AdapterCallParams,
  ): Promise<NormalizedModelResponse> {
    const model = params.model ?? this.config.vendorModels.groq;
    const response = await fetch(`${this.config.endpoints.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          ...(params.systemPrompt
            ? [{ role: "system", content: params.systemPrompt }]
            : []),
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama call failed: ${response.status} ${response.statusText}`,
      );
    }

    const payload = (await response.json()) as any;

    return {
      provider: this.provider,
      model,
      text: String(payload.message?.content ?? ""),
      toolCalls: [],
      raw: payload,
    };
  }

  private async callHuggingFace(
    prompt: string,
    params: AdapterCallParams,
  ): Promise<NormalizedModelResponse> {
    if (!this.config.apiKeys.huggingface) {
      throw new AdapterUnavailableError(
        "Hugging Face API key is not configured for OpenSourceAdapter.",
      );
    }

    const model = params.model ?? this.config.vendorModels.huggingface;
    const response = await fetch(
      `https://api-inference.huggingface.co/models/${model}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKeys.huggingface}`,
        },
        body: JSON.stringify({
          inputs: [params.systemPrompt, prompt].filter(Boolean).join("\n\n"),
          parameters: {
            max_new_tokens: params.maxTokens ?? 512,
            temperature: params.temperature ?? 0.2,
          },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Hugging Face call failed: ${response.status} ${response.statusText}`,
      );
    }

    const payload = (await response.json()) as Array<{ generated_text?: string }>;

    return {
      provider: this.provider,
      model,
      text: payload[0]?.generated_text ?? "",
      toolCalls: [],
      raw: payload,
    };
  }
}