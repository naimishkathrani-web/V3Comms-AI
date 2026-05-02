document.addEventListener('DOMContentLoaded', () => {
    const apiBase = '';
    const state = {
        taxonomy: { roles: [], categories: [], subCategories: [], companies: [], projects: [], commodities: [] },
        currentDraft: null,
        records: [],
    };

    const navItems = Array.from(document.querySelectorAll('.nav-item'));
    const sections = Array.from(document.querySelectorAll('.view'));
    const pageTitle = document.getElementById('page-title');
    const toolButtons = Array.from(document.querySelectorAll('[data-tool]'));
    const ingestModeButtons = Array.from(document.querySelectorAll('[data-ingest-mode]'));
    const fileForm = document.getElementById('file-intake-form');
    const urlForm = document.getElementById('url-intake-form');
    const draftReview = document.getElementById('draft-review');
    const recordsBody = document.getElementById('knowledge-records-body');
    const refreshRecordsBtn = document.getElementById('refresh-records');

    const chatInput = document.getElementById('chat-input');
    const chatHistory = document.getElementById('chat-history');
    const sendChatBtn = document.getElementById('send-chat');
    const chatRoleFilter = document.getElementById('chat-role-filter');
    const chatCategoryFilter = document.getElementById('chat-category-filter');
    const chatSubCategoryFilter = document.getElementById('chat-sub-category-filter');
    const chatCompanyFilter = document.getElementById('chat-company-filter');
    const chatProjectFilter = document.getElementById('chat-project-filter');
    const chatCommodityFilter = document.getElementById('chat-commodity-filter');

    const transBtn = document.getElementById('run-translate');
    const transInput = document.getElementById('translate-input');
    const transTarget = document.getElementById('target-lang');
    const transOutput = document.getElementById('translation-output');

    const builderInput = document.getElementById('builder-input');
    const builderHistory = document.getElementById('builder-history');
    const sendBuilderBtn = document.getElementById('send-builder');
    const builderModelBadge = document.getElementById('builder-model-badge');
    const builderTerminal = document.getElementById('builder-terminal');
    const builderTaskList = document.getElementById('builder-task-list');
    const builderResetBtn = document.getElementById('builder-reset');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const target = item.dataset.section;
            navItems.forEach(button => button.classList.toggle('active', button === item));
            sections.forEach(section => section.classList.toggle('hidden', section.id !== target));
            pageTitle.textContent = item.textContent.trim();
        });
    });

    toolButtons.forEach(button => {
        button.addEventListener('click', () => {
            const target = button.dataset.tool;
            toolButtons.forEach(item => item.classList.toggle('active', item === button));
            document.getElementById('chat-tool').classList.toggle('hidden', target !== 'chat');
            document.getElementById('translate-tool').classList.toggle('hidden', target !== 'translate');
        });
    });

    ingestModeButtons.forEach(button => {
        button.addEventListener('click', () => {
            const target = button.dataset.ingestMode;
            ingestModeButtons.forEach(item => item.classList.toggle('active', item === button));
            fileForm.classList.toggle('hidden', target !== 'file');
            urlForm.classList.toggle('hidden', target !== 'url');
        });
    });

    async function updateStatus() {
        try {
            const res = await fetch(`${apiBase}/health`);
            const data = await res.json();
            const seconds = Math.floor(data.uptime);
            const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
            const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
            const s = (seconds % 60).toString().padStart(2, '0');
            document.getElementById('uptime-val').textContent = `${h}:${m}:${s}`;
        } catch (error) {
            console.error('Status check failed', error);
        }
    }

    async function loadPlugins() {
        try {
            const res = await fetch(`${apiBase}/api/plugins`);
            const plugins = await res.json();
            document.getElementById('plugin-count').textContent = plugins.length;
            const list = document.getElementById('plugin-list');
            list.innerHTML = '';
            plugins.forEach(plugin => {
                const card = document.createElement('article');
                card.className = 'plugin-card';
                card.innerHTML = `
                    <p class="eyebrow">v${plugin.version}</p>
                    <h4>${plugin.name}</h4>
                    <p class="summary-copy">${plugin.description}</p>
                `;
                list.appendChild(card);
            });

            const hasOllama = plugins.some(plugin => plugin.name === 'ollama');
            document.getElementById('ollama-status').textContent = hasOllama ? 'Linked' : 'Missing';
        } catch (error) {
            console.error('Plugin load failed', error);
        }
    }

    async function loadKnowledgeStats() {
        try {
            const res = await fetch(`${apiBase}/api/knowledge/stats`);
            const stats = await res.json();
            document.getElementById('knowledge-doc-count').textContent = stats.documents ?? 0;
            document.getElementById('knowledge-chunk-count').textContent = stats.chunks ?? 0;
        } catch (error) {
            console.error('Knowledge stats failed', error);
        }
    }

    async function loadTaxonomy() {
        try {
            const res = await fetch(`${apiBase}/api/knowledge/taxonomy`);
            const data = await res.json();
            state.taxonomy = {
                roles: data.roles || [],
                categories: data.categories || [],
                subCategories: data.subCategories || [],
                companies: data.companies || [],
                projects: data.projects || [],
                commodities: data.commodities || [],
            };
            populateSelect('file-role', state.taxonomy.roles, 'AI recommend');
            populateSelect('url-role', state.taxonomy.roles, 'AI recommend');
            populateSelect('file-category', state.taxonomy.categories, 'AI recommend');
            populateSelect('url-category', state.taxonomy.categories, 'AI recommend');
            populateSelect('file-sub-category', state.taxonomy.subCategories, 'AI recommend');
            populateSelect('url-sub-category', state.taxonomy.subCategories, 'AI recommend');
            populateSelect('chat-role-filter', state.taxonomy.roles, 'Auto role');
            populateSelect('chat-category-filter', state.taxonomy.categories, 'Auto category');
            populateSelect('chat-sub-category-filter', state.taxonomy.subCategories, 'Auto sub-category');
        } catch (error) {
            console.error('Taxonomy load failed', error);
        }
    }

    function populateSelect(id, values, emptyLabel) {
        const select = document.getElementById(id);
        const current = select.value;
        select.innerHTML = '';
        const emptyOption = document.createElement('option');
        emptyOption.value = '';
        emptyOption.textContent = emptyLabel;
        select.appendChild(emptyOption);
        values.forEach(value => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value;
            if (value === current) option.selected = true;
            select.appendChild(option);
        });
    }

    async function loadRecords() {
        try {
            const res = await fetch(`${apiBase}/api/knowledge/intake/records`);
            const data = await res.json();
            state.records = data.records || [];
            renderRecords();
        } catch (error) {
            console.error('Records load failed', error);
        }
    }

    function renderRecords() {
        if (!state.records.length) {
            recordsBody.innerHTML = '<tr><td colspan="8" class="placeholder-cell">No intake records yet.</td></tr>';
            return;
        }

        recordsBody.innerHTML = '';
        state.records.forEach(record => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>
                    <strong>${escapeHtml(record.title)}</strong>
                    <div class="record-meta">${escapeHtml(record.source_path)}</div>
                </td>
                <td>${escapeHtml(record.role || record.suggested_role || 'General')}</td>
                <td>${escapeHtml(record.category || record.suggested_category || 'General')}</td>
                <td>${escapeHtml([record.sub_category || record.suggested_sub_category, record.company || record.suggested_company, record.project || record.suggested_project, record.commodity || record.suggested_commodity].filter(Boolean).join(' / ') || 'Shared')}</td>
                <td><span class="status-chip ${record.status}">${record.status.replaceAll('_', ' ')}</span></td>
                <td>${formatDate(record.created_at)}</td>
                <td>${record.ingested_at ? formatDate(record.ingested_at) : 'Not yet'}</td>
                <td class="actions-cell"></td>
            `;

            const actionsCell = row.querySelector('.actions-cell');
            const reviewButton = makeActionButton('Review', () => {
                state.currentDraft = { record, classification: null, warnings: record.source_metadata?.warnings || [] };
                renderDraft();
                showSection('knowledge');
            });
            actionsCell.appendChild(reviewButton);

            if (!record.read_only) {
                const approveButton = makeActionButton('Approve', () => approveRecord(record.id, record));
                const ingestButton = makeActionButton('Push to RAG', () => ingestRecord(record.id, record));
                actionsCell.appendChild(approveButton);
                actionsCell.appendChild(ingestButton);
            } else {
                const locked = document.createElement('span');
                locked.className = 'badge blue';
                locked.textContent = 'Read only';
                actionsCell.appendChild(locked);
            }

            recordsBody.appendChild(row);
        });
    }

    function renderDraft() {
        const draft = state.currentDraft;
        if (!draft) {
            draftReview.innerHTML = '<p class="placeholder">Analyze a file or URL to create a draft record. You will see AI recommendations, mismatch warnings, and actions here.</p>';
            return;
        }

        const record = draft.record;
        const warnings = draft.warnings || [];
        draftReview.innerHTML = `
            <div class="draft-card">
                <p class="eyebrow">Draft record #${record.id}</p>
                <h4>${escapeHtml(record.title)}</h4>
                <p class="summary-copy">${escapeHtml(record.source_metadata?.summary || 'Awaiting review')}</p>

                <div class="draft-grid">
                    <label class="field">
                        <span>Role</span>
                        <select id="draft-role"></select>
                    </label>
                    <label class="field">
                        <span>Category</span>
                        <select id="draft-category"></select>
                    </label>
                </div>
                <div class="draft-grid">
                    <label class="field">
                        <span>Sub-category</span>
                        <select id="draft-sub-category"></select>
                    </label>
                    <label class="field">
                        <span>Company</span>
                        <input type="text" id="draft-company" value="${escapeAttribute(record.company || record.suggested_company || '')}">
                    </label>
                </div>
                <div class="draft-grid">
                    <label class="field">
                        <span>Project</span>
                        <input type="text" id="draft-project" value="${escapeAttribute(record.project || record.suggested_project || '')}">
                    </label>
                    <label class="field">
                        <span>Commodity</span>
                        <input type="text" id="draft-commodity" value="${escapeAttribute(record.commodity || record.suggested_commodity || '')}">
                    </label>
                </div>

                <label class="field">
                    <span>Tags</span>
                    <input type="text" id="draft-tags" value="${escapeAttribute((record.tags || record.suggested_tags || []).join(', '))}">
                </label>

                <div class="draft-grid">
                    <div class="record-meta">
                        <strong>AI suggestion</strong><br>
                        ${escapeHtml(record.suggested_role || 'General')} / ${escapeHtml(record.suggested_category || 'General')} / ${escapeHtml(record.suggested_sub_category || 'General')}<br>
                        ${escapeHtml(record.suggested_company || 'Shared')} / ${escapeHtml(record.suggested_project || 'Shared')} / ${escapeHtml(record.suggested_commodity || 'General')}<br>
                        Confidence: ${Math.round((record.classification_confidence || 0) * 100)}%
                    </div>
                    <div class="record-meta">
                        <strong>Status</strong><br>
                        ${escapeHtml(record.status)}<br>
                        ${record.read_only ? 'This record is now read only.' : 'You can still approve metadata or ingest it.'}
                    </div>
                </div>

                ${warnings.length ? `
                    <div class="warning-card">
                        <strong>Review needed</strong>
                        <ul class="warning-list">${warnings.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
                    </div>
                ` : ''}

                <div class="review-actions">
                    <button class="secondary-btn" id="approve-draft-btn" type="button"${record.read_only ? ' disabled' : ''}>Approve metadata</button>
                    <button class="primary-btn" id="ingest-draft-btn" type="button"${record.read_only ? ' disabled' : ''}>Push to RAG</button>
                </div>
            </div>
        `;

        populateSelect('draft-role', state.taxonomy.roles, 'AI recommend');
        populateSelect('draft-category', state.taxonomy.categories, 'AI recommend');
        populateSelect('draft-sub-category', state.taxonomy.subCategories, 'AI recommend');
        document.getElementById('draft-role').value = record.role || record.suggested_role || '';
        document.getElementById('draft-category').value = record.category || record.suggested_category || '';
        document.getElementById('draft-sub-category').value = record.sub_category || record.suggested_sub_category || '';

        const approveButton = document.getElementById('approve-draft-btn');
        const ingestButton = document.getElementById('ingest-draft-btn');
        if (approveButton) approveButton.addEventListener('click', () => approveRecord(record.id, record));
        if (ingestButton) ingestButton.addEventListener('click', () => ingestRecord(record.id, record));
    }

    async function approveRecord(recordId, fallbackRecord) {
        const role = document.getElementById('draft-role')?.value || fallbackRecord.role || fallbackRecord.suggested_role || '';
        const category = document.getElementById('draft-category')?.value || fallbackRecord.category || fallbackRecord.suggested_category || '';
        const subCategory = document.getElementById('draft-sub-category')?.value || fallbackRecord.sub_category || fallbackRecord.suggested_sub_category || '';
        const company = document.getElementById('draft-company')?.value?.trim() || fallbackRecord.company || fallbackRecord.suggested_company || '';
        const project = document.getElementById('draft-project')?.value?.trim() || fallbackRecord.project || fallbackRecord.suggested_project || '';
        const commodity = document.getElementById('draft-commodity')?.value?.trim() || fallbackRecord.commodity || fallbackRecord.suggested_commodity || '';
        const tags = (document.getElementById('draft-tags')?.value || (fallbackRecord.tags || []).join(',')).trim();

        try {
            const res = await fetch(`${apiBase}/api/knowledge/intake/${recordId}/review`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role, category, subCategory, company, project, commodity, tags }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Approval failed');
            state.currentDraft = { record: data.record, warnings: [] };
            renderDraft();
            await Promise.all([loadRecords(), loadTaxonomy()]);
        } catch (error) {
            alert(error.message);
        }
    }

    async function ingestRecord(recordId, fallbackRecord) {
        const role = document.getElementById('draft-role')?.value || fallbackRecord.role || fallbackRecord.suggested_role || '';
        const category = document.getElementById('draft-category')?.value || fallbackRecord.category || fallbackRecord.suggested_category || '';
        const subCategory = document.getElementById('draft-sub-category')?.value || fallbackRecord.sub_category || fallbackRecord.suggested_sub_category || '';
        const company = document.getElementById('draft-company')?.value?.trim() || fallbackRecord.company || fallbackRecord.suggested_company || '';
        const project = document.getElementById('draft-project')?.value?.trim() || fallbackRecord.project || fallbackRecord.suggested_project || '';
        const commodity = document.getElementById('draft-commodity')?.value?.trim() || fallbackRecord.commodity || fallbackRecord.suggested_commodity || '';
        const tags = (document.getElementById('draft-tags')?.value || (fallbackRecord.tags || []).join(',')).trim();

        try {
            const res = await fetch(`${apiBase}/api/knowledge/intake/${recordId}/ingest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role, category, subCategory, company, project, commodity, tags }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Ingestion failed');
            state.currentDraft = { record: data.record, warnings: [] };
            renderDraft();
            await Promise.all([loadRecords(), loadKnowledgeStats(), loadTaxonomy()]);
        } catch (error) {
            alert(error.message);
        }
    }

    fileForm.addEventListener('submit', async event => {
        event.preventDefault();
        const fileInput = document.getElementById('knowledge-file');
        if (!fileInput.files.length) {
            alert('Choose a file first.');
            return;
        }

        const formData = new FormData();
        formData.append('file', fileInput.files[0]);
        formData.append('role', document.getElementById('file-role').value);
        formData.append('category', document.getElementById('file-category').value);
        formData.append('subCategory', document.getElementById('file-sub-category').value);
        formData.append('company', document.getElementById('file-company').value);
        formData.append('project', document.getElementById('file-project').value);
        formData.append('commodity', document.getElementById('file-commodity').value);
        formData.append('tags', document.getElementById('file-tags').value);

        try {
            const res = await fetch(`${apiBase}/api/knowledge/intake/upload`, {
                method: 'POST',
                body: formData,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'File analysis failed');
            state.currentDraft = data;
            renderDraft();
            await Promise.all([loadRecords(), loadTaxonomy()]);
            fileForm.reset();
        } catch (error) {
            alert(error.message);
        }
    });

    urlForm.addEventListener('submit', async event => {
        event.preventDefault();
        const payload = {
            url: document.getElementById('knowledge-url').value.trim(),
            role: document.getElementById('url-role').value,
            category: document.getElementById('url-category').value,
            subCategory: document.getElementById('url-sub-category').value,
            company: document.getElementById('url-company').value.trim(),
            project: document.getElementById('url-project').value.trim(),
            commodity: document.getElementById('url-commodity').value.trim(),
            tags: document.getElementById('url-tags').value,
        };
        if (!payload.url) {
            alert('Enter a URL first.');
            return;
        }

        try {
            const res = await fetch(`${apiBase}/api/knowledge/intake/url`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'URL analysis failed');
            state.currentDraft = data;
            renderDraft();
            await Promise.all([loadRecords(), loadTaxonomy()]);
            urlForm.reset();
        } catch (error) {
            alert(error.message);
        }
    });

    refreshRecordsBtn.addEventListener('click', () => Promise.all([loadRecords(), loadKnowledgeStats()]));

    async function handleChat() {
        const message = chatInput.value.trim();
        if (!message) return;

        // Disable input and send button while processing
        chatInput.disabled = true;
        sendChatBtn.disabled = true;
        sendChatBtn.textContent = 'Sending...';

        appendMessage(chatHistory, 'user', message);
        chatInput.value = '';
        const assistantMessage = appendMessage(chatHistory, 'assistant', '');
        let textContent = '';

        try {
            const response = await fetch(`${apiBase}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message,
                    stream: true,
                    model: document.getElementById('chat-model-select')?.value || 'auto',
                    role: chatRoleFilter.value || undefined,
                    category: chatCategoryFilter.value || undefined,
                    subCategory: chatSubCategoryFilter.value || undefined,
                    company: chatCompanyFilter.value.trim() || undefined,
                    project: chatProjectFilter.value.trim() || undefined,
                    commodity: chatCommodityFilter.value.trim() || undefined,
                }),
            });

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                const lines = decoder.decode(value).split('\n');
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const raw = line.slice(6);
                    if (raw === '[DONE]') break;
                    try {
                        const parsed = JSON.parse(raw);
                        if (parsed.type === 'content') {
                            textContent += parsed.chunk;
                            assistantMessage.textContent = textContent;
                        }
                    } catch (error) {
                        console.error(error);
                    }
                }
            }
            chatHistory.scrollTop = chatHistory.scrollHeight;
        } catch (error) {
            assistantMessage.textContent = 'Error connecting to chat.';
        } finally {
            // Re-enable input and send button after processing
            chatInput.disabled = false;
            sendChatBtn.disabled = false;
            sendChatBtn.textContent = 'Send';
            chatInput.focus();
        }
    }

    sendChatBtn.addEventListener('click', handleChat);
    chatInput.addEventListener('keypress', event => {
        if (event.key === 'Enter') handleChat();
    });

    transBtn.addEventListener('click', async () => {
        const text = transInput.value.trim();
        if (!text) return;

        transBtn.disabled = true;
        transBtn.textContent = 'Translating...';
        transOutput.innerHTML = '';

        try {
            const response = await fetch(`${apiBase}/translate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, targetLang: transTarget.value, stream: true }),
            });
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let output = '';
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                const lines = decoder.decode(value).split('\n');
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const raw = line.slice(6);
                    if (raw === '[DONE]') break;
                    try {
                        const parsed = JSON.parse(raw);
                        output += parsed.chunk || '';
                        transOutput.textContent = output;
                    } catch (error) {
                        console.error(error);
                    }
                }
            }
        } catch (error) {
            transOutput.innerHTML = '<p class="placeholder">Translation failed.</p>';
        } finally {
            transBtn.disabled = false;
            transBtn.textContent = 'Translate';
        }
    });

    let builderBusy = false;

    async function handleBuilderChat() {
        const message = builderInput.value.trim();
        if (!message || builderBusy) return;
        builderBusy = true;
        sendBuilderBtn.disabled = true;
        sendBuilderBtn.textContent = 'Working...';

        appendMessage(builderHistory, 'user', message);
        builderInput.value = '';
        const assistantMessage = appendMessage(builderHistory, 'assistant', '');
        let content = '';

        try {
            const response = await fetch(`${apiBase}/api/builder/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message }),
            });
            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                const lines = decoder.decode(value).split('\n');
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const raw = line.slice(6);
                    if (raw === '[DONE]') break;
                    try {
                        const parsed = JSON.parse(raw);
                        if (parsed.type === 'meta') {
                            builderModelBadge.textContent = parsed.model;
                        } else if (parsed.type === 'tool_start') {
                            appendTerminal(`> ${parsed.tool}`);
                        } else if (parsed.type === 'tool_result') {
                            appendTerminal(parsed.result || '');
                            await loadBuilderTasks();
                        } else if (parsed.type === 'content') {
                            content += parsed.chunk;
                            assistantMessage.textContent = content;
                        }
                    } catch (error) {
                        console.error(error);
                    }
                }
            }
        } catch (error) {
            assistantMessage.textContent = 'Error connecting to builder.';
        } finally {
            builderBusy = false;
            sendBuilderBtn.disabled = false;
            sendBuilderBtn.textContent = 'Build';
        }
    }

    function appendTerminal(text) {
        const placeholder = builderTerminal.querySelector('.terminal-dim');
        if (placeholder) placeholder.remove();
        const line = document.createElement('div');
        line.textContent = text;
        builderTerminal.appendChild(line);
        builderTerminal.scrollTop = builderTerminal.scrollHeight;
    }

    async function loadBuilderTasks() {
        try {
            const res = await fetch(`${apiBase}/api/builder/tasks`);
            const data = await res.json();
            const tasks = data.tasks || [];
            if (!tasks.length) {
                builderTaskList.innerHTML = '<p class="placeholder">No tasks yet.</p>';
                return;
            }
            builderTaskList.innerHTML = '';
            tasks.forEach(task => {
                const item = document.createElement('div');
                item.className = `task-item ${task.status}`;
                item.innerHTML = `
                    <div class="task-desc">${escapeHtml(task.description)}</div>
                    <div class="task-status">${escapeHtml(task.status)}${task.result ? `: ${escapeHtml(task.result.slice(0, 80))}` : ''}</div>
                `;
                builderTaskList.appendChild(item);
            });
        } catch (error) {
            console.error('Builder tasks failed', error);
        }
    }

    sendBuilderBtn.addEventListener('click', handleBuilderChat);
    builderInput.addEventListener('keypress', event => {
        if (event.key === 'Enter') handleBuilderChat();
    });

    builderResetBtn.addEventListener('click', async () => {
        await fetch(`${apiBase}/api/builder/reset`, { method: 'POST' });
        builderHistory.innerHTML = '<div class="msg system">Conversation reset. Ready for a new build task.</div>';
        builderTerminal.innerHTML = '<span class="terminal-dim">Waiting for commands...</span>';
        builderModelBadge.textContent = '...';
        await loadBuilderTasks();
    });

    function appendMessage(container, role, text) {
        const div = document.createElement('div');
        div.className = `msg ${role}`;
        div.textContent = text;
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        return div;
    }

    function makeActionButton(label, handler) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary-btn';
        button.textContent = label;
        button.addEventListener('click', handler);
        return button;
    }

    function showSection(id) {
        navItems.forEach(button => button.classList.toggle('active', button.dataset.section === id));
        sections.forEach(section => section.classList.toggle('hidden', section.id !== id));
        const active = navItems.find(button => button.dataset.section === id);
        pageTitle.textContent = active ? active.textContent.trim() : 'Overview';
    }

    function formatDate(value) {
        if (!value) return 'Not yet';
        return new Date(value).toLocaleString();
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
    }

    function escapeAttribute(value) {
        return escapeHtml(value).replaceAll('\n', ' ');
    }

    setInterval(updateStatus, 1000);
    updateStatus();
    loadPlugins();
    loadKnowledgeStats();
    loadTaxonomy();
    loadRecords();
    loadBuilderTasks();
    renderDraft();
    initModelsSection();
    initExecutionSection();
});

/* ── Execution Module (Project-Scoped RAG Chat) ── */

let currentProjectId = null;
let currentSessionId = null;

function initExecutionSection() {
    const createProjectBtn = document.getElementById('create-project-btn');
    const executionChatInput = document.getElementById('execution-chat-input');
    const executionSendBtn = document.getElementById('execution-send-chat');

    createProjectBtn?.addEventListener('click', () => {
        const name = prompt('Enter project name:');
        if (!name) return;
        fetch('/api/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ node_type: 'project', name }),
        }).then(r => r.json()).then(data => {
            if (data.success) loadProjects();
        });
    });

    executionChatInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleExecutionChat();
    });
    executionSendBtn?.addEventListener('click', handleExecutionChat);

    loadProjects();
}

async function loadProjects() {
    try {
        const res = await fetch('/api/projects');
        const data = await res.json();
        if (!data.success) return;

        const container = document.getElementById('projects-list');
        if (!container) return;

        if (data.projects.length === 0) {
            container.innerHTML = '<p class="placeholder">No projects yet. Create one to start.</p>';
            return;
        }

        container.innerHTML = data.projects.map(p => `
            <div class="project-item ${currentProjectId === p.id ? 'active' : ''}" data-project-id="${p.id}">
                <div class="project-item-header">
                    <span class="icon">📁</span>
                    <span>${p.name}</span>
                </div>
                <div class="project-item-meta">
                    ${new Date(p.created_at).toLocaleDateString()}
                </div>
                <div class="session-list" id="sessions-${p.id}">
                    <p class="placeholder" style="font-size:0.75rem; margin:4px 0;">No sessions</p>
                </div>
            </div>
        `).join('');

        // Add click handlers
        container.querySelectorAll('.project-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const projectId = item.dataset.projectId;
                if (e.target.closest('.session-item')) {
                    // Session click
                    const sessionId = e.target.closest('.session-item').dataset.sessionId;
                    selectSession(projectId, sessionId);
                } else {
                    // Project click - create new session
                    selectProject(projectId);
                }
            });
        });

        // Load sessions for each project
        for (const p of data.projects) {
            loadSessions(p.id);
        }
    } catch (e) {
        console.error('Failed to load projects:', e);
    }
}

async function loadSessions(projectId) {
    try {
        const res = await fetch(`/api/projects/${projectId}/children`);
        const data = await res.json();
        if (!data.success) return;

        const container = document.getElementById(`sessions-${projectId}`);
        if (!container) return;

        const sessions = data.children.filter(c => c.node_type === 'session');
        if (sessions.length === 0) {
            container.innerHTML = '<p class="placeholder" style="font-size:0.75rem; margin:4px 0;">No sessions</p>';
            return;
        }

        container.innerHTML = sessions.map(s => `
            <div class="session-item ${currentSessionId === s.id ? 'active' : ''}" data-session-id="${s.id}">
                ${s.name}
            </div>
        `).join('');
    } catch (e) {
        console.error('Failed to load sessions:', e);
    }
}

function selectProject(projectId) {
    currentProjectId = projectId;
    currentSessionId = null;

    // Create a new session
    fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            node_type: 'session',
            name: `Session ${new Date().toLocaleString()}`,
            parent_id: projectId,
        }),
    }).then(r => r.json()).then(data => {
        if (data.success) {
            selectSession(projectId, data.node.id);
            loadProjects();
        }
    });
}

function selectSession(projectId, sessionId) {
    currentProjectId = projectId;
    currentSessionId = sessionId;

    // Update UI
    document.querySelectorAll('.project-item').forEach(p => p.classList.toggle('active', p.dataset.projectId === projectId));
    document.querySelectorAll('.session-item').forEach(s => s.classList.toggle('active', s.dataset.sessionId === sessionId));

    // Enable chat
    const title = document.getElementById('execution-project-title');
    const input = document.getElementById('execution-chat-input');
    const btn = document.getElementById('execution-send-chat');
    const history = document.getElementById('execution-chat-history');

    if (title) title.textContent = `Project: ${projectId}`;
    if (input) { input.disabled = false; input.placeholder = 'Ask about this project...'; }
    if (btn) btn.disabled = false;
    if (history) history.innerHTML = '<div class="msg system">Session started. Ask anything about this project.</div>';
}

async function handleExecutionChat() {
    const input = document.getElementById('execution-chat-input');
    const message = input.value.trim();
    if (!message || !currentProjectId) return;

    const history = document.getElementById('execution-chat-history');
    if (!history) return;

    // Add user message
    const userMsg = document.createElement('div');
    userMsg.className = 'msg user';
    userMsg.textContent = message;
    history.appendChild(userMsg);

    input.value = '';

    // Add assistant placeholder
    const assistantMsg = document.createElement('div');
    assistantMsg.className = 'msg assistant';
    assistantMsg.textContent = 'Thinking...';
    history.appendChild(assistantMsg);

    try {
        const res = await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message,
                project: currentProjectId,
                stream: false,
            }),
        });
        const data = await res.json();
        assistantMsg.textContent = data.response || 'No response';
    } catch (e) {
        assistantMsg.textContent = 'Error: ' + e.message;
    }
}

/* ── Models Configuration ── */

function initModelsSection() {
    const autoToggle = document.getElementById('auto-mode-toggle');
    const addCloudBtn = document.getElementById('add-cloud-model');
    const addLocalBtn = document.getElementById('add-local-model');

    // Auto mode toggle
    autoToggle?.addEventListener('change', async () => {
        await fetch('/api/models/auto', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: autoToggle.checked }),
        });
    });

    // Add cloud model button
    addCloudBtn?.addEventListener('click', () => {
        showModelEditForm('cloud');
    });

    // Add local model button
    addLocalBtn?.addEventListener('click', () => {
        showModelEditForm('local');
    });

    // Initial load
    loadModels();
}

async function loadModels() {
    try {
        const res = await fetch('/api/models');
        const data = await res.json();
        if (!data.success) return;

        const autoToggle = document.getElementById('auto-mode-toggle');
        if (autoToggle) autoToggle.checked = data.autoMode;

        renderModelList('cloud-models-list', data.cloudModels, 'cloud');
        renderModelList('local-models-list', data.localModels, 'local');

        // Update model selector dropdown in Playground
        const select = document.getElementById('chat-model-select');
        if (select) {
            const currentVal = select.value;
            select.innerHTML = '<option value="auto">Auto (cloud → local)</option>';
            const allModels = [...(data.cloudModels || []), ...(data.localModels || [])]
                .filter(m => m.enabled)
                .sort((a, b) => a.priority - b.priority);
            allModels.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.textContent = `${m.name} (${m.type === 'cloud' ? m.provider : 'local'})`;
                select.appendChild(opt);
            });
            select.value = currentVal || 'auto';
        }
    } catch (e) {
        console.error('Failed to load models:', e);
    }
}

function renderModelList(containerId, models, type) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!models || models.length === 0) {
        container.innerHTML = '<p class="placeholder">No models configured.</p>';
        return;
    }

    const sorted = [...models].sort((a, b) => a.priority - b.priority);

    container.innerHTML = sorted.map((m, i) => `
        <div class="model-row" data-model-id="${m.id}" data-model-type="${type}" draggable="true">
            <span class="drag-handle" title="Drag to reorder">⠿</span>
            <div class="model-info">
                <span class="model-name">
                    ${m.name}
                    ${m.recommended ? '<span class="recommended-badge">RECOMMENDED</span>' : ''}
                </span>
                <span class="model-meta">
                    ${type === 'cloud' ? `${m.provider} · ${m.modelId}${m.apiKey ? ' · ✅ API key set' : ' · ⚠️ No API key'}` : `ollama · ${m.modelId}`}
                    ${m.notes ? ` · ${m.notes}` : ''}
                </span>
            </div>
            <div class="model-actions">
                ${type === 'cloud' ? `<button class="icon-btn" onclick="testModel('${m.id}')">Test</button>` : ''}
                <button class="icon-btn" onclick="editModel('${m.id}', '${type}')">Edit</button>
                <button class="icon-btn danger" onclick="deleteModel('${m.id}')">✕</button>
            </div>
            <label class="switch-label">
                <input type="checkbox" ${m.enabled ? 'checked' : ''} onchange="toggleModel('${m.id}')">
                <span class="switch-slider"></span>
            </label>
        </div>
    `).join('');

    // Enable drag & drop reorder
    setupDragReorder(container, type);
}

function setupDragReorder(container, type) {
    let draggedEl = null;

    container.querySelectorAll('.model-row').forEach(row => {
        row.addEventListener('dragstart', () => {
            draggedEl = row;
            row.classList.add('dragging');
        });
        row.addEventListener('dragend', () => {
            row.classList.remove('dragging');
            document.querySelectorAll('.model-row').forEach(r => r.classList.remove('drag-over'));
            // Save new order
            const ids = Array.from(container.querySelectorAll('.model-row')).map(r => r.dataset.modelId);
            const endpoint = type === 'cloud' ? '/api/models/reorder/cloud' : '/api/models/reorder/local';
            fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ order: ids }),
            });
        });
        row.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (row !== draggedEl) row.classList.add('drag-over');
        });
        row.addEventListener('dragleave', () => {
            row.classList.remove('drag-over');
        });
        row.addEventListener('drop', (e) => {
            e.preventDefault();
            row.classList.remove('drag-over');
            if (draggedEl && row !== draggedEl && draggedEl.parentNode === row.parentNode) {
                const rows = Array.from(container.querySelectorAll('.model-row'));
                const fromIdx = rows.indexOf(draggedEl);
                const toIdx = rows.indexOf(row);
                if (fromIdx < toIdx) {
                    row.parentNode.insertBefore(draggedEl, row.nextSibling);
                } else {
                    row.parentNode.insertBefore(draggedEl, row);
                }
            }
        });
    });
}

async function toggleModel(id) {
    await fetch('/api/models/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
    });
    loadModels();
}

async function deleteModel(id) {
    if (!confirm('Delete this model configuration?')) return;
    await fetch('/api/models', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
    });
    loadModels();
}

async function testModel(id) {
    const btn = document.querySelector(`.model-row[data-model-id="${id}"] .icon-btn`);
    if (btn) { btn.textContent = 'Testing...'; btn.disabled = true; }

    try {
        const res = await fetch('/api/models/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
        });
        const data = await res.json();
        if (btn) {
            if (data.ok) {
                btn.textContent = `✓ ${data.latencyMs}ms`;
                btn.className = 'icon-btn test-ok';
            } else {
                btn.textContent = '✗ Fail';
                btn.className = 'icon-btn test-fail';
                btn.title = data.error || 'Unknown error';
            }
            setTimeout(() => {
                btn.textContent = 'Test';
                btn.className = 'icon-btn';
                btn.disabled = false;
            }, 4000);
        }
    } catch (e) {
        if (btn) { btn.textContent = 'Test'; btn.disabled = false; }
    }
}

function editModel(id, type) {
    // Find model data from current rendered list
    const row = document.querySelector(`.model-row[data-model-id="${id}"]`);
    if (!row) return;

    // Fetch fresh data
    fetch('/api/models')
        .then(r => r.json())
        .then(data => {
            const allModels = [...data.cloudModels, ...data.localModels];
            const model = allModels.find(m => m.id === id);
            if (model) showModelEditForm(type, model);
        });
}

function showModelEditForm(type, existing = null) {
    const isCloud = type === 'cloud';
    const m = existing || {
        id: '',
        name: '',
        provider: isCloud ? 'nvidia' : 'ollama',
        modelId: '',
        apiKey: '',
        baseUrl: isCloud ? 'https://integrate.api.nvidia.com/v1' : '',
        enabled: false,
        priority: 99,
        maxTokens: 4096,
        timeoutMs: 30000,
        recommended: false,
        notes: '',
    };

    // Remove any existing form
    document.querySelector('.model-edit-form')?.remove();

    const form = document.createElement('div');
    form.className = 'model-edit-form';
    form.innerHTML = `
        <div class="field">
            <label>Display Name</label>
            <input type="text" data-field="name" value="${m.name}" placeholder="e.g. Llama 3.1 405B">
        </div>
        <div class="field">
            <label>Model ID</label>
            <input type="text" data-field="modelId" value="${m.modelId}" placeholder="${isCloud ? 'meta/llama-3.1-405b-instruct' : 'phi3.5:latest'}">
        </div>
        ${isCloud ? `
        <div class="field">
            <label>Provider</label>
            <select data-field="provider">
                <option value="nvidia" ${m.provider === 'nvidia' ? 'selected' : ''}>NVIDIA</option>
                <option value="google" ${m.provider === 'google' ? 'selected' : ''}>Google</option>
                <option value="anthropic" ${m.provider === 'anthropic' ? 'selected' : ''}>Anthropic</option>
                <option value="openai" ${m.provider === 'openai' ? 'selected' : ''}>OpenAI</option>
                <option value="other" ${m.provider === 'other' ? 'selected' : ''}>Other</option>
            </select>
        </div>
        <div class="field">
            <label>Base URL</label>
            <input type="text" data-field="baseUrl" value="${m.baseUrl}" placeholder="https://integrate.api.nvidia.com/v1">
        </div>
        <div class="field span-two">
            <label>API Key</label>
            <input type="password" data-field="apiKey" value="${m.apiKey || ''}" placeholder="nvapi-xxxx...">
        </div>
        ` : ''}
        <div class="field">
            <label>Max Tokens</label>
            <input type="number" data-field="maxTokens" value="${m.maxTokens || 4096}">
        </div>
        <div class="field">
            <label>Timeout (ms)</label>
            <input type="number" data-field="timeoutMs" value="${m.timeoutMs || 30000}">
        </div>
        <div class="field span-two">
            <label>Notes</label>
            <input type="text" data-field="notes" value="${m.notes || ''}" placeholder="Optional notes about this model">
        </div>
        <div class="form-actions">
            <button class="icon-btn" onclick="this.closest('.model-edit-form').remove()">Cancel</button>
            <button class="primary-btn small" id="save-model-btn">Save</button>
        </div>
    `;

    // Insert after the appropriate list
    const listId = isCloud ? 'cloud-models-list' : 'local-models-list';
    document.getElementById(listId)?.after(form);

    // Save handler
    form.querySelector('#save-model-btn')?.addEventListener('click', async () => {
        const fields = form.querySelectorAll('[data-field]');
        const payload = {
            id: m.id || `${isCloud ? 'cloud' : 'local'}-${Date.now()}`,
            type,
            enabled: m.enabled,
            priority: m.priority,
            recommended: m.recommended,
        };
        fields.forEach(f => {
            const key = f.dataset.field;
            payload[key] = f.tagName === 'SELECT' ? f.value : f.value;
        });
        // Convert numbers
        if (payload.maxTokens) payload.maxTokens = parseInt(payload.maxTokens);
        if (payload.timeoutMs) payload.timeoutMs = parseInt(payload.timeoutMs);

        const endpoint = isCloud ? '/api/models/cloud' : '/api/models/local';
        await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        form.remove();
        loadModels();
    });
}
