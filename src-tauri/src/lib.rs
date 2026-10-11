use serde::{Deserialize, Serialize};
use std::{fs, io::{Read, Write}, path::{Component, Path, PathBuf}, process::{Command, Output, Stdio}, sync::Mutex, thread, time::{Duration, Instant}};
use tauri::{Manager, State};

const REVIEW_COMMAND_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_REVIEW_PROMPT_BYTES: usize = 1_000_000;

fn read_bounded(mut reader: impl Read, limit: usize) -> Result<Vec<u8>, String> {
    let mut result = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let count = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 { break; }
        let remaining = limit.saturating_sub(result.len());
        result.extend_from_slice(&buffer[..count.min(remaining)]);
    }
    Ok(result)
}

#[derive(Default)]
struct AppState { root: Mutex<Option<PathBuf>>, job: Mutex<Job>, comments_lock: Mutex<()> }
#[derive(Default, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Job { running: bool, message: String, output: String, workspace_root: Option<String> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Workspace { root: String, branch: String, files: Vec<String>, changes: Vec<Change>, comments: Vec<ReviewComment> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Change { path: String, index: String, worktree: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileData { path: String, content: String, lines: usize }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewComment { id: String, path: String, line: usize, side: String, body: String, created_at: String, sent: bool, #[serde(default)] anchor: Option<String> }

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git").args(args).current_dir(root).output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok(String::from_utf8_lossy(&out.stdout).into_owned()) }
    else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}
