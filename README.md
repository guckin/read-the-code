# Read the Code

A small Rust/Tauri desktop app for reading AI-generated code and Markdown before committing. The interface is intentionally read-only: edits stay with your coding agent. You can inspect Git changes, stage or unstage files, and queue line comments locally before sending one review batch.

[Download the macOS Apple Silicon app](https://github.com/guckin/read-the-code/releases/latest)

## Run

```sh
npm install
npm run tauri -- dev
```

To build a macOS app bundle:

```sh
npm run tauri -- build
```

The app requires Rust, Node.js, and Git. AI delivery requires the corresponding `codex` or `claude` CLI installed and authenticated. The app uses the CLI on its PATH, or an absolute executable path entered in the Send dialog. On macOS it also detects the Codex CLI bundled with ChatGPT when the PATH version is missing or broken.

## Review flow

1. Open a Git repository.
2. Choose a file or a changed file. Switch among source, Markdown preview, working diff, and staged diff.
3. Click a source or diff line, then **+ Comment**. Comments are saved under the repository's private Git directory at `read-the-code/reviews.json`; they never become part of a commit.
4. Add as many comments as needed. Review them in the **Review** sidebar.
5. Click **Send review** and choose a destination. For an open Codex desktop chat, choose **Codex app chat** and paste its chat ID. The app uses `codex queue` to place all pending comments into that chat as one message. For Codex CLI or Claude Code, paste the CLI session ID; the app resumes that session in the repository. Comments are marked sent after the destination accepts the batch. Failed delivery leaves them queued.
6. Refresh Git status after the agent makes changes, then review the next diff.

The Codex app option queues a message into the selected desktop chat; the agent's response appears in that chat. The Codex CLI and Claude Code options run the agent and show its response in the Review sidebar. Keep the target chat or CLI session attached to the repository you are reviewing.

## Release

From a clean, pushed `main` branch on macOS, bump the version in both `package.json` and `src-tauri/tauri.conf.json`, then run:

```sh
npm run release:macos
```

The script builds the app and DMG in a local cache, verifies the app signature in the mounted DMG, tags the current commit, and uploads the DMG to GitHub Releases under a stable asset name.

The macOS build uses an ad hoc signature because no Apple Developer signing identity is configured. It is not notarized. See [Apple's guidance](https://support.apple.com/en-us/102445) for opening an app from a source you trust.

## Navigation

| Shortcut | Action |
| --- | --- |
| Shift Shift | Search Everywhere |
| `#` in Search Everywhere | Search file content |
| Cmd+Shift+O | Open repository |
| Cmd+F | Find in current file |
| Cmd+L | Toggle file tree |
| Ctrl+Tab / Ctrl+Shift+Tab | Switch open files |
| Cmd+Option+Left / Right | Back / forward |
| F12 with selected text | Search selected text in the repository |
| Cmd+W | Close file |
| Cmd+/ | Shortcut list |

On Windows and Linux, Cmd shortcuts use Ctrl. Navigation defaults follow Pawnk's keymap, implemented independently of its architecture. This is a reader, so editing, rename, autocomplete, Git push, and commit controls are intentionally outside its scope.
