import type { RegisteredFunction, ToolExecutionContext } from "../core/functionRegistry";

const WEATHER_CODES: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  71: "Slight snow fall",
  73: "Moderate snow fall",
  75: "Heavy snow fall",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Severe thunderstorm with hail",
};

const renderLocalSummary = (text: string, style: string): string => {
  if (!text.trim()) {
    return "No content available to summarize.";
  }

  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  const selected = sentences.slice(0, Math.max(2, Math.min(5, sentences.length)));

  switch (style) {
    case "bullet":
      return selected.map((sentence) => `- ${sentence.trim()}`).join("\n");
    case "executive":
      return `Executive summary: ${selected.slice(0, 2).join(" ")}`;
    case "detailed":
      return selected.join(" ");
    default:
      return selected.slice(0, 3).join(" ");
  }
};

const renderLocalCode = (description: string, language: string): string => {
  switch (language) {
    case "python":
      return [
        'def main():',
        `    """${description}."""`,
        "    raise NotImplementedError('Replace with real implementation')",
        "",
        'if __name__ == "__main__":',
        "    main()",
      ].join("\n");
    case "javascript":
      return [
        "/**",
        ` * ${description}.`,
        " */",
        "export function main() {",
        "  throw new Error('Replace with real implementation');",
        "}",
      ].join("\n");
    default:
      return [
        "/**",
        ` * ${description}.`,
        " */",
        "export function main(): void {",
        "  throw new Error('Replace with real implementation');",
        "}",
      ].join("\n");
  }
};

const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));

const stripHtml = (value: string): string =>
  decodeHtmlEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

const resolveDuckDuckGoUrl = (href: string): string => {
  const normalized = decodeHtmlEntities(href);
  if (normalized.startsWith("//duckduckgo.com/l/?")) {
    const url = new URL(`https:${normalized}`);
    return url.searchParams.get("uddg") ?? `https:${normalized}`;
  }

  if (normalized.startsWith("/")) {
    return `https://duckduckgo.com${normalized}`;
  }

  return normalized;
};

const searchBrave = async (
  query: string,
  maxResults: number,
  context: ToolExecutionContext,
) => {
  const apiKey = context.config.apiKeys.braveSearch;
  if (!apiKey) {
    return undefined;
  }

  const url = new URL(context.config.endpoints.braveSearchBaseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));
  url.searchParams.set("text_decorations", "false");
  url.searchParams.set("search_lang", "en");

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Brave Search failed: ${response.status}`);
  }

  const payload = (await response.json()) as {
    web?: {
      results?: Array<{ title?: string; url?: string; description?: string }>;
    };
  };
  const results = (payload.web?.results ?? [])
    .filter((item) => item.title && item.url)
    .slice(0, maxResults)
    .map((item) => ({
      title: item.title ?? query,
      url: item.url ?? "",
      snippet: item.description ?? "",
    }));

  return results.length
    ? {
        source: "brave",
        results,
      }
    : undefined;
};

const searchSerper = async (
  query: string,
  maxResults: number,
  context: ToolExecutionContext,
) => {
  const apiKey = context.config.apiKeys.serper;
  if (!apiKey) {
    return undefined;
  }

  const response = await fetch(context.config.endpoints.serperBaseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
    },
    body: JSON.stringify({
      q: query,
      num: maxResults,
    }),
  });

  if (!response.ok) {
    throw new Error(`Serper search failed: ${response.status}`);
  }

  const payload = (await response.json()) as {
    organic?: Array<{ title?: string; link?: string; snippet?: string }>;
  };
  const results = (payload.organic ?? [])
    .filter((item) => item.title && item.link)
    .slice(0, maxResults)
    .map((item) => ({
      title: item.title ?? query,
      url: item.link ?? "",
      snippet: item.snippet ?? "",
    }));

  return results.length
    ? {
        source: "serper",
        results,
      }
    : undefined;
};

const searchDuckDuckGo = async (query: string, maxResults: number) => {
  const response = await fetch(
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    {
      headers: {
        Accept: "text/html",
        "User-Agent": "funcflow-router/0.1",
      },
    },
  );

  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed: ${response.status}`);
  }

  const html = await response.text();
  const pattern = /<a rel="nofollow" href="([^"]+)" class=['"]result-link['"]>([\s\S]*?)<\/a>[\s\S]*?<td class=['"]result-snippet['"]>\s*([\s\S]*?)\s*<\/td>/gi;
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) && results.length < maxResults) {
    const title = stripHtml(match[2]);
    const snippet = stripHtml(match[3]);
    const url = resolveDuckDuckGoUrl(match[1]);

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  if (!results.length) {
    throw new Error("DuckDuckGo returned no parseable results.");
  }

  return {
    source: "duckduckgo-lite",
    results,
  };
};

