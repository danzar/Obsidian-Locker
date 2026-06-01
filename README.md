# Lockbox

Encrypt a note's **contents** while keeping its **title visible**. Locked notes
stay as ordinary `.md` files — they show up in the file explorer, graph, and
links by name — but their body is sealed with authenticated encryption until you
unlock them with a password.

## Features

- 🔒 **Lock / unlock individual notes** via commands, the ribbon icon, or the
  file context menu.
- 🗝️ **Two key models:**
  - **Vault password** — one password (cached in memory for the session)
    unlocks every note locked with the vault default.
  - **Per-note password** — lock a sensitive note with its own password.
- 🧮 **Strong crypto** — PBKDF2 (SHA-256, 310k iterations by default) derives an
  AES-GCM-256 key. Each note gets a fresh random salt and IV, and GCM
  authentication means a wrong password fails cleanly instead of returning
  garbage.
- ⏱️ **Auto-lock** — re-encrypt a note when you navigate away, after an
  inactivity timeout, and on Obsidian quit. The cached vault password expires
  after a configurable interval.
- ✅ **Encryption self-check** — before a note's plaintext is overwritten, the
  freshly-made ciphertext is decrypted and compared to the original. If it
  doesn't match, the lock is aborted and the note is left untouched, so a faulty
  lock can never silently destroy content.
- 🟡 **Status-bar indicator** — shows how many notes are currently unlocked
  (i.e. have plaintext on disk). Click it to lock everything at once.
- 💪 **Password-strength hint** — a meter on the lock dialog nudges you away
  from trivial passwords.
