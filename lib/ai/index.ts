import "server-only";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { mockAiProvider } from "./mock";
import { rotatingAiProvider } from "./rotating";
import type { AiProvider } from "./types";

/** Returns the selected provider. OpenRouter and Groq keys are tried in one loop. */
export function getAiProvider(choice: "openrouter" | "groq" | "mock" | string): AiProvider {
  if (choice === "mock") {
    if (env().isProduction) throw new AppError("NOT_CONFIGURED", "The mock AI provider is disabled in production.");
    return mockAiProvider;
  }
  return rotatingAiProvider;
}
