/*
 * Cryptography for Obsidian Locker.
 *
 * Uses the Web Crypto API (available in Obsidian's Electron runtime and on
 * mobile via Capacitor). Keys are derived from a password with PBKDF2 and
 * content is sealed with AES-GCM (authenticated encryption), so a wrong
 * password / tampered ciphertext fails decryption rather than returning junk.
 */

export const DEFAULT_ITERATIONS = 310000;
/** Accepted bounds for the (untrusted, in-cleartext) iteration count on decrypt. */
export const MIN_ITERATIONS = 100000;
export const MAX_ITERATIONS = 10000000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;

export type LockerScope = "vault" | "note";

/** Serializable payload stored inside the locked note. */
export interface LockerPayload {
	/** Payload format version, for forward compatibility. */
	v: number;
	alg: "AES-GCM";
	kdf: "PBKDF2";
	hash: "SHA-256";
	iterations: number;
	/** base64-encoded random salt */
	salt: string;
	/** base64-encoded random initialization vector */
	iv: string;
	/** base64-encoded ciphertext (includes the GCM auth tag) */
	ct: string;
	/** whether this note expects the vault password or its own password */
	scope: LockerScope;
}

/** Thrown when decryption fails (wrong password or corrupted data). */
export class DecryptError extends Error {
	constructor(message = "Incorrect password or the encrypted data is corrupted.") {
		super(message);
		this.name = "DecryptError";
	}
}

/** Thrown when the post-encryption round-trip self-check fails. */
export class SelfCheckError extends Error {
	constructor(
		message = "Encryption self-check failed: the ciphertext did not decrypt back to the original. Aborting to avoid data loss."
	) {
		super(message);
		this.name = "SelfCheckError";
	}
}

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < view.length; i += chunk) {
		binary += String.fromCharCode(...view.subarray(i, i + chunk));
	}
	return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

async function deriveKey(
	password: string,
	salt: Uint8Array,
	iterations: number
): Promise<CryptoKey> {
	const baseKey = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveKey"]
	);
	return crypto.subtle.deriveKey(
		{ name: "PBKDF2", salt, iterations, hash: "SHA-256" },
		baseKey,
		{ name: "AES-GCM", length: KEY_BITS },
		false,
		["encrypt", "decrypt"]
	);
}

/** Encrypt plaintext into a self-describing payload. */
export async function encryptContent(
	plaintext: string,
	password: string,
	scope: LockerScope,
	iterations: number = DEFAULT_ITERATIONS
): Promise<LockerPayload> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const key = await deriveKey(password, salt, iterations);
	const ct = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		new TextEncoder().encode(plaintext)
	);
	return {
		v: 1,
		alg: "AES-GCM",
		kdf: "PBKDF2",
		hash: "SHA-256",
		iterations,
		salt: toBase64(salt),
		iv: toBase64(iv),
		ct: toBase64(ct),
		scope,
	};
}

/**
 * Encrypt, then immediately decrypt and verify the result equals the original
 * before returning. This guarantees the payload is decryptable with the given
 * password, so a caller can safely overwrite the plaintext on disk. Throws
 * {@link SelfCheckError} if the round-trip does not match.
 */
export async function encryptContentVerified(
	plaintext: string,
	password: string,
	scope: LockerScope,
	iterations: number = DEFAULT_ITERATIONS
): Promise<LockerPayload> {
	const payload = await encryptContent(plaintext, password, scope, iterations);
	const roundTrip = await decryptContent(payload, password);
	if (roundTrip !== plaintext) {
		throw new SelfCheckError();
	}
	return payload;
}

/** Decrypt a payload back to plaintext. Throws {@link DecryptError} on failure. */
export async function decryptContent(
	payload: LockerPayload,
	password: string
): Promise<string> {
	// Validate the self-described, unauthenticated parameters before doing any
	// expensive key derivation. A corrupted/tampered payload should fail fast and
	// safely rather than e.g. freezing the UI with an absurd iteration count or
	// silently running an algorithm we never produced.
	if (payload.alg !== "AES-GCM" || payload.kdf !== "PBKDF2" || payload.hash !== "SHA-256") {
		throw new DecryptError("Unsupported or unrecognized encryption parameters.");
	}
	if (
		!Number.isInteger(payload.iterations) ||
		payload.iterations < MIN_ITERATIONS ||
		payload.iterations > MAX_ITERATIONS
	) {
		throw new DecryptError("Encryption parameters are out of the accepted range.");
	}

	try {
		const salt = fromBase64(payload.salt);
		const iv = fromBase64(payload.iv);
		const ct = fromBase64(payload.ct);
		if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || ct.length === 0) {
			throw new DecryptError("Encrypted data is malformed.");
		}
		const key = await deriveKey(password, salt, payload.iterations);
		const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
		return new TextDecoder().decode(plain);
	} catch (e) {
		if (e instanceof DecryptError) throw e;
		throw new DecryptError();
	}
}
