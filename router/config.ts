import { config as loadEnv } from "dotenv";

loadEnv();

export type TaskType =
  | "reasoning"
  | "code"
  | "multimodal"
  | "retrieval"
  | "summarization"
  | "general";

export type CostTier = "low" | "medium" | "high";
export type LatencyTier = "low" | "medium" | "high";
export type ProviderName = "claude" | "openai" | "gemini" | "open-source";

export interface ModelProfile {
  model: string;
  provider: ProviderName;
  label: string;
  contextWindow: number;
  costTier: CostTier;
  latencyTier: LatencyTier;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsVision: boolean;
  taskAffinity: Record<TaskType, number>;
}

export interface RouterConfig {
  timeoutMs: number;
  defaultModel: string;
  openSourceBackend: "groq" | "ollama" | "huggingface";
  apiKeys: {
    anthropic?: string;
    openai?: string;
    gemini?: string;
    groq?: string;
    huggingface?: string;
    braveSearch?: string;
    serper?: string;
  };
  endpoints: {
    groqBaseUrl: string;
    ollamaBaseUrl: string;
    braveSearchBaseUrl: string;
    serperBaseUrl: string;
    openMeteoGeocodingBaseUrl: string;
    openMeteoForecastBaseUrl: string;
  };
  vendorModels: {
    anthropic: string;
    openai: string;
    gemini: string;
    groq: string;
    huggingface: string;
  };
  modelCatalog: Record<string, ModelProfile>;
}

export const ROUTER_SYSTEM_PROMPT = `You are a Function Calling Router. Your job is to:

1. UNDERSTAND the user's intent from their natural language input.
2. SELECT the most appropriate function(s) from the registered tool registry.
3. EXTRACT and validate all required parameters for those functions.
4. SEQUENCE calls intelligently — run independent calls in parallel, dependent calls in order (chain them).
5. PICK the best underlying model for each function call based on task type, latency, and token budget.
6. RETURN a structured execution plan before running anything, and confirm with the user if ambiguity is detected.
7. HANDLE errors gracefully — if a function fails, retry with a fallback model or ask for clarification.`;

export const DEFAULT_MODEL_CATALOG: Record<string, ModelProfile> = {
  "claude-3-5-sonnet-latest": {
    model: "claude-3-5-sonnet-latest",
    provider: "claude",
    label: "claude",
    contextWindow: 200_000,
    costTier: "high",
    latencyTier: "medium",
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
    taskAffinity: {
      reasoning: 10,
      code: 7,
      multimodal: 6,
      retrieval: 7,
      summarization: 10,
      general: 8,
    },
  },
  "gpt-4o": {
    model: "gpt-4o",
    provider: "openai",
    label: "gpt-4o",
    contextWindow: 128_000,
    costTier: "high",
    latencyTier: "medium",
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
    taskAffinity: {
      reasoning: 8,
      code: 10,
      multimodal: 8,
      retrieval: 9,
      summarization: 8,
      general: 9,
    },
  },
  "gemini-1.5-flash": {
    model: "gemini-1.5-flash",
    provider: "gemini",
    label: "gemini-pro",
    contextWindow: 1_000_000,
    costTier: "medium",
    latencyTier: "low",
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
    taskAffinity: {
      reasoning: 7,
      code: 6,
      multimodal: 10,
      retrieval: 7,
      summarization: 8,
      general: 8,
    },
  },
  "llama-3.1-8b-instant": {
    model: "llama-3.1-8b-instant",
    provider: "open-source",
    label: "open-source",
    contextWindow: 32_768,
    costTier: "low",
    latencyTier: "low",
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
    taskAffinity: {
      reasoning: 6,
      code: 7,
      multimodal: 3,
      retrieval: 6,
      summarization: 7,
      general: 8,
    },
  },
};

export const getRouterConfig = (
  overrides: Partial<RouterConfig> = {},
): RouterConfig => {
  const defaultModel = process.env.ROUTER_DEFAULT_MODEL ?? "llama-3.1-8b-instant";
  const modelCatalog = {
    ...DEFAULT_MODEL_CATALOG,
    ...(overrides.modelCatalog ?? {}),
  };

  return {
    timeoutMs: Number(process.env.ROUTER_TIMEOUT_MS ?? 30_000),
    defaultModel,
    openSourceBackend:
      (process.env.ROUTER_OPEN_SOURCE_BACKEND as
        | "groq"
        | "ollama"
        | "huggingface"
        | undefined) ?? "groq",
    apiKeys: {
      anthropic: process.env.ANTHROPIC_API_KEY,
      openai: process.env.OPENAI_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
      groq: process.env.GROQ_API_KEY,
      huggingface: process.env.HUGGINGFACE_API_KEY,
        braveSearch: process.env.BRAVE_SEARCH_API_KEY,
        serper: process.env.SERPER_API_KEY,
      ...(overrides.apiKeys ?? {}),
    },
    endpoints: {
      groqBaseUrl:
        process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1",
      ollamaBaseUrl:
        process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
        braveSearchBaseUrl:
          process.env.BRAVE_SEARCH_BASE_URL ??
          "https://api.search.brave.com/res/v1/web/search",
        serperBaseUrl:
          process.env.SERPER_BASE_URL ?? "https://google.serper.dev/search",
        openMeteoGeocodingBaseUrl:
          process.env.OPEN_METEO_GEOCODING_BASE_URL ??
          "https://geocoding-api.open-meteo.com/v1/search",
        openMeteoForecastBaseUrl:
          process.env.OPEN_METEO_FORECAST_BASE_URL ??
          "https://api.open-meteo.com/v1/forecast",
      ...(overrides.endpoints ?? {}),
    },
    vendorModels: {
      anthropic:
        process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-latest",
      openai: process.env.OPENAI_MODEL ?? "gpt-4o",
      gemini: process.env.GEMINI_MODEL ?? "gemini-1.5-flash",
      groq: process.env.GROQ_MODEL ?? "llama-3.1-8b-instant",
      huggingface:
        process.env.HUGGINGFACE_MODEL ??
        "mistralai/Mistral-7B-Instruct-v0.3",
      ...(overrides.vendorModels ?? {}),
    },
    modelCatalog,
    ...overrides,
  };
};