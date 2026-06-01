import { App, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_ITERATIONS } from "./crypto";
import type LockerPlugin from "./main";

export interface LockerSettings {
	/** PBKDF2 iteration count used when locking new notes. */
	iterations: number;
	/** Re-encrypt an unlocked note automatically when you navigate away. */
	autoLockOnClose: boolean;
	/** Re-encrypt unlocked notes after this many minutes of inactivity (0 = off). */
	autoLockMinutes: number;
	/** Forget the cached vault password after this many minutes (0 = until quit). */
	forgetPasswordMinutes: number;
	/** Verify each note decrypts back to the original before overwriting it. */
	verifyOnLock: boolean;
}

export const DEFAULT_SETTINGS: LockerSettings = {
	iterations: DEFAULT_ITERATIONS,
	autoLockOnClose: true,
	// Non-zero by default so a note left open in a background pane (where the
	// navigate-away hook never fires) still re-locks as a backstop.
	autoLockMinutes: 5,
	forgetPasswordMinutes: 30,
	verifyOnLock: true,
};

export class LockerSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: LockerPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Auto-lock on close")
			.setDesc(
				"Re-encrypt a note as soon as you navigate away from it. Strongly recommended — while a note is unlocked its plaintext is written to disk."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoLockOnClose).onChange(async (value) => {
					this.plugin.settings.autoLockOnClose = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Auto-lock after inactivity")
			.setDesc("Minutes a note may stay unlocked before it is re-encrypted. 0 disables the timer.")
			.addText((text) => {
				text
					.setPlaceholder("5")
					.setValue(String(this.plugin.settings.autoLockMinutes))
					.onChange(async (value) => {
						const n = parseBoundedInt(value, 0, 100000);
						if (n === null) return; // ignore invalid/partial input; keep prior value
						this.plugin.settings.autoLockMinutes = n;
						await this.plugin.saveSettings();
					});
				// On blur, snap back to the saved value so invalid input is visibly rejected.
				text.inputEl.addEventListener("blur", () =>
					text.setValue(String(this.plugin.settings.autoLockMinutes))
				);
			});

		new Setting(containerEl)
			.setName("Forget vault password after")
			.setDesc(
				"Minutes the vault password stays cached in memory. After this you'll be asked again on the next unlock. 0 keeps it until Obsidian quits."
			)
			.addText((text) => {
				text
					.setPlaceholder("30")
					.setValue(String(this.plugin.settings.forgetPasswordMinutes))
					.onChange(async (value) => {
						// Crucially, do NOT collapse invalid input to 0 — that would
						// silently switch off password expiry (a security downgrade).
						const n = parseBoundedInt(value, 0, 100000);
						if (n === null) return;
						this.plugin.settings.forgetPasswordMinutes = n;
						await this.plugin.saveSettings();
					});
				text.inputEl.addEventListener("blur", () =>
					text.setValue(String(this.plugin.settings.forgetPasswordMinutes))
				);
			});

		new Setting(containerEl)
			.setName("Key derivation iterations")
			.setDesc(
				"PBKDF2 iterations used when locking new notes. Higher is slower but more resistant to brute force. Existing locked notes keep the value they were locked with."
			)
			.addText((text) => {
				text
					.setPlaceholder(String(DEFAULT_ITERATIONS))
					.setValue(String(this.plugin.settings.iterations))
					.onChange(async (value) => {
						// Reject sub-floor / absurd values rather than snapping silently;
						// an upper bound prevents a typo from freezing the UI on next lock.
						const n = parseBoundedInt(value, 100000, 10000000);
						if (n === null) return;
						this.plugin.settings.iterations = n;
						await this.plugin.saveSettings();
					});
				text.inputEl.addEventListener("blur", () =>
					text.setValue(String(this.plugin.settings.iterations))
				);
			});

		new Setting(containerEl)
			.setName("Verify before overwriting")
			.setDesc(
				"After encrypting, decrypt the result and confirm it matches the original before replacing the note. Strongly recommended — prevents a faulty lock from destroying content. Roughly doubles lock time."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.verifyOnLock).onChange(async (value) => {
					this.plugin.settings.verifyOnLock = value;
					await this.plugin.saveSettings();
				})
			);

		const warn = containerEl.createEl("div", { cls: "locker-settings-warning" });
		warn.createEl("strong", { text: "Heads up: " });
		warn.appendText(
			"There is no password recovery. If you forget a password, the encrypted note cannot be decrypted. Keep backups of important notes."
		);
	}
}

/**
 * Parse an integer within [min, max]. Returns null for empty/invalid/out-of-range
 * input so callers can leave the previous (valid) value untouched rather than
 * snapping to a default — important because for some fields a wrong default (0)
 * silently weakens security.
 */
function parseBoundedInt(value: string, min: number, max: number): number | null {
	if (!/^\d+$/.test(value.trim())) return null;
	const n = Number.parseInt(value, 10);
	if (!Number.isInteger(n) || n < min || n > max) return null;
	return n;
}
