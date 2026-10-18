/**
 * What this MCP process knows about its API key, for error text.
 *
 * `registerTools` records whether the key is a sandbox key; the background
 * start-up check records a failure. `renderToolError` reads both, so a tool
 * error can say "sandbox keys cannot do this" or "the key failed its start-up
 * check" instead of a bare "auth failed".
 */

/** Where a person signs up for an account key. */
export const SIGNUP_URL = 'https://phototology.com/signup';

/** The SDK's default API base URL, used when PHOTOTOLOGY_BASE_URL is unset. */
export const DEFAULT_API_BASE_URL = 'https://api.phototology.com';

interface KeyStatus {
  /** True for a `pt_test_` key: the anonymous sandbox. */
  sandbox: boolean;
  /** Why the start-up key check failed, when it did. */
  startupProblem?: string;
  /** The API base URL the tools' client uses, for network-error text. */
  baseUrl: string;
  /**
   * For a `pt_test_` key: true once the API confirmed it has no account (the
   * anonymous sandbox), false when it has one. Undefined until known.
   */
  anonymousSandbox?: boolean;
  /** The start-up probe that settles `anonymousSandbox`; resolves, never rejects. */
  sandboxProbe?: Promise<void>;
}

let status: KeyStatus = { sandbox: false, baseUrl: DEFAULT_API_BASE_URL };

export function setKeyContext(apiKey: string, baseUrl?: string): void {
  status = { sandbox: apiKey.startsWith('pt_test_'), baseUrl: baseUrl || DEFAULT_API_BASE_URL };
}

export function setAnonymousSandbox(anonymous: boolean): void {
  status = { ...status, anonymousSandbox: anonymous };
}

export function setSandboxProbe(probe: Promise<void>): void {
  status = { ...status, sandboxProbe: probe };
}

export function setStartupProblem(problem: string): void {
  status = { ...status, startupProblem: problem };
}

export function getKeyStatus(): Readonly<KeyStatus> {
  return status;
}
