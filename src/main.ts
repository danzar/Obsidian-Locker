import {
	MarkdownView,
	Menu,
	Notice,
	Plugin,
	setIcon,
	TAbstractFile,
	TFile,
	TFolder,
} from "obsidian";
import {
	decryptContent,
	DecryptError,
	encryptContent,
	encryptContentVerified,
	LockerPayload,
	LockerScope,
	SelfCheckError,
} from "./crypto";
import { buildLockedNote, isLocked, parseLockedNote, readScope } from "./format";
import { PasswordModal, PasswordPromptOptions } from "./PasswordModal";
import { DEFAULT_SETTINGS, LockerSettings, LockerSettingTab } from "./settings";

const SWEEP_INTERVAL_MS = 30 * 1000;

/** Tracks a note that is currently decrypted on disk so it can be re-locked. */
interface UnlockedNote {
	password: string;
	scope: LockerScope;
	iterations: number;
	lastTouched: number;
}

/** Shape persisted via saveData: settings plus a crash-recovery ledger of paths. */
interface PersistedData {
	settings: LockerSettings;
	/** Paths that held plaintext on disk at last write — used to recover after a crash. */
	ledger: string[];
}

export default class LockerPlugin extends Plugin {
	settings: LockerSettings = { ...DEFAULT_SETTINGS };

	/** Vault password cached for the session, never persisted to disk. */
	private vaultPassword: string | null = null;
	private vaultPasswordSetAt = 0;

	/** path -> details needed to re-lock an unlocked note. */
	private unlocked = new Map<string, UnlockedNote>();

	/** Serializes mutating operations per file path (lock/unlock/relock). */
	private inFlight = new Set<string>();

	private statusBarEl: HTMLElement | null = null;
	private lastActiveFile: string | null = null;

	/** Ledger read at startup, and notes found still exposed (plaintext) after a crash. */
	private startupLedger: string[] = [];
	private exposed: TFile[] = [];

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addSettingTab(new LockerSettingTab(this.app, this));

		this.addRibbonIcon("lock", "Locker: toggle lock on current note", async () => {
			await this.toggleActiveNote();
		});

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("locker-status");
		this.statusBarEl.addEventListener("click", () => {
			if (this.unlocked.size > 0) void this.lockAll();
		});
		this.updateStatusBar();

		this.registerCommands();
		this.registerEvents();

