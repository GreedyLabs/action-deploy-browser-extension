/**
 * Reads a required environment variable, throwing a descriptive error when it
 * is missing or empty. Used for credentials that are passed to the action via
 * `env:` rather than `with:` inputs.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}
