import type { AdapterRegistry } from "../adapters";
import { ROUTER_SYSTEM_PROMPT, type RouterConfig } from "../config";
import type { FunctionRegistry, ParameterReference } from "./functionRegistry";
import { ModelSelector } from "./modelSelector";

export interface ParsedInvocation {
  functionName: string;
  confidence: number;
  params: Record<string, unknown>;
  dependsOn: Array<string | number>;
  missingParams: string[];
  reason: string;
  index: number;
}

export interface ParsedIntent {
  intent: string;
  invocations: ParsedInvocation[];
  ambiguityDetected: boolean;
  clarificationQuestions: string[];
  parseSource: "heuristic" | "adapter" | "hybrid";
  parserModel?: string;
}

const WEATHER_WORDS = ["weather", "temperature", "forecast"];
const SEARCH_WORDS = ["search", "lookup", "look up", "find on the web"];
const SUMMARY_WORDS = ["summarize", "summary", "condense", "bullet summary"];
const CODE_WORDS = ["generate code", "write code", "build code", "implement"];

interface PlannerParsePayload {
  intent?: string;
  invocations?: Array<Partial<ParsedInvocation> & { functionName?: string }>;
  ambiguityDetected?: boolean;
  clarificationQuestions?: string[];
}

interface IntentParserOptions {
  adapters?: AdapterRegistry;
  config?: RouterConfig;
  modelSelector?: ModelSelector;
}

export class IntentParser {
  constructor(private readonly options: IntentParserOptions = {}) {}

  async parse(
    userMessage: string,
    registry: FunctionRegistry,
    availableFunctions?: string[],
  ): Promise<ParsedIntent> {
    const allowed = new Set(
      availableFunctions?.length
        ? availableFunctions
        : registry.list().map((tool) => tool.name),
    );

    const heuristic = this.postProcess(
      this.parseHeuristically(userMessage, allowed),
    );
    const adapterParsed = await this.parseWithAdapter(
      userMessage,
      registry,
      allowed,
    );
    const selected = adapterParsed
      ? this.mergeWithHeuristic(adapterParsed, heuristic)
      : heuristic;

    return this.postProcess(selected);
  }

  private parseHeuristically(
    userMessage: string,
    allowed: Set<string>,
  ): ParsedIntent {
    const candidates = [
      this.detectWeather(userMessage, allowed),
      this.detectSearch(userMessage, allowed),
      this.detectSummarize(userMessage, allowed),
      this.detectCode(userMessage, allowed),
    ]
      .filter((candidate): candidate is ParsedInvocation => Boolean(candidate))
      .sort((left, right) => left.index - right.index);

    if (candidates.length === 0) {
      return {
        intent: "unknown",
        invocations: [],
        ambiguityDetected: true,
        clarificationQuestions: [
          "I could not map the request to any registered function. Please clarify the action you want.",
        ],
        parseSource: "heuristic",
      };
    }

    const clarificationQuestions = candidates
      .flatMap((candidate) =>
        candidate.missingParams.map(
          (missingParam) =>
            `Provide ${missingParam} for ${candidate.functionName}.`,
        ),
      )
      .filter((value, index, list) => list.indexOf(value) === index);

    return {
      intent: buildIntentName(candidates),
      invocations: candidates,
      ambiguityDetected: clarificationQuestions.length > 0,
      clarificationQuestions,
      parseSource: "heuristic",
    };
  }

