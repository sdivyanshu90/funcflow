import { describe, expect, it } from "vitest";

import type { AdapterCallParams, AdapterInterface, NormalizedModelResponse, NormalizedToolDefinition } from "../router/adapters";
import { AdapterRegistry } from "../router/adapters";
import { getRouterConfig, ROUTER_SYSTEM_PROMPT } from "../router/config";
import { FunctionRegistry } from "../router/core/functionRegistry";
import { IntentParser } from "../router/core/intentParser";
import { ModelSelector } from "../router/core/modelSelector";
import { exampleFunctions } from "../router/functions/example";

class MockPlanningAdapter implements AdapterInterface {
  readonly provider = "open-source" as const;
  readonly name = "MockPlanningAdapter";
  lastSystemPrompt?: string;

  supportsModel(): boolean {
    return true;
  }

  async call(
    _prompt: string,
    _tools: NormalizedToolDefinition[] = [],
    params: AdapterCallParams = {},
  ): Promise<NormalizedModelResponse> {
    this.lastSystemPrompt = params.systemPrompt;

    return {
      provider: this.provider,
      model: params.model ?? "llama-3.1-8b-instant",
      text: JSON.stringify({
        intent: "search-web+summarize-document",
        invocations: [
          {
            functionName: "searchWeb",
            confidence: 0.98,
            params: {
              query: "OpenTelemetry architecture",
              maxResults: 3,
            },
            dependsOn: [],
            missingParams: [],
            reason: "Search the web first.",
            index: 0,
          },
          {
            functionName: "summarizeDocument",
            confidence: 0.92,
            params: {
              style: "bullet",
            },
            dependsOn: ["searchWeb"],
            missingParams: ["text"],
            reason: "Summarize the search findings.",
            index: 1,
          },
        ],
        ambiguityDetected: true,
        clarificationQuestions: ["Provide text for summarizeDocument."],
      }),
      toolCalls: [],
    };
  }
}

describe("IntentParser", () => {
  it("uses adapter-backed planning output when available", async () => {
    const registry = new FunctionRegistry();
    exampleFunctions.forEach((tool) => registry.register(tool));

    const adapters = new AdapterRegistry();
    const mockAdapter = new MockPlanningAdapter();
    adapters.register(mockAdapter);

    const config = getRouterConfig();
    const parser = new IntentParser({
      adapters,
      config,
      modelSelector: new ModelSelector(config.modelCatalog),
    });
    const parsed = await parser.parse(
      "search the web for OpenTelemetry architecture and summarize in bullet form",
      registry,
    );

    expect(parsed.parseSource).toBe("hybrid");
    expect(parsed.parserModel).toBeTruthy();
    expect(parsed.invocations[0]?.functionName).toBe("searchWeb");
    expect(parsed.invocations[1]?.dependsOn).toContain("searchWeb");
    expect(mockAdapter.lastSystemPrompt).toBe(ROUTER_SYSTEM_PROMPT);
  });
});