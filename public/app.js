// ===== DOM Elements =====
const uploadZone = document.getElementById('uploadZone');
const fileInput = document.getElementById('fileInput');
const uploadProgress = document.getElementById('uploadProgress');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const documentsList = document.getElementById('documentsList');
const emptyDocs = document.getElementById('emptyDocs');
const docCount = document.getElementById('docCount');
const chatMessages = document.getElementById('chatMessages');
const welcomeScreen = document.getElementById('welcomeScreen');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const chatStatus = document.getElementById('chatStatus');
const mobileMenuBtn = document.getElementById('mobileMenuBtn');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebarToggle');

let chatHistory = [];
let isProcessing = false;

// ===== Upload Logic =====

// Click to browse
uploadZone.addEventListener('click', () => fileInput.click());

// File selected
fileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) uploadFile(e.target.files[0]);
});

// Drag & Drop
uploadZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadZone.classList.add('drag-over');
});

uploadZone.addEventListener('dragleave', () => {
  uploadZone.classList.remove('drag-over');
});

uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type === 'application/pdf') {
    uploadFile(file);
  } else {
    showToast('Please upload a PDF file', 'error');
  }
});

async function uploadFile(file) {
  if (isProcessing) return;
  isProcessing = true;

  // Show progress
  uploadProgress.hidden = false;
  progressFill.style.width = '20%';
  progressText.textContent = `Uploading "${file.name}"...`;

  const formData = new FormData();
  formData.append('pdf', file);

  try {
    progressFill.style.width = '40%';
    progressText.textContent = 'Extracting text...';

    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });

    progressFill.style.width = '80%';
    progressText.textContent = 'Generating embeddings...';

    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Upload failed');

    progressFill.style.width = '100%';
    progressText.textContent = 'Done!';

    showToast(`"${data.name}" uploaded — ${data.chunks} chunks indexed`, 'success');
    loadDocuments();
    updateChatStatus();

    setTimeout(() => {
      uploadProgress.hidden = true;
      progressFill.style.width = '0%';
    }, 1500);

  } catch (err) {
    showToast(err.message, 'error');
    uploadProgress.hidden = true;
    progressFill.style.width = '0%';
  } finally {
    isProcessing = false;
    fileInput.value = '';
  }
}

// ===== Documents =====

async function loadDocuments() {
  try {
    const res = await fetch('/api/documents');
    const docs = await res.json();

    docCount.textContent = docs.length;

    if (docs.length === 0) {
      documentsList.innerHTML = '<div class="empty-docs"><p>No documents uploaded yet</p></div>';
      return;
    }

    documentsList.innerHTML = docs.map(doc => `
      <div class="doc-item" data-id="${doc.id}">
        <div class="doc-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
        </div>
        <div class="doc-info">
          <div class="doc-name" title="${doc.name}">${doc.name}</div>
          <div class="doc-meta">${doc.pages} pages · ${doc.chunkCount} chunks</div>
        </div>
        <button class="doc-delete" onclick="deleteDocument('${doc.id}')" title="Delete document">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load documents:', err);
  }
}

async function deleteDocument(docId) {
  if (!confirm('Delete this document? Its content will no longer be searchable.')) return;

  try {
    const res = await fetch(`/api/documents/${docId}`, { method: 'DELETE' });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Delete failed');

    showToast(data.message, 'success');
    loadDocuments();
    updateChatStatus();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ===== Chat =====

chatInput.addEventListener('input', () => {
  sendBtn.disabled = chatInput.value.trim().length === 0 || isProcessing;
  // Auto-resize textarea
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) chatForm.dispatchEvent(new Event('submit'));
  }
});

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const question = chatInput.value.trim();
  if (!question || isProcessing) return;

  // Hide welcome screen
  if (welcomeScreen) welcomeScreen.remove();

  // Add user message
  appendMessage('user', question);
  chatInput.value = '';
  chatInput.style.height = 'auto';
  sendBtn.disabled = true;
  isProcessing = true;

  // Show typing indicator
  const typingEl = appendTypingIndicator();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history: chatHistory })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Chat failed');

    // Remove typing indicator
    typingEl.remove();

    // Add bot message
    appendMessage('bot', data.answer, data.sources);

    // Update history
    chatHistory.push({ role: 'user', content: question });
    chatHistory.push({ role: 'assistant', content: data.answer });

    // Keep history manageable
    if (chatHistory.length > 12) chatHistory = chatHistory.slice(-12);

  } catch (err) {
    typingEl.remove();
    appendMessage('bot', `⚠️ Error: ${err.message}. Make sure Ollama is running.`);
  } finally {
    isProcessing = false;
    sendBtn.disabled = chatInput.value.trim().length === 0;
  }
});

function appendMessage(role, content, sources = []) {
  const div = document.createElement('div');
  div.className = `message ${role}`;

  const avatarText = role === 'bot' ? 'AI' : '👤';

  let sourcesHtml = '';
  if (sources.length > 0) {
    sourcesHtml = `
      <div class="message-sources">
        ${sources.map(s => {
          if (typeof s === 'string') {
            return `<span class="source-badge">📄 ${s}</span>`;
          } else {
            return `
              <div class="source-item">
                <span class="source-badge">📄 ${s.name} (Page ${s.page})</span>
                ${s.image ? `<a href="${s.image}" target="_blank"><img src="${s.image}" class="source-image" alt="Source Page ${s.page}" loading="lazy"/></a>` : ''}
              </div>
            `;
          }
        }).join('')}
      </div>
    `;
  }

  const renderedContent = role === 'bot' ? renderMarkdown(content) : escapeHtml(content);

  div.innerHTML = `
    <div class="message-avatar">${avatarText}</div>
    <div class="message-content">
      ${renderedContent}
      ${sourcesHtml}
    </div>
  `;

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendTypingIndicator() {
  const div = document.createElement('div');
  div.className = 'message bot';
  div.innerHTML = `
    <div class="message-avatar">AI</div>
    <div class="message-content">
      <div class="typing-indicator">
        <span></span><span></span><span></span>
      </div>
    </div>
  `;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

// ===== Markdown Rendering (lightweight) =====
function renderMarkdown(text) {
  let html = escapeHtml(text);

  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Unordered lists
  html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  // Line breaks  
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');

  // Wrap in paragraph if not starting with block element
  if (!html.startsWith('<h') && !html.startsWith('<ul') && !html.startsWith('<pre')) {
    html = `<p>${html}</p>`;
  }

  return html;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ===== Status Update =====
function updateChatStatus() {
  fetch('/api/documents')
    .then(res => res.json())
    .then(docs => {
      if (docs.length === 0) {
        chatStatus.textContent = 'Upload a PDF to get started';
      } else {
        chatStatus.textContent = `${docs.length} document${docs.length > 1 ? 's' : ''} loaded — ready to answer`;
      }
    });
}

// ===== Toast Notifications =====
function showToast(message, type = 'error') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 4000);
}

// ===== Mobile Sidebar =====
mobileMenuBtn.addEventListener('click', () => {
  sidebar.classList.add('open');
  showOverlay();
});

sidebarToggle.addEventListener('click', () => {
  sidebar.classList.remove('open');
  hideOverlay();
});

function showOverlay() {
  let overlay = document.querySelector('.sidebar-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    overlay.addEventListener('click', () => {
      sidebar.classList.remove('open');
      hideOverlay();
    });
    document.body.appendChild(overlay);
  }
  overlay.classList.add('active');
}

function hideOverlay() {
  const overlay = document.querySelector('.sidebar-overlay');
  if (overlay) overlay.classList.remove('active');
}

// ===== Init =====
loadDocuments();
updateChatStatus();