  private async parseWithAdapter(
    userMessage: string,
    registry: FunctionRegistry,
    allowed: Set<string>,
  ): Promise<ParsedIntent | undefined> {
    const { adapters, config, modelSelector } = this.options;
    if (!adapters || !config || !modelSelector) {
      return undefined;
    }

    try {
      const model = modelSelector.recommend({
        taskType: "reasoning",
        contextLength: userMessage.length + registry.list().length * 250,
        costTier: "low",
        latencyTier: "low",
        preferredModel: config.defaultModel,
        requireTools: false,
      }).model;
      const adapter = adapters.getForModel(model, config);
      if (!adapter) {
        return undefined;
      }

      const availableTools = registry
        .list()
        .filter((tool) => allowed.has(tool.name))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          tags: tool.tags,
          preferredModel: tool.preferred_model,
        }));

      const prompt = [
        "Return JSON only.",
        "Use only registered functions.",
        "If a required parameter is missing, include it in missingParams and add a clarification question.",
        "If a later function should consume a prior function's output, use dependsOn with the upstream function name.",
        "Schema:",
        JSON.stringify({
          intent: "string",
          invocations: [
            {
              functionName: "string",
              confidence: 0.0,
              params: {},
              dependsOn: [],
              missingParams: [],
              reason: "string",
              index: 0,
            },
          ],
          ambiguityDetected: false,
          clarificationQuestions: [],
        }),
        "Registered functions:",
        JSON.stringify(availableTools, null, 2),
        `User message: ${userMessage}`,
      ].join("\n\n");

      const response = await adapter.call(prompt, [], {
        model,
        systemPrompt: ROUTER_SYSTEM_PROMPT,
        temperature: 0.1,
        maxTokens: 1200,
      });
      const payload = parsePlannerPayload(response.text);
      if (!payload) {
        return undefined;
      }

      const parsed = sanitizePlannerPayload(payload, allowed);
      if (!parsed) {
        return undefined;
      }

      return {
        ...parsed,
        parseSource: "adapter",
        parserModel: model,
      };
    } catch {
      return undefined;
    }
  }

  private mergeWithHeuristic(
    adapterParsed: ParsedIntent,
    heuristic: ParsedIntent,
  ): ParsedIntent {
    if (adapterParsed.invocations.length === 0) {
      return heuristic;
    }

    const heuristicByFunction = new Map(
      heuristic.invocations.map((invocation) => [invocation.functionName, invocation]),
    );
    const mergedInvocations = adapterParsed.invocations.map((invocation) => {
      const fallback = heuristicByFunction.get(invocation.functionName);
      if (!fallback) {
        return invocation;
      }

      const mergedParams = { ...fallback.params, ...invocation.params };
      const missingParams = invocation.missingParams.length
        ? invocation.missingParams.filter((param) => !hasUsableValue(mergedParams[param]))
        : fallback.missingParams.filter((param) => !hasUsableValue(mergedParams[param]));

      return {
        ...invocation,
        params: mergedParams,
        missingParams,
        index: Math.min(invocation.index, fallback.index),
      };
    });

    if (!sameFunctionSet(mergedInvocations, heuristic.invocations)) {
      for (const invocation of heuristic.invocations) {
        if (!mergedInvocations.some((candidate) => candidate.functionName === invocation.functionName)) {
          mergedInvocations.push(invocation);
        }
      }
    }

    const clarificationQuestions = [
      ...adapterParsed.clarificationQuestions,
      ...heuristic.clarificationQuestions,
    ].filter((value, index, list) => value && list.indexOf(value) === index);

    return {
      intent:
        adapterParsed.intent !== "unknown" ? adapterParsed.intent : heuristic.intent,
      invocations: mergedInvocations.sort((left, right) => left.index - right.index),
      ambiguityDetected:
        clarificationQuestions.length > 0 || adapterParsed.ambiguityDetected,
      clarificationQuestions,
      parseSource: "hybrid",
      parserModel: adapterParsed.parserModel,
    };
  }

  private postProcess(parsed: ParsedIntent): ParsedIntent {
    const candidates = parsed.invocations
      .filter((candidate) => candidate.functionName)
      .sort((left, right) => left.index - right.index);

    if (candidates.length === 0) {
      return {
        ...parsed,
        intent: parsed.intent || "unknown",
        ambiguityDetected: true,
        clarificationQuestions: parsed.clarificationQuestions.length
          ? parsed.clarificationQuestions
          : [
              "I could not map the request to any registered function. Please clarify the action you want.",
            ],
      };
    }

    const searchInvocation = candidates.find(
      (candidate) => candidate.functionName === "searchWeb",
    );
    const summarizeInvocation = candidates.find(
      (candidate) => candidate.functionName === "summarizeDocument",
    );

    if (
      searchInvocation &&
      summarizeInvocation &&
      summarizeInvocation.index > searchInvocation.index &&
      isImplicitSummaryTarget(summarizeInvocation.params.text)
    ) {
      summarizeInvocation.dependsOn.push("searchWeb");
      summarizeInvocation.params.text = {
        $fromStep: "searchWeb",
        path: "summaryText",
      } satisfies ParameterReference;
      summarizeInvocation.missingParams.length = 0;
      summarizeInvocation.reason =
        "Summarization follows search intent, so summarize the search results.";
    }

    const clarificationQuestions = [
      ...parsed.clarificationQuestions,
      ...candidates.flatMap((candidate) =>
        candidate.missingParams.map(
          (missingParam) =>
            `Provide ${missingParam} for ${candidate.functionName}.`,
        ),
      ),
    ].filter((value, index, list) => value && list.indexOf(value) === index);

    return {
      intent: parsed.intent && parsed.intent !== "unknown"
        ? parsed.intent
        : buildIntentName(candidates),
      invocations: candidates,
      ambiguityDetected: clarificationQuestions.length > 0,
      clarificationQuestions,
      parseSource: parsed.parseSource,
      parserModel: parsed.parserModel,
    };
  }

  private detectWeather(
    message: string,
    allowed: Set<string>,
  ): ParsedInvocation | undefined {
    const index = findFirstIndex(message, WEATHER_WORDS);
    if (index === -1 || !allowed.has("getWeather")) {
      return undefined;
    }

    const locationMatch = message.match(
      /(?:weather|temperature|forecast)(?:\s+for|\s+in)?\s+([^?.!,]+?)(?=\s+(?:in\s+(?:celsius|fahrenheit))|[?.!,]|$)/i,
    );
    const unit = /fahrenheit|\b[fF]\b/.test(message)
      ? "fahrenheit"
      : "celsius";

    return {
      functionName: "getWeather",
      confidence: 0.91,
      params: {
        location: locationMatch?.[1]?.trim(),
        unit,
      },
      dependsOn: [],
      missingParams: locationMatch?.[1]?.trim() ? [] : ["location"],
      reason: "Detected weather intent and extracted location/unit parameters.",
      index,
    };
  }

  private detectSearch(
    message: string,
    allowed: Set<string>,
  ): ParsedInvocation | undefined {
    const index = findFirstIndex(message, SEARCH_WORDS);
    if (index === -1 || !allowed.has("searchWeb")) {
      return undefined;
    }

    const queryMatch = message.match(
      /(?:search|lookup|look up|find(?: on the web)?)(?:\s+the\s+web)?(?:\s+for)?\s+(.+?)(?=(?:\s+(?:then|and then)\s+summarize)|[?.!]|$)/i,
    );
    const maxResultsMatch = message.match(/(?:top|first|max(?:imum)?)\s+(\d+)/i);

    return {
      functionName: "searchWeb",
      confidence: 0.89,
      params: {
        query: queryMatch?.[1]?.trim(),
        maxResults: maxResultsMatch ? Number(maxResultsMatch[1]) : 5,
      },
      dependsOn: [],
      missingParams: queryMatch?.[1]?.trim() ? [] : ["query"],
      reason: "Detected search intent and extracted query/maxResults parameters.",
      index,
    };
  }

  private detectSummarize(
    message: string,
    allowed: Set<string>,
  ): ParsedInvocation | undefined {
    const index = findFirstIndex(message, SUMMARY_WORDS);
    if (index === -1 || !allowed.has("summarizeDocument")) {
      return undefined;
    }

    const quotedText = message.match(/"([\s\S]+?)"/);
    const directText = message.match(
      /(?:summarize|summary of|condense)\s+(.+?)(?=\s+in\s+(?:bullet|brief|detailed|executive)|[?.!]|$)/i,
    );
    const style = /bullet/i.test(message)
      ? "bullet"
      : /executive/i.test(message)
        ? "executive"
        : /detailed/i.test(message)
          ? "detailed"
          : "brief";
    const extractedText = quotedText?.[1] ?? directText?.[1];

    return {
      functionName: "summarizeDocument",
      confidence: 0.87,
      params: {
        text: extractedText?.trim(),
        style,
      },
      dependsOn: [],
      missingParams: extractedText?.trim() ? [] : ["text"],
      reason: "Detected summarization intent and extracted text/style parameters.",
      index,
    };
  }

  private detectCode(
    message: string,
    allowed: Set<string>,
  ): ParsedInvocation | undefined {
    const index = findFirstIndex(message, CODE_WORDS);
    if (index === -1 || !allowed.has("generateCode")) {
      return undefined;
    }

    const languageMatch = message.match(
      /\b(?:in|using)\s+(typescript|javascript|python|go|rust|java|c#|c\+\+)\b/i,
    );
    const descriptionMatch = message.match(
      /(?:generate code|write code|build code|implement)\s+(?:for\s+)?(.+?)(?=\s+in\s+(?:typescript|javascript|python|go|rust|java|c#|c\+\+)|[?.!]|$)/i,
    );

    return {
      functionName: "generateCode",
      confidence: 0.9,
      params: {
        description: descriptionMatch?.[1]?.trim(),
        language: languageMatch?.[1]?.toLowerCase() ?? "typescript",
      },
      dependsOn: [],
      missingParams: descriptionMatch?.[1]?.trim() ? [] : ["description"],
      reason: "Detected code-generation intent and extracted description/language.",
      index,
    };
  }
}

const buildIntentName = (candidates: ParsedInvocation[]): string =>
  candidates.map((candidate) => candidate.functionName.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)).join("+");

const findFirstIndex = (message: string, keywords: string[]): number => {
  const lowered = message.toLowerCase();
  const indexes = keywords
    .map((keyword) => lowered.indexOf(keyword.toLowerCase()))
    .filter((index) => index >= 0);
  return indexes.length ? Math.min(...indexes) : -1;
};

const isImplicitSummaryTarget = (value: unknown): boolean => {
  if (typeof value !== "string") {
    return true;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return (
    normalized === "results" ||
    normalized === "the results" ||
    normalized.startsWith("in bullet") ||
    normalized.startsWith("in brief") ||
    normalized.startsWith("in detailed") ||
    normalized.startsWith("in executive")
  );
};

const hasUsableValue = (value: unknown): boolean => {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  return value != null;
};

const sameFunctionSet = (
  left: ParsedInvocation[],
  right: ParsedInvocation[],
): boolean => {
  const leftNames = new Set(left.map((item) => item.functionName));
  const rightNames = new Set(right.map((item) => item.functionName));
  if (leftNames.size !== rightNames.size) {
    return false;
  }

  return [...leftNames].every((name) => rightNames.has(name));
};

const parsePlannerPayload = (text: string): PlannerParsePayload | undefined => {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fencedMatch?.[1] ?? text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return undefined;
  }

  try {
    return JSON.parse(raw.slice(start, end + 1)) as PlannerParsePayload;
  } catch {
    return undefined;
  }
};

const sanitizePlannerPayload = (
  payload: PlannerParsePayload,
  allowed: Set<string>,
): Omit<ParsedIntent, "parseSource" | "parserModel"> | undefined => {
  const invocations = (payload.invocations ?? [])
    .map((invocation, index) => {
      const functionName = invocation.functionName;
      if (!functionName || !allowed.has(functionName)) {
        return undefined;
      }

      return {
        functionName,
        confidence:
          typeof invocation.confidence === "number" ? invocation.confidence : 0.75,
        params:
          invocation.params && typeof invocation.params === "object"
            ? (invocation.params as Record<string, unknown>)
            : {},
        dependsOn: Array.isArray(invocation.dependsOn)
          ? invocation.dependsOn.filter(
              (item): item is string | number =>
                typeof item === "string" || typeof item === "number",
            )
          : [],
        missingParams: Array.isArray(invocation.missingParams)
          ? invocation.missingParams.filter(
              (item): item is string => typeof item === "string",
            )
          : [],
        reason:
          typeof invocation.reason === "string"
            ? invocation.reason
            : "Planner model selected this function based on the user intent.",
        index:
          typeof invocation.index === "number" ? invocation.index : index,
      } satisfies ParsedInvocation;
    })
    .filter((invocation): invocation is ParsedInvocation => Boolean(invocation));

  if (invocations.length === 0) {
    return undefined;
  }

  const clarificationQuestions = Array.isArray(payload.clarificationQuestions)
    ? payload.clarificationQuestions.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];

  return {
    intent:
      typeof payload.intent === "string" && payload.intent.length > 0
        ? payload.intent
        : buildIntentName(invocations),
    invocations,
    ambiguityDetected:
      typeof payload.ambiguityDetected === "boolean"
        ? payload.ambiguityDetected
        : clarificationQuestions.length > 0,
    clarificationQuestions,
  };
};