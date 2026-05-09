import { describe, expect, it } from "vitest";

import { FunctionRegistry } from "../router/core/functionRegistry";
import { ExecutionPlanner } from "../router/core/executionPlanner";
import { IntentParser } from "../router/core/intentParser";
import { ModelSelector } from "../router/core/modelSelector";
import { getRouterConfig } from "../router/config";
import { exampleFunctions } from "../router/functions/example";

describe("ExecutionPlanner", () => {
  it("creates a sequential search-then-summarize plan", async () => {
    const registry = new FunctionRegistry();
    exampleFunctions.forEach((tool) => registry.register(tool));

    const parser = new IntentParser();
    const parsed = await parser.parse(
      "search the web for function calling routers and then summarize in bullet form",
      registry,
    );

    const planner = new ExecutionPlanner(
      new ModelSelector(getRouterConfig().modelCatalog),
    );
    const plan = planner.buildPlan(parsed, registry);

    expect(plan.chain_strategy).toBe("sequential");
    expect(plan.execution_plan).toHaveLength(2);
    expect(plan.execution_plan[1].depends_on).toEqual([1]);
  });
});