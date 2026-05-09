import { describe, expect, it } from "vitest";

import { getRouterConfig } from "../router/config";
import { ModelSelector } from "../router/core/modelSelector";

describe("ModelSelector", () => {
  it("prefers a code-capable model for code tasks", () => {
    const selector = new ModelSelector(getRouterConfig().modelCatalog);
    const recommendation = selector.recommend({
      taskType: "code",
      contextLength: 1_500,
      costTier: "medium",
      latencyTier: "medium",
      preferredModel: "gpt-4o",
      requireTools: false,
    });

    expect(recommendation.model).toBe("gpt-4o");
  });
});