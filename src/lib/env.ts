/** Returns the env var value only if it is set and non-empty; undefined otherwise. */
export function nonEmptyEnv(key: string): string | undefined {
  const val = process.env[key];
  return val !== undefined && val.trim() !== '' ? val.trim() : undefined;
}