const fetchWeather = async (
  location: string,
  unit: string,
  context: ToolExecutionContext,
) => {
  const geocodingUrl = new URL(context.config.endpoints.openMeteoGeocodingBaseUrl);
  geocodingUrl.searchParams.set("name", location);
  geocodingUrl.searchParams.set("count", "1");
  geocodingUrl.searchParams.set("language", "en");
  geocodingUrl.searchParams.set("format", "json");

  const geocodingResponse = await fetch(geocodingUrl);
  if (!geocodingResponse.ok) {
    throw new Error(`Weather geocoding failed: ${geocodingResponse.status}`);
  }

  const geocodingPayload = (await geocodingResponse.json()) as {
    results?: Array<{
      name: string;
      country?: string;
      admin1?: string;
      latitude: number;
      longitude: number;
      timezone?: string;
    }>;
  };
  const match = geocodingPayload.results?.[0];
  if (!match) {
    throw new Error(`No weather location found for ${location}.`);
  }

  const forecastUrl = new URL(context.config.endpoints.openMeteoForecastBaseUrl);
  forecastUrl.searchParams.set("latitude", String(match.latitude));
  forecastUrl.searchParams.set("longitude", String(match.longitude));
  forecastUrl.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
  );
  forecastUrl.searchParams.set("timezone", "auto");
  forecastUrl.searchParams.set(
    "temperature_unit",
    unit === "fahrenheit" ? "fahrenheit" : "celsius",
  );
  forecastUrl.searchParams.set(
    "wind_speed_unit",
    unit === "fahrenheit" ? "mph" : "kmh",
  );

  const forecastResponse = await fetch(forecastUrl);
  if (!forecastResponse.ok) {
    throw new Error(`Weather forecast failed: ${forecastResponse.status}`);
  }

  const forecastPayload = (await forecastResponse.json()) as {
    timezone?: string;
    current?: {
      time?: string;
      temperature_2m?: number;
      apparent_temperature?: number;
      weather_code?: number;
      wind_speed_10m?: number;
    };
  };
  const current = forecastPayload.current;
  if (!current || typeof current.temperature_2m !== "number") {
    throw new Error(`Weather data unavailable for ${location}.`);
  }

  return {
    location: [match.name, match.admin1, match.country].filter(Boolean).join(", "),
    latitude: match.latitude,
    longitude: match.longitude,
    timezone: forecastPayload.timezone ?? match.timezone ?? "UTC",
    unit,
    temperature: current.temperature_2m,
    apparentTemperature: current.apparent_temperature,
    condition:
      WEATHER_CODES[current.weather_code ?? -1] ?? "Unknown conditions",
    windSpeed: current.wind_speed_10m,
    observedAt: current.time ?? new Date().toISOString(),
    source: "open-meteo",
  };
};

const summarizeWithModel = async (
  text: string,
  style: string,
  context: ToolExecutionContext,
): Promise<string> => {
  if (!context.adapter) {
    return renderLocalSummary(text, style);
  }

  try {
    const response = await context.adapter.call(
      `Summarize the following text in ${style} style:\n\n${text}`,
      [],
      {
        model: context.model,
        systemPrompt: "You produce concise, factual summaries.",
        temperature: 0.2,
        maxTokens: 600,
      },
    );

    return response.text.trim() || renderLocalSummary(text, style);
  } catch {
    return renderLocalSummary(text, style);
  }
};

