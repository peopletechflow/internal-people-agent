import { z } from "zod";

/**
 * Optional intent classifier using TypeSafe's Jev (System One model) via the official
 * @typesafe-ai/sdk. Jev answers typed questions (Choice, Noul) with probabilities and
 * confidence; it does not generate text, call tools, or decide permissions. Claude (the MCP
 * client) remains the default and writes all answers.
 */
export const INTENTS = { benefits_question: "Question about the person's own benefits or enrollment", equity_question: "Question about the person's own equity grants or vesting", policy_question: "Question about an HR policy", team_transfer: "Wants to move to another team or role", pbp_help: "Wants help from their People Business Partner or HR", out_of_scope: "Anything else, including questions about other people" } as const;
export type Intent = keyof typeof INTENTS;
export const IntentEnum = z.enum(Object.keys(INTENTS) as [Intent, ...Intent[]]);

export type Classification = { provider: "client" | "jev"; intent: Intent | null; confidence: number | null; anyFit: number | null; sensitive: number | null; model?: string };
export interface IntentClassifier { readonly name: "jev"; classify(question: string): Promise<Classification> }

/** Response contract, from the published OpenAPI (POST /v1/systemone, SystemOneResponse). */
export const SystemOneAnswers = z.object({
  model: z.string(),
  answers: z.object({
    intent: z.object({ type: z.literal("choice"), choice: z.string(), confidence: z.number().min(0).max(1), probabilities: z.record(z.number()) }).passthrough(),
    any_fit: z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }).passthrough(),
    sensitive: z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }).passthrough(),
  }).passthrough(),
}).passthrough();

export async function createJevClassifier(opts: { apiKey: string; model?: string; baseURL?: string; fetch?: typeof fetch }): Promise<IntentClassifier> {
  const sdk = await import("@typesafe-ai/sdk");
  const client = new sdk.TypeSafeClient({ apiKey: opts.apiKey, defaultModel: opts.model ?? "jev-latest", compression: false, logLevel: "error", ...(opts.baseURL ? { baseURL: opts.baseURL } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) } as never);
  return {
    name: "jev",
    async classify(question) {
      const r = await (client as unknown as { systemOne(req: unknown): Promise<unknown> }).systemOne({
        state: { employee_message: question },
        questions: {
          intent: sdk.choice("What is the employee asking for?", { ...INTENTS }),
          any_fit: sdk.noul("Does the message clearly fit one of: own benefits, own equity, HR policy, team transfer, help from HR?"),
          sensitive: sdk.noul("Does the message include health, family, financial hardship or other sensitive personal details?"),
        },
      });
      const a = SystemOneAnswers.parse(r);
      const intent = IntentEnum.safeParse(a.answers.intent.choice);
      return { provider: "jev", intent: intent.success ? intent.data : null, confidence: a.answers.intent.confidence, anyFit: a.answers.any_fit.noul, sensitive: a.answers.sensitive.noul, model: a.model };
    },
  };
}
