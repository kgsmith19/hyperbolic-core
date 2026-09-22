/**
 * Deep Search Frontend Application Orchestrator
 * Coordinates events, mode selection, settings drawer, deep parameters,
 * concurrency controls, pre-run workload estimation, cancellation kill-switch,
 * reports archive, and execution pipeline.
 */

function selectMode(mode) {
    window.appState.setMode(mode);
    updatePreRunEstimate();
}

function toggleSettings() {
    window.appState.toggleSettings();
}

function toggleParams() {
    window.appState.toggleParams();
}

function toggleReportsArchive() {
    window.appState.toggleReports();
}

function syncConcurrency(val) {
    const num = Math.max(1, Math.min(10, parseInt(val, 10) || 4));
    const range = document.getElementById('concurrency-range');
    const input = document.getElementById('concurrency');
    if (range) range.value = num;
    if (input) input.value = num;

    // Update active preset button style
    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    const matchBtn = document.getElementById(`preset-${num}`);
    if (matchBtn) matchBtn.classList.add('active');

    updatePreRunEstimate();
}

function setConcurrencyPreset(val) {
    syncConcurrency(val);
}

let estimateDebounceTimer = null;

async function updatePreRunEstimate() {
    clearTimeout(estimateDebounceTimer);
    estimateDebounceTimer = setTimeout(async () => {
        const mode = window.appState.selectedMode || 'extreme';
        const model = document.getElementById('openai-model')?.value || 'gpt-4o-mini';
        const reasoningEffort = document.getElementById('reasoning-effort')?.value || 'medium';
        const maxDocs = parseInt(document.getElementById('max-docs')?.value || '25', 10);
        const concurrency = parseInt(document.getElementById('concurrency')?.value || '4', 10);
        const topic = document.getElementById('topic')?.value || '';

        const params = {
            mode,
            model,
            reasoning_effort: reasoningEffort,
            max_documents: maxDocs,
            concurrency,
            topic
        };

        try {
            const estimate = await window.ApiClient.fetchEstimate(params);
            window.UiRenderer.renderPreRunEstimate(estimate);
        } catch (err) {
            // Local fallback calculation if offline or server is starting
            const isOffline = mode === 'deterministic' || mode === 'extreme';
            window.UiRenderer.renderPreRunEstimate({
                mode,
                model: isOffline ? 'offline-cpu' : model,
                reasoning_effort: isOffline ? 'n/a' : reasoningEffort,
                api_calls: isOffline ? 0 : (mode === 'expansion' ? 1 : 2),
                concurrency_workers: concurrency,
                estimated_prompt_tokens: isOffline ? 0 : 5000,
                estimated_completion_tokens: isOffline ? 0 : 1000,
                estimated_total_tokens: isOffline ? 0 : 6000,
                estimated_cost_display: isOffline ? '$0.00 (100% Free / Offline)' : '~$0.003 USD',
                call_breakdown: isOffline ? [
                    { step: 'Local Air-Gapped Discovery', calls: 0, desc: `${concurrency} parallel workers with territory reservation` }
                ] : [
                    { step: 'Query Planning', calls: 1, desc: `Angle expansion via ${model}` },
                    { step: 'Sourced Synthesis', calls: mode === 'full' ? 1 : 0, desc: `Executive summary via ${model}` }
                ]
            });
        }
    }, 60);
}

async function loadSettings() {
    try {
        const data = await window.ApiClient.fetchSettings();
        window.appState.updateSettings(data);
    } catch (err) {
        console.warn('Could not load provider settings:', err);
    }
}

