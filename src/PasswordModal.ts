import { App, Modal, Setting } from "obsidian";
import { estimateStrength } from "./strength";

export interface PasswordPromptOptions {
	title: string;
	description?: string;
	/** When true, requires a second matching field — used when locking. */
	confirm?: boolean;
	cta?: string;
}

/**
 * A modal that asks for a password. Resolves with the entered password, or
 * null if the user cancels.
 */
export class PasswordModal extends Modal {
	private resolver: ((value: string | null) => void) | null = null;
	private password = "";
	private confirmPassword = "";
	private submitted = false;
	private strengthEl: HTMLElement | null = null;

	constructor(app: App, private options: PasswordPromptOptions) {
		super(app);
	}

	open(): Promise<string | null> {
		super.open();
		return new Promise((resolve) => {
			this.resolver = resolve;
		});
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(this.options.title);

		if (this.options.description) {
			contentEl.createEl("p", {
				text: this.options.description,
				cls: "locker-modal-desc",
			});
		}

		const submit = () => this.trySubmit();

		const pwSetting = new Setting(contentEl).setName("Password");
		pwSetting.addText((text) => {
			text.inputEl.type = "password";
			text.inputEl.autocapitalize = "off";
			text.inputEl.setAttribute("autocomplete", "off");
			text.setPlaceholder("Enter password");
			text.onChange((value) => {
				this.password = value;
				this.updateStrength(value);
			});
			text.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					submit();
				}
			});
			// Focus the field once the modal is laid out.
			window.setTimeout(() => text.inputEl.focus(), 0);
		});

		// A strength hint is only useful while choosing a new password.
		if (this.options.confirm) {
			this.strengthEl = contentEl.createDiv({ cls: "locker-strength" });
			const bar = this.strengthEl.createDiv({ cls: "locker-strength-track" });
			bar.createDiv({ cls: "locker-strength-fill" });
			this.strengthEl.createSpan({ cls: "locker-strength-label" });
			this.updateStrength("");
		}

		if (this.options.confirm) {
			new Setting(contentEl).setName("Confirm password").addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.autocapitalize = "off";
				text.inputEl.setAttribute("autocomplete", "off");
				text.setPlaceholder("Re-enter password");
				text.onChange((value) => (this.confirmPassword = value));
				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						submit();
					}
				});
			});
		}

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText(this.options.cta ?? "Confirm")
				.setCta()
				.onClick(submit)
		);
	}

	private updateStrength(password: string): void {
		if (!this.strengthEl) return;
		const { score, label } = estimateStrength(password);
		const fill = this.strengthEl.querySelector<HTMLElement>(".locker-strength-fill");
		const text = this.strengthEl.querySelector<HTMLElement>(".locker-strength-label");
		if (fill) {
			fill.style.width = `${(score / 4) * 100}%`;
			fill.dataset.score = String(score);
		}
		if (text) text.setText(password ? label : "");
	}

	private trySubmit(): void {
		if (!this.password) {
			this.flash("Password cannot be empty.");
			return;
		}
		if (this.options.confirm && this.password !== this.confirmPassword) {
			this.flash("Passwords do not match.");
			return;
		}
		this.submitted = true;
		this.close();
	}

	private flash(message: string): void {
		const { contentEl } = this;
		let el = contentEl.querySelector<HTMLElement>(".locker-modal-error");
		if (!el) {
			el = contentEl.createEl("p", { cls: "locker-modal-error" });
		}
		el.setText(message);
	}

	onClose(): void {
		this.contentEl.empty();
		const value = this.submitted ? this.password : null;
		// Clear secrets from instance memory once handed off.
		this.password = "";
		this.confirmPassword = "";
		if (this.resolver) {
			this.resolver(value);
			this.resolver = null;
		}
	}
}
