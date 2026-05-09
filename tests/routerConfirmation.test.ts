import { describe, expect, it } from "vitest";

import { FunctionCallingRouter } from "../router/router";

describe("FunctionCallingRouter confirmation flow", () => {
  it("pauses ambiguous plans and resumes after answers are provided", async () => {
    const router = new FunctionCallingRouter();
    const initial = await router.route({
      userMessage: "what is the weather",
    });

    expect(initial.status).toBe("awaiting_confirmation");
    expect(initial.pendingConfirmation?.questions[0]?.parameter).toBe("location");

    const resumed = await router.route({
      userMessage: "what is the weather",
      pendingConfirmation: initial.pendingConfirmation,
      confirmation: {
        approved: true,
        answers: {
          [initial.pendingConfirmation!.questions[0]!.id]: "Berlin",
        },
      },
    });

    expect(resumed.status).toBe("completed");
    expect(resumed.results[0]?.status).toBe("fulfilled");
  });
});