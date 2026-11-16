import "server-only";
import { env } from "@/lib/env";
import { chatGroqJson, type ChatMessage as GroqMessage } from "./groq";
import { cooldownMs, rotate, switchesKey, uniqueKeys } from "./key-ring";
import { chatJson, type ChatMessage } from "./openrouter";
import type { BuiltPrompt } from "./prompt";
import { parseModelOutput } from "./schema";
import { AiError, type AiAttemptResult, type AiProvider, type GenerateOptions } from "./types";

interface Slot {
  id: string;
  provider: "openrouter" | "groq";
  key: string;
  model: string;
  label: string;
}

const state = globalThis as unknown as { __aiKeyCursor?: number; __aiKeyCool?: Map<string, number> };
const coolUntil = (state.__aiKeyCool ??= new Map<string, number>());

function slots(): Slot[] {
  const e = env();
  const openrouter = uniqueKeys(e.OPENROUTER_API_KEY, e.OPENROUTER_API_KEYS);
  const groq = uniqueKeys(e.GROQ_API_KEY, e.GROQ_API_KEYS);
  const out: Slot[] = [];
  openrouter.forEach((key, i) => out.push({ id: `openrouter:${i}`, provider: "openrouter", key, model: e.OPENROUTER_MODEL, label: `OpenRouter ${i + 1}/${openrouter.length}` }));
  groq.forEach((key, i) => out.push({ id: `groq:${i}`, provider: "groq", key, model: e.GROQ_MODEL || "openai/gpt-oss-120b", label: `Groq ${i + 1}/${groq.length}` }));
  return out;
}

function readySlots(): Slot[] {
  const all = slots();
  const now = Date.now();
  const start = state.__aiKeyCursor ?? 0;
  return rotate(all, start).filter((slot) => (coolUntil.get(slot.id) ?? 0) <= now);
}

function messagesFor(prompt: BuiltPrompt, opts: GenerateOptions): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];
  if (opts.strictJsonReminder) {
    messages.push({ role: "user", content: 'Your previous reply was not valid. Reply with ONLY a JSON object: {"subject": "...", "body": "..."}' });
  }
  if (opts.correction) {
    messages.push({
      role: "user",
      content: `Your previous draft was rejected: ${opts.correction}. Rewrite it for this recipient only, using only the supplied recipient data. Reply with ONLY the JSON object.`,
    });
  }
  return messages;
}

/** Tries every configured OpenRouter and Groq key. A spent or blocked key is skipped until its cooldown ends, then it rejoins the loop. */
export const rotatingAiProvider: AiProvider = {
  name: "rotating",

  model() {
    return readySlots()[0]?.model ?? slots()[0]?.model ?? env().OPENROUTER_MODEL;
  },

  async generate(prompt: BuiltPrompt, opts: GenerateOptions = {}): Promise<AiAttemptResult> {
    const all = slots();
    if (!all.length) throw new AiError("NOT_CONFIGURED", "No OpenRouter or Groq API keys are configured.");
    const usable = readySlots();
    if (!usable.length) {
      const wait = Math.min(...all.map((slot) => Math.max(0, (coolUntil.get(slot.id) ?? 0) - Date.now())));
      throw new AiError("RATE_LIMIT", "Every AI key is cooling down. Generation will retry.", { retryAfterMs: wait });
    }
    const messages = messagesFor(prompt, opts);
    let last: AiError | null = null;
    for (const slot of usable) {
      try {
        const result =
          slot.provider === "groq"
            ? await chatGroqJson(messages as GroqMessage[], { signal: opts.signal, apiKey: slot.key, temperature: opts.temperature })
            : await chatJson(messages, { signal: opts.signal, apiKey: slot.key, temperature: opts.temperature });
        const parsed = parseModelOutput(result.content);
        if (!parsed.ok) throw new AiError("MALFORMED", parsed.reason);
        const index = all.findIndex((item) => item.id === slot.id);
        state.__aiKeyCursor = index >= 0 ? index : 0;
        return { content: parsed.value, model: result.model, promptTokens: result.promptTokens, completionTokens: result.completionTokens, latencyMs: result.latencyMs };
      } catch (err) {
        const ai = err instanceof AiError ? err : new AiError("NETWORK", err instanceof Error ? err.message : "AI request failed");
        last = ai;
        if (!switchesKey(ai.kind, ai.message)) throw ai;
        coolUntil.set(slot.id, Date.now() + cooldownMs(ai.kind, ai.retryAfterMs));
        const index = all.findIndex((item) => item.id === slot.id);
        state.__aiKeyCursor = (index + 1) % all.length;
        console.warn(`[AI] ${slot.label} unavailable (${ai.kind}). Using the next key.`);
      }
    }
    throw last ?? new AiError("SERVER", "Every configured AI key failed.");
  },
};

export function configuredAiKeyCount(): { openrouter: number; groq: number } {
  const e = env();
  return { openrouter: uniqueKeys(e.OPENROUTER_API_KEY, e.OPENROUTER_API_KEYS).length, groq: uniqueKeys(e.GROQ_API_KEY, e.GROQ_API_KEYS).length };
}
