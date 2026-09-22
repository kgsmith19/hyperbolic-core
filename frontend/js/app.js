/**
 * Deep Search Frontend Application Orchestrator
 * Coordinates options, settings, preview, confirm, cancel, and launch.
 */

function toggleSettings() {
    window.appState.toggleSettings();
}

function toggleParams() {
    window.appState.toggleParams();
}

function toggleReportsArchive() {
    window.appState.toggleReports();
}

function collectOptionsFromForm() {
    return {
        blind_watchlist: Boolean(document.getElementById('blind-watchlist')?.checked),
        decoy_queries: parseInt(document.getElementById('decoy-queries')?.value || '0', 10),
        ai_planning: Boolean(document.getElementById('ai-planning')?.checked),
        ai_summary: Boolean(document.getElementById('ai-summary')?.checked),
        max_depth: parseInt(document.getElementById('max-depth')?.value || '2', 10),
        max_documents: parseInt(document.getElementById('max-docs')?.value || '15', 10),
        max_duration_sec: parseFloat(document.getElementById('max-duration')?.value || '180'),
        concurrency: parseInt(document.getElementById('concurrency')?.value || '4', 10),
        openai_model: document.getElementById('openai-model')?.value || 'gpt-4o-mini',
        reasoning_effort: document.getElementById('reasoning-effort')?.value || 'medium',
        max_spend_usd: parseFloat(document.getElementById('max-spend')?.value || '2.00'),
        topic: document.getElementById('topic')?.value || ''
    };
}

function applyMacro(name) {
    const blind = document.getElementById('blind-watchlist');
    const decoys = document.getElementById('decoy-queries');
    const plan = document.getElementById('ai-planning');
    const summary = document.getElementById('ai-summary');
    if (!blind || !decoys || !plan || !summary) return;

    if (name === 'local') {
        blind.checked = false;
        decoys.value = 0;
        plan.checked = false;
        summary.checked = false;
    } else if (name === 'private') {
        blind.checked = true;
        decoys.value = 3;
        plan.checked = false;
        summary.checked = false;
    } else if (name === 'plan') {
        blind.checked = false;
        decoys.value = 0;
        plan.checked = true;
        summary.checked = false;
    } else if (name === 'brief') {
        blind.checked = false;
        decoys.value = 0;
        plan.checked = true;
        summary.checked = true;
    }
    const confirm = document.getElementById('confirm-weaker-recall');
    if (confirm) confirm.checked = false;
    updatePreRunEstimate();
}

function syncConcurrency(val) {
    const num = Math.max(1, Math.min(10, parseInt(val, 10) || 4));
    const range = document.getElementById('concurrency-range');
    const input = document.getElementById('concurrency');
    if (range) range.value = num;
    if (input) input.value = num;

    document.querySelectorAll('.preset-btn').forEach(btn => {
        if (btn.id && btn.id.startsWith('preset-')) btn.classList.remove('active');
    });
    const matchBtn = document.getElementById(`preset-${num}`);
    if (matchBtn) matchBtn.classList.add('active');

    updatePreRunEstimate();
}

function setConcurrencyPreset(val) {
    syncConcurrency(val);
}

function syncLaunchEnabled() {
    const runBtn = document.getElementById('run-btn');
    const wrap = document.getElementById('confirm-weaker-wrap');
    const confirm = document.getElementById('confirm-weaker-recall');
    const preview = window.appState.lastPreview;
    const needsConfirm = Boolean(preview && preview.requires_confirm);
    if (wrap) wrap.style.display = needsConfirm ? 'block' : 'none';
    if (runBtn) {
        runBtn.disabled = Boolean(window.appState.isRunning || (needsConfirm && !confirm?.checked));
    }
}

let estimateDebounceTimer = null;

async function updatePreRunEstimate() {
    clearTimeout(estimateDebounceTimer);
    estimateDebounceTimer = setTimeout(async () => {
        const params = collectOptionsFromForm();
        try {
            const estimate = await window.ApiClient.fetchEstimate(params);
            window.appState.setPreview(estimate);
            window.UiRenderer.renderPreRunEstimate(estimate);
        } catch (err) {
            const fallback = {
                expected_hops: params.max_depth,
                expected_sources: params.max_documents,
                expected_duration_sec: params.max_duration_sec,
                expected_spend_usd: 0,
                expected_cost_display: (params.ai_planning || params.ai_summary) ? '~$0.003 USD' : '$0.00 (100% Free / Offline)',
                warnings: [],
                requires_confirm: Boolean(params.blind_watchlist || params.decoy_queries > 0)
            };
            window.appState.setPreview(fallback);
            window.UiRenderer.renderPreRunEstimate(fallback);
        }
        syncLaunchEnabled();
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
        window.UiRenderer.renderStatus('running', 'Cancellation requested. Terminating workers and compiling partial results...');
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

    const options = collectOptionsFromForm();
    const preview = window.appState.lastPreview;
    const confirm = document.getElementById('confirm-weaker-recall');
    if (preview && preview.requires_confirm && !confirm?.checked) {
        alert('This combination reduces recall. Check "I accept weaker recall" to launch.');
        return;
    }

    const openaiKey = document.getElementById('openai-key')?.value?.trim();
    const braveKey = document.getElementById('brave-key')?.value?.trim();
    const payload = {
        topic,
        watchlist,
        ...options
    };
    if (openaiKey && !openaiKey.startsWith('***')) payload.openai_key = openaiKey;
    if (braveKey && !braveKey.startsWith('***')) payload.brave_key = braveKey;

    window.appState.setRunning(true);
    if (runBtn) runBtn.disabled = true;
    if (resultsSection) resultsSection.style.display = 'none';
    window.UiRenderer.renderStatus('running', 'Initializing Secret Core and launching concurrent workers...');

    try {
        const data = await window.ApiClient.executeResearch(payload);
        window.UiRenderer.renderStatus('', '');
        window.appState.setResult(data);
        window.UiRenderer.renderResults(data);
        await loadReports();
    } catch (err) {
        window.UiRenderer.renderStatus('error', '⚠️ ' + err.message);
    } finally {
        window.appState.setRunning(false);
        syncLaunchEnabled();
    }
}

window.appState.subscribe((event, value) => {
    if (event === 'settingsOpen') {
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
    } else if (event === 'preview') {
        syncLaunchEnabled();
    }
});

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

    const inputsToWatch = ['openai-model', 'reasoning-effort', 'max-docs', 'max-depth', 'max-duration', 'topic', 'blind-watchlist', 'decoy-queries', 'ai-planning', 'ai-summary'];
    inputsToWatch.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', updatePreRunEstimate);
            el.addEventListener('change', updatePreRunEstimate);
        }
    });

    updatePreRunEstimate();
});
