import { initFileExplorer } from './file-explorer.js';
import { initPdfViewer } from './pdf-viewer.js';
import { initChat } from './chat.js';

const { invoke } = window.__TAURI__.core;

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
    e.preventDefault();
    invoke('open_url', { url: href });
  }
});

const pdfViewer = initPdfViewer();
const chat = initChat(pdfViewer);
const fileExplorer = initFileExplorer(pdfViewer, chat);

window.__refreshFolder = () => {
  if (window.__lastFolder) fileExplorer.openFolder(window.__lastFolder);
};

// Refresh button
document.getElementById('btn-refresh').addEventListener('click', () => {
  if (window.__lastFolder) fileExplorer.openFolder(window.__lastFolder);
});

// Drag and drop PDF files into the folder
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (!window.__lastFolder) return;
  const files = e.dataTransfer.files;
  for (const file of files) {
    if (file.name.toLowerCase().endsWith('.pdf') && file.path) {
      try {
        await invoke('copy_file_to_folder', { source: file.path, folder: window.__lastFolder });
      } catch (err) {
        console.error('Failed to copy file:', err);
      }
    }
  }
  fileExplorer.openFolder(window.__lastFolder);
});

// Sidebar toggle
document.getElementById('btn-toggle-sidebar').addEventListener('click', () => {
  const left = document.getElementById('left-pane');
  const handle = document.getElementById('resize-left');
  const collapsed = left.classList.toggle('collapsed');
  handle.style.display = collapsed ? 'none' : '';
});

initResizeHandles();

// Restore session
restoreSession();

async function restoreSession() {
  const session = await chat.loadSessionData();
  if (!session) return;

  if (session.lastFolder) {
    await fileExplorer.openFolder(session.lastFolder);
  }
  if (session.lastPdf) {
    const fileName = session.lastPdf.split('/').pop();
    await pdfViewer.loadPdf(session.lastPdf, fileName);
    chat.onPdfLoaded(session.lastPdf);
  }
}

function initResizeHandles() {
  setupResize('resize-left', 'left-pane', 'left');
  setupResize('resize-right', 'right-pane', 'right');
}

function setupResize(handleId, paneId, side) {
  const handle = document.getElementById(handleId);
  const pane = document.getElementById(paneId);
  let startX, startWidth;

  handle.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startWidth = pane.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (e) => {
      const delta = side === 'left' ? e.clientX - startX : startX - e.clientX;
      const newWidth = Math.max(120, startWidth + delta);
      pane.style.width = newWidth + 'px';
    };

    const onUp = () => {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
