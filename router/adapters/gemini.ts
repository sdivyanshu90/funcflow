import { GoogleGenerativeAI } from "@google/generative-ai";

import type { RouterConfig } from "../config";
import {
  AdapterInterface,
  AdapterUnavailableError,
  type AdapterCallParams,
  type NormalizedModelResponse,
  type NormalizedToolDefinition,
  streamFromCall,
} from "./index";

export class GeminiAdapter implements AdapterInterface {
  readonly provider = "gemini" as const;
  readonly name = "Google Gemini Adapter";

  private readonly client?: GoogleGenerativeAI;

  constructor(private readonly config: RouterConfig) {
    if (config.apiKeys.gemini) {
      this.client = new GoogleGenerativeAI(config.apiKeys.gemini);
    }
  }

  supportsModel(model: string): boolean {
    return (
      this.config.modelCatalog[model]?.provider === this.provider ||
      model.startsWith("gemini")
    );
  }

  async call(
    prompt: string,
    _tools: NormalizedToolDefinition[] = [],
    params: AdapterCallParams = {},
  ): Promise<NormalizedModelResponse> {
    if (!this.client) {
      throw new AdapterUnavailableError(
        "Gemini API key is not configured for GeminiAdapter.",
      );
    }

    const model = params.model ?? this.config.vendorModels.gemini;
    const generator = this.client.getGenerativeModel({ model });
    const response = await generator.generateContent([
      ...(params.systemPrompt ? [params.systemPrompt] : []),
      prompt,
    ]);
    const resolved = await response.response;

    return {
      provider: this.provider,
      model,
      text: resolved.text(),
      toolCalls: [],
      raw: resolved,
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