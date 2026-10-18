/**
 * Public claims policy (design spec 2026-10-17, section 11).
 *
 * Words that must never appear on a surface a person or an agent can read:
 * README, SECURITY.md, skills, server.json, server instructions, tool
 * descriptions and input-field descriptions. Used by the claims test and by
 * the pre-publish grep.
 *
 * Matching is case-insensitive and on word boundaries, so the lens name
 * `authenticity` passes while `authentic` is caught.
 */
export const BANNED_PUBLIC_WORDS: readonly string[] = Object.freeze([
  'immutable',
  'authentic',
  'authenticated',
  'verified authentic',
  'proof of authenticity',
  'court-proven',
  'court-admissible',
  'forensic-grade',
  'ISO-certified',
  'tamper-proof',
  'cannot be altered',
]);

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const BANNED_PATTERNS: readonly { word: string; re: RegExp }[] = BANNED_PUBLIC_WORDS.map((word) => ({
  word,
  re: new RegExp(`\\b${escapeRegExp(word).replace(/ /g, '\\s+')}\\b`, 'i'),
}));

/** Banned words found in `text`, each reported once, in list order. */
export function findBannedWords(text: string): string[] {
  return BANNED_PATTERNS.filter(({ re }) => re.test(text)).map(({ word }) => word);
}

/** Number of em dashes (U+2014) in `text`. Public copy allows none. */
export function findEmDashes(text: string): number {
  return (text.match(/—/g) ?? []).length;
}
