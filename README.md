# funcflow

Model-agnostic function-calling router middleware for Node.js and TypeScript.

The router accepts a natural-language request, matches it against a tool registry,
builds a dependency-aware execution plan, selects the best model for each step,
and executes the plan with retries and fallbacks.

The default out-of-the-box runtime is Groq on a free-tier open-weight model, while
Anthropic, OpenAI, and Gemini adapters stay fully swappable behind a shared adapter
interface.

## Features

- Strict TypeScript project layout with decoupled adapters and core routing logic.
- Function registry with JSON-Schema-like validation.
- Hybrid intent parsing with adapter-backed planning plus heuristic fallback.
- Model ranking based on task type, context size, cost tier, and latency tier.
- Dependency-aware execution planning with topological sorting.
- Parallel execution via `Promise.allSettled()` and single-retry fallback models.
- Interactive confirmation flow for ambiguous plans before execution.
- Real weather integration via Open-Meteo and search-provider chaining via Brave, Serper, or DuckDuckGo Lite.
- CLI entry point plus importable `route()` function.

## Project Layout

```text
router/
	adapters/
		claude.ts
		openai.ts
		gemini.ts
		openSource.ts
		index.ts
	core/
		intentParser.ts
		functionRegistry.ts
		executionPlanner.ts
		modelSelector.ts
		executor.ts
	functions/
		example.ts
	router.ts
	config.ts
tests/
	executionPlanner.test.ts
	functionRegistry.test.ts
	modelSelector.test.ts
```

## Architecture

```text
User Message
		|
		v
+-------------------+
| Intent Parser     |
| - adapter prompt  |
| - heuristic merge |
| - ambiguity       |
+-------------------+
		|
		v
+-------------------+        +-------------------+
| Function Registry |<------>| Model Selector    |
| - metadata        |        | - ranking         |
| - validation      |        | - recommendations |
+-------------------+        +-------------------+
		|                              |
		+--------------+---------------+
									 |
									 v
					+-------------------+
					| Execution Planner |
					| - dependencies    |
					| - topo sort       |
					| - parallel groups |
					+-------------------+
									 |
									 v
					+-------------------+
					| Executor          |
					| - Promise.all...  |
					| - fallback retry  |
					+-------------------+
									 |
									 v
					+-------------------+
					| Adapter Layer     |
					| claude/openai/    |
					| gemini/openSource |
					+-------------------+
```

## Setup

1. Install dependencies.

```bash
npm install
```

2. Copy environment variables and add any provider keys you want to enable.

```bash
cp .env.example .env
```

Optional search integrations:

- `BRAVE_SEARCH_API_KEY` enables Brave Search as the primary web-search backend.
- `SERPER_API_KEY` enables Google Serper as an alternative backend.
- Without either key, the router falls back to DuckDuckGo Lite for zero-config runs.

Weather uses Open-Meteo and does not require an API key.

3. Build or typecheck.

```bash
npm run build
npm run typecheck
```

4. Run the CLI.

```bash
npm run dev -- "search the web for edge AI routers and summarize the findings in bullets"
```

## Usage

### Importable module

```ts
import { route } from "./router/router";

const result = await route({
	userMessage: "get the weather in Tokyo in celsius",
});

if (result.status === "awaiting_confirmation") {
	console.log(result.pendingConfirmation?.questions);
} else {
	console.log(JSON.stringify(result.plan, null, 2));
	console.log(result.summary);
}
```

### CLI

```bash
npm run dev -- "generate code for a retrying HTTP client in typescript"
```

If the CLI detects ambiguity, it prints the plan preview, asks the clarification questions interactively, and executes only after approval.

### Example plan shape

```json
{
	"intent": "search-and-summarize",
	"parse_source": "adapter",
	"execution_plan": [
		{
			"step": 1,
			"function": "searchWeb",
			"model": "gpt-4o",
			"reason": "Preferred by the tool metadata and strong for retrieval/tool-use.",
			"params": {
				"query": "edge AI routers",
				"maxResults": 5
			},
			"depends_on": []
		},
		{
			"step": 2,
			"function": "summarizeDocument",
			"model": "claude-3-5-sonnet-latest",
			"reason": "Large context and high summarization quality.",
			"params": {
				"text": {
					"$fromStep": 1,
					"path": "summaryText"
				},
				"style": "bullet"
			},
			"depends_on": [1]
		}
	],
	"chain_strategy": "sequential"
}
```

## Notes

- The default open-source adapter is configured for Groq's OpenAI-compatible API and a free-tier model.
- Vendor adapters are isolated from core logic, so swapping providers does not require router-core changes.
- Intent parsing first attempts an adapter-backed planner prompt using the router system prompt from `router/config.ts`, then falls back to heuristics if no model is available or the response is invalid.
- Summary/code tools still fall back to deterministic local behavior when a model adapter is unavailable.

## Tests

```bash
npm test
```