fn execute_with_timeout(mut command: Command, input: Option<Vec<u8>>) -> Result<Output, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() });
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("Missing CLI stdout")?;
    let stderr = child.stderr.take().ok_or("Missing CLI stderr")?;
    let stdout_reader = thread::spawn(move || read_bounded(stdout, 10_000_000));
    let stderr_reader = thread::spawn(move || read_bounded(stderr, 1_000_000));
    let stdin_writer = input.map(|bytes| {
        let mut stdin = child.stdin.take().expect("piped stdin configured for input");
        thread::spawn(move || stdin.write_all(&bytes).map_err(|e| e.to_string()))
    });
    let deadline = Instant::now() + REVIEW_COMMAND_TIMEOUT;
    let (status, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (status, false),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                let _ = child.kill();
                break (child.wait().map_err(|e| e.to_string())?, true);
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.to_string());
            }
        }
    };
    let stdout = stdout_reader.join().map_err(|_| "CLI stdout reader failed")??;
    let stderr = stderr_reader.join().map_err(|_| "CLI stderr reader failed")??;
    if let Some(writer) = stdin_writer {
        writer.join().map_err(|_| "CLI stdin writer failed")??;
    }
    if timed_out { return Err("AI command timed out after 10 minutes".into()); }
    Ok(Output { status, stdout, stderr })
}
fn root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    state.root.lock().map_err(|e| e.to_string())?.clone().ok_or("Open a Git repository first".to_string())
}
fn validate_relative_path(rel: &str) -> Result<(), String> {
    let path = Path::new(rel);
    if rel.is_empty() || path.components().any(|c| !matches!(c, Component::Normal(_)))
        || path.components().any(|c| c.as_os_str() == ".git")
    {
        return Err("Invalid repository path".into());
    }
    Ok(())
}
fn safe_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    validate_relative_path(rel)?;
    let candidate = root.join(rel);
    let path = candidate.canonicalize().map_err(|e| e.to_string())?;
    if !path.starts_with(root) || !path.is_file()
        || path.components().any(|c| c.as_os_str() == ".git")
    { return Err("File is outside the workspace".into()); }
    Ok(path)
}
fn valid_repo_path(root: &Path, rel: &str) -> Result<(), String> {
    validate_relative_path(rel)?;
    if root.join(rel).exists() { safe_path(root, rel)?; return Ok(()); }
    git(root, &["--literal-pathspecs", "ls-files", "--error-unmatch", "--", rel]).map(|_| ())
}
fn review_path(root: &Path) -> Result<PathBuf, String> {
    let path = git(root, &["rev-parse", "--git-path", "read-the-code/reviews.json"])?;
    let path = PathBuf::from(path.trim());
    Ok(if path.is_absolute() { path } else { root.join(path) })
}
fn load_comments(root: &Path) -> Result<Vec<ReviewComment>, String> {
    let path = review_path(root)?;
    if !path.exists() { return Ok(vec![]); }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
fn save_comments(root: &Path, comments: &[ReviewComment]) -> Result<(), String> {
    let path = review_path(root)?;
    fs::create_dir_all(path.parent().ok_or("Invalid review path")?).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, serde_json::to_vec_pretty(comments).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(temp, path).map_err(|e| e.to_string())
}
fn snapshot(root: &Path) -> Result<Workspace, String> {
    let mut files = vec![];
    let walker = ignore::WalkBuilder::new(root).hidden(false).git_ignore(true).build();
    for entry in walker.flatten() {
        if entry.file_type().is_some_and(|t| t.is_file()) {
            if let Ok(rel) = entry.path().strip_prefix(root) {
                if !rel.components().any(|c| c.as_os_str() == ".git") { files.push(rel.to_string_lossy().into_owned()); }
            }
        }
    }
    files.sort();
    let raw = Command::new("git").args(["status", "--porcelain=v1", "-z", "--untracked-files=all"]).current_dir(root).output().map_err(|e| e.to_string())?;
    if !raw.status.success() { return Err(String::from_utf8_lossy(&raw.stderr).into_owned()); }
    let mut changes = vec![];
    let mut parts = raw.stdout.split(|b| *b == 0).filter(|p| !p.is_empty());
    while let Some(part) = parts.next() {
        if part.len() < 4 { continue; }
        let index = part[0] as char;
        let worktree = part[1] as char;
        let path = String::from_utf8_lossy(&part[3..]).into_owned();
        if index == 'R' || index == 'C' { parts.next(); }
        changes.push(Change { path, index: index.to_string(), worktree: worktree.to_string() });
    }
    Ok(Workspace { root: root.to_string_lossy().into_owned(), branch: git(root, &["branch", "--show-current"]).unwrap_or_default().trim().to_string(), files, changes, comments: load_comments(root)? })
}
#[tauri::command]
fn open_workspace(path: String, state: State<'_, AppState>) -> Result<Workspace, String> {
    let path = PathBuf::from(path).canonicalize().map_err(|e| e.to_string())?;
    if !path.is_dir() { return Err("Choose a folder".into()); }
    git(&path, &["rev-parse", "--show-toplevel"])?;
    *state.root.lock().map_err(|e| e.to_string())? = Some(path.clone());
    snapshot(&path)
}
#[tauri::command]
fn refresh_workspace(state: State<'_, AppState>) -> Result<Workspace, String> { snapshot(&root(&state)?) }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchHit { path: String, line: usize, text: String }
#[tauri::command]
fn search_content(query: String, state: State<'_, AppState>) -> Result<Vec<SearchHit>, String> {
    let root = root(&state)?;
    let needle = query.trim().to_lowercase();
    if needle.len() < 2 { return Ok(vec![]); }
    let mut hits = vec![];
    for entry in ignore::WalkBuilder::new(&root).hidden(false).git_ignore(true).build().flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) { continue; }
        let path = entry.path();
        if path.components().any(|c| c.as_os_str() == ".git") { continue; }
        if fs::metadata(path).is_ok_and(|m| m.len() > 1_000_000) { continue; }
        let Ok(contents) = fs::read_to_string(path) else { continue; };
        let rel = path.strip_prefix(&root).unwrap().to_string_lossy().into_owned();
        for (idx, line) in contents.lines().enumerate() {
            if line.to_lowercase().contains(&needle) {
                hits.push(SearchHit { path: rel.clone(), line: idx + 1, text: line.trim().chars().take(200).collect() });
                if hits.len() >= 100 { return Ok(hits); }
            }
        }
    }
    Ok(hits)
}
#[tauri::command]
fn read_file(path: String, state: State<'_, AppState>) -> Result<FileData, String> {
    let root = root(&state)?;
    let path_on_disk = safe_path(&root, &path)?;
    if fs::metadata(&path_on_disk).map_err(|e| e.to_string())?.len() > 3_000_000 { return Err("File is over 3 MB".into()); }
    let data = fs::read(path_on_disk).map_err(|e| e.to_string())?;
    if data.contains(&0) { return Err("Binary files cannot be displayed".into()); }
    let content = String::from_utf8(data).map_err(|_| "File is not UTF-8".to_string())?;
    let lines = content.lines().count().max(1);
    Ok(FileData { path, content, lines })
}
#[tauri::command]
fn read_diff(path: String, staged: bool, state: State<'_, AppState>) -> Result<String, String> {
    let root = root(&state)?;
    valid_repo_path(&root, &path)?;
    let mut args = vec!["--literal-pathspecs", "diff", "--no-ext-diff", "--no-color"];
    if staged { args.push("--cached"); }
    args.extend(["--", &path]);
    let diff = git(&root, &args)?;
    if !diff.is_empty() || staged { return Ok(diff); }
    // An untracked file has no regular git diff. Build a normal unified diff without a shell.
    let tracked = git(&root, &["--literal-pathspecs", "ls-files", "--error-unmatch", "--", &path]).is_ok();
    if tracked { return Ok(diff); }
    let null_device = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let out = Command::new("git").args(["diff", "--no-index", "--no-color", "--", null_device, &path]).current_dir(&root).output().map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}
