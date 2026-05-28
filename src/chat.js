import { marked } from './vendor/marked.esm.js';

marked.use({
  breaks: true,
  gfm: true,
  renderer: {
    image({ href, title, text }) {
      const t = title ? ` title="${title}"` : '';
      return `<img src="${href}" alt="${text || ''}"${t} />`;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const t = title ? ` title="${title}"` : '';
      return `<a href="${href}"${t}>${text}</a>`;
    },
  },
});

const { invoke } = window.__TAURI__.core;

const DEFAULTS = {
  url: 'http://localhost:8317/v1',
  key: '123',
  model: 'claude-sonnet-4-6',
};

const S2_API_KEY = 'REDACTED';

// --- Chat Tree ---

class ChatTree {
  constructor(pdfPath) {
    this.pdfPath = pdfPath;
    this.messages = {};
    this.rootId = crypto.randomUUID();
    this.messages[this.rootId] = { id: this.rootId, role: 'root', content: '', parentId: null, children: [] };
    this.activeNodeId = this.rootId;
  }

  addMessage(role, content) {
    const id = crypto.randomUUID();
    const parentId = this.activeNodeId;
    const msg = { id, role, content, parentId, children: [] };
    this.messages[id] = msg;
    if (parentId && this.messages[parentId]) {
      this.messages[parentId].children.push(id);
    }
    this.activeNodeId = id;
    return msg;
  }

  getCurrentPath() {
    const path = [];
    let id = this.activeNodeId;
    while (id && this.messages[id]) {
      if (this.messages[id].role !== 'root') path.unshift(this.messages[id]);
      id = this.messages[id].parentId;
    }
    return path;
  }

  getPathTo(nodeId) {
    const path = [];
    let id = nodeId;
    while (id && this.messages[id]) {
      if (this.messages[id].role !== 'root') path.unshift(this.messages[id]);
      id = this.messages[id].parentId;
    }
    return path;
  }

  forkFrom(nodeId) {
    this.activeNodeId = nodeId;
  }

  restart() {
    this.activeNodeId = this.rootId;
  }

  getRoots() {
    return [this.messages[this.rootId]];
  }

  isEmpty() {
    return Object.keys(this.messages).length <= 1;
  }

  toJSON() {
    return JSON.stringify({
      pdfPath: this.pdfPath,
      messages: this.messages,
      activeNodeId: this.activeNodeId,
      rootId: this.rootId,
    });
  }

  static fromJSON(json) {
    const data = JSON.parse(json);
    const tree = new ChatTree(data.pdfPath);
    tree.messages = data.messages || {};

    if (data.rootId && tree.messages[data.rootId]) {
      tree.rootId = data.rootId;
    } else {
      // Legacy tree without root node — graft one on top
      const rootId = tree.rootId;
      const orphans = Object.values(tree.messages).filter(m => m.id !== rootId && !m.parentId);
      for (const m of orphans) {
        m.parentId = rootId;
        tree.messages[rootId].children.push(m.id);
      }
    }

    tree.activeNodeId = data.activeNodeId || tree.rootId;
    return tree;
  }
}

// --- Settings ---

function loadSettings() {
  try {
    const saved = localStorage.getItem('llm_settings');
    if (saved) return { ...DEFAULTS, ...JSON.parse(saved) };
  } catch {}
  return { ...DEFAULTS };
}

function saveSettingsLocal(s) {
  localStorage.setItem('llm_settings', JSON.stringify(s));
}

// --- Init ---

