/*
 * A lightweight, dependency-free password strength heuristic.
 *
 * This is intentionally simple (length + character-class variety + a couple of
 * obvious-weakness penalties). It is a UX hint to nudge users away from trivial
 * passwords — not a substitute for a real estimator like zxcvbn.
 */

export interface StrengthResult {
	/** 0 (worst) .. 4 (best) */
	score: 0 | 1 | 2 | 3 | 4;
	label: string;
}

const LABELS = ["Very weak", "Weak", "Fair", "Good", "Strong"] as const;

export function estimateStrength(password: string): StrengthResult {
	if (!password) return { score: 0, label: LABELS[0] };

	const len = password.length;
	let classes = 0;
	if (/[a-z]/.test(password)) classes++;
	if (/[A-Z]/.test(password)) classes++;
	if (/[0-9]/.test(password)) classes++;
	if (/[^A-Za-z0-9]/.test(password)) classes++;

	let points = 0;
	if (len >= 8) points++;
	if (len >= 12) points++;
	if (len >= 16) points++;
	if (len >= 20) points++;
	if (classes >= 3) points++;
	if (classes >= 4) points++;

	// Penalize obvious weaknesses.
	if (/^(.)\1+$/.test(password)) points = 0; // all one repeated char
	if (/^(?:0123456789|abcdefghijklmnopqrstuvwxyz|password|qwerty)/i.test(password)) {
		points = Math.min(points, 1);
	}
	// Low character diversity (e.g. "abababab", "aaabbb") is weak regardless of
	// length or class count — entropy comes from variety, not just length.
	const unique = new Set(password).size;
	if (unique <= 2) points = 0;
	else if (unique * 2 < len) points = Math.min(points, 2);

	let score = Math.round((points * 4) / 6);
	// Length dominates entropy: don't let class-variety alone label a short
	// password "Strong". Cap progressively by length.
	if (len < 12) score = Math.min(score, 2);
	if (len < 8) score = Math.min(score, 1);
	if (len < 5) score = 0;
	score = Math.max(0, Math.min(4, score)) as StrengthResult["score"];

	return { score: score as StrengthResult["score"], label: LABELS[score] };
}