#[tauri::command]
fn stage_file(path: String, stage: bool, state: State<'_, AppState>) -> Result<Workspace, String> {
    let root = root(&state)?;
    valid_repo_path(&root, &path)?;
    if stage { git(&root, &["--literal-pathspecs", "add", "--", &path])?; }
    else { git(&root, &["--literal-pathspecs", "restore", "--staged", "--", &path])?; }
    snapshot(&root)
}
#[tauri::command]
fn add_comment(path: String, line: usize, side: String, body: String, anchor: Option<String>, state: State<'_, AppState>) -> Result<Vec<ReviewComment>, String> {
    let root = root(&state)?;
    let _guard = state.comments_lock.lock().map_err(|e| e.to_string())?;
    valid_repo_path(&root, &path)?;
    if line == 0 || body.trim().is_empty() || body.len() > 20_000 { return Err("Add a comment of at most 20,000 characters on a line".into()); }
    if side != "file" && side != "new" && side != "old" { return Err("Invalid diff side".into()); }
    let mut comments = load_comments(&root)?;
    comments.push(ReviewComment { id: format!("{}-{}", chrono::Utc::now().timestamp_millis(), comments.len()), path, line, side, body: body.trim().to_string(), created_at: chrono::Utc::now().to_rfc3339(), sent: false, anchor: anchor.map(|value| value.chars().take(400).collect()).filter(|value: &String| !value.is_empty()) });
    save_comments(&root, &comments)?;
    Ok(comments)
}
#[tauri::command]
fn delete_comment(id: String, state: State<'_, AppState>) -> Result<Vec<ReviewComment>, String> {
    let root = root(&state)?;
    let _guard = state.comments_lock.lock().map_err(|e| e.to_string())?;
    let mut comments = load_comments(&root)?;
    comments.retain(|c| c.id != id || c.sent);
    save_comments(&root, &comments)?;
    Ok(comments)
}
#[tauri::command]
fn job_status(state: State<'_, AppState>) -> Result<Job, String> { Ok(state.job.lock().map_err(|e| e.to_string())?.clone()) }
#[tauri::command]
fn send_review(provider: String, session_id: String, executable: Option<String>, state: State<'_, AppState>, app: tauri::AppHandle) -> Result<(), String> {
    let root = root(&state)?;
    if provider != "codex" && provider != "codex-app" && provider != "claude" { return Err("Choose Codex app, Codex CLI, or Claude Code".into()); }
    if session_id.trim().is_empty() { return Err("Enter the session ID".into()); }
    let pending: Vec<_> = {
        let _guard = state.comments_lock.lock().map_err(|e| e.to_string())?;
        load_comments(&root)?.into_iter().filter(|c| !c.sent).collect()
    };
    if pending.is_empty() { return Err("There are no unsent comments".into()); }
    let workspace_root = root.to_string_lossy().into_owned();
    let prompt = format!("Please address this batch of local code review comments in the current repository. Inspect the referenced code and diffs, verify each line against the included excerpt because code may have moved, make the requested changes, and summarize what you changed. Comments:\n\n{}", pending.iter().enumerate().map(|(i,c)| format!("{}. {}:{} [{}]{}\n{}", i+1, c.path, c.line, c.side, c.anchor.as_deref().map(|a| format!("\nCode at review time: {a}")).unwrap_or_default(), c.body)).collect::<Vec<_>>().join("\n\n"));
    if prompt.len() > MAX_REVIEW_PROMPT_BYTES { return Err("Review batch is over 1 MB; split it into smaller batches".into()); }
    {
        let mut job = state.job.lock().map_err(|e| e.to_string())?;
        if job.running { return Err("A review is already running".into()); }
        *job = Job { running: true, message: "Sending review to AI session…".into(), output: String::new(), workspace_root: Some(workspace_root) };
    }
    std::thread::spawn(move || {
        let result = (|| -> Result<String, String> {
            let bundled_codex = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
            let program = executable.as_deref().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| {
                if provider.starts_with("codex")
                    && Path::new(bundled_codex).exists()
                    && !Command::new("codex").arg("--version").output().is_ok_and(|o| o.status.success())
                { bundled_codex } else if provider.starts_with("codex") { "codex" } else { "claude" }
            });
            if provider == "codex-app" {
                let mut command = Command::new(program);
                command.args(["queue", "--thread", &session_id, "--message", &prompt]).current_dir(&root);
                let out = execute_with_timeout(command, None).map_err(|e| format!("Could not run Codex CLI: {e}"))?;
                let output = String::from_utf8_lossy(&out.stdout).into_owned();
                if !out.status.success() { return Err(format!("{output}\n{}", String::from_utf8_lossy(&out.stderr))); }
                return Ok(output);
            }
            let mut cmd = if provider == "codex" {
                let mut c = Command::new(program); c.args(["exec", "resume", &session_id, "-"]); c
            } else {
                let mut c = Command::new(program); c.args(["--print", "--resume", &session_id]); c
            };
            cmd.current_dir(&root);
            let out = execute_with_timeout(cmd, Some(prompt.into_bytes())).map_err(|e| format!("Could not run {provider} CLI: {e}"))?;
            let output = String::from_utf8_lossy(&out.stdout).into_owned();
            if !out.status.success() { return Err(format!("{output}\n{}", String::from_utf8_lossy(&out.stderr))); }
            Ok(output)
        })();
        let state = app.state::<AppState>();
        if let Ok(mut job) = state.job.lock() {
            job.running = false;
            match result {
                Ok(output) => {
                    let save_result = (|| {
                        let _guard = state.comments_lock.lock().map_err(|e| e.to_string())?;
                        let mut current = load_comments(&root)?;
                        for comment in &mut current { if pending.iter().any(|p| p.id == comment.id) { comment.sent = true; } }
                        save_comments(&root, &current)
                    })();
                    match save_result {
                        Ok(()) => { job.message = if provider == "codex-app" { format!("Queued {} comments in Codex app", pending.len()) } else { format!("Sent {} comments to {provider}", pending.len()) }; job.output = output; }
                        Err(e) => { job.message = format!("AI replied, but saving sent status failed: {e}"); job.output = output; }
                    }
                }
                Err(e) => { job.message = format!("Review failed: {e}"); job.output = String::new(); }
            }
        };
    });
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![open_workspace, refresh_workspace, search_content, read_file, read_diff, stage_file, add_comment, delete_comment, job_status, send_review])
        .run(tauri::generate_context!())
        .expect("error while running Read the Code");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repository_review_survives_refresh_and_tracks_changes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init"]).unwrap();
        fs::write(root.join("hello.rs"), "fn main() {}\n").unwrap();
        let snapshot = snapshot(root).unwrap();
        assert!(snapshot.files.contains(&"hello.rs".to_string()));
        assert_eq!(snapshot.changes[0].path, "hello.rs");
        assert_eq!(snapshot.changes[0].index, "?");
        let comments = vec![ReviewComment { id:"one".into(), path:"hello.rs".into(), line:1, side:"file".into(), body:"Check this".into(), created_at:"now".into(), sent:false, anchor:None }];
        save_comments(root, &comments).unwrap();
        assert_eq!(load_comments(root).unwrap()[0].body, "Check this");
        assert!(!root.join("read-the-code").exists());
    }
    #[test]
    fn paths_cannot_escape_repository() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init"]).unwrap();
        assert!(valid_repo_path(dir.path(), "../outside").is_err());
        assert!(valid_repo_path(dir.path(), "/etc/passwd").is_err());
    }
}
