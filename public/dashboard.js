document.addEventListener('DOMContentLoaded', () => {
    const apiBase = ''; // Current host

    // Navigation
    const navItems = document.querySelectorAll('nav li');
    const sections = document.querySelectorAll('.view');
    const topNavTitle = document.querySelector('.top-nav h1');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const sectionId = item.getAttribute('data-section');
            
            navItems.forEach(n => n.classList.remove('active'));
            item.classList.add('active');

            sections.forEach(s => {
                s.classList.toggle('hidden', s.id !== sectionId);
            });

            topNavTitle.textContent = item.textContent.trim();
        });
    });

    // Tool Selector
    const toolBtns = document.querySelectorAll('.tool-btn');
    const toolUIs = document.querySelectorAll('.tool-ui');

    toolBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const toolId = btn.getAttribute('data-tool');
            toolBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            toolUIs.forEach(ui => {
                ui.classList.toggle('hidden', ui.id !== `${toolId}-tool`);
            });
        });
    });

    // Uptime & Status Info
    async function updateStatus() {
        try {
            const res = await fetch(`${apiBase}/health`);
            const data = await res.json();
            
            const seconds = Math.floor(data.uptime);
            const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
            const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
            const s = (seconds % 60).toString().padStart(2, '0');
            
            document.getElementById('uptime-val').textContent = `${h}:${m}:${s}`;
        } catch (e) {
            console.error('Status check failed', e);
        }
    }

    async function loadPlugins() {
        try {
            const res = await fetch(`${apiBase}/api/plugins`);
            const plugins = await res.json();
            
            document.getElementById('plugin-count').textContent = plugins.length;
            
            const list = document.getElementById('plugin-list');
            list.innerHTML = '';
            
            plugins.forEach(p => {
                const card = document.createElement('div');
                card.className = 'plugin-card glass';
                card.innerHTML = `
                    <div class="ver">v${p.version}</div>
                    <h4>${p.name}</h4>
                    <p class="desc">${p.description}</p>
                `;
                list.appendChild(card);
            });

            const hasOllama = plugins.some(p => p.name === 'ollama');
            document.getElementById('ollama-status').textContent = hasOllama ? 'Linked' : 'Missing';
            document.getElementById('ollama-status').style.color = hasOllama ? '#00ff88' : '#ff4d4d';
        } catch (e) {
            console.error('Plugin load failed', e);
        }
    }

    // Chat Logic
    const chatInput = document.getElementById('chat-input');
    const chatHistory = document.getElementById('chat-history');
    const sendBtn = document.getElementById('send-chat');

    async function handleChat() {
        const message = chatInput.value.trim();
        if (!message) return;

        appendMessage('user', message);
        chatInput.value = '';

        const assistantMsgDiv = appendMessage('assistant', '');
        
        try {
            const response = await fetch(`${apiBase}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message, stream: true })
            });

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                
                const lines = decoder.decode(value).split('\n');
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') break;
                        try {
                            const { chunk } = JSON.parse(data);
                            assistantMsgDiv.textContent += chunk;
                            chatHistory.scrollTop = chatHistory.scrollHeight;
                        } catch (e) {}
                    }
                }
            }
        } catch (e) {
            assistantMsgDiv.textContent = 'Error connecting to agent.';
        }
    }

    function appendMessage(role, text) {
        const div = document.createElement('div');
        div.className = `msg ${role}`;
        div.textContent = text;
        chatHistory.appendChild(div);
        chatHistory.scrollTop = chatHistory.scrollHeight;
        return div;
    }

    sendBtn.addEventListener('click', handleChat);
    chatInput.addEventListener('keypress', (e) => { if(e.key === 'Enter') handleChat(); });

    // Translation Logic
    const transBtn = document.getElementById('run-translate');
    const transInput = document.getElementById('translate-input');
    const transTarget = document.getElementById('target-lang');
    const transOutput = document.getElementById('translation-output');

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
                body: JSON.stringify({ text, targetLang: transTarget.value, stream: true })
            });

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;

                const lines = decoder.decode(value).split('\n');
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') break;
                        try {
                            const { chunk } = JSON.parse(data);
                            transOutput.innerHTML += chunk;
                        } catch (e) {}
                    }
                }
            }
        } catch (e) {
            transOutput.innerHTML = `<p style="color:#ff4d4d">Translation failed.</p>`;
        } finally {
            transBtn.disabled = false;
            transBtn.textContent = 'Translate';
        }
    });

    // Add Performance Guide dynamically
    const docsView = document.getElementById('docs');
    if (docsView) {
        docsView.innerHTML = `
            <h2>High-Performance Guide</h2>
            <div class="glass" style="padding: 20px; margin-top: 20px;">
                <h4 style="color: var(--accent-secondary)">🚀 Recommendation for Speed</h4>
                <p style="margin-top: 10px; font-size: 14px; color: var(--text-dim)">
                    For the fastest responses, we recommend switching to smaller, optimized models in Ollama:
                </p>
                <ul style="margin: 15px 0 0 20px; font-size: 14px; color: var(--text-dim)">
                    <li><strong>Llama 3.2 (1B/3B)</strong>: <code>ollama run llama3.2:1b</code></li>
                    <li><strong>Phi-3.5 Mini</strong>: <code>ollama run phi3.5:latest</code></li>
                    <li><strong>Qwen 2.5 (3B)</strong>: <code>ollama run qwen2.5:3b</code></li>
                </ul>
                <p style="margin-top: 15px; font-size: 14px; color: var(--accent-primary)">
                    💡 We have enabled <strong>Server-Sent Events (SSE)</strong> for real-time streaming!
                </p>
            </div>
        `;
    }

    // Initial Load
    setInterval(updateStatus, 1000);
    updateStatus();
    loadPlugins();
});
