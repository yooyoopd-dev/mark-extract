import { claude } from "./claude";
import { codex } from "./codex";
import { gemini } from "./gemini";
import { ollama } from "./ollama";
import type { Provider } from "../types";
import type { Provider as ProviderId } from "../../../shared/parse";

export const PROVIDERS: Record<ProviderId, Provider> = { claude, gemini, codex, ollama };
export const providerOf = (id: ProviderId): Provider => PROVIDERS[id];