const generateCodeWithModel = async (
  description: string,
  language: string,
  context: ToolExecutionContext,
): Promise<string> => {
  if (!context.adapter) {
    return renderLocalCode(description, language);
  }

  try {
    const response = await context.adapter.call(
      `Generate ${language} code for: ${description}`,
      [],
      {
        model: context.model,
        systemPrompt:
          "You are a senior software engineer. Return only the requested code.",
        temperature: 0.1,
        maxTokens: 900,
      },
    );

    return response.text.trim() || renderLocalCode(description, language);
  } catch {
    return renderLocalCode(description, language);
  }
};

const getWeather: RegisteredFunction = {
  name: "getWeather",
  description: "Get weather conditions for a location.",
  parameters: {
    type: "object",
    required: ["location", "unit"],
    additionalProperties: false,
    properties: {
      location: { type: "string", description: "City or region name." },
      unit: {
        type: "string",
        enum: ["celsius", "fahrenheit"],
        description: "Temperature unit.",
      },
    },
  },
  preferred_model: "gemini-1.5-flash",
  tags: ["weather", "forecast", "fast"],
  taskType: "general",
  latencyTier: "low",
  costTier: "low",
  handler: async (params, context) => {
    const location = String(params.location);
    const unit = String(params.unit);
    return fetchWeather(location, unit, context);
  },
};

const searchWeb: RegisteredFunction = {
  name: "searchWeb",
  description: "Search the web for topical information.",
  parameters: {
    type: "object",
    required: ["query"],
    additionalProperties: false,
    properties: {
      query: { type: "string", description: "Search query." },
      maxResults: { type: "integer", description: "Maximum results to return." },
    },
  },
  preferred_model: "gpt-4o",
  tags: ["search", "retrieval", "web"],
  taskType: "retrieval",
  latencyTier: "medium",
  costTier: "medium",
  handler: async (params, context) => {
    const query = String(params.query);
    const maxResults = Number(params.maxResults ?? 5);
    const providerResult =
      (await searchBrave(query, maxResults, context).catch(() => undefined)) ??
      (await searchSerper(query, maxResults, context).catch(() => undefined)) ??
      (await searchDuckDuckGo(query, maxResults));

    return {
      query,
      maxResults,
      results: providerResult.results,
      summaryText: providerResult.results.map((result) => result.snippet).join(" "),
      source: providerResult.source,
    };
  },
};

const summarizeDocument: RegisteredFunction = {
  name: "summarizeDocument",
  description: "Summarize a document or block of text.",
  parameters: {
    type: "object",
    required: ["text"],
    additionalProperties: false,
    properties: {
      text: { type: "string", description: "Document text to summarize." },
      style: {
        type: "string",
        enum: ["brief", "bullet", "detailed", "executive"],
        description: "Summary style.",
      },
    },
  },
  preferred_model: "claude-3-5-sonnet-latest",
  tags: ["summary", "document", "long-context"],
  taskType: "summarization",
  latencyTier: "medium",
  costTier: "medium",
  handler: async (params, context) => {
    const text = String(params.text);
    const style = String(params.style ?? "brief");
    const summary = await summarizeWithModel(text, style, context);

    return {
      style,
      summary,
      length: summary.length,
    };
  },
};

const generateCode: RegisteredFunction = {
  name: "generateCode",
  description: "Generate code from a natural-language description.",
  parameters: {
    type: "object",
    required: ["description", "language"],
    additionalProperties: false,
    properties: {
      description: { type: "string", description: "Desired implementation." },
      language: { type: "string", description: "Programming language." },
    },
  },
  preferred_model: "gpt-4o",
  tags: ["code", "generation", "developer"],
  taskType: "code",
  latencyTier: "medium",
  costTier: "high",
  handler: async (params, context) => {
    const description = String(params.description);
    const language = String(params.language ?? "typescript");
    const code = await generateCodeWithModel(description, language, context);

    return {
      language,
      code,
    };
  },
};

export const exampleFunctions: RegisteredFunction[] = [
  getWeather,
  searchWeb,
  summarizeDocument,
  generateCode,
];