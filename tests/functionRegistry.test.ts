import { describe, expect, it } from "vitest";

import { FunctionRegistry } from "../router/core/functionRegistry";
import { exampleFunctions } from "../router/functions/example";

describe("FunctionRegistry", () => {
  it("registers and validates a tool payload", () => {
    const registry = new FunctionRegistry();
    registry.register(exampleFunctions[0]);

    const result = registry.validate("getWeather", {
      location: "Berlin",
      unit: "celsius",
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects missing required properties", () => {
    const registry = new FunctionRegistry();
    registry.register(exampleFunctions[1]);

    const result = registry.validate("searchWeb", {
      maxResults: 3,
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("query");
  });
});