import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import './style.css';
import { renderView } from './view';
import type { AppState, Comment, FileData, Job, SearchHit, Workspace } from './types';
import { basename, esc, ext } from './helpers';

const app = document.querySelector<HTMLDivElement>('#app')!;
const s: AppState = {
  ws: null,
  file: null,
  active: null,
  mode: 'file',
  staged: false,
  diff: '',
  preview: true,
  tabs: [],
  history: [],
  historyAt: -1,
  quick: false,
  query: '',
  results: [],
  find: false,
  findQuery: '',
  selectedLine: 1,
  selectedSide: 'file',
  showComposer: false,
  showSend: false,
  draft: '',
  sidebar: true,
  panel: 'files',
  job: null,
  toast: '',
  shortcuts: false,
};

const changed = (path: string) => s.ws?.changes.find((change) => change.path === path);
const pending = () => s.ws?.comments.filter((comment) => !comment.sent) || [];
function render() {
  renderView(s, findNext);
}
const notice = (m: string) => {
  s.toast = m;
  render();
  setTimeout(() => {
    if (s.toast === m) {
      s.toast = '';
      render();
    }
  }, 4500);
};
async function refresh() {
  if (!s.ws) return;
  try {
    s.ws = await invoke<Workspace>('refresh_workspace');
    render();
  } catch (e) {
    notice(String(e));
  }
}
async function choose() {
  const path = await open({ directory: true, multiple: false });
  if (typeof path === 'string') await openWorkspace(path);
}
async function openWorkspace(path: string) {
  try {
    s.ws = await invoke<Workspace>('open_workspace', { path });
    localStorage.setItem('rtc-root', path);
    s.active = null;
    s.file = null;
    s.tabs = [];
    s.history = [];
    s.historyAt = -1;
    render();
  } catch (e) {
    notice(String(e));
  }
}
async function openFile(path: string, record = true) {
  if (!s.ws) return;
  try {
    s.file = await invoke<FileData>('read_file', { path });
    s.active = path;
    s.mode = 'file';
    s.preview = true;
    s.selectedLine = 1;
    s.selectedSide = 'file';
    if (!s.tabs.includes(path)) s.tabs.push(path);
    if (record) {
      s.history = s.history.slice(0, s.historyAt + 1);
      s.history.push(path);
      s.historyAt = s.history.length - 1;
    }
    s.quick = false;
    s.query = '';
    render();
  } catch (e) {
    notice(String(e));
  }
}
async function showDiff(path: string, staged = false) {
  if (s.active !== path) {
    try {
      await openFile(path);
    } catch {}
    s.active = path;
    if (!s.file || s.file.path !== path) s.file = { path, content: '', lines: 1 };
    if (!s.tabs.includes(path)) s.tabs.push(path);
  }
  s.mode = 'diff';
  s.staged = staged;
  s.selectedLine = 1;
  s.selectedSide = 'new';
  try {
    s.diff = await invoke<string>('read_diff', { path, staged });
    render();
  } catch (e) {
    notice(String(e));
  }
}
async function stage(path: string, stage: boolean) {
  try {
    s.ws = await invoke<Workspace>('stage_file', { path, stage });
    render();
    notice(stage ? 'Staged ' + basename(path) : 'Unstaged ' + basename(path));
  } catch (e) {
    notice(String(e));
  }
}
function navigate(delta: number) {
  const next = s.historyAt + delta;
  if (next >= 0 && next < s.history.length) {
    s.historyAt = next;
    openFile(s.history[next], false);
  }
}
function switchTab(delta: number) {
  if (!s.active || !s.tabs.length) return;
  const i = s.tabs.indexOf(s.active);
  openFile(s.tabs[(i + delta + s.tabs.length) % s.tabs.length]);
}
function closeTab(path: string) {
  const i = s.tabs.indexOf(path);
  s.tabs = s.tabs.filter((p) => p !== path);
  if (s.active === path) {
    const next = s.tabs[Math.max(0, i - 1)];
    if (next) openFile(next);
    else {
      s.active = null;
      s.file = null;
      render();
    }
  } else render();
}
function findNext() {
  if (!s.file || !s.findQuery) return;
  const rows = s.file.content.split('\n');
  const start = s.selectedLine;
  for (let j = 0; j < rows.length; j++) {
    const i = (start + j) % rows.length;
    if (rows[i].toLowerCase().includes(s.findQuery.toLowerCase())) {
      s.selectedLine = i + 1;
      document.querySelector(`[data-line="${i + 1}"]`)?.scrollIntoView({ block: 'center' });
      document
        .querySelectorAll('.code-row')
        .forEach((el) =>
          el.classList.toggle('selected', el.getAttribute('data-line') === String(i + 1)),
        );
      break;
    }
  }
}
async function sendReview() {
  if (!s.ws) {
    notice('Open a repository first');
    return;
  }
  if (!pending().length) {
    s.panel = 'review';
    render();
    notice('Add a comment before sending');
    return;
  }
  s.showSend = true;
  render();
}
async function dispatchReview() {
  const p = document.querySelector<HTMLSelectElement>('#provider')?.value || 'codex-app';
  const session = document.querySelector<HTMLInputElement>('#session-id')?.value.trim() || '';
  if (!session) {
    notice('Enter the session ID');
    return;
  }
  localStorage.setItem('rtc-provider', p);
  localStorage.setItem('rtc-session', session);
  const executable = document.querySelector<HTMLInputElement>('#executable')?.value.trim() || '';
  localStorage.setItem('rtc-executable', executable);
  try {
    await invoke('send_review', {
      provider: p,
      sessionId: session,
      executable: executable || null,
    });
    s.showSend = false;
    s.job = {
      running: true,
      message: 'Sending review to AI session…',
      output: '',
      workspaceRoot: s.ws?.root || null,
    };
    render();
    pollJob();
  } catch (e) {
    notice(String(e));
  }
}
async function pollJob() {
  const timer = setInterval(async () => {
    try {
      s.job = await invoke<Job>('job_status');
      if (!s.job.running) {
        clearInterval(timer);
        if (s.job.workspaceRoot === s.ws?.root) {
          await refresh();
          notice(s.job.message);
        }
        if (s.job.output) console.info('AI review response:', s.job.output);
      } else render();
    } catch (e) {
      clearInterval(timer);
      notice(String(e));
    }
  }, 1200);
}
app.addEventListener('click', async (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>(
    '[data-action],[data-open],[data-diff],[data-stage],[data-close],[data-panel],[data-delete],[data-jump],[data-result],[data-line]',
  );
  if (!t) return;
  if (t.dataset.open) {
    await openFile(t.dataset.open);
    return;
  }
  if (t.dataset.diff) {
    await showDiff(t.dataset.diff);
    return;
  }
  if (t.dataset.stage) {
    await stage(
      t.dataset.stage,
      !(changed(t.dataset.stage)?.index.trim() && changed(t.dataset.stage)?.index !== '?'),
    );
    return;
  }
  if (t.dataset.close) {
    closeTab(t.dataset.close);
    return;
  }
  if (t.dataset.panel) {
    s.panel = t.dataset.panel as typeof s.panel;
    render();
    return;
  }
  if (t.dataset.delete) {
    try {
      s.ws!.comments = await invoke<Comment[]>('delete_comment', { id: t.dataset.delete });
      render();
    } catch (e) {
      notice(String(e));
    }
    return;
  }
  if (t.dataset.result) {
    const m = t.dataset.result.match(/^(.*):(\d+)$/);
    if (m) {
      await openFile(m[1]);
      s.selectedLine = +m[2];
      render();
      document.querySelector(`[data-line=\"${m[2]}\"]`)?.scrollIntoView({ block: 'center' });
    }
    return;
  }
  if (t.dataset.jump) {
    const m = t.dataset.jump.match(/^(.*):(\d+)$/);
    if (m) {
      await openFile(m[1]);
      s.selectedLine = +m[2];
      render();
      document.querySelector(`[data-line="${m[2]}"]`)?.scrollIntoView({ block: 'center' });
    }
    return;
  }
  if (t.dataset.line) {
    s.selectedLine = +t.dataset.line;
    s.selectedSide = t.dataset.side || 'file';
    document
      .querySelectorAll('.code-row.selected')
      .forEach((el) => el.classList.remove('selected'));
    t.classList.add('selected');
    return;
  }
  switch (t.dataset.action) {
    case 'open':
      await choose();
      break;
    case 'refresh':
      await refresh();
      if (s.mode === 'diff' && s.active) await showDiff(s.active, s.staged);
      break;
    case 'sidebar':
      s.sidebar = !s.sidebar;
      render();
      break;
    case 'quick':
      s.quick = true;
      s.query = '';
      render();
      break;
    case 'shortcuts':
      s.shortcuts = true;
      render();
      break;
    case 'file':
      s.mode = 'file';
      s.preview = false;
      render();
      break;
    case 'preview':
      s.mode = 'file';
      s.preview = true;
      render();
      break;
    case 'diff':
      if (s.active) await showDiff(s.active);
      break;
    case 'staged-diff':
      if (s.active) await showDiff(s.active, true);
      break;
    case 'comment':
      if (ext(s.active || '') === 'md' && s.preview) {
        s.preview = false;
        s.mode = 'file';
      }
      s.showComposer = true;
      s.draft = '';
      render();
      break;
    case 'save-comment': {
      s.draft = document.querySelector<HTMLTextAreaElement>('#comment-body')?.value || '';
      if (!s.draft.trim()) {
        notice('Write a comment first');
        return;
      }
      try {
        s.ws!.comments = await invoke<Comment[]>('add_comment', {
          path: s.active,
          line: s.selectedLine,
          side: s.selectedSide,
          body: s.draft,
          anchor:
            (document.querySelector<HTMLElement>('.code-row.selected code')?.textContent || '')
              .trim()
              .replace(/^[-+]/, '')
              .slice(0, 400) || null,
        });
        s.showComposer = false;
        s.panel = 'review';
        s.draft = '';
        render();
      } catch (e) {
        notice(String(e));
      }
      break;
    }
    case 'send':
      await sendReview();
      break;
    case 'dispatch':
      await dispatchReview();
      break;
    case 'close-overlay':
      if (e.target !== t) break;
      s.quick = false;
      s.showComposer = false;
      s.showSend = false;
      s.shortcuts = false;
      s.find = false;
      render();
      break;
  }
});
app.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === 'quick-input') {
    s.query = t.value;
    if (t.value.startsWith('#')) {
      queueSearchCode(t.value.slice(1));
      document.querySelector('.palette-results')!.innerHTML =
        '<div class="empty-small">Searching code…</div>';
    } else {
      const list =
        s.ws?.files.filter((f) => f.toLowerCase().includes(s.query.toLowerCase())).slice(0, 40) ||
        [];
      document.querySelector('.palette-results')!.innerHTML =
        list
          .map(
            (p, i) =>
              `<button class="palette-result ${i === 0 ? 'first' : ''}" data-open="${esc(p)}"><span>◇</span><span>${esc(basename(p))}<small>${esc(p)}</small></span></button>`,
          )
          .join('') || '<div class="empty-small">No files found</div>';
    }
  }
  if (t.id === 'filter-files') {
    s.query = t.value;
    document
      .querySelector('.sidebar-content')!
      .querySelectorAll('.tree-item')
      .forEach((el) => el.remove());
    const input = document.querySelector<HTMLInputElement>('#filter-files');
    const position = input?.selectionStart || 0;
    render();
    const next = document.querySelector<HTMLInputElement>('#filter-files');
    next?.focus();
    next?.setSelectionRange(position, position);
  }
});
let searchSerial = 0;
let searchTimer = 0;
function queueSearchCode(q: string) {
  window.clearTimeout(searchTimer);
  if (q.trim().length < 2) {
    searchSerial++;
    s.results = [];
    render();
    return;
  }
  searchTimer = window.setTimeout(() => void searchCode(q), 250);
}
async function searchCode(q: string) {
  const id = ++searchSerial;
  if (q.trim().length < 2) {
    s.results = [];
    render();
    return;
  }
  try {
    const results = await invoke<SearchHit[]>('search_content', { query: q });
    if (id === searchSerial && s.quick && s.query.startsWith('#')) {
      s.results = results;
      const input = document.querySelector<HTMLInputElement>('#quick-input');
      const pos = input?.selectionStart || 0;
      render();
      const next = document.querySelector<HTMLInputElement>('#quick-input');
      next?.setSelectionRange(pos, pos);
    }
  } catch (e) {
    if (id === searchSerial) notice(String(e));
  }
}
let lastShift = 0;
window.addEventListener('keydown', (e) => {
  const mod = navigator.platform.includes('Mac') ? e.metaKey : e.ctrlKey;
  const isInput = (e.target as HTMLElement)?.matches('input,textarea');
  if (e.key === 'Shift' && !e.repeat) {
    const now = Date.now();
    if (now - lastShift < 420) {
      e.preventDefault();
      s.quick = true;
      s.query = '';
      render();
      lastShift = 0;
    } else lastShift = now;
    return;
  }
  if (e.key === 'Escape') {
    s.quick = false;
    s.showComposer = false;
    s.showSend = false;
    s.shortcuts = false;
    s.find = false;
    render();
    return;
  }
  if (s.quick) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = Array.from(document.querySelectorAll<HTMLElement>('.palette-result'));
      if (items.length) {
        const current = Math.max(
          0,
          items.findIndex((i) => i.classList.contains('first')),
        );
        items[current].classList.remove('first');
        const next = (current + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next].classList.add('first');
        items[next].scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = document.querySelector<HTMLElement>('.palette-result.first');
      const p = first?.dataset.open;
      if (p) openFile(p);
      else first?.click();
    }
    return;
  }
  if (isInput && e.key !== 'Tab') return;
  if (e.key === 'F12') {
    e.preventDefault();
    const word = window.getSelection()?.toString().trim();
    if (word) {
      s.quick = true;
      s.query = '#' + word;
      s.results = [];
      render();
      searchCode(word);
    }
    return;
  }
  if (mod && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    s.find = true;
    render();
    return;
  }
  if (mod && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    s.sidebar = !s.sidebar;
    render();
    return;
  }
  if (mod && e.key === '/') {
    e.preventDefault();
    s.shortcuts = true;
    render();
    return;
  }
  if (mod && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    if (s.active) closeTab(s.active);
    return;
  }
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    switchTab(e.shiftKey ? -1 : 1);
    return;
  }
  if (mod && e.altKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    navigate(-1);
    return;
  }
  if (mod && e.altKey && e.key === 'ArrowRight') {
    e.preventDefault();
    navigate(1);
    return;
  }
  if (mod && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    choose();
  }
});
render();
const saved = localStorage.getItem('rtc-root');
if (saved) openWorkspace(saved);
