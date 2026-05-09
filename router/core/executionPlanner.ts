import type { CostTier, LatencyTier } from "../config";
import type { FunctionRegistry } from "./functionRegistry";
import { isParameterReference } from "./functionRegistry";
import type { ParsedIntent } from "./intentParser";
import { ModelSelector } from "./modelSelector";

export interface ExecutionStep {
  step: number;
  function: string;
  model: string;
  reason: string;
  params: Record<string, unknown>;
  depends_on: number[];
  fallback_model?: string;
}

export interface ExecutionPlan {
  intent: string;
  execution_plan: ExecutionStep[];
  chain_strategy: "parallel" | "sequential" | "mixed";
  parallel_groups: number[][];
  parse_source?: "heuristic" | "adapter" | "hybrid";
  parse_model?: string;
  ambiguityDetected?: boolean;
  clarificationQuestions?: string[];
}

export class ExecutionPlanner {
  constructor(private readonly modelSelector: ModelSelector) {}

  buildPlan(parsed: ParsedIntent, registry: FunctionRegistry): ExecutionPlan {
    const stepByFunction = new Map<string, number>();
    const provisionalSteps = parsed.invocations.map((invocation, index) => {
      const registeredFunction = registry.getByName(invocation.functionName);
      if (!registeredFunction) {
        throw new Error(`Unknown function in plan: ${invocation.functionName}`);
      }

      const validation = registry.validate(invocation.functionName, invocation.params);
      const recommendation = this.modelSelector.rankModels({
        taskType: registeredFunction.taskType,
        contextLength: JSON.stringify(validation.value).length,
        costTier: registeredFunction.costTier ?? ("medium" satisfies CostTier),
        latencyTier:
          registeredFunction.latencyTier ?? ("medium" satisfies LatencyTier),
        preferredModel: registeredFunction.preferred_model,
        requireTools: registeredFunction.taskType === "retrieval",
      });

      const step = {
        step: index + 1,
        function: invocation.functionName,
        model: recommendation[0]?.model ?? "llama-3.1-8b-instant",
        reason:
          recommendation[0]?.reason ??
          "Fallback model selected because no ranked recommendation was available.",
        params: validation.value,
        depends_on: [] as number[],
        fallback_model: recommendation[1]?.model,
      };

      stepByFunction.set(invocation.functionName, step.step);
      return {
        step,
        dependencies: [...invocation.dependsOn],
        validationErrors: validation.errors,
      };
    });

    for (const provisional of provisionalSteps) {
      provisional.step.params = resolveReferences(
        provisional.step.params,
        stepByFunction,
        provisional.dependencies,
      );
      provisional.step.depends_on = normalizeDependencies(
        provisional.dependencies,
        stepByFunction,
        provisional.step.params,
      );
    }

    const executionPlan = topologicalLayers(
      provisionalSteps.map((item) => item.step),
    );
    const flattened = executionPlan.flatMap((group) =>
      group.map((stepNumber) =>
        provisionalSteps.find((item) => item.step.step === stepNumber)!.step,
      ),
    );
    const clarificationQuestions = [
      ...parsed.clarificationQuestions,
      ...provisionalSteps.flatMap((item) => item.validationErrors),
    ];

    return {
      intent: parsed.intent,
      execution_plan: flattened,
      chain_strategy: detectChainStrategy(executionPlan),
      parallel_groups: executionPlan,
      parse_source: parsed.parseSource,
      parse_model: parsed.parserModel,
      ambiguityDetected: clarificationQuestions.length > 0,
      clarificationQuestions,
    };
  }
}

const resolveReferences = (
  value: Record<string, unknown>,
  stepByFunction: Map<string, number>,
  dependencies: Array<string | number>,
): Record<string, unknown> => {
  const visit = (entry: unknown): unknown => {
    if (Array.isArray(entry)) {
      return entry.map(visit);
    }

    if (isParameterReference(entry)) {
      if (typeof entry.$fromStep === "string") {
        const resolvedStep = stepByFunction.get(entry.$fromStep);
        if (resolvedStep) {
          if (!dependencies.includes(resolvedStep)) {
            dependencies.push(resolvedStep);
          }
          return {
            ...entry,
            $fromStep: resolvedStep,
          };
        }
      }

      return entry;
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
};

const normalizeDependencies = (
  dependencies: Array<string | number>,
  stepByFunction: Map<string, number>,
  params: Record<string, unknown>,
): number[] => {
  const stepNumbers = new Set<number>();

  for (const dependency of dependencies) {
    if (typeof dependency === "number") {
      stepNumbers.add(dependency);
      continue;
    }

    const resolved = stepByFunction.get(dependency);
    if (resolved) {
      stepNumbers.add(resolved);
    }
  }

  collectDependencyReferences(params, stepNumbers);

  return [...stepNumbers].sort((left, right) => left - right);
};

const collectDependencyReferences = (
  value: unknown,
  bucket: Set<number>,
): void => {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectDependencyReferences(entry, bucket));
    return;
  }

  if (isParameterReference(value) && typeof value.$fromStep === "number") {
    bucket.add(value.$fromStep);
    return;
  }

  if (value && typeof value === "object") {
    Object.values(value).forEach((entry) => collectDependencyReferences(entry, bucket));
  }
};

const topologicalLayers = (steps: ExecutionStep[]): number[][] => {
  const indegree = new Map<number, number>();
  const outgoing = new Map<number, number[]>();

  for (const step of steps) {
    indegree.set(step.step, step.depends_on.length);
    outgoing.set(step.step, []);
  }

  for (const step of steps) {
    for (const dependency of step.depends_on) {
      outgoing.get(dependency)?.push(step.step);
    }
  }

  const layers: number[][] = [];
  let queue = steps
    .filter((step) => step.depends_on.length === 0)
    .map((step) => step.step)
    .sort((left, right) => left - right);
  let visited = 0;

  while (queue.length) {
    layers.push(queue);
    visited += queue.length;
    const nextQueue: number[] = [];

    for (const current of queue) {
      for (const target of outgoing.get(current) ?? []) {
        const remaining = (indegree.get(target) ?? 0) - 1;
        indegree.set(target, remaining);
        if (remaining === 0) {
          nextQueue.push(target);
        }
      }
    }

    queue = nextQueue.sort((left, right) => left - right);
  }

  if (visited !== steps.length) {
    throw new Error("Dependency cycle detected in execution plan.");
  }

  return layers;
};

const detectChainStrategy = (
  layers: number[][],
): "parallel" | "sequential" | "mixed" => {
  if (layers.length <= 1) {
    return layers[0]?.length > 1 ? "parallel" : "sequential";
  }

  const hasParallelLayer = layers.some((layer) => layer.length > 1);
  return hasParallelLayer ? "mixed" : "sequential";
};