const { invoke } = window.__TAURI__.core;

// Polyfill for WebKitGTK
if (!Promise.withResolvers) {
  Promise.withResolvers = function() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

let pdfjsLib = null;

async function loadPdfJs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import('./vendor/pdf.mjs?v=4');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs', import.meta.url).href;
  return pdfjsLib;
}

export function initPdfViewer() {
  let currentPdf = null;
  let currentPage = 1;
  let totalPages = 0;
  let currentScale = 1.0;
  let currentPdfPath = null;
  let pdfText = null;
  let pageTexts = [];
  let rendering = false;
  let currentTextLayer = null;
  let stamps = [];
  let onStampClick = null;
  let onStampDelete = null;
  let onCiteResolve = null;
  let pendingHighlight = null;
  let citationOccurrences = {}; // refNum → [{page, charStart}]

  // --- Keyword search ---
  let searchMatches = []; // [{page, spanIndex, startOffset, endOffset}]
  let searchCurrentIdx = -1;
  let searchQuery = '';
  let searchCaseSensitive = false;

  const searchInput = document.getElementById('search-input');
  const searchCase = document.getElementById('search-case');
  const searchCount = document.getElementById('search-count');

  function buildSearchMatches(query, caseSensitive) {
    searchMatches = [];
    if (!query || pageTexts.length === 0) return;
    for (let p = 0; p < pageTexts.length; p++) {
      const text = caseSensitive ? pageTexts[p] : pageTexts[p].toLowerCase();
      const q = caseSensitive ? query : query.toLowerCase();
      let idx = 0;
      while ((idx = text.indexOf(q, idx)) !== -1) {
        searchMatches.push({ page: p + 1, charStart: idx, charEnd: idx + q.length });
        idx += q.length;
      }
    }
  }

  function highlightSearchOnPage() {
    pageWrapper.querySelectorAll('.search-hl-overlay').forEach(el => el.remove());
    if (!searchQuery) return;

    const spans = textLayerDiv.querySelectorAll('span');
    const wrapperRect = pageWrapper.getBoundingClientRect();
    const q = searchCaseSensitive ? searchQuery : searchQuery.toLowerCase();

    // Count which match on this page we're at (for active highlight)
    let pageMatchesBefore = 0;
    for (const m of searchMatches) {
      if (m.page < currentPage) pageMatchesBefore++;
    }

    let matchIdx = 0;
    for (const span of spans) {
      const spanText = span.textContent;
      const searchIn = searchCaseSensitive ? spanText : spanText.toLowerCase();
      let pos = 0;
      while ((pos = searchIn.indexOf(q, pos)) !== -1) {
        const globalIdx = pageMatchesBefore + matchIdx;
        const isActive = globalIdx === searchCurrentIdx;
        const node = span.firstChild || span;
        const range = document.createRange();
        range.setStart(node, pos);
        range.setEnd(node, pos + q.length);

        const rects = range.getClientRects();
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i];
          if (r.width < 1) continue;
          const hl = document.createElement('div');
          hl.className = 'search-hl-overlay' + (isActive ? ' search-hl-active' : '');
          hl.style.position = 'absolute';
          hl.style.left = (r.left - wrapperRect.left) + 'px';
          hl.style.top = (r.top - wrapperRect.top) + 'px';
          hl.style.width = r.width + 'px';
          hl.style.height = r.height + 'px';
          hl.style.pointerEvents = 'none';
          hl.style.zIndex = '6';
          pageWrapper.appendChild(hl);
          if (isActive && i === 0) {
            const hlRect = hl.getBoundingClientRect();
            const containerRect = pdfContainer.getBoundingClientRect();
            const scrollTop = pdfContainer.scrollTop + (hlRect.top - containerRect.top) - containerRect.height / 2;
            pdfContainer.scrollTo({ top: scrollTop, behavior: 'smooth' });
          }
        }
        matchIdx++;
        pos += q.length;
      }
    }
  }

  function doSearch(direction) {
    const query = searchInput.value;
    const caseSensitive = searchCase.checked;

    if (query !== searchQuery || caseSensitive !== searchCaseSensitive) {
      searchQuery = query;
      searchCaseSensitive = caseSensitive;
      buildSearchMatches(query, caseSensitive);
      searchCurrentIdx = searchMatches.length > 0 ? 0 : -1;
    } else if (searchMatches.length > 0) {
      if (direction === 'next') {
        searchCurrentIdx = (searchCurrentIdx + 1) % searchMatches.length;
      } else {
        searchCurrentIdx = (searchCurrentIdx - 1 + searchMatches.length) % searchMatches.length;
      }
    }

    if (searchMatches.length === 0) {
      searchCount.textContent = query ? '0/0' : '';
      highlightSearchOnPage();
      return;
    }

    searchCount.textContent = `${searchCurrentIdx + 1}/${searchMatches.length}`;

    const target = searchMatches[searchCurrentIdx];
    if (target.page !== currentPage) {
      currentPage = target.page;
      renderPage();
    } else {
      highlightSearchOnPage();
    }
  }

  document.getElementById('btn-search-next').addEventListener('click', () => doSearch('next'));
  document.getElementById('btn-search-prev').addEventListener('click', () => doSearch('prev'));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSearch(e.shiftKey ? 'prev' : 'next'); }
  });
  searchCase.addEventListener('change', () => {
    searchQuery = '';
    doSearch('next');
  });
  let referencesMap = {};
  let onCitationChat = null;

  const canvas = document.getElementById('pdf-canvas');
  const ctx = canvas.getContext('2d');
  const pageInfo = document.getElementById('page-info');
  const placeholder = document.getElementById('pdf-placeholder');
  const pageWrapper = document.getElementById('pdf-page-wrapper');
  const textLayerDiv = document.getElementById('text-layer');
  const zoomLevel = document.getElementById('zoom-level');
  const pdfContainer = document.getElementById('pdf-container');

  const MIN_SCALE = 0.25;
  const MAX_SCALE = 5.0;
  const ZOOM_STEP = 0.1;

  document.getElementById('btn-prev-page').addEventListener('click', () => {
    if (currentPage > 1) { currentPage--; renderPage(); }
  });
  document.getElementById('btn-next-page').addEventListener('click', () => {
    if (currentPage < totalPages) { currentPage++; renderPage(); }
  });

  function clampPage() {
    if (currentPage < 1) currentPage = 1;
    if (totalPages > 0 && currentPage > totalPages) currentPage = totalPages;
  }
  document.getElementById('btn-zoom-in').addEventListener('click', () => {
    setScale(currentScale + ZOOM_STEP);
  });
  document.getElementById('btn-zoom-out').addEventListener('click', () => {
    setScale(currentScale - ZOOM_STEP);
  });

  let mouseDownPos = null;
  let isDragging = false;
  pageWrapper.addEventListener('mousedown', (e) => {
    mouseDownPos = { x: e.clientX, y: e.clientY };
    isDragging = false;
  });
  pageWrapper.addEventListener('mousemove', (e) => {
    if (!mouseDownPos) return;
    const dx = Math.abs(e.clientX - mouseDownPos.x);
    const dy = Math.abs(e.clientY - mouseDownPos.y);
    if (!isDragging && (dx > 5 || dy > 5)) {
      isDragging = true;
      pageWrapper.style.cursor = 'text';
    }
  });
  let onCommentStamp = null;
  let selectionRect = null;

  pageWrapper.addEventListener('mouseup', (e) => {
    const wasDrag = isDragging;
    pageWrapper.style.cursor = '';
    isDragging = false;
    if (!mouseDownPos) return;
    const dx = Math.abs(e.clientX - mouseDownPos.x);
    const dy = Math.abs(e.clientY - mouseDownPos.y);
    mouseDownPos = null;

    if (wasDrag || dx > 5 || dy > 5) {
      // Text was selected — store rect, position, and create persistent highlight
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) { selectionRect = null; savedPosition = null; return; }
        const range = sel.getRangeAt(0);
        if (!textLayerDiv.contains(range.startContainer)) { selectionRect = null; savedPosition = null; return; }
        selectionRect = range.getBoundingClientRect();
        savedPosition = getSelectionPosition();
        showSelectionHighlight();
      }, 20);
      return;
    }

    // Clean click inside PDF — clear selection highlight
    if (!commentEditing) {
      selectionRect = null;
      savedPosition = null;
      removeSelectionHighlight();
    }
    // Clean click — check for PDF links
    const links = pageWrapper.querySelectorAll('.pdf-link-annot');
    for (const link of links) {
      const lr = link.getBoundingClientRect();
      if (e.clientX >= lr.left && e.clientX <= lr.right && e.clientY >= lr.top && e.clientY <= lr.bottom) {
        invoke('open_url', { url: link.href });
        return;
      }
    }
  });

  // Persistent selection highlight
  let selectionHighlightEl = null;

  function showSelectionHighlight() {
    removeSelectionHighlight();
    if (!savedPosition || !savedPosition.rects || savedPosition.rects.length === 0) return;
    selectionHighlightEl = document.createElement('div');
    selectionHighlightEl.className = 'selection-highlight-container';
    for (const r of savedPosition.rects) {
      const el = document.createElement('div');
      el.className = 'selection-highlight';
      el.style.left = (r.x * currentScale) + 'px';
      el.style.top = (r.y * currentScale) + 'px';
      el.style.width = (r.w * currentScale) + 'px';
      el.style.height = (r.h * currentScale) + 'px';
      selectionHighlightEl.appendChild(el);
    }
    const stampLayer = pageWrapper.querySelector('.stampLayer');
    if (stampLayer) stampLayer.appendChild(selectionHighlightEl);
  }

  function removeSelectionHighlight() {
    if (selectionHighlightEl) { selectionHighlightEl.remove(); selectionHighlightEl = null; }
  }

  // Show "Add Comment" on hover over selected text
  let commentPopup = null;
  let commentTimeout = null;
  let commentEditing = false;
  let savedPosition = null;
  let commentHighlight = null;

  function removeCommentPopup() {
    if (commentEditing) return;
    if (commentPopup) { commentPopup.remove(); commentPopup = null; }
    if (commentHighlight) { commentHighlight.remove(); commentHighlight = null; }
  }

  function forceRemoveCommentPopup() {
    commentEditing = false;
    if (commentPopup) { commentPopup.remove(); commentPopup = null; }
    if (commentHighlight) { commentHighlight.remove(); commentHighlight = null; }
    removeSelectionHighlight();
    savedPosition = null;
    selectionRect = null;
  }

  function showCommentHighlight() {
    if (!savedPosition) return;
    if (commentHighlight) { commentHighlight.remove(); commentHighlight = null; }
    commentHighlight = document.createElement('div');
    commentHighlight.style.position = 'absolute';
    commentHighlight.style.top = '0';
    commentHighlight.style.left = '0';
    commentHighlight.style.pointerEvents = 'none';
    const rects = savedPosition.rects || [savedPosition];
    for (const r of rects) {
      const el = document.createElement('div');
      el.className = 'comment-highlight-overlay';
      el.style.left = (r.x * currentScale) + 'px';
      el.style.top = (r.y * currentScale) + 'px';
      el.style.width = (r.w * currentScale) + 'px';
      el.style.height = (r.h * currentScale) + 'px';
      commentHighlight.appendChild(el);
    }
    const stampLayer = pageWrapper.querySelector('.stampLayer');
    if (stampLayer) stampLayer.appendChild(commentHighlight);
  }

  textLayerDiv.addEventListener('mousemove', (e) => {
    if (!selectionRect || commentEditing) return;
    const mx = e.clientX, my = e.clientY;
    const r = selectionRect;
    const inSelection = mx >= r.left - 5 && mx <= r.right + 5 && my >= r.top - 5 && my <= r.bottom + 5;
    if (inSelection && !commentPopup) {
      clearTimeout(commentTimeout);

      if (!savedPosition) savedPosition = getSelectionPosition();
      if (!savedPosition) return;

      commentPopup = document.createElement('div');
      commentPopup.className = 'comment-popup';

      const addBtn = document.createElement('button');
      addBtn.className = 'comment-popup-btn';
      addBtn.textContent = '💬 Add Comment';
      addBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        commentEditing = true;
        addBtn.style.display = 'none';
        showCommentHighlight();

        const ta = document.createElement('textarea');
        ta.className = 'comment-popup-textarea';
        ta.placeholder = 'Type your comment...';
        ta.rows = 3;

        const saveBtn = document.createElement('button');
        saveBtn.className = 'comment-popup-save';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', (ev2) => {
          ev2.stopPropagation();
          const text = ta.value.trim();
          if (savedPosition && onCommentStamp) {
            onCommentStamp({ ...savedPosition, comment: text });
          }
          forceRemoveCommentPopup();
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'comment-popup-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', (ev2) => {
          ev2.stopPropagation();
          forceRemoveCommentPopup();
        });

        commentPopup.appendChild(ta);
        const btnRow = document.createElement('div');
        btnRow.className = 'comment-popup-row';
        btnRow.appendChild(saveBtn);
        btnRow.appendChild(cancelBtn);
        commentPopup.appendChild(btnRow);
        setTimeout(() => ta.focus(), 10);
      });

      commentPopup.appendChild(addBtn);
      commentPopup.addEventListener('mousedown', (ev) => { ev.preventDefault(); ev.stopPropagation(); });
      commentPopup.addEventListener('mouseenter', () => clearTimeout(commentTimeout));
      commentPopup.addEventListener('mouseleave', () => {
        if (!commentEditing) commentTimeout = setTimeout(removeCommentPopup, 300);
      });

      const wrapperRect = pageWrapper.getBoundingClientRect();
      commentPopup.style.left = (r.left - wrapperRect.left) + 'px';
      commentPopup.style.top = (r.bottom - wrapperRect.top + 4) + 'px';
      pageWrapper.appendChild(commentPopup);
    } else if (!inSelection && commentPopup && !commentEditing) {
      commentTimeout = setTimeout(removeCommentPopup, 300);
    }
  });

  pdfContainer.addEventListener('wheel', (e) => {
    if (!currentPdf || !e.ctrlKey) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    setScale(currentScale + delta);
  }, { passive: false });

  function setScale(newScale) {
    newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
    newScale = Math.round(newScale * 100) / 100;
    if (newScale === currentScale) return;
    currentScale = newScale;
    zoomLevel.textContent = Math.round(currentScale * 100) + '%';
    renderPage();
  }

  async function loadPdf(filePath, fileName) {
    currentPdfPath = filePath;
    currentPage = 1;
    pdfText = null;

    document.getElementById('current-pdf-name').textContent = fileName || filePath.split('/').pop();

    const lib = await loadPdfJs();
    const base64 = await invoke('read_pdf_bytes', { path: filePath });
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

    currentPdf = await lib.getDocument({
      data: bytes,
      isOffscreenCanvasSupported: false,
      isEvalSupported: true,
      useSystemFonts: true,
    }).promise;
    totalPages = currentPdf.numPages;

    placeholder.style.display = 'none';
    pageWrapper.style.display = '';
    renderPage();
    extractAllText();
    loadCitationPipeline(filePath);
    checkOcrState();
  }

  let pendingRender = false;
  async function renderPage() {
    if (!currentPdf) return;
    clampPage();
    if (rendering) { pendingRender = true; return; }
    rendering = true;
    try {
      const page = await currentPdf.getPage(currentPage);
      const viewport = page.getViewport({ scale: currentScale });
      const pixelRatio = window.devicePixelRatio || 1;

      // Buffer at high-DPI resolution, CSS at logical size
      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = Math.floor(viewport.width) + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';

      const transform = pixelRatio !== 1 ? [pixelRatio, 0, 0, pixelRatio, 0, 0] : null;
      try {
        await page.render({ canvasContext: ctx, viewport, transform }).promise;
      } catch (renderErr) {
        console.error('PDF render error:', renderErr);
        document.title = 'RENDER ERR: ' + renderErr.message;
      }

      // Set CSS variables that pdf.js TextLayer/setLayerDimensions depend on
      pageWrapper.style.setProperty('--scale-factor', currentScale);
      pageWrapper.style.setProperty('--total-scale-factor', currentScale);
      pageWrapper.style.setProperty('--scale-round-x', '1px');
      pageWrapper.style.setProperty('--scale-round-y', '1px');

      // Rebuild text layer
      textLayerDiv.innerHTML = '';
      if (currentTextLayer) {
        currentTextLayer.cancel();
        currentTextLayer = null;
      }

      const textContent = await page.getTextContent();
      try {
        const textLayer = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container: textLayerDiv,
          viewport: viewport,
        });
        currentTextLayer = textLayer;
        await textLayer.render();
        makeCitationsClickable();
        highlightSearchOnPage();
        if (pendingHighlight) {
          highlightReferenceText(pendingHighlight);
          pendingHighlight = null;
        }
        if (pendingScrollCitation) {
          scrollToCitation(pendingScrollCitation.refNum, pendingScrollCitation.charStart);
          pendingScrollCitation = null;
        }
      } catch (textErr) {
        console.error('TextLayer error:', textErr);
      }

      // Rebuild annotation layer (makes PDF links clickable)
      let annotLayerDiv = pageWrapper.querySelector('.annotationLayer');
      if (!annotLayerDiv) {
        annotLayerDiv = document.createElement('div');
        annotLayerDiv.className = 'annotationLayer';
        pageWrapper.appendChild(annotLayerDiv);
      }
      annotLayerDiv.innerHTML = '';
      annotLayerDiv.style.width = Math.floor(viewport.width) + 'px';
      annotLayerDiv.style.height = Math.floor(viewport.height) + 'px';

      const annotations = await page.getAnnotations();
      for (const annot of annotations) {
        if (annot.subtype === 'Link' && annot.url) {
          const rect = annot.rect;
          const [x1, y1, x2, y2] = pdfjsLib.Util.normalizeRect(
            viewport.convertToViewportRectangle(rect)
          );
          const link = document.createElement('a');
          link.href = annot.url;
          link.className = 'pdf-link-annot';
          link.style.left = x1 + 'px';
          link.style.top = y1 + 'px';
          link.style.width = (x2 - x1) + 'px';
          link.style.height = (y2 - y1) + 'px';
          link.title = annot.url;
          annotLayerDiv.appendChild(link);
        }
      }

      // Rebuild stamp layer
      let stampLayerDiv = pageWrapper.querySelector('.stampLayer');
      if (!stampLayerDiv) {
        stampLayerDiv = document.createElement('div');
        stampLayerDiv.className = 'stampLayer';
        pageWrapper.appendChild(stampLayerDiv);
      }
      stampLayerDiv.innerHTML = '';
      stampLayerDiv.style.width = Math.floor(viewport.width) + 'px';
      stampLayerDiv.style.height = Math.floor(viewport.height) + 'px';

      renderStampMarkers(stampLayerDiv);

      pageInfo.textContent = `Page ${currentPage} / ${totalPages}`;
      zoomLevel.textContent = Math.round(currentScale * 100) + '%';
    } finally {
      rendering = false;
      if (pendingRender) {
        pendingRender = false;
        renderPage();
      }
    }
  }

  async function extractAllText() {
    if (!currentPdf) return;
    const parts = [];
    pageTexts = [];
    for (let i = 1; i <= currentPdf.numPages; i++) {
      const page = await currentPdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str).join(' ');
      pageTexts.push(pageText);
      if (pageText.trim()) parts.push(pageText);
    }
    pdfText = parts.join('\n\n');
    // Extract refs section raw text for author-year parsing (use last occurrence)
    const lastRefsIdx = Math.max(pdfText.lastIndexOf('References'), pdfText.lastIndexOf('REFERENCES'), pdfText.lastIndexOf('Bibliography'));
    refsRawText = lastRefsIdx >= 0 ? pdfText.slice(lastRefsIdx) : '';
    // Only set regex-based map if LLM pipeline hasn't populated it yet
    if (Object.keys(referencesMap).length === 0) {
      referencesMap = buildReferencesMap(pdfText);
      console.log('[refs] regex fallback:', Object.keys(referencesMap).length, 'refs');
    }
    // Build citation occurrences index
    citationOccurrences = {};
    for (let p = 0; p < pageTexts.length; p++) {
      const text = pageTexts[p];
      const re = /\[([\d,\s–\-]+)\]/g;
      let cm;
      while ((cm = re.exec(text)) !== null) {
        const inner = cm[1];
        const nums = [];
        const rangeMatch = inner.match(/(\d+)\s*[-–]\s*(\d+)/);
        if (rangeMatch) {
          for (let n = parseInt(rangeMatch[1]); n <= parseInt(rangeMatch[2]); n++) nums.push(n);
        }
        for (const d of inner.match(/\d+/g) || []) nums.push(parseInt(d));
        for (const num of [...new Set(nums)]) {
          if (!citationOccurrences[num]) citationOccurrences[num] = [];
          citationOccurrences[num].push({ page: p + 1, charStart: cm.index });
        }
      }
    }

    // Re-render citation overlays now that refs are available
    makeCitationsClickable();
  }

  let citationStyle = null;
  let authorYearLookup = {};

  // --- LLM Citation Pipeline ---

  function detectReferencesPages() {
    let refStart = -1;
    for (let i = pageTexts.length - 1; i >= 0; i--) {
      if (/\breferences\b|\bbibliography\b/i.test(pageTexts[i].slice(0, 300))) {
        refStart = i;
      }
    }
    if (refStart < 0) {
      for (let i = pageTexts.length - 1; i >= Math.max(0, pageTexts.length - 5); i--) {
        if (/\breferences\b|\bbibliography\b/i.test(pageTexts[i])) { refStart = i; break; }
      }
    }
    if (refStart < 0) refStart = pageTexts.length;
    return {
      refPages: Array.from({ length: pageTexts.length - refStart }, (_, i) => refStart + i),
      bodyPages: Array.from({ length: refStart }, (_, i) => i),
    };
  }

  async function extractReferencesMarkdown(refPages) {
    if (refPages.length === 0 || !currentPdfPath) return '';
    // Use pdftotext for clean column-aware extraction
    try {
      const firstPage = refPages[0] + 1; // 1-based
      const lastPage = refPages[refPages.length - 1] + 1;
      const text = await invoke('extract_pdf_text', { path: currentPdfPath, firstPage, lastPage });
      return text;
    } catch (e) {
      console.warn('[citations] pdftotext failed, falling back to pdf.js text:', e);
      return refPages.map(p => pageTexts[p] || '').join('\n\n');
    }
  }

  function scanBodyCitations(bodyPages) {
    const keys = new Set();
    for (const p of bodyPages) {
      const text = pageTexts[p] || '';
      // Bracket: [N] or [N, M, ...] or [N-M]
      const bracketRe = /\[([\d,\s–\-]+)\]/g;
      let m;
      while ((m = bracketRe.exec(text)) !== null) {
        const inner = m[1];
        // Handle ranges like 14-20
        const rangeMatch = inner.match(/(\d+)\s*[-–]\s*(\d+)/);
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1]), end = parseInt(rangeMatch[2]);
          for (let n = start; n <= end; n++) keys.add(String(n));
        }
        // Handle individual numbers and comma-separated
        for (const d of inner.match(/\d+/g) || []) keys.add(d);
      }
      // Parenthetical: (Author et al., Year) or (Author, Year)
      const parenRe = /\(([A-Z][a-z]+)(?:\s+et\s+al\.?)?,?\s*((?:19|20)\d{2}[a-z]?)\)/g;
      while ((m = parenRe.exec(text)) !== null) keys.add(m[1] + '_' + m[2].replace(/[a-z]$/, ''));
    }
    // Detect style
    const numKeys = [...keys].filter(k => /^\d+$/.test(k));
    const authorKeys = [...keys].filter(k => /_/.test(k));
    citationStyle = numKeys.length >= authorKeys.length ? 'bracket' : 'parenthetical';
    return [...keys];
  }

  function getLlmSettings() {
    try {
      const s = JSON.parse(localStorage.getItem('llm_settings') || '{}');
      return {
        url: s.url || 'http://localhost:8317/v1',
        key: s.key || '123',
        model: s.model || 'claude-sonnet-4-6',
      };
    } catch { return { url: 'http://localhost:8317/v1', key: '123', model: 'claude-sonnet-4-6' }; }
  }

  async function renderPageToImage(pageNum) {
    const page = await currentPdf.getPage(pageNum);
    const scale = 2.0;
    const viewport = page.getViewport({ scale });
    const offCanvas = document.createElement('canvas');
    offCanvas.width = viewport.width;
    offCanvas.height = viewport.height;
    const offCtx = offCanvas.getContext('2d');
    await page.render({ canvasContext: offCtx, viewport }).promise;
    return offCanvas.toDataURL('image/png').split(',')[1];
  }

  async function mapCitationsViaLLM(refPages, citationKeys) {
    const settings = getLlmSettings();

    // Render reference pages to images
    const images = [];
    for (const p of refPages) {
      try {
        const b64 = await renderPageToImage(p + 1); // 1-based
        images.push(b64);
      } catch (e) {
        console.warn('[citations] failed to render page', p + 1, e);
      }
    }

    const userContent = [];

    // Add images (OpenAI vision format)
    for (const b64 of images) {
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${b64}` },
      });
    }

    // Add text prompt
    userContent.push({
      type: 'text',
      text: `The images above show the References/Bibliography section of a research paper. Extract each numbered reference and map it to the citation keys below.

## Citation keys found in paper body:
${citationKeys.join(', ')}

## Instructions:
Return a JSON object where each citation key maps to:
{"title": "full paper title", "venue": "journal or conference name", "year": "publication year", "firstAuthor": "surname of first author"}

For numeric keys like "1", "2", match to the corresponding numbered reference [1], [2] in the images.
For author-year keys like "Smith_2020", match by author surname and year.
If a key cannot be matched, set all fields to empty strings.
Output ONLY valid JSON, no markdown fences, no commentary.`,
    });

    console.log('[citations] sending', images.length, 'images + prompt to LLM, image sizes:', images.map(b => Math.round(b.length / 1024) + 'KB'));

    const messages = [
      { role: 'system', content: 'You output only valid JSON. No markdown, no explanation.' },
      { role: 'user', content: userContent },
    ];
    console.log('[citations] message content types:', userContent.map(c => c.type));

    const resp = await invoke('send_chat_message', {
      messages,
      model: settings.model,
      apiUrl: settings.url,
      apiKey: settings.key,
    });

    // Parse response — extract JSON from potentially chatty response
    let cleaned = resp.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    // Find the first { and last } to extract just the JSON object
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
    try {
      return JSON.parse(cleaned);
    } catch (e) {
      console.error('[citations] LLM response (failed to parse):', resp.slice(0, 500));
      throw e;
    }
  }

  function applyCitationMap(parsedMap) {
    referencesMap = {};
    authorYearLookup = {};
    for (const [key, val] of Object.entries(parsedMap)) {
      const numKey = parseInt(key);
      const mapKey = isNaN(numKey) ? key : numKey;
      const hasData = val.title && val.title.length > 0;
      referencesMap[mapKey] = {
        fullText: hasData ? `${val.firstAuthor} et al. ${val.title}. ${val.venue} (${val.year})` : '',
        title: val.title || '',
        venue: val.venue || '',
        year: val.year || '',
        month: '',
        firstAuthor: val.firstAuthor || '',
        split: false,
        confidence: hasData ? 'high' : 'unmatched',
      };
      if (val.firstAuthor && val.year) {
        const aKey = val.firstAuthor + '_' + val.year;
        if (!authorYearLookup[aKey]) authorYearLookup[aKey] = mapKey;
      }
    }
    refsRawText = Object.values(referencesMap).map(r => `${r.firstAuthor}, ${r.year}. ${r.title}. ${r.venue}`).join(' ');
  }

  const citeBtnEl = document.getElementById('btn-refresh-citations');
  document.getElementById('btn-goto-refs').addEventListener('click', () => goToReference(0));

  function setCiteLoading(loading) {
    citeBtnEl.classList.toggle('loading', loading);
    citeBtnEl.disabled = loading;
  }

  async function loadCitationPipeline(pdfPath) {
    // Try cache first
    try {
      const cached = await invoke('load_citations', { pdfPath });
      if (cached) {
        const data = JSON.parse(cached);
        if (data.version === 2 && data.parsedMap) {
          citationStyle = data.citationStyle || 'bracket';
          applyCitationMap(data.parsedMap);
          console.log('[citations] loaded from cache:', Object.keys(referencesMap).length, 'refs');
          renderPage();
          return;
        }
      }
    } catch {}

    await runCitationPipeline(pdfPath, false);
  }

  async function runCitationPipeline(pdfPath, isRefresh) {
    if (!pdfText || pageTexts.length === 0) return;
    setCiteLoading(true);
    try {
      const { refPages, bodyPages } = detectReferencesPages();
      const citationKeys = scanBodyCitations(bodyPages);

      console.log('[citations] detected', refPages.length, 'ref pages,', citationKeys.length, 'citation keys, style:', citationStyle);

      if (citationKeys.length === 0) {
        console.log('[citations] no citations found');
        return;
      }

      console.log('[citations] rendering ref page images for vision LLM...');
      const parsedMap = await mapCitationsViaLLM(refPages, citationKeys);
      applyCitationMap(parsedMap);

      console.log('[citations] LLM mapped', Object.keys(referencesMap).length, 'refs');

      // Cache
      const cacheData = {
        version: 2,
        citationKeys,
        parsedMap,
        citationStyle,
        timestamp: new Date().toISOString(),
      };
      try {
        await invoke('save_citations', { pdfPath, data: JSON.stringify(cacheData) });
      } catch {}

      renderPage();
    } catch (e) {
      console.error('[citations] pipeline failed:', e);
      // Fallback to regex
      referencesMap = buildReferencesMap(pdfText);
      renderPage();
    } finally {
      setCiteLoading(false);
    }
  }

  citeBtnEl.addEventListener('click', () => {
    if (currentPdfPath) runCitationPipeline(currentPdfPath, true);
  });

  // --- OCR button ---
  const ocrBtnEl = document.getElementById('btn-ocr');
  let ocrOriginals = new Set();

  async function checkOcrState() {
    if (!currentPdfPath) return;
    try {
      const originals = await invoke('list_ocr_originals');
      ocrOriginals = new Set(originals);
      const filename = currentPdfPath.split('/').pop();
      const backupPath = '/tmp/pdf-reader-originals/' + filename;
      if (ocrOriginals.has(backupPath)) {
        ocrBtnEl.classList.add('ocr-done');
        ocrBtnEl.title = 'Already OCR\'d — right-click to copy original path';
        ocrBtnEl.dataset.originalPath = backupPath;
      } else {
        ocrBtnEl.classList.remove('ocr-done');
        ocrBtnEl.title = 'OCR this PDF for cleaner text layer';
        ocrBtnEl.dataset.originalPath = '';
      }
    } catch (e) {}
  }

  ocrBtnEl.addEventListener('click', async () => {
    if (!currentPdfPath) return;
    if (ocrBtnEl.classList.contains('ocr-done')) return;
    ocrBtnEl.classList.add('loading');
    ocrBtnEl.disabled = true;
    ocrBtnEl.textContent = 'OCR...';
    try {
      const backupPath = await invoke('ocr_pdf', { pdfPath: currentPdfPath });
      ocrBtnEl.dataset.originalPath = backupPath;
      ocrBtnEl.classList.add('ocr-done');
      ocrBtnEl.title = 'Already OCR\'d — right-click to copy original path';
      // Reload the PDF
      const fileName = currentPdfPath.split('/').pop();
      await loadPdf(currentPdfPath, fileName);
    } catch (e) {
      console.error('OCR failed:', e);
      ocrBtnEl.title = 'OCR failed: ' + e;
    } finally {
      ocrBtnEl.classList.remove('loading');
      ocrBtnEl.disabled = false;
      ocrBtnEl.textContent = 'OCR';
    }
  });

  ocrBtnEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const path = ocrBtnEl.dataset.originalPath;
    if (!path) return;
    navigator.clipboard.writeText(path).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = path;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    });
    ocrBtnEl.title = 'Copied: ' + path;
    setTimeout(() => { ocrBtnEl.title = 'Already OCR\'d — right-click to copy original path'; }, 2000);
  });

  function parseReference(refText) {
    const yearMatch = refText.match(/\b((?:19|20)\d{2})[a-z]?\b/);
    const year = yearMatch ? yearMatch[1] : '';

    // Strategy: try multiple approaches, pick the best title

    // Helper: is this segment an author name? (e.g. "N. Noy", "A.-C. Ngomo", "J.F. Sequeda")
    const isAuthor = (s) => /^[A-Z][-.]/.test(s.trim()) || /^[a-z]/.test(s.trim()) || /^and\s/i.test(s.trim());
    // Helper: is this junk? (pages, DOI, URL, year, volume)
    const isJunk = (s) => {
      const t = s.trim();
      return !t || /^\d/.test(t) || /^http/i.test(t) || /^doi/i.test(t)
        || /^arXiv/i.test(t) || /^pp\./i.test(t) || /^vol\./i.test(t)
        || /^[(\[]?\d{4}[)\]]?$/.test(t) || t.length < 5;
    };

    let title = '';
    let venue = '';

    // Approach 1: "Authors. Year. Title. Venue..." (period-separated, year before title)
    const fmtA = refText.match(/(?:19|20)\d{2}[a-z]?\.\s+(.+)/);
    if (fmtA) {
      const rest = fmtA[1];
      const sentEnd = rest.search(/\.\s+[A-Z]/);
      const candidate = sentEnd > 10 ? rest.slice(0, sentEnd) : rest.split(/\.\s/)[0];
      if (candidate.length > 15) title = candidate;
    }

    // Approach 2: comma-separated — split, skip authors/junk, first long segment is title
    if (!title || title.length < 15) {
      const parts = refText.split(/,\s*/);
      for (const part of parts) {
        const p = part.trim();
        if (isAuthor(p) || isJunk(p)) continue;
        if (p.length >= 15 && /^[A-Z]/.test(p)) {
          title = p;
          // Venue is the next non-junk part
          const idx = parts.indexOf(part);
          for (let vi = idx + 1; vi < parts.length; vi++) {
            const vp = parts[vi].trim();
            if (!isJunk(vp) && /^[A-Z]/.test(vp) && vp.length > 3 && vp.length < 100) {
              venue = vp;
              break;
            }
          }
          break;
        }
      }
    }

    // Approach 3: period-separated fallback
    if (!title || title.length < 15) {
      const sentences = refText.split(/\.\s+/);
      for (const s of sentences) {
        const clean = s.trim();
        if (clean.length > (title || '').length && clean.length >= 15 && clean.length < 250
            && /^[A-Z]/.test(clean) && !isJunk(clean) && !isAuthor(clean)) {
          title = clean;
          break;
        }
      }
    }

    title = (title || '').replace(/\.$/, '').trim() || refText.slice(0, 80);

    // Extract venue if not found yet
    if (!venue) {
      if (/arXiv/i.test(refText)) venue = 'arXiv';
      else {
        const titleIdx = refText.indexOf(title);
        if (titleIdx >= 0) {
          const after = refText.slice(titleIdx + title.length).replace(/^[.,]\s*/, '');
          const vm = after.match(/^(?:In\s+)?([A-Z][A-Za-z.\s&]+?)(?:\s+\d|\s*\(|\s*$)/);
          if (vm) venue = vm[1].trim().replace(/^In\s+/i, '').replace(/[.,]$/, '');
        }
      }
    }

    const monthMatch = refText.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i);
    const month = monthMatch ? monthMatch[1].slice(0, 3) : '';

    const authorMatch = refText.match(/^([A-Z][a-z]+)/);
    const firstAuthor = authorMatch ? authorMatch[1] : '';

    return { title, venue, year, month, firstAuthor };
  }

  function buildReferencesMap(text) {
    const map = {};
    if (!text) return map;
    const lastIdx = Math.max(text.lastIndexOf('References'), text.lastIndexOf('REFERENCES'), text.lastIndexOf('Bibliography'));
    if (lastIdx < 0) return map;
    const sec = text.slice(lastIdx).replace(/^(?:References|REFERENCES|Bibliography)\s*/, '');

    // Format 1: [N] — find each reference number independently
    const bracketPositions = [];
    const bracketFindRe = /\[\s*(\d+)\s*\]/g;
    let m;
    while ((m = bracketFindRe.exec(sec)) !== null) {
      const num = parseInt(m[1]);
      if (num < 1 || num > 999) continue;
      bracketPositions.push({ num, start: m.index, textStart: m.index + m[0].length });
    }

    if (bracketPositions.length > 0) {
      // Sort by reference number to handle column interleaving
      bracketPositions.sort((a, b) => a.num - b.num);

      // Deduplicate: if same number appears multiple times, keep the one whose text looks like a reference
      const byNum = {};
      for (const pos of bracketPositions) {
        if (!byNum[pos.num]) byNum[pos.num] = [];
        byNum[pos.num].push(pos);
      }

      // Sort by text position to find what comes next in raw text
      const byPosition = [...bracketPositions].sort((a, b) => a.start - b.start);

      for (let i = 0; i < byPosition.length; i++) {
        const pos = byPosition[i];
        const endPos = (i + 1 < byPosition.length) ? byPosition[i + 1].start : sec.length;
        const fullText = sec.slice(pos.textStart, endPos).replace(/\s+/g, ' ').trim();

        if (fullText.length < 10) continue;

        // If this number already has an entry, pick the one that looks more like a real reference
        if (map[pos.num]) {
          const hasYear = /\b(19|20)\d{2}\b/.test(fullText);
          const oldHasYear = /\b(19|20)\d{2}\b/.test(map[pos.num].fullText);
          // Keep the one with a year, or the longer one
          if (oldHasYear && !hasYear) continue;
          if (oldHasYear === hasYear && map[pos.num].fullText.length >= fullText.length) continue;
        }

        map[pos.num] = { fullText, ...parseReference(fullText) };
      }

      // Fix column-wrap gaps: if [N] is missing but [N-1] and [N+1] exist,
      // [N] likely got merged into [N-1]'s text due to column wrapping
      const nums = Object.keys(map).map(Number).sort((a, b) => a - b);
      const maxNum = nums[nums.length - 1] || 0;
      for (let n = 1; n <= maxNum; n++) {
        if (map[n]) continue;
        // [N] is missing — check if the text after [N-1] in the refs section contains [N]'s content
        // Try to find [N] directly in the full refs text
        const directRe = new RegExp('\\[\\s*' + n + '\\s*\\]\\s*(.{10,500}?)(?=\\[\\s*\\d+\\s*\\]|$)');
        const directMatch = sec.match(directRe);
        if (directMatch) {
          const fullText = directMatch[1].replace(/\s+/g, ' ').trim();
          map[n] = { fullText, ...parseReference(fullText) };
        }
      }
      return map;
    }

    // Format 2: "1. Author text" — skip if text looks like section heading
    const dotRe = /(?:^|\s)(\d+)\.\s+([\s\S]*?)(?=(?:^|\s)\d+\.\s|$)/g;
    while ((m = dotRe.exec(sec)) !== null) {
      const fullText = m[2].replace(/\s+/g, ' ').trim();
      if (fullText.length < 40 || !/,/.test(fullText.slice(0, 50)) || !/\b(19|20)\d{2}\b/.test(fullText)) continue;
      map[parseInt(m[1])] = { fullText, ...parseReference(fullText) };
    }
    return map;
  }

  let refsRawText = '';

  function makeCitationsClickable() {
    let citeLayer = pageWrapper.querySelector('.citeLayer');
    if (!citeLayer) {
      citeLayer = document.createElement('div');
      citeLayer.className = 'citeLayer';
      pageWrapper.appendChild(citeLayer);
    }
    citeLayer.innerHTML = '';

    const wrapperRect = textLayerDiv.getBoundingClientRect();
    const spans = Array.from(textLayerDiv.querySelectorAll('span'));

    // Build full text from spans for range-based matching
    let fullText = '';
    const fullSegments = [];
    for (let si = 0; si < spans.length; si++) {
      const span = spans[si];
      const r = span.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const text = span.textContent;
      if (fullText.length > 0) {
        const lastChar = fullText[fullText.length - 1];
        const firstChar = text[0];
        if (lastChar && firstChar && lastChar !== ' ' && firstChar !== ' ' && lastChar !== '(' && firstChar !== ')') {
          fullText += ' ';
        }
      }
      fullSegments.push({ span, start: fullText.length, len: text.length });
      fullText += text;
    }

    if (citationStyle === 'parenthetical' || citationStyle === 'bracket-author') {
      // Author-year citations: (Author et al., Year) or [Author et al., Year]
      const parenRe = citationStyle === 'bracket-author'
        ? /\[([^\]]{5,300})\]/g
        : /\(([^)]{5,300})\)/g;
      let pm;
      while ((pm = parenRe.exec(fullText)) !== null) {
        const inner = pm[1];
        const parenStart = pm.index;
        const parts = inner.split(/;/);
        for (const part of parts) {
          const trimmed = part.trim();
          const citeMatch = trimmed.match(/([A-Z][a-z]+)(?:[\s.]+(?:et\s*al\.?|and\s+[A-Z][a-z]+))?[.,\s]*((?:19|20)\d{2}[a-z]?)/);
          if (!citeMatch) continue;
          const surname = citeMatch[1];
          const yearFull = citeMatch[2];
          const yearBase = yearFull.replace(/[a-z]$/, '');

          let refIndex = authorYearLookup[surname + '_' + yearFull]
                      || authorYearLookup[surname + '_' + yearBase];
          if (!refIndex) {
            const prefix = surname.slice(0, 4);
            for (const [k, v] of Object.entries(authorYearLookup)) {
              if (k.startsWith(prefix + '_' + yearBase)) { refIndex = v; break; }
            }
          }
          if (!refIndex || !referencesMap[refIndex]) continue;

          const partIdx = fullText.indexOf(trimmed, parenStart);
          if (partIdx < 0) continue;
          const partEnd = partIdx + trimmed.length;

          const range = document.createRange();
          let rangeStartSet = false;
          for (const seg of fullSegments) {
            const segEnd = seg.start + seg.len;
            if (!rangeStartSet && partIdx >= seg.start && partIdx < segEnd) {
              const node = seg.span.firstChild || seg.span;
              range.setStart(node, partIdx - seg.start);
              rangeStartSet = true;
            }
            if (rangeStartSet && partEnd <= segEnd) {
              const node = seg.span.firstChild || seg.span;
              range.setEnd(node, partEnd - seg.start);
              break;
            }
          }
          if (!rangeStartSet) continue;

          const clientRects = range.getClientRects();
          const pad = 2;
          for (let ri = 0; ri < clientRects.length; ri++) {
            const rect = clientRects[ri];
            if (rect.width < 2) continue;
            const el = document.createElement('div');
            el.className = 'cite-overlay';
            el.dataset.ref = String(refIndex);
            el.style.left = (rect.left - wrapperRect.left - pad) + 'px';
            el.style.top = (rect.top - wrapperRect.top - pad) + 'px';
            el.style.width = (rect.width + pad * 2) + 'px';
            el.style.height = (rect.height + pad * 2) + 'px';
            setupCiteOverlay(el, refIndex);
            citeLayer.appendChild(el);
          }
        }
      }
    } else {
      // Bracket citations: find [N] in fullText (built from visible layer
      // only, with no spaces around brackets so cross-font [N] concatenates).
      // Create overlay divs positioned via range rects.
      const pad = 2;
      const bracketRe = /\[(\d+(?:[,\s–—-]+\d+)*)\]/g;
      let bm;
      while ((bm = bracketRe.exec(fullText)) !== null) {
        const nums = [];
        for (const part of bm[1].split(/[,]+/)) {
          const rm = part.match(/^(\d+)[–—-](\d+)$/);
          if (rm) { for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) nums.push(n); }
          else { const n = parseInt(part); if (!isNaN(n)) nums.push(n); }
        }
        const valid = nums.filter(n => n > 0);
        if (valid.length === 0) continue;

        const mStart = bm.index + 1, mEnd = bm.index + bm[0].length - 1;
        const range = document.createRange();
        let ok = false;
        for (const seg of fullSegments) {
          const segEnd = seg.start + seg.len;
          if (!ok && mStart >= seg.start && mStart < segEnd) {
            const node = seg.span.firstChild || seg.span;
            try { range.setStart(node, mStart - seg.start); ok = true; } catch(e) { break; }
          }
          if (ok && mEnd <= segEnd) {
            const node = seg.span.firstChild || seg.span;
            try { range.setEnd(node, mEnd - seg.start); } catch(e) { ok = false; }
            break;
          }
        }
        if (!ok) continue;

        for (const rect of range.getClientRects()) {
          if (rect.width < 2 || rect.height < 2) continue;
          const el = document.createElement('div');
          el.className = 'cite-overlay';
          el.dataset.ref = String(valid[0]);
          el.dataset.refs = valid.join(',');
          el.style.left = (rect.left - wrapperRect.left - pad) + 'px';
          el.style.top = (rect.top - wrapperRect.top - pad) + 'px';
          el.style.width = (rect.width + pad * 2) + 'px';
          el.style.height = (rect.height + pad * 2) + 'px';
          setupCiteOverlay(el, valid[0]);
          citeLayer.appendChild(el);
        }
      }
    }
    console.log('[cite] style:', citationStyle, 'overlays:', citeLayer.children.length, 'refs:', Object.keys(referencesMap).length);
  }

  function setupCiteOverlay(el, refNum) {
    const refs = (el.dataset.refs || String(refNum)).split(',').map(Number).filter(n => n > 0);
    if (refs.length === 0) return;

    function refDisplay(n) {
      const r = referencesMap[n];
      if (!r) return { title: '', disp: '(unknown)', url: '', split: false, confidence: 'unmatched' };
      if (r.confidence === 'unmatched' || !r.title) {
        return { title: '', disp: '(unmatched)', url: '', split: false, confidence: 'unmatched' };
      }
      const venue = r.venue || '';
      const year = r.year || '';
      const tag = venue || year ? ` (${[venue, year].filter(Boolean).join(', ')})` : '';
      const splitTag = r.split ? '(split) ' : '';
      return { title: r.title, disp: splitTag + r.title + tag, url: 'https://scholar.google.com/scholar?q=' + encodeURIComponent(r.title), split: !!r.split, confidence: r.confidence || 'medium' };
    }

    let popup = null;
    let popupTimeout = null;

    el.addEventListener('mouseenter', () => {
      clearTimeout(popupTimeout);
      if (popup) return;
      popup = document.createElement('div');
      popup.className = 'cite-popup';
      for (const n of refs) {
        const d = refDisplay(n);
        const row = document.createElement('div');
        row.className = 'cite-popup-row';
        const confBadge = d.confidence === 'high' ? '<span class="cite-conf cite-conf-high">✓</span>'
          : d.confidence === 'unmatched' ? '<span class="cite-conf cite-conf-low">?</span>'
          : d.confidence === 'low' ? '<span class="cite-conf cite-conf-low">⚠</span>'
          : '<span class="cite-conf cite-conf-med">~</span>';
        const googleLink = d.url ? `<a class="cite-popup-link" href="${d.url}">Google Scholar ↗</a>` : '';
        row.innerHTML = `<div class="cite-popup-title">${confBadge} [${n}] ${d.disp}</div>${googleLink}`;

        const occs = citationOccurrences[n] || [];
        if (occs.length > 0) {
          const navRow = document.createElement('div');
          navRow.className = 'cite-popup-nav';
          for (let oi = 0; oi < occs.length; oi++) {
            const btn = document.createElement('button');
            btn.className = 'cite-popup-goto';
            btn.textContent = `p${occs[oi].page}`;
            btn.title = `Occurrence ${oi + 1} on page ${occs[oi].page}`;
            const idx = oi;
            btn.addEventListener('click', (ev) => {
              ev.stopPropagation();
              goToOccurrence(n, idx);
              if (popup) { popup.remove(); popup = null; }
            });
            navRow.appendChild(btn);
          }
          row.appendChild(navRow);
        }

        popup.appendChild(row);
      }
      popup.addEventListener('mousedown', (ev) => { ev.preventDefault(); ev.stopPropagation(); });
      popup.addEventListener('mouseenter', () => clearTimeout(popupTimeout));
      popup.addEventListener('mouseleave', () => { popupTimeout = setTimeout(() => { if (popup) { popup.remove(); popup = null; } }, 200); });
      const rect = el.getBoundingClientRect();
      const wr = pageWrapper.getBoundingClientRect();
      popup.style.left = (rect.left - wr.left) + 'px';
      popup.style.top = (rect.bottom - wr.top + 2) + 'px';
      pageWrapper.appendChild(popup);
    });

    el.addEventListener('mouseleave', () => {
      popupTimeout = setTimeout(() => { if (popup) { popup.remove(); popup = null; } }, 200);
    });

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      if (onCitationChat) {
        const lines = refs.map(n => {
          const d = refDisplay(n);
          if (d.confidence === 'unmatched') return `**[${n}]** (unmatched)`;
          const link = d.url ? `\n\n[Google Scholar ↗](${d.url})` : '';
          return `**[${n}]** ${d.disp}${link}`;
        });
        const md = lines.join('\n\n---\n\n');
        const occData = {};
        for (const n of refs) occData[n] = citationOccurrences[n] || [];
        onCitationChat(refs, md, occData);
      }
    });
  }

  let pendingScrollCitation = null;

  function goToOccurrence(refNum, occIdx) {
    const occs = citationOccurrences[refNum];
    if (!occs || !occs[occIdx]) return;
    const occ = occs[occIdx];
    pendingScrollCitation = { refNum, charStart: occ.charStart };
    if (occ.page !== currentPage) {
      currentPage = occ.page;
      renderPage();
    } else {
      scrollToCitation(refNum, occ.charStart);
    }
  }

  function scrollToCitation(refNum, charStart) {
    const spans = textLayerDiv.querySelectorAll('span');
    const target = `[${refNum}]`;
    let offset = 0;
    for (const span of spans) {
      const text = span.textContent;
      const idx = text.indexOf(target);
      if (idx >= 0) {
        // Check if this is roughly the right occurrence by char position
        if (Math.abs(offset + idx - charStart) < 200 || charStart === undefined) {
          const rect = span.getBoundingClientRect();
          const containerRect = pdfContainer.getBoundingClientRect();
          pdfContainer.scrollTo({
            top: pdfContainer.scrollTop + (rect.top - containerRect.top) - containerRect.height / 2,
            behavior: 'smooth'
          });
          // Brief highlight
          span.classList.add('search-highlight-active');
          setTimeout(() => span.classList.remove('search-highlight-active'), 2000);
          return;
        }
      }
      offset += text.length;
    }
  }

  function goToReference(refNum) {
    if (pageTexts.length === 0) return;
    for (let i = 0; i < pageTexts.length; i++) {
      if (/references|bibliography/i.test(pageTexts[i])) {
        const targetPage = i + 1;
        if (currentPage !== targetPage) {
          currentPage = targetPage;
          renderPage();
        }
        pdfContainer.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
    }
  }

  function highlightReferenceText(refNum) {
    // Remove any existing highlight/download buttons
    textLayerDiv.querySelectorAll('.ref-highlight').forEach(el => el.classList.remove('ref-highlight'));
    pageWrapper.querySelectorAll('.ref-download-btn').forEach(el => el.remove());

    const spans = textLayerDiv.querySelectorAll('span');
    let firstSpan = null;
    let refText = '';
    const refPatterns = [
      new RegExp(`^\\s*\\[${refNum}\\]`),
      new RegExp(`^\\s*${refNum}\\.\\s`),
    ];

    for (const span of spans) {
      const text = span.textContent;
      for (const pattern of refPatterns) {
        if (pattern.test(text)) {
          span.classList.add('ref-highlight');
          firstSpan = span;
          refText = text;
          let next = span.nextElementSibling;
          const nextRefPattern = new RegExp(`^\\s*\\[${refNum + 1}\\]|^\\s*${refNum + 1}\\.\\s`);
          while (next) {
            if (nextRefPattern.test(next.textContent) || (/^\s*\[\d+\]/.test(next.textContent) && !new RegExp(`\\[${refNum}\\]`).test(next.textContent))) break;
            next.classList.add('ref-highlight');
            refText += ' ' + next.textContent;
            next = next.nextElementSibling;
          }
          break;
        }
      }
      if (firstSpan) break;
    }

    if (!firstSpan) {
      for (const span of spans) {
        if (span.textContent.includes(`[${refNum}]`)) {
          span.classList.add('ref-highlight');
          firstSpan = span;
          refText = span.textContent;
          break;
        }
      }
    }

    if (firstSpan) {
      firstSpan.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Add download button next to highlight
      const btn = document.createElement('button');
      btn.className = 'ref-download-btn';
      btn.textContent = '⬇ Download';
      const spanRect = firstSpan.getBoundingClientRect();
      const wrapperRect = pageWrapper.getBoundingClientRect();
      btn.style.left = (spanRect.right - wrapperRect.left + 4) + 'px';
      btn.style.top = (spanRect.top - wrapperRect.top) + 'px';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onCiteResolve) onCiteResolve(refNum, refText.trim(), btn);
      });
      pageWrapper.appendChild(btn);

      setTimeout(() => {
        textLayerDiv.querySelectorAll('.ref-highlight').forEach(el => el.classList.remove('ref-highlight'));
        btn.remove();
      }, 10000);
    }
  }

  function getSelectionPosition() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!textLayerDiv.contains(range.startContainer)) return null;
    const wrapperRect = pageWrapper.getBoundingClientRect();
    const clientRects = range.getClientRects();
    const rects = [];
    for (let i = 0; i < clientRects.length; i++) {
      const r = clientRects[i];
      if (r.width < 1 || r.height < 1) continue;
      rects.push({
        x: (r.left - wrapperRect.left) / currentScale,
        y: (r.top - wrapperRect.top) / currentScale,
        w: r.width / currentScale,
        h: r.height / currentScale,
      });
    }
    const boundingRect = range.getBoundingClientRect();
    return {
      page: currentPage,
      x: (boundingRect.left - wrapperRect.left) / currentScale,
      y: (boundingRect.top - wrapperRect.top) / currentScale,
      w: boundingRect.width / currentScale,
      h: boundingRect.height / currentScale,
      rects: rects,
      selectedText: sel.toString().trim(),
    };
  }

  function renderStampMarkers(container) {
    container.innerHTML = '';
    const pageStamps = stamps.filter(st => st.pageNumber === currentPage);
    console.log('[stamps] rendering', pageStamps.length, 'stamps on page', currentPage, pageStamps.map(s => ({ id: s.id?.slice(0,8), messageId: s.messageId, isComment: !s.messageId })));
    for (const stamp of pageStamps) {
      const isComment = !stamp.messageId;

      if (isComment) {
        // Render per-line underlines for comments
        const lineRects = stamp.rects || [{ x: stamp.x, y: stamp.y, w: stamp.w || 20, h: stamp.h || 12 }];
        const wrapper = document.createElement('div');
        wrapper.style.position = 'absolute';
        wrapper.style.top = '0';
        wrapper.style.left = '0';
        wrapper.style.pointerEvents = 'none';

        for (const r of lineRects) {
          const line = document.createElement('div');
          line.className = 'comment-underline';
          line.style.left = (r.x * currentScale) + 'px';
          line.style.top = ((r.y + r.h) * currentScale) + 'px';
          line.style.width = (r.w * currentScale) + 'px';
          line.style.pointerEvents = 'auto';
          wrapper.appendChild(line);
        }

        wrapper.addEventListener('click', (e) => {
          e.stopPropagation();
          if (onStampClick) onStampClick(stamp);
        });
        wrapper.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (onStampDelete) onStampDelete(stamp);
        });

        // Hover popup for comment
        let popup = null;
        let popupTimeout = null;
        function showPopup() {
          if (popup) return;
          popup = document.createElement('div');
          popup.className = 'stamp-popup';
          const textDiv = document.createElement('div');
          textDiv.textContent = stamp.content;
          popup.appendChild(textDiv);
          const delBtn = document.createElement('button');
          delBtn.className = 'stamp-popup-delete';
          delBtn.textContent = 'Delete comment';
          delBtn.addEventListener('click', (ev) => { ev.stopPropagation(); hidePopup(); if (onStampDelete) onStampDelete(stamp); });
          popup.appendChild(delBtn);
          popup.addEventListener('mouseenter', () => clearTimeout(popupTimeout));
          popup.addEventListener('mouseleave', () => { popupTimeout = setTimeout(hidePopup, 150); });
          const firstRect = lineRects[lineRects.length - 1];
          popup.style.left = (firstRect.x * currentScale) + 'px';
          popup.style.top = ((firstRect.y + firstRect.h + 4) * currentScale) + 'px';
          pageWrapper.appendChild(popup);
        }
        function hidePopup() { if (popup) { popup.remove(); popup = null; } }
        wrapper.addEventListener('mouseenter', () => { clearTimeout(popupTimeout); showPopup(); });
        wrapper.addEventListener('mouseleave', () => { popupTimeout = setTimeout(hidePopup, 150); });

        container.appendChild(wrapper);
        continue;
      }

      // Regular stamp marker
      const marker = document.createElement('div');
      marker.className = 'stamp-marker';
      const pad = 3;
      marker.style.left = (stamp.x * currentScale - pad) + 'px';
      marker.style.top = (stamp.y * currentScale - pad) + 'px';
      marker.style.width = ((stamp.w || 20) * currentScale + pad * 2) + 'px';
      marker.style.height = ((stamp.h || 14) * currentScale + pad * 2) + 'px';

      marker.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onStampClick) onStampClick(stamp);
      });

      // Right-click to delete
      marker.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (onStampDelete) onStampDelete(stamp);
      });

      // Hover popup with delete button
      let popup = null;
      let popupTimeout = null;

      function showPopup() {
        if (popup) return;
        popup = document.createElement('div');
        popup.className = 'stamp-popup';
        const preview = stamp.content.length > 300 ? stamp.content.slice(0, 300) + '...' : stamp.content;
        const textSpan = document.createElement('div');
        textSpan.textContent = preview;
        popup.appendChild(textSpan);

        const delBtn = document.createElement('button');
        delBtn.className = 'stamp-popup-delete';
        delBtn.textContent = 'Delete stamp';
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          hidePopup();
          if (onStampDelete) onStampDelete(stamp);
        });
        popup.appendChild(delBtn);

        popup.addEventListener('mouseenter', () => { clearTimeout(popupTimeout); });
        popup.addEventListener('mouseleave', () => { popupTimeout = setTimeout(hidePopup, 150); });

        const markerRect = marker.getBoundingClientRect();
        const wrapperRect = pageWrapper.getBoundingClientRect();
        popup.style.left = (markerRect.left - wrapperRect.left) + 'px';
        popup.style.top = (markerRect.bottom - wrapperRect.top + 4) + 'px';
        pageWrapper.appendChild(popup);
      }

      function hidePopup() {
        if (popup) { popup.remove(); popup = null; }
      }

      marker.addEventListener('mouseenter', () => { clearTimeout(popupTimeout); showPopup(); });
      marker.addEventListener('mouseleave', () => { popupTimeout = setTimeout(hidePopup, 150); });

      container.appendChild(marker);
    }
  }

  function setStamps(s) {
    stamps = s || [];
    const stampLayerDiv = pageWrapper.querySelector('.stampLayer');
    if (!stampLayerDiv || !currentPdf) return;
    renderStampMarkers(stampLayerDiv);
  }

  return {
    loadPdf,
    getPdfText: () => pdfText,
    getReferencesMap: () => referencesMap,
    getCurrentPath: () => currentPdfPath,
    getCurrentPage: () => currentPage,
    getSelectionPosition,
    getSavedPosition: () => savedPosition,
    goToReference,
    goToOccurrence,
    setStamps,
    setOnStampClick: (cb) => { onStampClick = cb; },
    setOnStampDelete: (cb) => { onStampDelete = cb; },
    setOnCommentStamp: (cb) => { onCommentStamp = cb; },
    setOnCiteResolve: (cb) => { onCiteResolve = cb; },
    setOnCitationChat: (cb) => { onCitationChat = cb; },
  };
}
