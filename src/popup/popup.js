import { FORMATS, CATEGORIES } from '../shared/formats.js';

const list = document.getElementById('format-list');
const status = document.getElementById('status');

// ── Build UI ──────────────────────────────────────────────
const grouped = {};
for (const [id, fmt] of Object.entries(FORMATS)) {
  (grouped[fmt.category] ??= []).push({ id, ...fmt });
}

for (const [cat, label] of Object.entries(CATEGORIES)) {
  const items = grouped[cat];
  if (!items) continue;

  const h = document.createElement('div');
  h.className = 'category-label';
  h.textContent = label;
  list.appendChild(h);

  for (const fmt of items) {
    const btn = document.createElement('button');
    btn.className = 'format-btn';
    btn.dataset.format = fmt.id;
    btn.innerHTML =
      `<span class="name">${fmt.name}</span>` +
      `<span class="ext">${fmt.ext}</span>`;
    btn.addEventListener('click', () => startExport(fmt.id));
    list.appendChild(btn);
  }
}

// ── Export logic ──────────────────────────────────────────
let exporting = false;

function setButtons(enabled) {
  for (const btn of list.querySelectorAll('.format-btn')) {
    btn.disabled = !enabled;
  }
}

function showStatus(text, type) {
  status.textContent = text;
  status.className = `status ${type}`;
}

function startExport(format) {
  if (exporting) return;
  exporting = true;
  setButtons(false);
  showStatus('Exporting\u2026', 'loading');

  chrome.runtime.sendMessage({ action: 'export', format });
}

// ── Listen for result from background ─────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'export-complete') {
    showStatus('Download started!', 'success');
    exporting = false;
    setButtons(true);
  }
  if (msg.action === 'export-error') {
    showStatus(msg.error ?? 'Export failed', 'error');
    exporting = false;
    setButtons(true);
  }
});