export function initChat(pdfViewer) {
  const messagesDiv = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const sendBtn = document.getElementById('btn-send');
  const settingsBtn = document.getElementById('btn-settings');
  const settingsPanel = document.getElementById('settings-panel');
  const settingUrl = document.getElementById('setting-url');
  const settingKey = document.getElementById('setting-key');
  const settingModel = document.getElementById('setting-model');
  const selectedBar = document.getElementById('selected-text-bar');
  const selectedContent = document.getElementById('selected-text-content');
  const defineBtn = document.getElementById('btn-define');
  const locationBtn = document.getElementById('btn-location');
  const personBtn = document.getElementById('btn-person');
  const citeBtn = document.getElementById('btn-cite');
  const stampBtn = document.getElementById('btn-stamp');
  const downloadAllBtn = document.getElementById('btn-download-all');
  const treeBtn = document.getElementById('btn-tree');
  const newChatBtn = document.getElementById('btn-new-chat');
  const treeModal = document.getElementById('tree-modal');
  const treeView = document.getElementById('tree-view');
  const stampView = document.getElementById('stamp-view');
  const stampViewContent = document.getElementById('stamp-view-content');

  let settings = loadSettings();
  let trees = {};
  let currentTree = null;
  let selectedText = '';
  let allStamps = {};
  let currentStamps = [];
  let viewingStamp = null;

  function extractReference(refNum) {
    const map = pdfViewer.getReferencesMap();
    return map[parseInt(refNum)] || null;
  }

  // Populate settings
  settingUrl.value = settings.url;
  settingKey.value = settings.key;
  settingModel.value = settings.model;

  settingsBtn.addEventListener('click', () => settingsPanel.classList.toggle('open'));

  for (const input of [settingUrl, settingKey, settingModel]) {
    input.addEventListener('change', () => {
      settings = {
        url: settingUrl.value || DEFAULTS.url,
        key: settingKey.value || DEFAULTS.key,
        model: settingModel.value || DEFAULTS.model,
      };
      saveSettingsLocal(settings);
      saveSession();
    });
  }

  // --- Selection ---

  function handleSelectionUp() {
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const text = sel.toString().trim();
      if (!text) return;
      selectedText = text;
      selectedContent.textContent = text.length > 120 ? text.slice(0, 120) + '...' : text;
      selectedBar.style.display = '';
    }, 10);
  }

  document.getElementById('text-layer').addEventListener('mouseup', handleSelectionUp);
  messagesDiv.addEventListener('mouseup', handleSelectionUp);

  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.textLayer') && !e.target.closest('#right-pane') && !e.target.closest('#selected-text-bar')) {
      if (selectedText) {
        selectedText = '';
        selectedBar.style.display = 'none';
      }
    }
  });

  // --- Send / Define ---

  sendBtn.addEventListener('click', () => sendMessage(chatInput.value.trim()));
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(chatInput.value.trim());
    }
  });

  defineBtn.addEventListener('click', () => {
    if (!selectedText) return;
    sendMessage(`Define: "${selectedText}"`);
  });

  function latLonToTile(lat, lon, zoom) {
    const n = Math.pow(2, zoom);
    const x = Math.floor((parseFloat(lon) + 180) / 360 * n);
    const latRad = parseFloat(lat) * Math.PI / 180;
    const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    return { x, y };
  }

  locationBtn.addEventListener('click', async () => {
    if (!selectedText || !currentTree) return;
    const query = selectedText;
    chatInput.value = '';
    currentTree.addMessage('user', `Define: "${query}"`);
    renderMessages();
    const loadingEl = appendLoadingMessage();

    try {
      const [apiResponse, geo] = await Promise.all([
        invoke('send_chat_message', {
          messages: buildApiMessages(),
          model: settings.model, apiUrl: settings.url, apiKey: settings.key,
        }),
        invoke('geocode_location', { query }),
      ]);

      removeLoadingMessage(loadingEl);

      const lat = geo.lat;
      const lon = geo.lon;
      const name = geo.display_name;
      const q = encodeURIComponent(query);

      const tileUrl = (z) => {
        const { x, y } = latLonToTile(lat, lon, z);
        return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
      };

      let mapsMd = '';
      try {
        const [globalImg, continentImg, regionImg] = await Promise.all([
          invoke('proxy_image', { url: tileUrl(2) }),
          invoke('proxy_image', { url: tileUrl(5) }),
          invoke('proxy_image', { url: tileUrl(8) }),
        ]);
        mapsMd = `\n\n---\n\n**${name}**\n\n` +
          `[View on Google Images](https://www.google.com/search?tbm=isch&q=${q})\n\n` +
          `**Global**\n\n![Global](${globalImg})\n\n` +
          `**Continent**\n\n![Continent](${continentImg})\n\n` +
          `**Region**\n\n![Region](${regionImg})`;
      } catch {}

      currentTree.addMessage('assistant', apiResponse + mapsMd);
      renderMessages();
      saveCurrentTree();
    } catch (err) {
      removeLoadingMessage(loadingEl);
      currentTree.addMessage('assistant', `Error: ${err}`);
      renderMessages();
      saveCurrentTree();
    }
  });

  personBtn.addEventListener('click', async () => {
    if (!selectedText || !currentTree) return;
    const query = selectedText;

    currentTree.addMessage('user', `Person: "${query}"`);
    renderMessages();
    const loadingEl = appendLoadingMessage();

    try {
      const [apiResponse, person] = await Promise.all([
        invoke('send_chat_message', {
          messages: [...buildApiMessages(), { role: 'user', content: `Person: "${query}"` }],
          model: settings.model, apiUrl: settings.url, apiKey: settings.key,
        }),
        invoke('lookup_person', { name: query }),
      ]);

      removeLoadingMessage(loadingEl);

      let thumbData = '';
      if (person.thumbnail) {
        try { thumbData = await invoke('proxy_image', { url: person.thumbnail }); } catch {}
      }

      let personMd;
      if (person.type === 'researcher') {
        const topics = (person.topics || []).map(t => `\`${t}\``).join(', ');
        personMd = `\n\n---\n\n### ${person.name}\n` +
          `**Researcher**\n\n` +
          `| | |\n|---|---|\n` +
          `| **Institution** | ${person.institution}${person.country ? ` (${person.country})` : ''} |\n` +
          `| **Publications** | ${person.works_count.toLocaleString()} |\n` +
          `| **Citations** | ${person.cited_by_count.toLocaleString()} |\n` +
          `| **h-index** | ${person.h_index} |\n` +
          (person.orcid ? `| **ORCID** | [${person.orcid}](${person.orcid}) |\n` : '') +
          `\n**Research areas:** ${topics || 'N/A'}\n\n` +
          (person.openalex_url ? `[View on OpenAlex](${person.openalex_url})` : '') +
          ` · [Google Scholar](https://scholar.google.com/scholar?q=author:"${encodeURIComponent(person.name)}")`;
      } else {
        personMd = `\n\n---\n\n### ${person.name}\n` +
          (person.description ? `*${person.description}*\n\n` : '\n') +
          (thumbData ? `![${person.name}](${thumbData})\n\n` : '') +
          `${person.extract}\n\n` +
          (person.url ? `[Read more on Wikipedia](${person.url})` : '');
      }

      currentTree.addMessage('assistant', apiResponse + personMd);
      renderMessages();
      saveCurrentTree();
    } catch (err) {
      removeLoadingMessage(loadingEl);
      currentTree.addMessage('assistant', `Person lookup failed: ${err}`);
      renderMessages();
      saveCurrentTree();
    }
  });

  citeBtn.addEventListener('click', async () => {
    if (!selectedText || !currentTree) return;
    const raw = selectedText.trim();

    currentTree.addMessage('user', `Cite: "${raw}"`);
    renderMessages();
    const loadingEl = appendLoadingMessage();

    try {
      // Determine query type and text
      let query, queryType;

      // Check for DOI pattern
      const doiMatch = raw.match(/10\.\d{4,}[^\s]*/);
      if (doiMatch) {
        query = doiMatch[0].replace(/[.,;)\]]+$/, '');
        queryType = 'doi';
      } else {
        // Check for reference number like [23] or (23)
        const refMatch = raw.match(/^\[?(\d{1,3})\]?$/);
        if (refMatch) {
          const refNum = refMatch[1];
          const refText = extractReference(refNum);
          if (refText) {
            const refDoi = refText.match(/10\.\d{4,}[^\s]*/);
            if (refDoi) {
              query = refDoi[0].replace(/[.,;)\]]+$/, '');
              queryType = 'doi';
            } else {
              query = refText;
              queryType = 'search';
            }
          } else {
            query = raw;
            queryType = 'search';
          }
        } else {
          query = raw;
          queryType = 'search';
        }
      }

      const paper = await invoke('resolve_citation', { query, queryType, apiKey: S2_API_KEY });
      removeLoadingMessage(loadingEl);

      const authors = (paper.authors || []).join(', ');
      const links = [];
      if (paper.venue_pdf) links.push(`[Venue PDF](${paper.venue_pdf})`);
      if (paper.arxiv_pdf) links.push(`[arXiv PDF](${paper.arxiv_pdf})`);
      if (paper.s2_url) links.push(`[Semantic Scholar](${paper.s2_url})`);

      const pdfUrl = paper.venue_pdf || paper.arxiv_pdf;

      let md = `### ${paper.title}\n\n` +
        `**${authors}** (${paper.year || 'n.d.'})\n\n` +
        (paper.venue ? `*${paper.venue}*\n\n` : '') +
        `| | |\n|---|---|\n` +
        `| **Citations** | ${(paper.citation_count || 0).toLocaleString()} |\n` +
        (paper.doi ? `| **DOI** | [${paper.doi}](https://doi.org/${paper.doi}) |\n` : '') +
        (paper.arxiv_id ? `| **arXiv** | [${paper.arxiv_id}](https://arxiv.org/abs/${paper.arxiv_id}) |\n` : '') +
        `\n${links.join(' · ')}\n` +
        (paper.abstract ? `\n<details><summary>Abstract</summary>\n\n${paper.abstract}\n</details>` : '');

      currentTree.addMessage('assistant', md);
      renderMessages();

      if (pdfUrl && window.__lastFolder) {
        const dlBtn = document.createElement('button');
        dlBtn.className = 'cite-download-btn';
        dlBtn.textContent = 'Download PDF to folder';
        dlBtn.addEventListener('click', async () => {
          dlBtn.disabled = true;
          dlBtn.textContent = 'Downloading...';
          try {
            const safeName = (paper.title || 'paper').replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 80).trim() + '.pdf';
            const savedPath = await invoke('download_pdf', { url: pdfUrl, folder: window.__lastFolder, filename: safeName });
            dlBtn.textContent = 'Downloaded!';
            if (window.__refreshFolder) window.__refreshFolder();
          } catch (e) {
            dlBtn.textContent = 'Download failed';
            console.error('Download failed:', e);
          }
        });
        messagesDiv.appendChild(dlBtn);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
      }

      saveCurrentTree();
    } catch (err) {
      removeLoadingMessage(loadingEl);
      currentTree.addMessage('assistant', `Citation lookup failed: ${err}`);
      renderMessages();
      saveCurrentTree();
    }
  });

  // --- Stamp ---

  stampBtn.addEventListener('click', () => {
    if (!currentTree) return;
    const pos = pdfViewer.getSelectionPosition() || pdfViewer.getSavedPosition();
    if (!pos) return;
    const path = currentTree.getCurrentPath();
    const lastAssistant = [...path].reverse().find(m => m.role === 'assistant');
    if (!lastAssistant) return;

    const stamp = {
      id: crypto.randomUUID(),
      pdfPath: pdfViewer.getCurrentPath(),
      pageNumber: pos.page,
      x: pos.x,
      y: pos.y,
      w: pos.w,
      h: pos.h,
      selectedText: pos.selectedText,
      messageId: lastAssistant.id,
      content: lastAssistant.content,
      createdAt: new Date().toISOString(),
    };
    currentStamps.push(stamp);
    saveStamps();
    pdfViewer.setStamps(currentStamps);
  });

  pdfViewer.setOnCiteResolve(async (refNum, refText, btn) => {
    if (!window.__lastFolder) { btn.textContent = 'No folder open'; return; }
    btn.disabled = true;
    btn.textContent = '⬇ Resolving...';

    try {
      // Extract DOI from reference text if present
      const doiMatch = refText.match(/10\.\d{4,}[^\s]*/);
      let query, queryType;
      if (doiMatch) {
        query = doiMatch[0].replace(/[.,;)\]]+$/, '');
        queryType = 'doi';
      } else {
        query = refText.replace(/^\s*\[\d+\]\s*/, '').replace(/^\s*\d+\.\s*/, '');
        queryType = 'search';
      }

      const paper = await invoke('resolve_citation', { query, queryType, apiKey: S2_API_KEY });
      const pdfUrl = paper.venue_pdf || paper.arxiv_pdf;
      if (!pdfUrl) { btn.textContent = 'No PDF found'; return; }

      btn.textContent = '⬇ Downloading...';
      const safeName = (paper.title || 'paper').replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 80).trim() + '.pdf';
      await invoke('download_pdf', { url: pdfUrl, folder: window.__lastFolder, filename: safeName });
      btn.textContent = '✓ Downloaded';
      if (window.__refreshFolder) window.__refreshFolder();
    } catch (err) {
      btn.textContent = 'Failed';
      console.error('Cite resolve failed:', err);
    }
  });

  pdfViewer.setOnCitationChat((refNum, displayTitle, googleUrl) => {
    if (!currentTree) return;
    currentTree.addMessage('assistant', displayTitle);
    renderMessages();
    saveCurrentTree();
  });

  pdfViewer.setOnStampClick((stamp) => {
    viewingStamp = stamp;
    messagesDiv.style.display = 'none';
    stampView.style.display = '';
    renderStampView();
  });

  pdfViewer.setOnStampDelete((stamp) => {
    currentStamps = currentStamps.filter(s => s.id !== stamp.id);
    saveStamps();
    pdfViewer.setStamps(currentStamps);
  });

  pdfViewer.setOnCommentStamp((pos) => {
    const stamp = {
      id: crypto.randomUUID(),
      pdfPath: pdfViewer.getCurrentPath(),
      pageNumber: pos.page,
      x: pos.x,
      y: pos.y,
      w: pos.w,
      h: pos.h,
      rects: pos.rects || [],
      selectedText: pos.selectedText,
      messageId: null,
      content: pos.comment,
      createdAt: new Date().toISOString(),
    };
    currentStamps.push(stamp);
    saveStamps();
    pdfViewer.setStamps(currentStamps);
  });

  document.getElementById('btn-back-to-chat').addEventListener('click', () => {
    viewingStamp = null;
    stampView.style.display = 'none';
    messagesDiv.style.display = '';
  });

  document.getElementById('btn-delete-stamp').addEventListener('click', () => {
    if (!viewingStamp) return;
    currentStamps = currentStamps.filter(s => s.id !== viewingStamp.id);
    saveStamps();
    pdfViewer.setStamps(currentStamps);
    viewingStamp = null;
    stampView.style.display = 'none';
    messagesDiv.style.display = '';
  });

  function renderStampView() {
    if (!viewingStamp) return;
    stampViewContent.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'chat-message assistant';
    div.innerHTML = marked.parse(viewingStamp.content);
    stampViewContent.appendChild(div);

    const editBtn = document.createElement('button');
    editBtn.className = 'msg-edit-btn';
    editBtn.textContent = '✎ Edit';
    editBtn.addEventListener('click', () => {
      const ta = document.createElement('textarea');
      ta.className = 'msg-edit-textarea';
      ta.value = viewingStamp.content;
      ta.rows = Math.max(5, viewingStamp.content.split('\n').length + 2);

      const saveBtn = document.createElement('button');
      saveBtn.className = 'msg-edit-btn';
      saveBtn.textContent = '💾 Save';
      saveBtn.addEventListener('click', () => {
        viewingStamp.content = ta.value;
        const idx = currentStamps.findIndex(s => s.id === viewingStamp.id);
        if (idx >= 0) currentStamps[idx].content = ta.value;
        saveStamps();
        renderStampView();
      });

      stampViewContent.innerHTML = '';
      stampViewContent.appendChild(ta);
      stampViewContent.appendChild(saveBtn);
      ta.focus();
    });
    stampViewContent.appendChild(editBtn);
  }

  function createStampFromMessage(msg) {
    const pos = pdfViewer.getSelectionPosition() || pdfViewer.getSavedPosition();
    if (!pos) return false;
    const stamp = {
      id: crypto.randomUUID(),
      pdfPath: pdfViewer.getCurrentPath(),
      pageNumber: pos.page,
      x: pos.x,
      y: pos.y,
      w: pos.w,
      h: pos.h,
      selectedText: pos.selectedText,
      messageId: msg.id,
      content: msg.content,
      createdAt: new Date().toISOString(),
    };
    currentStamps.push(stamp);
    saveStamps();
    pdfViewer.setStamps(currentStamps);
    return true;
  }

  async function saveStamps() {
    if (!pdfViewer.getCurrentPath()) return;
    try {
      await invoke('save_stamps', { pdfPath: pdfViewer.getCurrentPath(), data: JSON.stringify(currentStamps) });
    } catch (e) {
      console.warn('Failed to save stamps:', e);
    }
  }

  async function loadStampsForPdf(pdfPath) {
    if (allStamps[pdfPath]) {
      currentStamps = allStamps[pdfPath];
    } else {
      try {
        const data = await invoke('load_stamps', { pdfPath });
        currentStamps = data ? JSON.parse(data) : [];
      } catch {
        currentStamps = [];
      }
      allStamps[pdfPath] = currentStamps;
    }
    pdfViewer.setStamps(currentStamps);
  }

  newChatBtn.addEventListener('click', () => {
    if (!currentTree) return;
    currentTree.restart();
    renderMessages();
    saveCurrentTree();
  });

  // --- Tree modal ---

  treeBtn.addEventListener('click', () => {
    if (!currentTree) return;
    renderTreeView();
    treeModal.style.display = '';
  });

  document.getElementById('btn-close-tree').addEventListener('click', () => {
    treeModal.style.display = 'none';
  });

  treeModal.addEventListener('click', (e) => {
    if (e.target === treeModal) treeModal.style.display = 'none';
  });

  // --- Download All References ---

  let downloadingAll = false;

  if (downloadAllBtn) downloadAllBtn.addEventListener('click', async () => {
    if (downloadingAll) return;
    const refsMap = pdfViewer.getReferencesMap();
    const refNums = Object.keys(refsMap).map(Number).sort((a, b) => a - b);
    if (refNums.length === 0 || !window.__lastFolder || !pdfViewer.getCurrentPath()) return;

    downloadingAll = true;
    if (downloadAllBtn) { downloadAllBtn.disabled = true; downloadAllBtn.textContent = 'Downloading...'; }

    // Create subfolder named after the PDF
    const pdfName = pdfViewer.getCurrentPath().split('/').pop().replace(/\.pdf$/i, '');
    const subFolder = window.__lastFolder + '/' + pdfName;
    try {
      await invoke('create_directory', { path: subFolder });
    } catch (e) {
      if (downloadAllBtn) { downloadAllBtn.textContent = 'Download All'; downloadAllBtn.disabled = false; }
      downloadingAll = false;
      if (currentTree) {
        currentTree.addMessage('assistant', `Failed to create folder: ${e}`);
        renderMessages();
        saveCurrentTree();
      }
      return;
    }

    const failed = [];
    let downloaded = 0;

    if (currentTree) {
      currentTree.addMessage('user', `Download all ${refNums.length} references`);
      currentTree.addMessage('assistant', `Starting download of ${refNums.length} references to ${pdfName}/...`);
      renderMessages();
    }

    const statusMsg = currentTree ? currentTree.messages[currentTree.activeNodeId] : null;

    // Phase 1: Resolve all citations via Semantic Scholar
    const resolved = [];
    for (let i = 0; i < refNums.length; i++) {
      const num = refNums[i];
      const refText = refsMap[num];
      if (statusMsg) {
        statusMsg.content = `**Phase 1: Resolving citations** ${i + 1}/${refNums.length}\nCurrent: [${num}]`;
        renderMessages();
      }
      try {
        const doiMatch = refText.match(/10\.\d{4,}[^\s]*/);
        let query, queryType;
        if (doiMatch) {
          query = doiMatch[0].replace(/[.,;)\]]+$/, '');
          queryType = 'doi';
        } else {
          query = refText.replace(/^\s*\[\d+\]\s*/, '').replace(/^\s*\d+\.\s*/, '');
          queryType = 'search';
        }
        const paper = await invoke('resolve_citation', { query, queryType, apiKey: S2_API_KEY });
        resolved.push({ num, refText, paper });
      } catch (e) {
        resolved.push({ num, refText, paper: null, error: String(e) });
      }
    }

    // Phase 2: Download — venue first, then arxiv fallback
    // Phase 2: Download venue PDFs
    const pendingArxiv = [];

    for (let i = 0; i < resolved.length; i++) {
      const { num, refText, paper, error } = resolved[i];
      if (!paper) {
        failed.push({ num, title: refText.slice(0, 60), reason: error || 'Resolution failed' });
        continue;
      }

      const safeTitle = (paper.title || 'paper').replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 70).trim();
      const filename = `[${num}] ${safeTitle}.pdf`;

      if (statusMsg) {
        statusMsg.content = `**Phase 2: Venue downloads** ${downloaded}/${refNums.length} done, ${pendingArxiv.length} deferred\nCurrent: [${num}] ${safeTitle}\nURL: ${paper.venue_pdf || 'none'}`;
        renderMessages();
      }
      console.log(`[DL] Phase 2 [${num}] venue_pdf=${paper.venue_pdf || 'none'} arxiv_pdf=${paper.arxiv_pdf || 'none'}`);

      if (paper.venue_pdf) {
        try {
          console.log(`[DL] Downloading venue: ${paper.venue_pdf}`);
          await invoke('download_pdf', { url: paper.venue_pdf, folder: subFolder, filename });
          console.log(`[DL] [${num}] venue OK`);
          downloaded++;
          continue;
        } catch (dlErr) {
          console.warn(`[DL] [${num}] venue FAILED: ${dlErr}`);
        }
      }

      pendingArxiv.push({ num, refText, paper, filename });
    }

    console.log(`[DL] Phase 2 done. Downloaded: ${downloaded}, pending arxiv: ${pendingArxiv.length}`);

    // Phase 3: Download arxiv fallbacks (S2 known arXiv IDs)
    const pendingArxivSearch = [];
    for (let i = 0; i < pendingArxiv.length; i++) {
      const { num, paper, filename } = pendingArxiv[i];
      if (statusMsg) {
        statusMsg.content = `**Phase 3: arXiv fallbacks** ${i + 1}/${pendingArxiv.length}\nCurrent: [${num}]\nURL: ${paper.arxiv_pdf || 'none'}`;
        renderMessages();
      }
      console.log(`[DL] Phase 3 [${num}] arxiv_pdf=${paper.arxiv_pdf || 'none'}`);

      if (paper.arxiv_pdf) {
        try {
          console.log(`[DL] Downloading arxiv: ${paper.arxiv_pdf}`);
          await invoke('download_pdf', { url: paper.arxiv_pdf, folder: subFolder, filename });
          console.log(`[DL] [${num}] arxiv OK`);
          downloaded++;
          continue;
        } catch (dlErr) {
          console.warn(`[DL] [${num}] arxiv FAILED: ${dlErr}`);
        }
      }

      pendingArxivSearch.push({ num, paper, filename });
    }
    console.log(`[DL] Phase 3 done. Downloaded: ${downloaded}, pending arxiv search: ${pendingArxivSearch.length}`);

    // Phase 4: Search arXiv by title for remaining papers
    for (let i = 0; i < pendingArxivSearch.length; i++) {
      const { num, paper, filename } = pendingArxivSearch[i];
      const title = paper.title || '';
      if (!title) {
        const doi = paper.doi ? `https://doi.org/${paper.doi}` : '';
        const s2 = paper.s2_url || '';
        failed.push({ num, title: '?', doi, s2, arxiv: '', reason: 'No title to search' });
        continue;
      }

      if (statusMsg) {
        statusMsg.content = `**Phase 4: arXiv title search** ${i + 1}/${pendingArxivSearch.length}\nCurrent: [${num}] ${title.slice(0, 60)}`;
        renderMessages();
      }
      console.log(`[DL] Phase 4 [${num}] searching arXiv for: ${title.slice(0, 60)}`);

      try {
        const arxivUrl = await invoke('search_arxiv', { title });
        console.log(`[DL] [${num}] arXiv found: ${arxivUrl}`);
        await invoke('download_pdf', { url: arxivUrl, folder: subFolder, filename });
        console.log(`[DL] [${num}] arXiv search download OK`);
        downloaded++;
      } catch (e) {
        console.log(`[DL] [${num}] arXiv search failed: ${e}`);
        const doi = paper.doi ? `https://doi.org/${paper.doi}` : '';
        const s2 = paper.s2_url || '';
        const arxiv = paper.arxiv_id ? `https://arxiv.org/abs/${paper.arxiv_id}` : '';
        failed.push({ num, title: paper.title || '?', doi, s2, arxiv, reason: 'No open access PDF' });
      }
    }
    console.log(`[DL] Phase 4 done. Total downloaded: ${downloaded}, failed: ${failed.length}`);

    // Final report
    let report = `**Downloaded ${downloaded}/${refNums.length}** references to \`${pdfName}/\``;

    if (failed.length > 0) {
      report += `\n\n---\n\n**${failed.length} papers not downloaded:**\n\n`;
      for (const f of failed) {
        const links = [];
        if (f.doi) links.push(`[DOI](${f.doi})`);
        if (f.arxiv) links.push(`[arXiv](${f.arxiv})`);
        if (f.s2) links.push(`[S2](${f.s2})`);
        report += `- **[${f.num}]** ${f.title}`;
        if (links.length > 0) report += ` — ${links.join(' · ')}`;
        if (f.reason) report += ` *(${f.reason})*`;
        report += `\n`;
      }
    }

    console.log('[DL] Report length:', report.length);
    console.log('[DL] statusMsg exists:', !!statusMsg);

    if (statusMsg) {
      statusMsg.content = report;
      try {
        renderMessages();
        console.log('[DL] renderMessages OK');
      } catch (renderErr) {
        console.error('[DL] renderMessages FAILED:', renderErr);
      }
      saveCurrentTree();
    }

    if (window.__refreshFolder) window.__refreshFolder();

    if (downloadAllBtn) { downloadAllBtn.textContent = 'Download All'; downloadAllBtn.disabled = false; }
    downloadingAll = false;
  });

  // --- Core ---

  async function sendMessage(text) {
    if (!text) return;
    chatInput.value = '';

    if (!currentTree) return;

    currentTree.addMessage('user', text);
    renderMessages();

    const loadingEl = appendLoadingMessage();

    try {
      const apiMessages = buildApiMessages();
      const response = await invoke('send_chat_message', {
        messages: apiMessages,
        model: settings.model,
        apiUrl: settings.url,
        apiKey: settings.key,
      });

      currentTree.addMessage('assistant', response);
      removeLoadingMessage(loadingEl);
      renderMessages();
      saveCurrentTree();
    } catch (err) {
      removeLoadingMessage(loadingEl);
      currentTree.addMessage('assistant', `Error: ${err}`);
      renderMessages();
      saveCurrentTree();
    }
  }

  function buildApiMessages() {
    const msgs = [];
    const pdfText = pdfViewer.getPdfText();
    const pdfPath = pdfViewer.getCurrentPath();

    const instructions = 'Stay concise only saying things that you need to to convey the answer. Make the goal to increase in understanding and intellectual flexibility. When defining words give the top 3 definitions, the prefix, suffix meanings.';

    if (pdfText) {
      const name = pdfPath ? pdfPath.split('/').pop() : 'document';
      msgs.push({
        role: 'system',
        content: `${instructions}\n\nThe user is reading "${name}". Here is the document text:\n\n${pdfText}\n\nAnswer questions based on this document when relevant.`
      });
    } else {
      msgs.push({ role: 'system', content: `${instructions}\n\nNo PDF is currently loaded.` });
    }

    if (currentTree) {
      for (const msg of currentTree.getCurrentPath()) {
        msgs.push({ role: msg.role, content: msg.content });
      }
    }

    return msgs;
  }

  function collectCitations(text) {
    const re = /\[[\d\s,\n]+\]/g;
    const nums = new Set();
    let m;
    while ((m = re.exec(text)) !== null) {
      for (const d of m[0].match(/\d+/g) || []) {
        const n = parseInt(d);
        if (n < 10000) nums.add(n);
      }
    }
    return [...nums].sort((a, b) => a - b);
  }

  function buildReferencesBlock(citationNums) {
    const map = pdfViewer.getReferencesMap();
    if (!map || citationNums.length === 0) return '';
    const lines = [];
    for (const num of citationNums) {
      const ref = map[num];
      if (!ref) continue;
      const text = typeof ref === 'string' ? ref : (ref.title || ref.fullText || '');
      lines.push(`[${num}] ${text}`);
    }
    if (lines.length === 0) return '';
    return '\n\n---\n**References**\n' + lines.map(l => `- ${l}`).join('\n');
  }

  function renderMessages() {
    messagesDiv.innerHTML = '';
    if (!currentTree) return;
    const path = currentTree.getCurrentPath();
    for (const msg of path) {
      const div = document.createElement('div');
      div.className = `chat-message ${msg.role}`;
      if (msg.role === 'assistant') {
        const citations = collectCitations(msg.content);
        const refsBlock = buildReferencesBlock(citations);
        div.innerHTML = marked.parse(msg.content + refsBlock);

        const editBtn = document.createElement('button');
        editBtn.className = 'msg-edit-btn';
        editBtn.textContent = '✎';
        editBtn.title = 'Edit message';
        editBtn.addEventListener('click', () => {
          const ta = document.createElement('textarea');
          ta.className = 'msg-edit-textarea';
          ta.value = msg.content;
          ta.rows = Math.max(4, msg.content.split('\n').length + 1);
          const saveBtn = document.createElement('button');
          saveBtn.className = 'msg-edit-btn';
          saveBtn.textContent = '💾 Save';
          saveBtn.addEventListener('click', () => {
            msg.content = ta.value;
            if (currentTree.messages[msg.id]) currentTree.messages[msg.id].content = ta.value;
            saveCurrentTree();
            renderMessages();
          });
          div.innerHTML = '';
          div.style.maxWidth = '100%';
          div.style.width = '100%';
          div.appendChild(ta);
          div.appendChild(saveBtn);
          ta.style.height = Math.max(150, ta.scrollHeight) + 'px';
          ta.focus();
        });
        div.appendChild(editBtn);
      } else {
        div.textContent = msg.content;
      }
      messagesDiv.appendChild(div);
    }
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }

  function appendLoadingMessage() {
    const div = document.createElement('div');
    div.className = 'chat-message assistant loading';
    div.textContent = 'Thinking...';
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    return div;
  }

  function removeLoadingMessage(el) {
    el?.remove();
  }

  // --- Tree View ---

  function renderTreeView() {
    treeView.innerHTML = '';
    if (!currentTree) return;
    const roots = currentTree.getRoots();
    const activePath = new Set(currentTree.getCurrentPath().map(m => m.id));
    activePath.add(currentTree.rootId);
    for (const root of roots) {
      treeView.appendChild(buildTreeNode(root, activePath, 0));
    }
  }

  function buildTreeNode(msg, activePath, depth) {
    const wrapper = document.createElement('div');

    const row = document.createElement('div');
    row.className = 'tree-msg';
    if (msg.id === currentTree.activeNodeId) row.classList.add('active-node');
    else if (activePath.has(msg.id)) row.classList.add('on-path');

    const isRoot = msg.role === 'root';

    const role = document.createElement('span');
    role.className = `tree-msg-role ${isRoot ? 'root' : msg.role}`;
    role.textContent = isRoot ? '●' : (msg.role === 'user' ? 'You' : 'AI');

    const preview = document.createElement('span');
    preview.className = 'tree-msg-preview';
    preview.textContent = isRoot ? 'Start new conversation' : (msg.content.length > 60 ? msg.content.slice(0, 60) + '...' : msg.content);

    row.appendChild(role);
    row.appendChild(preview);

    if (msg.children.length > 1) {
      const fork = document.createElement('span');
      fork.className = 'tree-fork-indicator';
      fork.textContent = `${msg.children.length} branches`;
      row.appendChild(fork);
    }

    if (msg.role === 'assistant') {
      const stampIcon = document.createElement('span');
      stampIcon.className = 'tree-stamp-btn';
      stampIcon.textContent = '📌';
      stampIcon.title = 'Stamp this message (select text in PDF first)';
      stampIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        if (createStampFromMessage(msg)) {
          stampIcon.textContent = '✓';
        }
      });
      row.appendChild(stampIcon);
    }

    row.addEventListener('click', () => {
      currentTree.forkFrom(msg.id);
      renderMessages();
      renderTreeView();
      saveCurrentTree();
    });

    wrapper.appendChild(row);

    if (msg.children.length > 0) {
      const branch = document.createElement('div');
      branch.className = 'tree-branch';
      for (const childId of msg.children) {
        const child = currentTree.messages[childId];
        if (child) branch.appendChild(buildTreeNode(child, activePath, depth + 1));
      }
      wrapper.appendChild(branch);
    }

    return wrapper;
  }

  // --- Persistence ---

  async function saveCurrentTree() {
    if (!currentTree) return;
    try {
      await invoke('save_chat_tree', { pdfPath: currentTree.pdfPath, data: currentTree.toJSON() });
    } catch (e) {
      console.warn('Failed to save chat tree:', e);
    }
  }

  async function loadTreeForPdf(pdfPath) {
    if (trees[pdfPath]) {
      currentTree = trees[pdfPath];
      renderMessages();
      return;
    }
    try {
      const data = await invoke('load_chat_tree', { pdfPath });
      if (data) {
        currentTree = ChatTree.fromJSON(data);
      } else {
        currentTree = new ChatTree(pdfPath);
      }
    } catch {
      currentTree = new ChatTree(pdfPath);
    }
    trees[pdfPath] = currentTree;
    renderMessages();
  }

  async function saveSession() {
    try {
      await invoke('save_session', {
        data: JSON.stringify({
          settings,
          lastFolder: window.__lastFolder || null,
          lastPdf: pdfViewer.getCurrentPath(),
        })
      });
    } catch (e) {
      console.warn('Failed to save session:', e);
    }
  }

  async function loadSessionData() {
    try {
      const data = await invoke('load_session');
      if (data) return JSON.parse(data);
    } catch {}
    return null;
  }

  // --- Public API ---

  return {
    onPdfLoaded(pdfPath) {
      loadTreeForPdf(pdfPath);
      loadStampsForPdf(pdfPath);
      saveSession();
      if (downloadAllBtn) downloadAllBtn.style.display = 'none';
      // References map loads async — check periodically
      let checks = 0;
      const iv = setInterval(() => {
        const map = pdfViewer.getReferencesMap();
        if (Object.keys(map).length > 0) {
          if (downloadAllBtn) downloadAllBtn.style.display = '';
          clearInterval(iv);
        }
        if (++checks > 30) clearInterval(iv);
      }, 500);
    },
    saveSession,
    loadSessionData,
    getSettings: () => settings,
  };
}
