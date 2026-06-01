import { App, Modal, Setting } from "obsidian";

/** A minimal yes/no confirmation modal. Resolves true on confirm, false otherwise. */
export class ConfirmModal extends Modal {
	private resolver: ((value: boolean) => void) | null = null;
	private confirmed = false;

	constructor(
		app: App,
		private opts: { title: string; message: string; cta?: string }
	) {
		super(app);
	}

	open(): Promise<boolean> {
		super.open();
		return new Promise((resolve) => {
			this.resolver = resolve;
		});
	}

	onOpen(): void {
		this.titleEl.setText(this.opts.title);
		this.contentEl.createEl("p", { text: this.opts.message });
		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close())
			)
			.addButton((btn) => {
				btn.setButtonText(this.opts.cta ?? "Confirm").setCta();
				btn.onClick(() => {
					this.confirmed = true;
					this.close();
				});
			});
	}

	onClose(): void {
		this.contentEl.empty();
		if (this.resolver) {
			this.resolver(this.confirmed);
			this.resolver = null;
		}
	}
}