		// One fixed-cadence sweep; it reads current settings each tick, so settings
		// changes take effect without re-registering (avoids leaking intervals).
		this.registerInterval(window.setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS));

		this.app.workspace.onLayoutReady(() => {
			this.lastActiveFile = this.app.workspace.getActiveFile()?.path ?? null;
			void this.recoverExposedNotes();
		});
	}

	onunload(): void {
		// Obsidian does NOT await an async onunload, so this is best-effort: kick off
		// a re-lock of anything still decrypted. The persisted ledger lets the next
		// session detect and re-secure anything this didn't finish in time.
		void this.lockAll(true);
		this.vaultPassword = null;
	}

	private registerCommands(): void {
		this.addCommand({
			id: "lock-note",
			name: "Lock note (vault password)",
			checkCallback: (checking) => this.commandOnFile(checking, (f) => this.lockNote(f, "vault")),
		});
		this.addCommand({
			id: "lock-note-separate-password",
			name: "Lock note with a separate password",
			checkCallback: (checking) => this.commandOnFile(checking, (f) => this.lockNote(f, "note")),
		});
		this.addCommand({
			id: "unlock-note",
			name: "Unlock note",
			checkCallback: (checking) => this.commandOnFile(checking, (f) => this.unlockNote(f)),
		});
		this.addCommand({
			id: "lock-all",
			name: "Lock all currently-unlocked notes",
			callback: () => this.lockAll(),
		});

		this.addCommand({
			id: "lock-vault",
			name: "Lock every note in the vault (vault password)",
			callback: () => this.lockFolder(this.app.vault.getRoot()),
		});

		this.addCommand({
			id: "unlock-vault",
			name: "Unlock every vault-password note in the vault",
			callback: () => this.unlockFolder(this.app.vault.getRoot()),
		});
		this.addCommand({
			id: "forget-vault-password",
			name: "Forget vault password (lock session)",
			callback: () => this.forgetVaultPassword(),
		});
		this.addCommand({
			id: "secure-exposed",
			name: "Secure notes left exposed (after a crash)",
			checkCallback: (checking) => {
				if (this.exposed.length === 0) return false;
				if (!checking) void this.secureExposed();
				return true;
			},
		});
	}

	private registerEvents(): void {
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file) => {
				if (file instanceof TFile && file.extension === "md") {
					this.addFileMenuItems(menu, file);
				} else if (file instanceof TFolder) {
					this.addFolderMenuItems(menu, file);
				}
			})
		);

		// Auto-lock the note being left. Listen to both events: file-open misses
		// switches to non-file views / closing the last tab, which leaf-change catches.
		this.registerEvent(this.app.workspace.on("file-open", () => this.handleActiveChange()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.handleActiveChange()));

		// Keep the unlocked-map keys (which are file paths) in sync with the vault.
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				const info = this.unlocked.get(oldPath);
				if (info) {
					this.unlocked.delete(oldPath);
					this.unlocked.set(file.path, info);
					void this.persist();
				}
				if (this.lastActiveFile === oldPath) this.lastActiveFile = file.path;
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				if (this.unlocked.delete(file.path)) {
					void this.persist();
					this.updateStatusBar();
				}
			})
		);

		// Best-effort re-lock on app quit (in addition to onunload).
		this.registerEvent(
			// 'quit' is a real workspace event but not in the public typings.
			(this.app.workspace as { on(name: string, cb: () => void): import("obsidian").EventRef }).on(
				"quit",
				() => void this.lockAll(true)
			)
		);
	}

	// ---- settings & persistence ----------------------------------------

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Partial<PersistedData> | LockerSettings | null;
		if (raw && typeof raw === "object" && "settings" in raw && raw.settings) {
			this.settings = Object.assign({}, DEFAULT_SETTINGS, raw.settings);
			this.startupLedger = Array.isArray((raw as PersistedData).ledger)
				? (raw as PersistedData).ledger
				: [];
		} else {
			// Back-compat: older data stored the settings object flat.
			this.settings = Object.assign({}, DEFAULT_SETTINGS, (raw as LockerSettings) ?? {});
			this.startupLedger = [];
		}
	}

	async saveSettings(): Promise<void> {
		await this.persist();
	}

	private async persist(): Promise<void> {
		const data: PersistedData = {
			settings: this.settings,
			ledger: Array.from(this.unlocked.keys()),
		};
		await this.saveData(data);
	}

	// ---- command plumbing ----------------------------------------------

	private commandOnFile(checking: boolean, run: (file: TFile) => Promise<void>): boolean {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") return false;
		if (!checking) void run(file);
		return true;
	}

	private addFileMenuItems(menu: Menu, file: TFile): void {
		menu.addItem((item) =>
			item
				.setTitle("Locker: lock note")
				.setIcon("lock")
				.onClick(() => this.lockNote(file, "vault"))
		);
		menu.addItem((item) =>
			item
				.setTitle("Locker: unlock note")
				.setIcon("unlock")
				.onClick(() => this.unlockNote(file))
		);
	}

	private addFolderMenuItems(menu: Menu, folder: TFolder): void {
		menu.addItem((item) =>
			item
				.setTitle("Locker: lock all notes in folder")
				.setIcon("lock")
				.onClick(() => this.lockFolder(folder))
		);
		menu.addItem((item) =>
			item
				.setTitle("Locker: unlock all notes in folder")
				.setIcon("unlock")
				.onClick(() => this.unlockFolder(folder))
		);
	}

	private async toggleActiveNote(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") {
			new Notice("Locker: open a markdown note first.");
			return;
		}
		const content = await this.readLiveContent(file);
		if (isLocked(content)) {
			await this.unlockNote(file);
		} else {
			await this.lockNote(file, "vault");
		}
	}

	// ---- reading / writing safely --------------------------------------

	/** The MarkdownView currently editing `file`, if any. */
	private findEditorView(file: TFile): MarkdownView | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file && view.file.path === file.path) {
				return view;
			}
		}
		return null;
	}

	/**
	 * Read the note's TRUE current content: the live editor buffer when it's open
	 * (which may contain unsaved keystrokes not yet flushed to disk), otherwise
	 * the file on disk. Reading the buffer is what prevents locking from silently
	 * encrypting away the user's most recent, unsaved edits.
	 */
	private async readLiveContent(file: TFile): Promise<string> {
		const view = this.findEditorView(file);
		if (view) return view.editor.getValue();
		return this.app.vault.read(file);
	}

	/**
	 * Write `next` to `file`, but only if its content still equals `expected`
	 * (i.e. nothing changed during the slow crypto step). Returns false without
	 * writing if it changed, so the caller can abort instead of clobbering.
	 *
	 *  - Open in an editor: verify the buffer is unchanged, then drive the write
	 *    through the editor so its in-memory buffer can't later re-flush stale
	 *    content over what we wrote.
	 *  - Not open: use the atomic vault.process() read-modify-write.
	 */
	private async writeContent(file: TFile, expected: string, next: string): Promise<boolean> {
		const view = this.findEditorView(file);
		if (view) {
			if (view.editor.getValue() !== expected) return false;
			view.editor.setValue(next);
			await this.app.vault.modify(file, next);
			return true;
		}
		let aborted = false;
		await this.app.vault.process(file, (current) => {
			if (current !== expected) {
				aborted = true;
				return current; // no-op write
			}
			return next;
		});
		return !aborted;
	}

	/**
	 * Run `fn` while holding an exclusive in-flight lock on `path` (no-ops if busy).
	 * Also a backstop catch so the many `void`-dispatched call sites (commands,
	 * ribbon, events) can never surface an unhandled promise rejection.
	 */
	private async withFileLock(path: string, fn: () => Promise<void>): Promise<void> {
		if (this.inFlight.has(path)) return;
		this.inFlight.add(path);
		try {
			await fn();
		} catch (e) {
			console.error("Locker: operation failed", e);
			new Notice("Locker: operation failed. See console for details.");
		} finally {
			this.inFlight.delete(path);
		}
	}

	// ---- lock / unlock --------------------------------------------------

	async lockNote(file: TFile, scope: LockerScope): Promise<void> {
		await this.withFileLock(file.path, async () => {
			if (isLocked(await this.readLiveContent(file))) {
				new Notice("Locker: that note is already locked.");
				return;
			}

			const password =
				scope === "note"
					? await this.promptPassword({
							title: "Lock note with a separate password",
							description: `"${file.basename}" will need this exact password to unlock. There is no recovery.`,
							confirm: true,
							cta: "Lock",
						})
					: await this.ensureVaultPassword(true);
			if (!password) return;

			// Re-read AFTER the prompt so we encrypt the freshest content.
			const content = await this.readLiveContent(file);
			try {
				const payload = await this.seal(content, password, scope, this.settings.iterations);
				const written = await this.writeContent(file, content, buildLockedNote(payload));
				if (!written) {
					new Notice(`Locker: "${file.basename}" changed while locking — left unlocked.`);
					return;
				}
				this.unlocked.delete(file.path);
				await this.persist();
				this.updateStatusBar();
				new Notice(`Locker: locked "${file.basename}".`);
			} catch (e) {
				if (e instanceof SelfCheckError) {
					console.error("Locker: encryption self-check failed", e);
					new Notice("Locker: encryption self-check failed — note left unlocked to avoid data loss.");
				} else {
					console.error("Locker: failed to lock note", e);
					new Notice("Locker: failed to lock note. See console for details.");
				}
			}
		});
	}

	async unlockNote(file: TFile): Promise<void> {
		await this.withFileLock(file.path, async () => {
			const content = await this.readLiveContent(file);
			const payload = parseLockedNote(content);
			if (!payload || !isLocked(content)) {
				new Notice("Locker: that note isn't locked.");
				return;
			}

			const scope = payload.scope ?? readScope(content);
			const password =
				scope === "note"
					? await this.promptPassword({
							title: "Unlock note",
							description: `Enter the password for "${file.basename}".`,
							cta: "Unlock",
						})
					: await this.ensureVaultPassword(false);
			if (!password) return;

			try {
				const plaintext = await decryptContent(payload, password);
				const written = await this.writeContent(file, content, plaintext);
				if (!written) {
					new Notice(`Locker: "${file.basename}" changed while unlocking — try again.`);
					return;
				}
				this.unlocked.set(file.path, {
					password,
					scope,
					iterations: payload.iterations,
					lastTouched: this.now(),
				});
				if (scope === "vault") this.cacheVaultPassword(password);
				await this.persist();
				this.updateStatusBar();
				new Notice(`Locker: unlocked "${file.basename}".`);
			} catch (e) {
				if (e instanceof DecryptError) {
					new Notice("Locker: incorrect password.");
					if (scope === "vault") this.forgetVaultPassword(true);
				} else {
					console.error("Locker: failed to unlock note", e);
					new Notice("Locker: failed to unlock note. See console for details.");
				}
			}
		});
	}

	/** Re-encrypt a note that was previously unlocked, using its stored password. */
	private async relock(path: string): Promise<void> {
		await this.withFileLock(path, async () => {
			const info = this.unlocked.get(path);
			if (!info) return;

			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) {
				this.unlocked.delete(path);
				await this.persist();
				this.updateStatusBar();
				return;
			}

			const content = await this.readLiveContent(file);
			if (isLocked(content)) {
				this.unlocked.delete(path);
				await this.persist();
				this.updateStatusBar();
				return; // already locked (e.g. user locked it manually)
			}

			// For vault-scoped notes prefer the CURRENT cached vault password, so an
			// auto-lock always matches the user's live vault password rather than a
			// stale snapshot captured at unlock time.
			const password =
				info.scope === "vault" ? this.vaultPassword ?? info.password : info.password;

			try {
				const payload = await this.seal(content, password, info.scope, info.iterations);
				const written = await this.writeContent(file, content, buildLockedNote(payload));
				if (!written) {
					new Notice(`Locker: "${file.basename}" changed while locking — left unlocked, will retry.`);
					return;
				}
				this.unlocked.delete(path);
				await this.persist();
			} catch (e) {
				console.error("Locker: failed to auto-lock note", e);
				new Notice(`Locker: could not auto-lock "${file.basename}" — it remains unlocked. See console.`);
			} finally {
				this.updateStatusBar();
			}
		});
	}

	async lockAll(silent = false): Promise<void> {
		const paths = Array.from(this.unlocked.keys());
		for (const path of paths) {
			await this.relock(path);
		}
		if (!silent) {
			new Notice(
				paths.length ? `Locker: locked ${paths.length} note(s).` : "Locker: nothing to lock."
			);
		}
	}

	// ---- bulk / folder operations --------------------------------------

	/** All markdown notes at or under `folder` (recursive). */
	private notesInFolder(folder: TFolder): TFile[] {
		const prefix = folder.isRoot() ? "" : folder.path + "/";
		return this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(prefix));
	}

	/** Lock every currently-unlocked note in a folder with the vault password. */
	async lockFolder(folder: TFolder): Promise<void> {
		const targets: TFile[] = [];
		for (const file of this.notesInFolder(folder)) {
			try {
				if (!isLocked(await this.readLiveContent(file))) targets.push(file);
			} catch (e) {
				console.error("Locker: could not read note for bulk lock", file.path, e);
			}
		}
		if (targets.length === 0) {
			new Notice("Locker: no unlocked notes to lock here.");
			return;
		}

		const password = await this.ensureVaultPassword(true);
		if (!password) return;

		const progress = new Notice(`Locker: locking ${targets.length} note(s)…`, 0);
		let locked = 0;
		let failed = 0;
		for (const file of targets) {
			await this.withFileLock(file.path, async () => {
				const content = await this.readLiveContent(file);
				if (isLocked(content)) return;
				try {
					const payload = await this.seal(content, password, "vault", this.settings.iterations);
					if (await this.writeContent(file, content, buildLockedNote(payload))) {
						this.unlocked.delete(file.path);
						locked++;
					} else {
						failed++;
					}
				} catch (e) {
					console.error("Locker: failed to lock note in bulk", file.path, e);
					failed++;
				}
			});
		}
		await this.persist();
		this.updateStatusBar();
		progress.hide();
		new Notice(`Locker: locked ${locked} note(s)${failed ? `, ${failed} failed` : ""}.`);
	}

	/**
	 * Unlock every vault-password note in a folder. Notes that use their own
	 * separate password are reported and skipped (unlock those individually).
	 */
	async unlockFolder(folder: TFolder): Promise<void> {
		const targets: TFile[] = [];
		let perNote = 0;
		for (const file of this.notesInFolder(folder)) {
			try {
				const content = await this.readLiveContent(file);
				const payload = parseLockedNote(content);
				if (!payload || !isLocked(content)) continue;
				if ((payload.scope ?? readScope(content)) === "note") perNote++;
				else targets.push(file);
			} catch (e) {
				console.error("Locker: could not read note for bulk unlock", file.path, e);
			}
		}
		if (targets.length === 0) {
			new Notice(
				perNote > 0
					? `Locker: ${perNote} note(s) here use a separate password — unlock them individually.`
					: "Locker: no vault-password notes to unlock here."
			);
			return;
		}

		const password = await this.ensureVaultPassword(false);
		if (!password) return;

		const progress = new Notice(`Locker: unlocking ${targets.length} note(s)…`, 0);
		let unlockedCount = 0;
		let failed = 0;
		for (const file of targets) {
			await this.withFileLock(file.path, async () => {
				const content = await this.readLiveContent(file);
				const payload = parseLockedNote(content);
				if (!payload) return;
				try {
					const plaintext = await decryptContent(payload, password);
					if (await this.writeContent(file, content, plaintext)) {
						this.unlocked.set(file.path, {
							password,
							scope: "vault",
							iterations: payload.iterations,
							lastTouched: this.now(),
						});
						unlockedCount++;
					} else {
						failed++;
					}
				} catch (e) {
					if (e instanceof DecryptError) failed++;
					else {
						console.error("Locker: failed to unlock note in bulk", file.path, e);
						failed++;
					}
				}
			});
		}
		if (unlockedCount > 0) this.cacheVaultPassword(password);
		else if (failed === targets.length) this.forgetVaultPassword(true); // wrong password
		await this.persist();
		this.updateStatusBar();
		progress.hide();
		new Notice(
			`Locker: unlocked ${unlockedCount} note(s)` +
				(failed ? `, ${failed} failed` : "") +
				(perNote ? `; ${perNote} use a separate password (unlock individually)` : "") +
				"."
		);
	}

	/**
	 * Encrypt content into a payload. When the verify setting is on, the result
	 * is round-trip checked so callers can safely overwrite the plaintext.
	 */
	private seal(
		plaintext: string,
		password: string,
		scope: LockerScope,
		iterations: number
	): Promise<LockerPayload> {
		if (this.settings.verifyOnLock) {
			return encryptContentVerified(plaintext, password, scope, iterations);
		}
		return encryptContent(plaintext, password, scope, iterations);
	}

	private updateStatusBar(): void {
		if (!this.statusBarEl) return;
		const count = this.unlocked.size;
		this.statusBarEl.empty();
		const icon = this.statusBarEl.createSpan({ cls: "locker-status-icon" });
		setIcon(icon, count > 0 ? "unlock" : "lock");
		this.statusBarEl.createSpan({
			cls: "locker-status-text",
			text: count > 0 ? `${count} unlocked` : "Locked",
		});
		this.statusBarEl.toggleClass("locker-status-warn", count > 0);
		this.statusBarEl.setAttribute(
			"aria-label",
			count > 0
				? `Locker: ${count} note(s) unlocked (plaintext on disk) — click to lock all`
				: "Locker: no notes are unlocked"
		);
	}

	// ---- crash recovery -------------------------------------------------

	/** After load, find notes the ledger says were unlocked but are still plaintext. */
	private async recoverExposedNotes(): Promise<void> {
		const exposed: TFile[] = [];
		for (const path of this.startupLedger) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile && file.extension === "md") {
				try {
					if (!isLocked(await this.app.vault.read(file))) exposed.push(file);
				} catch {
					/* unreadable; skip */
				}
			}
		}
		this.exposed = exposed;
		// Clear the stale on-disk ledger now that we've captured it (unlocked is empty
		// at startup, so this writes an empty ledger).
		await this.persist();
		if (exposed.length > 0) {
			new Notice(
				`Locker: ${exposed.length} note(s) may have been left unlocked after an unclean shutdown. ` +
					`Run "Locker: secure notes left exposed" to re-encrypt them.`,
				12000
			);
		}
	}

	private async secureExposed(): Promise<void> {
		const password = await this.ensureVaultPassword(true);
		if (!password) return;
		let secured = 0;
		for (const file of this.exposed.slice()) {
			await this.withFileLock(file.path, async () => {
				const content = await this.readLiveContent(file);
				if (isLocked(content)) return;
				try {
					const payload = await this.seal(content, password, "vault", this.settings.iterations);
					if (await this.writeContent(file, content, buildLockedNote(payload))) secured++;
				} catch (e) {
					console.error("Locker: failed to secure exposed note", e);
				}
			});
		}
		this.exposed = [];
		new Notice(`Locker: secured ${secured} note(s) with the vault password.`);
	}

	// ---- vault password session ----------------------------------------

	/** Indirection point so tests can supply passwords without UI. */
	protected promptPassword(opts: PasswordPromptOptions): Promise<string | null> {
		return new PasswordModal(this.app, opts).open();
	}

	private async ensureVaultPassword(confirm: boolean): Promise<string | null> {
		if (this.vaultPassword) {
			this.vaultPasswordSetAt = this.now();
			return this.vaultPassword;
		}
		const password = await this.promptPassword({
			title: confirm ? "Set vault password" : "Enter vault password",
			description: confirm
				? "This password unlocks every note locked with the vault default. It is kept in memory only for this session and never written to disk."
				: "Enter your vault password to unlock this note.",
			confirm,
			cta: confirm ? "Lock" : "Unlock",
		});
		if (password) this.cacheVaultPassword(password);
		return password;
	}

	private cacheVaultPassword(password: string): void {
		this.vaultPassword = password;
		this.vaultPasswordSetAt = this.now();
	}

	forgetVaultPassword(silent = false): void {
		this.vaultPassword = null;
		this.vaultPasswordSetAt = 0;
		if (!silent) new Notice("Locker: forgot the cached vault password.");
	}

	// ---- events & timers ------------------------------------------------

	private handleActiveChange(): void {
		const current = this.app.workspace.getActiveFile()?.path ?? null;
		const previous = this.lastActiveFile;
		this.lastActiveFile = current;
		if (!this.settings.autoLockOnClose) return;
		if (previous && previous !== current && this.unlocked.has(previous)) {
			void this.relock(previous);
		}
	}

	private async sweep(): Promise<void> {
		const now = this.now();

		if (this.settings.autoLockMinutes > 0) {
			const maxAge = this.settings.autoLockMinutes * 60 * 1000;
			const active = this.app.workspace.getActiveFile()?.path ?? null;
			// Snapshot keys: relock() mutates the map mid-iteration.
			for (const path of Array.from(this.unlocked.keys())) {
				const info = this.unlocked.get(path);
				if (!info) continue;
				if (path === active) {
					info.lastTouched = now; // keep refreshing the note in view
					continue;
				}
				if (now - info.lastTouched >= maxAge) {
					await this.relock(path);
				}
			}
		}

		if (
			this.settings.forgetPasswordMinutes > 0 &&
			this.vaultPassword &&
			now - this.vaultPasswordSetAt >= this.settings.forgetPasswordMinutes * 60 * 1000
		) {
			this.forgetVaultPassword(true);
		}
	}

	private now(): number {
		return Date.now();
	}
}
