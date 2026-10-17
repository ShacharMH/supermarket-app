import { supabase } from "../supabase";
import { termKind, weighedHint, type TermCounts, type TermKind } from "./basket";

// What the shelves say about list terms the built-in hints don't know, kept on the device.
const KEY = "term-kinds";

export function loadKinds(): Record<string, TermKind> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function saveKinds(patch: Record<string, TermKind>) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadKinds(), ...patch }));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(KEY));
}

/** Call `fn` whenever the remembered kinds change (e.g. "במשקל" picked in the results). */
export function onKindsChange(fn: () => void): () => void {
  window.addEventListener(KEY, fn);
  return () => window.removeEventListener(KEY, fn);
}

/** Look up the terms not known yet (one call for all of them) and remember the answers. */
export async function fetchKinds(terms: string[]): Promise<Record<string, TermKind>> {
  const known = loadKinds();
  const todo = [...new Set(terms)].filter((t) => t.length >= 2 && weighedHint(t) === null && !(t in known));
  if (!todo.length) return known;
  const { data, error } = await supabase.rpc("term_kinds", { terms: todo });
  if (error || !data) return known;
  const found = Object.fromEntries((data as (TermCounts & { term: string })[]).map((r) => [r.term, termKind(r)]));
  saveKinds(found);
  return { ...known, ...found };
}
