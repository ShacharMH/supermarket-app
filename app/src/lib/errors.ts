/** Turn any thrown value (Error, Supabase error object, network failure) into Hebrew text. */
export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : (e as { message?: string } | null)?.message ?? String(e);
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg) || (typeof navigator !== "undefined" && !navigator.onLine))
    return "אין חיבור לאינטרנט כרגע. בדקו את הקליטה ונסו שוב.";
  if (/statement timeout|57014/i.test(msg)) return "השרת עמוס כרגע. נסו שוב בעוד רגע.";
  if (/JWT|not authenticated|invalid claim/i.test(msg)) return "פג תוקף ההתחברות. צאו והתחברו מחדש.";
  return `משהו השתבש: ${msg}`;
}