async function loadModels() {
    try {
        const data = await window.ApiClient.fetchModels();
        const select = document.getElementById('openai-model');
        if (select && data.models && data.models.length > 0) {
            const currentVal = select.value;
            select.innerHTML = '';
            data.models.forEach(m => {
                const opt = document.createElement('option');
                const modelId = typeof m === 'string' ? m : m.id;
                const inRate = typeof m === 'object' && m.input_per_m !== undefined ? `$${m.input_per_m}` : '';
                const outRate = typeof m === 'object' && m.output_per_m !== undefined ? `$${m.output_per_m}` : '';
                const tag = inRate ? ` (${inRate}/${outRate} Mtok)` : '';
                opt.value = modelId;
                opt.innerText = `${modelId}${tag}`;
                if (modelId === currentVal || (!currentVal && modelId === 'gpt-4o-mini')) {
                    opt.selected = true;
                }
                select.appendChild(opt);
            });
            updatePreRunEstimate();
        }
    } catch (err) {
        console.warn('Could not load models list:', err);
    }
}

async function loadReports() {
    try {
        const data = await window.ApiClient.fetchReports();
        window.appState.setReports(data.reports || []);
    } catch (err) {
        console.warn('Could not load archived reports:', err);
    }
}

async function saveSettings() {
    const braveKey = document.getElementById('brave-key').value.trim();
    const openaiKey = document.getElementById('openai-key').value.trim();
    const searxngUrl = document.getElementById('searxng-url').value.trim();
    const localLlmUrl = document.getElementById('local-llm-url').value.trim();
    const msg = document.getElementById('settings-status-msg');

    const payload = { searxng_url: searxngUrl, local_llm_url: localLlmUrl };
    if (braveKey && !braveKey.startsWith('***')) payload.brave_key = braveKey;
    if (openaiKey && !openaiKey.startsWith('***')) payload.openai_key = openaiKey;

    try {
        await window.ApiClient.saveSettings(payload);
        if (msg) {
            msg.style.display = 'inline';
            msg.innerText = 'Saved to .env & applied!';
            setTimeout(() => { msg.style.display = 'none'; }, 3000);
        }
        await loadSettings();
    } catch (err) {
        alert('Failed to save settings: ' + err.message);
    }
}

async function cancelResearch() {
    try {
        window.UiRenderer.renderStatus('running', '🛑 Cancellation requested. Terminating workers and compiling partial results...');
        const res = await window.ApiClient.cancelResearch();
        console.log('Cancellation dispatched:', res);
    } catch (err) {
        console.warn('Cancellation request failed:', err);
    }
}

async function executeResearch() {
    const topic = document.getElementById('topic').value.trim();
    const watchlist = document.getElementById('watchlist').value.trim();
    const runBtn = document.getElementById('run-btn');
    const resultsSection = document.getElementById('results-section');

    if (!topic) {
        alert('Please enter a research topic.');
        return;
    }

    const maxDepth = parseInt(document.getElementById('max-depth')?.value || '3', 10);
    const maxDocs = parseInt(document.getElementById('max-docs')?.value || '25', 10);
    const maxDuration = parseFloat(document.getElementById('max-duration')?.value || '180');
    const concurrency = parseInt(document.getElementById('concurrency')?.value || '4', 10);
    const openaiModel = document.getElementById('openai-model')?.value || 'gpt-4o-mini';
    const reasoningEffort = document.getElementById('reasoning-effort')?.value || 'medium';
    const maxSpend = parseFloat(document.getElementById('max-spend')?.value || '2.00');
    const openaiKey = document.getElementById('openai-key')?.value?.trim();
    const braveKey = document.getElementById('brave-key')?.value?.trim();

    const payload = {
        topic,
        watchlist,
        mode: window.appState.selectedMode,
        max_depth: maxDepth,
        max_documents: maxDocs,
        max_duration_sec: maxDuration,
        concurrency,
        openai_model: openaiModel,
        reasoning_effort: reasoningEffort,
        max_spend_usd: maxSpend
    };

    if (openaiKey && !openaiKey.startsWith('***')) {
        payload.openai_key = openaiKey;
    }
    if (braveKey && !braveKey.startsWith('***')) {
        payload.brave_key = braveKey;
    }

    window.appState.setRunning(true);
    if (runBtn) runBtn.disabled = true;
    if (resultsSection) resultsSection.style.display = 'none';

    window.UiRenderer.renderStatus('running', 'Initializing Secret Core, partitioning crawl territory, and launching concurrent workers...');

    try {
        const data = await window.ApiClient.executeResearch(payload);
        window.UiRenderer.renderStatus('', '');
        window.appState.setResult(data);
        window.UiRenderer.renderResults(data);
        // Refresh archive list after report is written
        await loadReports();
    } catch (err) {
        window.UiRenderer.renderStatus('error', '⚠️ ' + err.message);
    } finally {
        window.appState.setRunning(false);
        if (runBtn) runBtn.disabled = false;
    }
}

