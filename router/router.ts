#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { ClaudeAdapter } from "./adapters/claude";
import { GeminiAdapter } from "./adapters/gemini";
import { OpenAIAdapter } from "./adapters/openai";
import { OpenSourceAdapter } from "./adapters/openSource";
import { AdapterRegistry } from "./adapters";
import { getRouterConfig, type RouterConfig } from "./config";
import { ExecutionPlanner, type ExecutionPlan } from "./core/executionPlanner";
import { Executor, type StepExecutionResult } from "./core/executor";
import { FunctionRegistry } from "./core/functionRegistry";
import { IntentParser } from "./core/intentParser";
import { ModelSelector } from "./core/modelSelector";
import { exampleFunctions } from "./functions/example";

export interface ConfirmationQuestion {
  id: string;
  prompt: string;
  step?: number;
  functionName?: string;
  parameter?: string;
}

export interface PendingConfirmation {
  originalMessage: string;
  plan: ExecutionPlan;
  questions: ConfirmationQuestion[];
}

export interface ConfirmationResponse {
  approved: boolean;
  answers?: Record<string, string>;
}

export interface RouteInput {
  userMessage: string;
  availableFunctions?: string[];
  stream?: boolean;
  pendingConfirmation?: PendingConfirmation;
  confirmation?: ConfirmationResponse;
}

export interface RouteOutput {
  status: "awaiting_confirmation" | "completed" | "cancelled";
  plan: ExecutionPlan;
  results: StepExecutionResult[];
  summary: string;
  pendingConfirmation?: PendingConfirmation;
}

export class FunctionCallingRouter {
  private readonly config: RouterConfig;
  private readonly adapters: AdapterRegistry;
  private readonly registry: FunctionRegistry;
  private readonly intentParser: IntentParser;
  private readonly executionPlanner: ExecutionPlanner;
  private readonly executor: Executor;

  constructor(overrides: Partial<RouterConfig> = {}) {
    this.config = getRouterConfig(overrides);
    this.adapters = new AdapterRegistry();
    this.adapters.register(new ClaudeAdapter(this.config));
    this.adapters.register(new OpenAIAdapter(this.config));
    this.adapters.register(new GeminiAdapter(this.config));
    this.adapters.register(new OpenSourceAdapter(this.config));

    this.registry = new FunctionRegistry();
    for (const tool of exampleFunctions) {
      this.registry.register(tool);
    }

    const modelSelector = new ModelSelector(this.config.modelCatalog);
    this.intentParser = new IntentParser({
      adapters: this.adapters,
      config: this.config,
      modelSelector,
    });
    this.executionPlanner = new ExecutionPlanner(modelSelector);
    this.executor = new Executor(
      this.registry,
      this.adapters,
      this.config,
      modelSelector,
    );
  }

  async route(input: RouteInput): Promise<RouteOutput> {
    if (input.pendingConfirmation && input.confirmation && !input.confirmation.approved) {
      return {
        status: "cancelled",
        plan: input.pendingConfirmation.plan,
        results: [],
        summary: "Execution cancelled by the user before running the plan.",
      };
    }

    const plan = input.pendingConfirmation && input.confirmation?.approved
      ? await this.resumeConfirmedPlan(input.pendingConfirmation, input.confirmation)
      : this.executionPlanner.buildPlan(
          await this.intentParser.parse(
            input.userMessage,
            this.registry,
            input.availableFunctions,
          ),
          this.registry,
        );

    if (plan.ambiguityDetected) {
      return {
        status: "awaiting_confirmation",
        plan,
        results: [],
        summary:
          plan.clarificationQuestions?.length
            ? `Awaiting confirmation before execution: ${plan.clarificationQuestions.join(" ")}`
            : "Awaiting confirmation before execution.",
        pendingConfirmation: {
          originalMessage: input.pendingConfirmation?.originalMessage ?? input.userMessage,
          plan,
          questions: buildConfirmationQuestions(plan),
        },
      };
    }

    const results = await this.executor.execute(plan, {
      stream: input.stream,
    });

    return {
      status: "completed",
      plan,
      results,
      summary: summarizeResults(plan, results),
    };
  }

  listFunctions(): string[] {
    return this.registry.list().map((definition) => definition.name);
  }

