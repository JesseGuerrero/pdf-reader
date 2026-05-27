const { invoke } = window.__TAURI__.core;

export function initFileExplorer(pdfViewer, chat) {
  const fileTree = document.getElementById('file-tree');
  const openBtn = document.getElementById('btn-open-folder');

  openBtn.addEventListener('click', async () => {
    try {
      const folder = await invoke('pick_folder');
      if (!folder) return;
      await openFolder(folder);
    } catch (err) {
      console.error('Failed to open folder:', err);
    }
  });

  async function openFolder(folderPath) {
    try {
      const tree = await invoke('scan_directory', { path: folderPath });
      renderTree(fileTree, tree, pdfViewer, chat);
      window.__lastFolder = folderPath;
      chat.saveSession();
    } catch (err) {
      console.error('Failed to scan folder:', err);
    }
  }

  return { openFolder };
}

function renderTree(container, nodes, pdfViewer, chat) {
  container.innerHTML = '';
  const ul = document.createElement('ul');
  for (const node of nodes) {
    ul.appendChild(createNode(node, pdfViewer, chat));
  }
  container.appendChild(ul);
}

function createNode(node, pdfViewer, chat) {
  const li = document.createElement('li');
  if (node.is_dir) {
    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle';
    toggle.textContent = '▶';
    const name = document.createElement('span');
    name.className = 'tree-dir-name';
    name.textContent = '\u{1F4C1} ' + node.name;
    li.appendChild(toggle);
    li.appendChild(name);

    const childUl = document.createElement('ul');
    childUl.style.display = 'none';
    for (const child of node.children) {
      childUl.appendChild(createNode(child, pdfViewer, chat));
    }
    li.appendChild(childUl);

    const toggleDir = () => {
      const open = childUl.style.display !== 'none';
      childUl.style.display = open ? 'none' : '';
      toggle.textContent = open ? '▶' : '▼';
    };
    toggle.addEventListener('click', toggleDir);
    name.addEventListener('click', toggleDir);
  } else {
    const name = document.createElement('span');
    name.className = 'tree-file-name';
    name.textContent = '\u{1F4C4} ' + node.name;
    li.appendChild(name);
    name.addEventListener('click', () => {
      document.querySelectorAll('.tree-file-name.active').forEach(el => el.classList.remove('active'));
      name.classList.add('active');
      pdfViewer.loadPdf(node.path, node.name);
      chat.onPdfLoaded(node.path);
    });
    name.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Remove any existing context menu
      document.querySelectorAll('.file-context-menu').forEach(el => el.remove());

      const menu = document.createElement('div');
      menu.className = 'file-context-menu';

      const copyBtn = document.createElement('div');
      copyBtn.className = 'file-context-item';
      copyBtn.textContent = 'Copy Path';
      copyBtn.addEventListener('click', () => {
        const fullPath = '"' + node.path + '"';
        navigator.clipboard.writeText(fullPath).catch(() => {
          // Fallback for WebKitGTK
          const ta = document.createElement('textarea');
          ta.value = fullPath;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        });
        menu.remove();
      });
      menu.appendChild(copyBtn);

      menu.style.left = e.pageX + 'px';
      menu.style.top = e.pageY + 'px';
      document.body.appendChild(menu);

      const dismiss = (ev) => {
        if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', dismiss); }
      };
      setTimeout(() => document.addEventListener('mousedown', dismiss), 10);
    });
  }
  return li;
}