// State change subscriptions
window.appState.subscribe((event, value) => {
    if (event === 'mode') {
        document.querySelectorAll('.mode-option').forEach(el => {
            const input = el.querySelector('input');
            const isMatch = input && input.value === value;
            el.classList.toggle('active', isMatch);
            if (input) input.checked = isMatch;
        });
        updatePreRunEstimate();
    } else if (event === 'settingsOpen') {
        const body = document.getElementById('settings-body');
        const btn = document.getElementById('settings-toggle-btn');
        if (body) body.style.display = value ? 'block' : 'none';
        if (btn) btn.innerText = value ? '▲ Close' : '▼ Configure Keys';
    } else if (event === 'paramsOpen') {
        const body = document.getElementById('params-body');
        const btn = document.getElementById('params-toggle-btn');
        if (body) body.style.display = value ? 'grid' : 'none';
        if (btn) btn.innerText = value ? '▲ Close Limits' : '▼ Adjust Limits & Model';
    } else if (event === 'reportsOpen') {
        const body = document.getElementById('reports-body');
        const btn = document.getElementById('reports-toggle-btn');
        if (body) {
            body.style.display = value ? 'block' : 'none';
            if (value) loadReports();
        }
        if (btn) btn.innerText = value ? '▲ Close Archive' : '▼ View Archive';
    } else if (event === 'reports') {
        window.UiRenderer.renderReportsList(value);
    } else if (event === 'settings') {
        const braveInput = document.getElementById('brave-key');
        const openaiInput = document.getElementById('openai-key');
        const searxngInput = document.getElementById('searxng-url');
        const localLlmInput = document.getElementById('local-llm-url');

        if (braveInput && value.hasBrave) {
            braveInput.placeholder = `Configured (${value.bravePreview})`;
        }
        if (openaiInput && value.hasOpenAI) {
            openaiInput.placeholder = `Configured (${value.openaiPreview})`;
        }
        if (searxngInput && value.searxngUrl) {
            searxngInput.value = value.searxngUrl;
        }
        if (localLlmInput && value.localLlmUrl) {
            localLlmInput.value = value.localLlmUrl;
        }

        window.UiRenderer.renderSettingsBadge(value);
    }
});

// Bootstrap on DOM load
window.addEventListener('DOMContentLoaded', async () => {
    await loadSettings();
    await loadModels();
    await loadReports();

    try {
        const defaults = await window.ApiClient.fetchDefaults();
        const topicEl = document.getElementById('topic');
        const watchlistEl = document.getElementById('watchlist');
        if (topicEl && defaults.topic) topicEl.value = defaults.topic;
        if (watchlistEl && defaults.watchlist) watchlistEl.value = defaults.watchlist;
    } catch (e) {
        // Defaults are optional
    }

    // Attach listeners for dynamic pre-run cost & workload estimation
    const inputsToWatch = ['openai-model', 'reasoning-effort', 'max-docs', 'max-depth', 'topic'];
    inputsToWatch.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', updatePreRunEstimate);
            el.addEventListener('change', updatePreRunEstimate);
        }
    });

    // Initial pre-run estimate calculation
    updatePreRunEstimate();
});
