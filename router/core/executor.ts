import type { AdapterRegistry } from "../adapters";
import type { RouterConfig } from "../config";
import type { FunctionRegistry, ParameterReference } from "./functionRegistry";
import { isParameterReference } from "./functionRegistry";
import type { ExecutionPlan, ExecutionStep } from "./executionPlanner";
import { ModelSelector } from "./modelSelector";

export interface StepExecutionResult {
  step: number;
  function: string;
  model: string;
  status: "fulfilled" | "rejected";
  output?: unknown;
  error?: string;
  retryUsed: boolean;
}

export class Executor {
  constructor(
    private readonly registry: FunctionRegistry,
    private readonly adapters: AdapterRegistry,
    private readonly config: RouterConfig,
    private readonly modelSelector: ModelSelector,
  ) {}

  async execute(
    plan: ExecutionPlan,
    options: { stream?: boolean } = {},
  ): Promise<StepExecutionResult[]> {
    const results = new Map<number, StepExecutionResult>();
    const outputs = new Map<number, unknown>();

    for (const group of plan.parallel_groups) {
      const groupSteps = group.map((stepNumber) =>
        plan.execution_plan.find((step) => step.step === stepNumber),
      );

      const executions = groupSteps
        .filter((step): step is ExecutionStep => Boolean(step))
        .map((step) => this.executeStep(step, outputs, options.stream));
      const settled = await Promise.allSettled(executions);

      settled.forEach((entry) => {
        const value =
          entry.status === "fulfilled"
            ? entry.value
            : {
                step: -1,
                function: "unknown",
                model: this.config.defaultModel,
                status: "rejected" as const,
                error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
                retryUsed: false,
              };
        results.set(value.step, value);
        if (value.status === "fulfilled") {
          outputs.set(value.step, value.output);
        }
      });
    }

    return [...results.values()].sort((left, right) => left.step - right.step);
  }

  private async executeStep(
    step: ExecutionStep,
    outputs: Map<number, unknown>,
    stream?: boolean,
  ): Promise<StepExecutionResult> {
    const definition = this.registry.getByName(step.function);
    if (!definition) {
      return {
        step: step.step,
        function: step.function,
        model: step.model,
        status: "rejected",
        error: `Function not registered: ${step.function}`,
        retryUsed: false,
      };
    }

    const run = async (model: string) => {
      const resolvedParams = this.resolveParams(step.params, outputs);
      const adapter = this.adapters.getForModel(model, this.config);
      return definition.handler(resolvedParams, {
        model,
        stream,
        adapter,
        previousResults: Object.fromEntries(outputs.entries()),
        config: this.config,
      });
    };

    try {
      const output = await run(step.model);
      return {
        step: step.step,
        function: step.function,
        model: step.model,
        status: "fulfilled",
        output,
        retryUsed: false,
      };
    } catch (error) {
      const fallbackModel = this.getFallbackModel(step);
      if (fallbackModel && fallbackModel !== step.model) {
        try {
          const output = await run(fallbackModel);
          return {
            step: step.step,
            function: step.function,
            model: fallbackModel,
            status: "fulfilled",
            output,
            retryUsed: true,
          };
        } catch (retryError) {
          return {
            step: step.step,
            function: step.function,
            model: fallbackModel,
            status: "rejected",
            error:
              retryError instanceof Error
                ? retryError.message
                : String(retryError),
            retryUsed: true,
          };
        }
      }

      return {
        step: step.step,
        function: step.function,
        model: step.model,
        status: "rejected",
        error: error instanceof Error ? error.message : String(error),
        retryUsed: false,
      };
    }
  }

  private getFallbackModel(step: ExecutionStep): string | undefined {
    if (step.fallback_model) {
      return step.fallback_model;
    }

    const definition = this.registry.getByName(step.function);
    if (!definition) {
      return undefined;
    }

    return this.modelSelector.rankModels({
      taskType: definition.taskType,
      contextLength: JSON.stringify(step.params).length,
      costTier: definition.costTier ?? "medium",
      latencyTier: definition.latencyTier ?? "medium",
      preferredModel: definition.preferred_model,
      requireTools: definition.taskType === "retrieval",
    })[1]?.model;
  }

  private resolveParams(
    value: Record<string, unknown>,
    outputs: Map<number, unknown>,
  ): Record<string, unknown> {
    const visit = (entry: unknown): unknown => {
      if (Array.isArray(entry)) {
        return entry.map(visit);
      }

      if (isParameterReference(entry)) {
        return this.resolveReference(entry, outputs);
      }

      if (entry && typeof entry === "object") {
        return Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).map(([key, nested]) => [
            key,
            visit(nested),
          ]),
        );
      }

      return entry;
    };

    return visit(value) as Record<string, unknown>;
  }

  private resolveReference(
    reference: ParameterReference,
    outputs: Map<number, unknown>,
  ): unknown {
    if (typeof reference.$fromStep !== "number") {
      return undefined;
    }

    const output = outputs.get(reference.$fromStep);
    if (!reference.path) {
      return output;
    }

    return reference.path
      .split(".")
      .reduce<unknown>((current, segment) => {
        if (current && typeof current === "object") {
          return (current as Record<string, unknown>)[segment];
        }

        return undefined;
      }, output);
  }
}