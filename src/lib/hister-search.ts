import { invoke } from "@tauri-apps/api/core"
import type { HisterConfig } from "@/stores/wiki-store"
import type { WebSearchResult } from "./web-search"

export const DEFAULT_HISTER_ENDPOINT = "http://127.0.0.1:9091"
export const DEFAULT_HISTER_LIMIT = 10

/**
 * Unlike `normalizeAnyTxtConfig`, this never infers `enabled: true` from
 * an endpoint being present — Hister is opt-in only, since it can surface
 * personal browsing history rather than just files the user chose to
 * index. `enabled` defaults to `false` unless the user has explicitly
 * turned it on.
 */
export function normalizeHisterConfig(config?: HisterConfig): Required<HisterConfig> {
  return {
    enabled: config?.enabled ?? false,
    endpoint: config?.endpoint?.trim() || DEFAULT_HISTER_ENDPOINT,
    token: config?.token ?? "",
    limit: clampHisterLimit(config?.limit),
  }
}

export function hasConfiguredHister(config?: HisterConfig): boolean {
  const resolved = normalizeHisterConfig(config)
  return Boolean(resolved.enabled && resolved.endpoint.trim())
}

function clampHisterLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_HISTER_LIMIT
  return Math.min(50, Math.max(1, Math.round(limit)))
}

/** Used only by the settings "Test connection" button — the Agent's own
 * use of Hister goes through the `hister.search` tool inside
 * `agent::runtime`, not this function. */
export async function histerSearch(
  query: string,
  config?: HisterConfig,
  maxResults: number = DEFAULT_HISTER_LIMIT,
): Promise<WebSearchResult[]> {
  if (!query.trim()) return []
  const resolved = normalizeHisterConfig(config)
  if (!resolved.enabled) return []
  return invoke<WebSearchResult[]>("hister_search", {
    query,
    config: resolved,
    maxResults,
  })
}
