import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import rust from 'highlight.js/lib/languages/rust';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import 'highlight.js/styles/github-dark.css';
import type { AppState } from './types';
import { basename, esc, ext } from './helpers';

for (const [name, grammar] of Object.entries({
  javascript,
  typescript,
  rust,
  json,
  python,
  bash,
  css,
  xml,
})) {
  hljs.registerLanguage(name, grammar);
}

const highlightCache = new Map<string, string>();
const fileTreeCache = new WeakMap<object, { key: string; html: string }>();

export function renderView(state: AppState, findNext: () => void): void {
  const s = state;
  const app = document.querySelector<HTMLDivElement>('#app')!;
  const changed = (path: string) => s.ws?.changes.find((change) => change.path === path);
  const pending = () => s.ws?.comments.filter((comment) => !comment.sent) || [];
  const activeJob = () => (s.job?.workspaceRoot === s.ws?.root ? s.job : null);
  const lang = (path: string) =>
    (
      ({
        ts: 'typescript',
        tsx: 'typescript',
        js: 'javascript',
        jsx: 'javascript',
        rs: 'rust',
        py: 'python',
        json: 'json',
        sh: 'bash',
        css: 'css',
        html: 'xml',
        xml: 'xml',
      }) as Record<string, string>
    )[ext(path)];
  const highlight = (value: string, path: string) => {
    const language = lang(path);
    if (!language) return esc(value);
    const key = `${language}\0${value}`;
    const cached = highlightCache.get(key);
    if (cached !== undefined) {
      highlightCache.delete(key);
      highlightCache.set(key, cached);
      return cached;
    }
    try {
      const result = hljs.highlight(value, { language }).value;
      if (highlightCache.size >= 10_000) highlightCache.delete(highlightCache.keys().next().value!);
      highlightCache.set(key, result);
      return result;
    } catch {
      return esc(value);
    }
  };
  function fileTree() {
    if (!s.ws) return '';
    const q = s.query.toLowerCase();
    const key = `${q}\0${s.active || ''}`;
    const cached = fileTreeCache.get(s.ws);
    if (cached?.key === key) return cached.html;
    let files = s.ws.files.filter((f) => !q || f.toLowerCase().includes(q));
    const html =
      files
        .slice(0, 2500)
        .map(
          (p) =>
            `<button class="tree-item ${p === s.active ? 'active' : ''}" data-open="${esc(p)}" title="${esc(p)}"><span class="file-icon">${ext(p) === 'md' ? '▤' : '◇'}</span><span class="tree-path">${esc(p)}</span>${changed(p) ? '<span class="change-dot"></span>' : ''}</button>`,
        )
        .join('') || '<div class="empty-small">No matching files</div>';
    fileTreeCache.set(s.ws, { key, html });
    return html;
  }
  function changesList() {
    if (!s.ws) return '';
    return (
      s.ws.changes
        .map(
          (c) =>
            `<div class="change-item"><button data-diff="${esc(c.path)}" title="Open diff"><span class="status">${c.index === '?' ? 'U' : c.worktree === 'M' ? 'M' : c.index.trim() || c.worktree.trim()}</span><span class="change-name">${esc(c.path)}</span></button><button class="tiny" data-stage="${esc(c.path)}" title="Stage">${c.index.trim() && c.index !== '?' ? '−' : '+'}</button></div>`,
        )
        .join('') || '<div class="empty-small">Working tree is clean</div>'
    );
  }
  function commentsList() {
    const comments = s.ws?.comments || [];
    return (
      comments
        .map(
          (c) =>
            `<div class="comment-card ${c.sent ? 'sent' : ''}"><div class="comment-meta"><button data-jump="${esc(c.path)}:${c.line}">${esc(c.path)}:${c.line}</button><span>${c.sent ? 'Sent' : 'Queued'}</span></div>${c.anchor ? `<code class="comment-anchor">${esc(c.anchor)}</code>` : ''}<p>${esc(c.body)}</p>${!c.sent ? `<button class="text-button" data-delete="${esc(c.id)}">Remove</button>` : ''}</div>`,
        )
        .join('') || '<div class="empty-small">Select a line to add a review comment.</div>'
    );
  }
  function codeLines(content: string, p: string) {
    return content
      .split('\n')
      .map(
        (line, i) =>
          `<div class="code-row ${s.selectedLine === i + 1 && s.mode === 'file' ? 'selected' : ''}" data-line="${i + 1}" data-side="file"><span class="line-no">${i + 1}</span><code>${highlight(line, p) || ' '}</code></div>`,
      )
      .join('');
  }
  function diffLines(diff: string) {
    let old = 0,
      newline = 0;
    return diff
      .split('\n')
      .map((line) => {
        let cls = 'context',
          side = 'new',
          n = 0;
        if (line.startsWith('@@')) {
          const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
          if (m) {
            old = +m[1];
            newline = +m[2];
          }
          cls = 'hunk';
        } else if (
          line.startsWith('+++') ||
          line.startsWith('---') ||
          line.startsWith('diff ') ||
          line.startsWith('index ')
        ) {
          cls = 'meta';
        } else if (line.startsWith('+')) {
          cls = 'add';
          n = newline++;
        } else if (line.startsWith('-')) {
          cls = 'remove';
          side = 'old';
          n = old++;
        } else {
          n = newline++;
          old++;
        }
        return `<div class="code-row diff-row ${cls} ${s.selectedLine === n && s.selectedSide === side ? 'selected' : ''}" ${n ? `data-line="${n}" data-side="${side}"` : ''}><span class="line-no">${n || ''}</span><code>${esc(line) || ' '}</code></div>`;
      })
      .join('');
  }
  function editor() {
    if (!s.active || !s.file)
      return `<div class="welcome"><div class="welcome-mark">⌘</div><h1>Read the Code</h1><p>Open a repository, navigate the code, inspect changes, and queue review comments for your AI session.</p><button class="primary" data-action="open">Open repository</button><div class="welcome-keys"><span>Shift Shift <b>Search Everywhere</b></span><span>⌘F <b>Find in file</b></span><span>⌃Tab <b>Switch files</b></span></div></div>`;
    const p = s.active;
    let body = '';
    if (s.mode === 'diff') {
      body = s.diff
        ? diffLines(s.diff)
        : '<div class="empty-small">No diff on this side. Try the other diff view.</div>';
    } else if (ext(p) === 'md' && s.preview) {
      body = `<div class="markdown">${DOMPurify.sanitize(marked.parse(s.file.content, { async: false }) as string)}</div>`;
    } else {
      body = `<div class="code">${codeLines(s.file.content, p)}</div>`;
    }
    return `<div class="file-toolbar"><div class="breadcrumbs">${esc(s.ws?.root.split('/').pop() || '')} <span>›</span> ${esc(p)}</div><div class="toolbar-actions"><button class="pill ${s.mode === 'file' && !s.preview ? 'on' : ''}" data-action="file">Source</button>${ext(p) === 'md' ? `<button class="pill ${s.mode === 'file' && s.preview ? 'on' : ''}" data-action="preview">Preview</button>` : ''}<button class="pill ${s.mode === 'diff' && !s.staged ? 'on' : ''}" data-action="diff">Working diff</button><button class="pill ${s.mode === 'diff' && s.staged ? 'on' : ''}" data-action="staged-diff">Staged diff</button><button class="subtle" data-action="comment">+ Comment</button></div></div><div class="editor-scroll" id="editor-scroll">${body}</div><div class="file-footer"><span>${esc(p)}</span><span>${s.mode === 'file' ? `${s.file.lines} lines` : 'Click a changed line to comment'} · UTF-8 · Read only</span></div>`;
  }
  function quick() {
    if (!s.quick) return '';
    const q = s.query.toLowerCase();
    const searching = q.startsWith('#');
    const list =
      s.ws?.files.filter((f) => !searching && f.toLowerCase().includes(q)).slice(0, 40) || [];
    const rows = searching
      ? s.results
          .map(
            (h, i) =>
              `<button class="palette-result ${i === 0 ? 'first' : ''}" data-result="${esc(h.path)}:${h.line}"><span>⌕</span><span>${esc(basename(h.path))}:${h.line}<small>${esc(h.text)}</small></span></button>`,
          )
          .join('')
      : list
          .map(
            (p, i) =>
              `<button class="palette-result ${i === 0 ? 'first' : ''}" data-open="${esc(p)}"><span>◇</span><span>${esc(basename(p))}<small>${esc(p)}</small></span></button>`,
          )
          .join('');
    return `<div class="scrim" data-action="close-overlay"><div class="palette"><div class="palette-input"><span>⌕</span><input id="quick-input" placeholder="Search files, or # text in code…" value="${esc(s.query)}" autocomplete="off"/></div><div class="palette-results">${rows || '<div class="empty-small">No matches</div>'}</div><div class="palette-tip">Prefix # to search code · ↵ Open · Esc Close</div></div></div>`;
  }
  function composer() {
    if (!s.showComposer || !s.active) return '';
    return `<div class="scrim" data-action="close-overlay"><div class="composer"><div class="composer-heading"><h2>Comment on code</h2><span>${esc(s.active)}:${s.selectedLine} ${s.selectedSide === 'old' ? '(old)' : ''}</span></div><textarea id="comment-body" placeholder="What should the AI change or explain?">${esc(s.draft)}</textarea><div class="composer-footer"><span>Queued locally until you send the review</span><button class="primary" data-action="save-comment">Add comment</button></div></div></div>`;
  }
  function sendDialog() {
    if (!s.showSend) return '';
    const provider = localStorage.getItem('rtc-provider') || 'codex-app';
    return `<div class="scrim" data-action="close-overlay"><div class="composer send-dialog"><h2>Send local review</h2><p>${pending().length} queued comment${pending().length === 1 ? '' : 's'} will be sent together. The session can then make changes in this repository.</p><label>AI provider<select id="provider"><option value="codex-app" ${provider === 'codex-app' ? 'selected' : ''}>Codex app chat</option><option value="codex" ${provider === 'codex' ? 'selected' : ''}>Codex CLI session</option><option value="claude" ${provider === 'claude' ? 'selected' : ''}>Claude Code</option></select></label><label>Session ID<input id="session-id" placeholder="Paste the Codex chat or CLI session ID" value="${esc(localStorage.getItem('rtc-session') || '')}"/></label><label>CLI executable path <small>(optional if on PATH)</small><input id="executable" placeholder="/path/to/codex or claude" value="${esc(localStorage.getItem('rtc-executable') || '')}"/></label><div class="composer-footer"><span>Comments remain queued if delivery fails</span><button class="primary" data-action="dispatch">Send ${pending().length} comments</button></div></div></div>`;
  }
  function shortcuts() {
    if (!s.shortcuts) return '';
    return `<div class="scrim" data-action="close-overlay"><div class="shortcuts"><h2>Keyboard shortcuts</h2><p>Based on your Pawnk bindings and IntelliJ navigation.</p>${[
      ['Shift Shift', 'Search Everywhere'],
      ['⌘F', 'Find in file'],
      ['⌘L', 'Toggle file tree'],
      ['⌘⇧O', 'Open repository'],
      ['⌃Tab / ⌃⇧Tab', 'Next / previous file'],
      ['⌘⌥← / ⌘⌥→', 'Back / forward'],
      ['⌘W', 'Close file'],
      ['⌘/', 'Keyboard shortcuts'],
      ['Esc', 'Close dialog'],
    ]
      .map(([k, v]) => `<div><span>${v}</span><kbd>${k}</kbd></div>`)
      .join('')}</div></div>`;
  }
  function render() {
    const count = pending().length;
    const job = activeJob();
    app.innerHTML = `<div class="shell"><header class="topbar"><div class="brand"><span class="brand-symbol">⌘</span><span>Read the Code</span></div><button class="workspace-picker" data-action="open"><span class="branch-icon">⌁</span><span>${s.ws ? esc(s.ws.root.split('/').pop() || s.ws.root) : 'Open a repository'}</span><span class="chevron">⌄</span></button><div class="top-spacer"></div><button class="search-trigger" data-action="quick"><span>⌕ &nbsp;Search Everywhere</span><kbd>⇧ ⇧</kbd></button><button class="icon-button" data-action="refresh" title="Refresh">↻</button><button class="icon-button" data-action="shortcuts" title="Keyboard shortcuts">?</button></header><div class="main-area">${s.sidebar ? `<aside class="sidebar"><div class="sidebar-tabs"><button class="${s.panel === 'files' ? 'active' : ''}" data-panel="files">Files</button><button class="${s.panel === 'changes' ? 'active' : ''}" data-panel="changes">Changes ${s.ws?.changes.length ? `<em>${s.ws.changes.length}</em>` : ''}</button><button class="${s.panel === 'review' ? 'active' : ''}" data-panel="review">Review ${count ? `<em>${count}</em>` : ''}</button></div><div class="sidebar-content">${s.panel === 'files' ? `<div class="sidebar-title">EXPLORER</div><input id="filter-files" placeholder="Filter files…" value="${!s.quick ? esc(s.query) : ''}"/>${fileTree()}` : s.panel === 'changes' ? `<div class="sidebar-title">WORKING TREE <button data-action="refresh">↻</button></div>${changesList()}` : `<div class="sidebar-title">REVIEW QUEUE</div>${commentsList()}${job?.output ? `<div class=\"ai-output\"><b>AI response</b><pre>${esc(job.output)}</pre></div>` : ''}`}</div></aside>` : ''}<section class="content"><div class="tabs"><button class="sidebar-toggle" data-action="sidebar" title="Toggle sidebar">☷</button>${s.tabs.map((p) => `<div class="tab ${p === s.active ? 'active' : ''}"><button data-open="${esc(p)}">${changed(p) ? '<span class="tab-dot"></span>' : ''}${esc(basename(p))}</button><button class="tab-close" data-close="${esc(p)}">×</button></div>`).join('')}</div>${editor()}</section></div><footer class="bottom-bar"><span>${s.ws ? `<span class="branch-icon">⌁</span> ${esc(s.ws.branch || 'detached')}` : 'No repository'}</span><span class="footer-center">${job?.running ? 'AI review in progress…' : job?.message ? esc(job.message) : 'Local review · comments stay here until sent'}</span><button class="review-button" data-action="send">Send review ${count ? `<b>${count}</b>` : ''}</button></footer></div>${quick()}${composer()}${sendDialog()}${shortcuts()}${s.toast ? `<div class="toast">${esc(s.toast)}</div>` : ''}`;
    if (s.quick) {
      const input = document.querySelector<HTMLInputElement>('#quick-input');
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }
    if (s.showComposer) document.querySelector<HTMLTextAreaElement>('#comment-body')?.focus();
    if (s.find) {
      let box = document.querySelector<HTMLInputElement>('#find-box');
      if (!box) {
        const bar = document.createElement('div');
        bar.className = 'find-bar';
        bar.innerHTML =
          '<input id="find-box" placeholder="Find in file…"/><button id="find-next">Next ↵</button><button id="find-close">×</button>';
        document.querySelector('.content')?.appendChild(bar);
        box = bar.querySelector<HTMLInputElement>('input')!;
        box.value = s.findQuery;
        bar.querySelector('#find-next')?.addEventListener('click', findNext);
        bar.querySelector('#find-close')?.addEventListener('click', () => {
          s.find = false;
          render();
        });
        box.addEventListener('input', () => {
          s.findQuery = box!.value;
          findNext();
        });
        box.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            findNext();
          }
        });
      }
      box.focus();
    }
  }
  render();
}