- 📄 **Plain `.md` storage** — the encrypted payload lives in a fenced
  ` ```locker ` block, so locked notes still sync, back up, and version like any
  other note.

## Installation

### From the Community Plugins store
Once approved: in Obsidian go to **Settings → Community plugins → Browse**,
search for **Lockbox**, install, then enable it.

### Manual install
Download `main.js`, `manifest.json`, and `styles.css` from the
[latest release](https://github.com/danzar/Obsidian-Locker/releases/latest) and
place them in `<your-vault>/.obsidian/plugins/lockbox/`, then enable
**Lockbox** under Settings → Community plugins.

### Beta testing with BRAT
Track pre-release builds by adding the repo `danzar/Obsidian-Locker` in the
[BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.

## How a locked note looks on disk

````markdown
---
locker: true
locker-scope: vault
---

> [!lock]- 🔒 Encrypted with Lockbox
> This note is locked. Run **Lockbox: Unlock note** (or click the ribbon lock
> icon) to decrypt it.

```locker
{"v":1,"alg":"AES-GCM","kdf":"PBKDF2","hash":"SHA-256","iterations":310000,"salt":"…","iv":"…","ct":"…","scope":"vault"}
```
````

The note's *own* frontmatter and body are encrypted together inside `ct`, so
nothing of the original content leaks — only the filename stays readable.

## ⚠️ Security model — read this

This plugin gives you **encryption at rest while a note is locked.** Be aware of
the tradeoffs of in-place editing:

- **While a note is unlocked, its plaintext is written to disk** so you can edit
  it as a normal note. Auto-lock-on-close (on by default), the inactivity timer
  (5 min default), and a best-effort lock on quit shrink this window. If the app
  crashes or is force-quit while a note is unlocked, plaintext can remain on
  disk — on the next launch Lockbox detects this from a recovery ledger and
  prompts you to run **Lockbox: Secure notes left exposed**.
- **There is no password recovery.** Forget a password and the note is
  unrecoverable. Keep backups of anything important.
- The vault password is held in memory only and never persisted. It is cleared
  on quit and after the "forget" timeout.
- This is defense against casual/at-rest access (a synced file, a shared
  machine), not a guarantee against a determined attacker with live access to
  your unlocked vault.

### How your edits are protected

The lock/unlock paths are written to avoid the data-loss traps of editing files
that may be open or syncing:

- **Live buffer is the source of truth.** When a note is open, Lockbox reads the
  editor's current contents (including unsaved keystrokes) rather than stale
  disk content, so locking never encrypts away your latest edits.
- **Atomic, checked writes.** Encryption can take a moment; if the file changes
  during that window (you keep typing, or a sync client writes it), Lockbox
  detects the change and aborts rather than overwriting — the note simply stays
  unlocked so you can retry.
- **Self-check before overwrite** (see above) guarantees the ciphertext
  decrypts back to the original before the plaintext is replaced.
- **Rename/delete aware.** Renaming or moving an unlocked note keeps it tracked
  so auto-lock still re-encrypts it at its new path.

## Usage

| Action | How |
|--------|-----|
| Lock the active note with the vault password | Command **Lockbox: Lock note (vault password)** or the ribbon lock icon |
| Lock with a separate password | Command **Lockbox: Lock note with a separate password** |
| Unlock the active note | Command **Lockbox: Unlock note**, ribbon icon, or just run unlock |
| Re-encrypt everything now | Command **Lockbox: Lock all currently-unlocked notes** |
| Lock/unlock a whole folder | Right-click a folder → **Lockbox: lock all notes in folder** / **unlock all notes in folder** |
| Lock/unlock the entire vault | Commands **Lockbox: Lock every note in the vault** / **Unlock every vault-password note in the vault** |
| Clear the cached vault password | Command **Lockbox: Forget vault password (lock session)** |
| Re-secure notes left exposed by a crash | Command **Lockbox: Secure notes left exposed** (only available when needed) |

## Settings

- **Auto-lock on close** — re-encrypt a note when you navigate away (default on).
- **Auto-lock after inactivity** — minutes before an idle unlocked note re-locks
  (`0` = off).
- **Forget vault password after** — minutes the vault password stays cached
  (`0` = until quit).
- **Key derivation iterations** — PBKDF2 iterations for newly locked notes.
- **Verify before overwriting** — round-trip-check each lock before replacing
  the note (default on; roughly doubles lock time).

## Development

```bash
npm install      # install deps
npm run dev      # watch build -> main.js
npm run build    # type-check + production bundle
npm test         # crypto + format round-trip tests
```

### Installing into a vault for testing

Copy `manifest.json`, `main.js`, and `styles.css` into
`<your-vault>/.obsidian/plugins/lockbox/`, then enable **Lockbox** under
Settings → Community plugins. (Re-run `npm run build` to refresh `main.js`.)

## Changelog

### 0.5.2 — bug sweep (mobile, recovery, concurrency, UX)
From a third adversarial review focused on new bugs and gaps:
- **Mobile:** re-lock on app background (`visibilitychange`/`pagehide`) — the only
  reliable re-lock signal on mobile, where quit/`onunload` don't fire and timers
  freeze. Ribbon icon now also indicates unlocked state (the status bar is hidden
  on mobile).
- **Crash recovery:** the ledger now records each note's scope, so "secure notes
  left exposed" re-locks separate-password notes at their own scope (prompting
  for a new password) instead of silently re-keying them to the vault password.
- **Concurrency:** `lock all` backs off during a bulk run; a note open in two
  panes no longer lets a stale buffer clobber the ciphertext; a still-visible
  note isn't prematurely auto-locked; recovery keeps notes it couldn't secure.
- **UX:** reading-view placeholder instead of the raw base64 block; ConfirmModal
  keyboard support (Enter/Escape, Cancel focused); "busy"/"cancelled" feedback;
  clearer non-markdown message; better password-strength scoring; settings revert
  invalid input on blur.

### 0.5.1 — review fixes
- Dropped the `builtin-modules` devDependency in favor of Node's native
  `node:module` `builtinModules` (resolves an Obsidian review warning).

### 0.5.0 — rename to Lockbox + submission prep
- Renamed the plugin to **Lockbox** (id `lockbox`). The previous name/id
  `obsidian-locker` couldn't be used — the community store forbids `obsidian` in
  plugin ids, and `note-locker` / `Note Locker` was already taken. The on-disk
  marker stays `locker` internally for compatibility.
- Added a GitHub Actions release workflow that builds and attaches
  `main.js` / `manifest.json` / `styles.css` on a version tag.
- Installation instructions (store, manual, BRAT).

### 0.4.0 — bulk operations
- **Folder & vault lock/unlock**: right-click a folder, or use the
  Lock/Unlock-vault commands. Built on the same safe-write path (live-buffer
  read, atomic change-checked writes, per-path mutex, self-check).
- Bulk unlock skips per-note-password notes and reports them; a **confirmation
  prompt** guards mass operations.
- Hardened after a second adversarial review: per-note ledger persistence during
  bulk unlock (crash recovery), accurate skipped/changed/failed accounting, no
  spurious password-forgetting, auto-lock backs off during bulk runs, and the
  progress notice always clears.

### 0.3.0 — hardening (data-safety & robustness)
Following an adversarial multi-agent review:
- Read the **live editor buffer** when locking an open note (no more lost
  unsaved edits); **atomic writes** with change-detection abort instead of
  clobbering concurrent/sync edits.
- **Crash-recovery ledger**: detect and re-secure notes left as plaintext after
  an unclean shutdown.
- **Rename/delete handlers** keep unlocked notes tracked and re-lockable.
- CRLF-tolerant, frontmatter-anchored locked-note detection (fixes Windows/sync
  lockouts and false positives).
- Decrypt now validates algorithm/KDF/iteration/salt/IV parameters.
- Per-path concurrency guard; single sweep timer; safer settings validation;
  non-zero inactivity auto-lock default.
- Full orchestration test suite for the lock/unlock/relock lifecycle.

### 0.2.0
Self-check before overwrite, status-bar indicator, password-strength hint.

### 0.1.0
Initial MVP: lock/unlock, vault & per-note passwords, AES-GCM/PBKDF2, settings.

## License

GNU General Public License v3.0 (GPL-3.0-or-later) © 2025 Zarware. See
[`LICENSE`](LICENSE).
