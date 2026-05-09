import type { CostTier, LatencyTier, ModelProfile, TaskType } from "../config";

export interface ModelSelectionInput {
  taskType: TaskType;
  contextLength: number;
  costTier: CostTier;
  latencyTier: LatencyTier;
  preferredModel?: string;
  availableModels?: string[];
  requireTools?: boolean;
  requireStreaming?: boolean;
  requireVision?: boolean;
}

export interface RankedModelRecommendation {
  model: string;
  provider: string;
  score: number;
  reason: string;
}

const COST_SCORE: Record<CostTier, number> = {
  low: 3,
  medium: 2,
  high: 1,
};

const LATENCY_SCORE: Record<LatencyTier, number> = {
  low: 3,
  medium: 2,
  high: 1,
};

export class ModelSelector {
  constructor(private readonly modelCatalog: Record<string, ModelProfile>) {}

  rankModels(input: ModelSelectionInput): RankedModelRecommendation[] {
    const allowedModels = input.availableModels?.length
      ? new Set(input.availableModels)
      : undefined;

    return Object.values(this.modelCatalog)
      .filter((profile) => !allowedModels || allowedModels.has(profile.model))
      .map((profile) => this.scoreModel(profile, input))
      .sort((left, right) => right.score - left.score);
  }

  recommend(input: ModelSelectionInput): RankedModelRecommendation {
    const ranked = this.rankModels(input);
    if (ranked.length === 0) {
      throw new Error("No models are available for the requested selection input.");
    }

    return ranked[0];
  }

  private scoreModel(
    profile: ModelProfile,
    input: ModelSelectionInput,
  ): RankedModelRecommendation {
    let score = profile.taskAffinity[input.taskType] * 10;
    const reasons: string[] = [];

    if (
      input.preferredModel &&
      (input.preferredModel === profile.model ||
        input.preferredModel === profile.label)
    ) {
      score += 25;
      reasons.push("preferred by tool metadata");
    }

    if (profile.contextWindow >= input.contextLength) {
      score += 15;
      reasons.push(`fits ${input.contextLength} tokens of context`);
    } else {
      score -= 20;
      reasons.push("context window may be too small");
    }

    score += compareTier(profile.costTier, input.costTier, COST_SCORE, 10);
    if (compareTier(profile.costTier, input.costTier, COST_SCORE, 10) > 0) {
      reasons.push(`aligned with ${input.costTier} cost target`);
    }

    score += compareTier(
      profile.latencyTier,
      input.latencyTier,
      LATENCY_SCORE,
      10,
    );
    if (compareTier(profile.latencyTier, input.latencyTier, LATENCY_SCORE, 10) > 0) {
      reasons.push(`aligned with ${input.latencyTier} latency target`);
    }

    if (input.requireTools) {
      score += profile.supportsTools ? 8 : -20;
      reasons.push(profile.supportsTools ? "supports tools" : "tool support missing");
    }

    if (input.requireStreaming) {
      score += profile.supportsStreaming ? 4 : -10;
      reasons.push(
        profile.supportsStreaming
          ? "supports streaming"
          : "streaming support missing",
      );
    }

    if (input.requireVision) {
      score += profile.supportsVision ? 6 : -10;
      reasons.push(
        profile.supportsVision ? "supports multimodal input" : "no vision support",
      );
    }

    return {
      model: profile.model,
      provider: profile.provider,
      score,
      reason: capitalize(reasons.join("; ")) || "Balanced default recommendation.",
    };
  }
}

const compareTier = <Tier extends CostTier | LatencyTier>(
  modelTier: Tier,
  requestedTier: Tier,
  table: Record<Tier, number>,
  weight: number,
): number => {
  const delta = table[modelTier] - table[requestedTier];
  if (delta >= 0) {
    return weight - Math.max(0, 2 - delta) * 2;
  }

  return delta * 5;
};

const capitalize = (value: string): string =>
  value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;