  private async resumeConfirmedPlan(
    pendingConfirmation: PendingConfirmation,
    confirmation: ConfirmationResponse,
  ): Promise<ExecutionPlan> {
    const hasStructuredQuestions = pendingConfirmation.questions.every(
      (question) => typeof question.step === "number" && Boolean(question.parameter),
    );

    if (!hasStructuredQuestions) {
      const clarifiedMessage = buildClarifiedMessage(
        pendingConfirmation.originalMessage,
        pendingConfirmation.questions,
        confirmation.answers ?? {},
      );
      const parsed = await this.intentParser.parse(
        clarifiedMessage,
        this.registry,
      );
      return this.executionPlanner.buildPlan(parsed, this.registry);
    }

    const plan = JSON.parse(
      JSON.stringify(pendingConfirmation.plan),
    ) as ExecutionPlan;
    const answers = confirmation.answers ?? {};

    for (const question of pendingConfirmation.questions) {
      const targetStep = plan.execution_plan.find((step) => step.step === question.step);
      if (targetStep && question.parameter && answers[question.id]) {
        targetStep.params[question.parameter] = answers[question.id];
      }
    }

    const clarificationQuestions: string[] = [];
    for (const step of plan.execution_plan) {
      const validation = this.registry.validate(step.function, step.params);
      step.params = validation.value;
      clarificationQuestions.push(...validation.errors);
    }

    plan.ambiguityDetected = clarificationQuestions.length > 0;
    plan.clarificationQuestions = clarificationQuestions;
    return plan;
  }
}

export const route = async (input: RouteInput): Promise<RouteOutput> => {
  const router = new FunctionCallingRouter();
  return router.route(input);
};

const summarizeResults = (
  plan: ExecutionPlan,
  results: StepExecutionResult[],
): string => {
  const successCount = results.filter((result) => result.status === "fulfilled").length;
  const failedCount = results.length - successCount;
  return `${plan.intent}: executed ${results.length} step(s), ${successCount} succeeded, ${failedCount} failed.`;
};

const cli = async (): Promise<void> => {
  const userMessage = process.argv.slice(2).join(" ").trim();

  if (!userMessage) {
    console.error("Usage: funcflow-router \"<natural language request>\"");
    process.exitCode = 1;
    return;
  }

  const router = new FunctionCallingRouter();
  let result = await router.route({ userMessage });

  if (result.status === "awaiting_confirmation" && result.pendingConfirmation) {
    const readline = createInterface({ input, output });

    try {
      console.log(JSON.stringify({ plan: result.plan, questions: result.pendingConfirmation.questions }, null, 2));
      const answers: Record<string, string> = {};
      for (const question of result.pendingConfirmation.questions) {
        answers[question.id] = (await readline.question(`${question.prompt} `)).trim();
      }

      const approval = (await readline.question("Proceed with execution? [y/N] ")).trim();
      const approved = /^(y|yes)$/i.test(approval);
      result = await router.route({
        userMessage,
        pendingConfirmation: result.pendingConfirmation,
        confirmation: {
          approved,
          answers,
        },
      });
    } finally {
      readline.close();
    }
  }

  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  void cli();
}

const buildConfirmationQuestions = (plan: ExecutionPlan): ConfirmationQuestion[] => {
  const questions: ConfirmationQuestion[] = [];

  for (const step of plan.execution_plan) {
    const params = step.params;
    for (const [key, value] of Object.entries(params)) {
      if (value == null || (typeof value === "string" && value.trim().length === 0)) {
        questions.push({
          id: `step-${step.step}-${key}`,
          prompt: `Provide ${key} for ${step.function}:`,
          step: step.step,
          functionName: step.function,
          parameter: key,
        });
      }
    }
  }

  if (!questions.length) {
    return (plan.clarificationQuestions ?? []).map((question, index) => ({
      id: `clarification-${index + 1}`,
      prompt: question,
    }));
  }

  return questions;
};

const buildClarifiedMessage = (
  originalMessage: string,
  questions: ConfirmationQuestion[],
  answers: Record<string, string>,
): string => {
  const clarificationLines = questions
    .map((question) => {
      const answer = answers[question.id];
      if (!answer) {
        return undefined;
      }

      if (question.functionName && question.parameter) {
        return `Clarification for ${question.functionName}.${question.parameter}: ${answer}`;
      }

      return `Clarification: ${answer}`;
    })
    .filter((line): line is string => Boolean(line));

  return clarificationLines.length
    ? [originalMessage, "Additional clarifications:", ...clarificationLines].join("\n")
    : originalMessage;
};