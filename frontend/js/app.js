/**
 * Deep Search controller: wires the composer, plan review, live run, results,
 * history rail, and settings to the API.
 */

const S = window.appState;
const R = window.UiRenderer;
const $ = (id) => document.getElementById(id);

let estimateTimer = null;
let clockTimer = null;
let sourceFilter = { lane: '', text: '', sort: 'rank' };
let currentReportFile = '';

/* ------------------------------------------------------------------ options */

function intVal(id, fallback) {
    const v = parseInt($(id)?.value, 10);
    return Number.isFinite(v) ? v : fallback;
}

function floatVal(id, fallback) {
    const v = parseFloat($(id)?.value);
    return Number.isFinite(v) ? v : fallback;
}

function checked(id, fallback = false) {
    const node = $(id);
    return node ? Boolean(node.checked) : fallback;
}

function collectOptionsFromForm() {
    const maxDocs = intVal('max-docs', 90);
    const conceal = checked('conceal-process');
    return {
        topic: $('topic')?.value || '',
        preset: S.preset,
        academic_weight: intVal('academic-weight', 50) / 100,
        source_lanes: [...S.lanes],
        max_duration_min: floatVal('max-duration-min', 15),
        max_documents: maxDocs,
        rerank_keep: maxDocs,
        max_depth: intVal('max-depth', 2),
        max_gap_rounds: intVal('max-gap-rounds', 3),
        breadth: intVal('breadth', 6),
        queries_per_round: intVal('queries-per-round', 5),
        concurrency: intVal('concurrency', 6),
        max_per_domain: (S.presets[S.preset] || {}).max_per_domain || 6,
        results_per_lane: (S.presets[S.preset] || {}).results_per_lane || 8,
        llm_gap_rounds: (S.presets[S.preset] || {}).llm_gap_rounds || 1,
        follow_leads: checked('follow-leads', true),
        citation_expansion: checked('citation-expansion', true),
        claim_verification: checked('claim-verification', true),
        rerank_results: checked('rerank-results', true),
        query_rewrite: checked('query-rewrite', true),
        hyde_queries: checked('hyde-queries', true),
        chunk_documents: true,
        graph_prioritization: true,
        ai_planning: checked('ai-planning'),
        ai_summary: checked('ai-summary'),
        llm_process: conceal ? 'hide' : 'show',
        concealer_model: $('concealer-model')?.value || 'gpt-4o-mini',
        deep_model: $('deep-model')?.value || 'gpt-4o',
        openai_model: $('concealer-model')?.value || 'gpt-4o-mini',
        reasoning_effort: $('reasoning-effort')?.value || 'medium',
        max_spend_usd: floatVal('max-spend', 2),
        blind_watchlist: checked('blind-watchlist'),
        decoy_queries: intVal('decoy-queries', 0)
    };
}

function applyPreset(name, { silent = false } = {}) {
    const p = S.presets[name];
    if (!p) return;
    S.preset = name;
    R.markPreset(name);
    const map = {
        'max-duration-min': p.max_duration_min, 'max-docs': p.max_documents, 'max-depth': p.max_depth,
        'max-gap-rounds': p.max_gap_rounds, 'breadth': p.breadth, 'queries-per-round': p.queries_per_round,
        'concurrency': p.concurrency
    };
    Object.entries(map).forEach(([id, v]) => { if ($(id) && v !== undefined) $(id).value = v; });
    if (!silent) updateEstimate();
}

function syncPrivacySummary() {
    const words = ($('watchlist')?.value || '').split('\n').filter(s => s.trim()).length;
    const blind = checked('blind-watchlist');
    const conceal = checked('conceal-process');
    const decoys = intVal('decoy-queries', 0);
    const on = words || blind || conceal || decoys;
    const parts = [];
    if (words) parts.push(`${words} private word${words === 1 ? '' : 's'} kept local`);
    if (blind) parts.push('placeholders in searches');
    if (conceal) parts.push('process hidden from AI');
    if (decoys) parts.push(`${decoys} decoy${decoys === 1 ? '' : 's'}`);
    $('privacy-summary').textContent = on ? `On: ${parts.join(', ')}` : 'Off. Searches run in the open.';
    $('privacy-panel').classList.toggle('active', Boolean(on));
}

function syncLaunchEnabled() {
    const runBtn = $('run-btn');
    const confirmWrap = $('confirm-weaker-wrap');
    const needsConfirm = Boolean(S.lastPreview && S.lastPreview.requires_confirm);
    if (confirmWrap) confirmWrap.hidden = !needsConfirm;
    if (runBtn) {
        runBtn.disabled = Boolean(S.isRunning || (needsConfirm && !checked('confirm-weaker-recall')));
        runBtn.textContent = checked('plan-first') ? 'Draft the plan' : 'Start search';
    }
}

function updateEstimate() {
    clearTimeout(estimateTimer);
    syncPrivacySummary();
    estimateTimer = setTimeout(async () => {
        const params = collectOptionsFromForm();
        try {
            const estimate = await window.ApiClient.fetchEstimate(params);
            S.setPreview(estimate);
            R.renderEstimate(estimate, params);
        } catch (err) {
            const fallback = { expected_cost_display: '$0.00', warnings: [], requires_confirm: Boolean(params.blind_watchlist || params.decoy_queries > 0) };
            S.setPreview(fallback);
            R.renderEstimate(fallback, params);
        }
        syncLaunchEnabled();
    }, 120);
}

function showComposeError(message) {
    const box = $('compose-error');
    if (!box) return;
    box.textContent = message || '';
    box.hidden = !message;
}

/* ------------------------------------------------------------------ plan */

async function draftPlan() {
    const topic = ($('topic').value || '').trim();
    if (!topic) {
        showComposeError('Add a topic or question first.');
        $('topic').focus();
        return;
    }
    showComposeError('');
    const runBtn = $('run-btn');
    runBtn.disabled = true;
    runBtn.textContent = 'Drafting the plan…';
    try {
        const params = { ...collectOptionsFromForm(), watchlist: $('watchlist').value };
        if (S.parentContext) params.context_topic = S.parentContext.topic;
        const data = await window.ApiClient.fetchPlan(params);
        S.plan = (data.plan.sub_questions || []).map(sq => ({ ...sq, enabled: true }));
        R.renderPlan(S.plan, topic);
        const note = (data.notes || []).join(' ');
        $('plan-note').textContent = note || (data.plan.source === 'model'
            ? 'Drafted by the AI planner. Edit the wording, add or remove searches, switch questions off, or add your own.'
            : 'Each question becomes its own line of investigation. Edit the wording, add or remove searches, switch questions off, or add your own.');
        updatePlanEstimate();
        S.setView('plan');
    } catch (err) {
        showComposeError(err.message);
    } finally {
        syncLaunchEnabled();
    }
}

function readPlanFromDom() {
    document.querySelectorAll('#plan-list .plan-item').forEach(li => {
        const idx = parseInt(li.dataset.index, 10);
        const q = S.plan[idx];
        if (!q) return;
        q.question = li.querySelector('[data-field="question"]').value.trim();
        q.enabled = li.querySelector('[data-toggle-question]').checked;
    });
}

function updatePlanEstimate() {
    const on = (S.plan || []).filter(q => q.enabled !== false);
    const searches = on.reduce((a, q) => a + (q.queries || []).length, 0);
    const opts = collectOptionsFromForm();
    $('plan-estimate').innerHTML = `<span>${on.length} question${on.length === 1 ? '' : 's'}</span><span>${searches} opening searches</span><span>up to ${opts.max_documents} sources</span><span>${opts.max_duration_min} min budget</span>`;
    $('plan-start').disabled = !on.length;
}

function onPlanClick(event) {
    const li = event.target.closest('.plan-item');
    if (!li) return;
    const q = S.plan[parseInt(li.dataset.index, 10)];
    const remove = event.target.closest('[data-remove-query]');
    if (remove && q) {
        readPlanFromDom();
        q.queries.splice(parseInt(remove.dataset.removeQuery, 10), 1);
        R.renderPlan(S.plan, $('topic').value.trim());
        updatePlanEstimate();
    }
}

function onPlanKey(event) {
    if (event.key !== 'Enter' || !event.target.matches('[data-add-query]')) return;
    event.preventDefault();
    const li = event.target.closest('.plan-item');
    const q = S.plan[parseInt(li.dataset.index, 10)];
    const value = event.target.value.trim();
    if (!q || !value) return;
    readPlanFromDom();
    q.queries.push(value);
    R.renderPlan(S.plan, $('topic').value.trim());
    updatePlanEstimate();
    document.querySelector(`.plan-item[data-index="${li.dataset.index}"] [data-add-query]`)?.focus();
}

/* ------------------------------------------------------------------ run */

function buildPayload(extra = {}) {
    const payload = { ...collectOptionsFromForm(), watchlist: $('watchlist').value, ...extra };
    if (S.parentContext) {
        payload.context_topic = S.parentContext.topic;
        payload.exclude_urls = S.parentContext.urls;
    }
    return payload;
}

async function executeResearch() {
    const topic = ($('topic').value || '').trim();
    if (!topic) {
        showComposeError('Add a topic or question first.');
        $('topic').focus();
        return;
    }
    if (S.lastPreview && S.lastPreview.requires_confirm && !checked('confirm-weaker-recall')) {
        $('privacy-panel').open = true;
        showComposeError('The privacy options you chose weaken results. Confirm that trade-off in the privacy layer first.');
        $('confirm-weaker-recall')?.focus();
        return;
    }
    if (checked('plan-first')) {
        await draftPlan();
        return;
    }
    await startRun(buildPayload());
}

async function startRun(payload) {
    showComposeError('');
    S.run = S.freshRun();
    S.run.topic = payload.topic;
    S.run.startedAt = Date.now();
    S.run.timeBudget = (payload.max_duration_min || 15) * 60;
    S.run.maxDocs = payload.max_documents;
    S.run.maxRounds = payload.max_gap_rounds;
    R.resetRun(payload.topic, payload);
    S.setRunning(true);
    S.setView('run');
    R.renderStatus('running', 'Starting…');
    startClock();
    try {
        const data = await window.ApiClient.executeResearch(payload, onRunEvent);
        finishRun(data);
    } catch (err) {
        failRun(err);
    }
}

async function attachRun(runId, topic) {
    S.run = S.freshRun();
    S.run.topic = topic || 'Research in progress';
    S.run.startedAt = Date.now();
    S.runId = runId;
    R.resetRun(S.run.topic, {});
    S.setRunning(true);
    S.setView('run');
    R.renderStatus('running', 'Reconnecting…');
    $('reattach-banner').hidden = true;
    startClock();
    try {
        const data = await window.ApiClient.attachRun(runId, onRunEvent);
        finishRun(data);
    } catch (err) {
        failRun(err);
    }
}

function finishRun(data) {
    stopClock();
    S.setRunning(false);
    R.renderStage('done');
    R.renderStatus('', '');
    S.parentContext = null;
    data.when = new Date().toLocaleString();
    S.setResult(data);
    currentReportFile = (data.report_archive || '').replace(/\\/g, '/').split('/').pop();
    showResults(data);
    loadReports();
    loadRuns();
}

function failRun(err) {
    stopClock();
    S.setRunning(false);
    R.renderStatus('error', err.message);
    const cancelBtn = $('cancel-btn');
    if (cancelBtn) cancelBtn.hidden = true;
    R.pushLog(`Run failed: ${err.message}`, elapsedSec(), 'warn');
    R.toast('The run stopped with an error. Details are in the activity log.');
}

function elapsedSec() {
    return S.run.startedAt ? (Date.now() - S.run.startedAt) / 1000 : 0;
}

function startClock() {
    stopClock();
    clockTimer = setInterval(() => R.renderClock(elapsedSec(), S.run.timeBudget), 1000);
    R.renderClock(0, S.run.timeBudget);
}

function stopClock() {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = null;
}

function onRunEvent(event) {
    const run = S.run;
    switch (event.type) {
        case 'run':
            S.runId = event.run_id;
            if (event.topic) {
                run.topic = event.topic;
                $('run-title').textContent = event.topic;
            }
            if (event.options) {
                run.timeBudget = (event.options.max_duration_min || 15) * 60;
                run.maxDocs = event.options.max_documents;
                R.sounding.reset(event.options.max_depth || 2, run.timeBudget);
            }
            break;
        case 'progress':
            R.renderStatus('running', event.message);
            R.pushLog(event.message, elapsedSec(), /failed|unavailable|blocked|cap reached|no openai/i.test(event.message) ? 'warn' : '');
            break;
        case 'stage':
            run.stage = event.stage;
            R.renderStage(event.stage);
            break;
        case 'stats':
            if (typeof event.elapsed_sec === 'number' && event.elapsed_sec > elapsedSec() + 2) {
                run.startedAt = Date.now() - event.elapsed_sec * 1000; // re-attached mid-run
            }
            run.stats = event;
            R.renderStats(event, run);
            if (run.plan) R.renderQuestions(run.plan, coverage());
            break;
        case 'plan':
            run.plan = event.plan;
            if (event.plan && event.plan.sub_questions && event.plan.sub_questions.length > 1) {
                R.renderQuestions(event.plan, {});
            }
            break;
        case 'round':
            run.round = event.round;
            run.maxRounds = event.max_rounds;
            R.renderRound(event.round, event.max_rounds);
            R.pushLog(`Round ${event.round}: ${(event.queries || []).length} new searches`, elapsedSec(), 'round');
            break;
        case 'source':
            run.sources.push(event);
            if (event.subq !== undefined) run.coverage = coverage();
            R.pushSource(event, run.sources.length);
            break;
        case 'learning':
            run.learnings.push(event);
            R.pushLearning(event, run.learnings.length);
            break;
        default:
            break;
    }
}

function coverage() {
    // Sources do not carry sub-question ids live; approximate by lane affinity.
    const plan = S.run.plan;
    if (!plan || !plan.sub_questions) return {};
    const counts = {};
    const laneCounts = {};
    S.run.sources.forEach(s => { laneCounts[s.lane] = (laneCounts[s.lane] || 0) + 1; });
    plan.sub_questions.forEach(sq => {
        const lanes = sq.lanes && sq.lanes.length ? sq.lanes : Object.keys(laneCounts);
        counts[sq.id] = Math.round(lanes.reduce((a, l) => a + (laneCounts[l] || 0), 0) / Math.max(1, plan.sub_questions.length / 2));
    });
    return counts;
}

async function cancelResearch() {
    R.renderStatus('running', 'Stopping. Writing a report from everything gathered so far…');
    try {
        await window.ApiClient.cancelResearch(S.runId);
    } catch (err) {
        R.toast(`Could not send the stop signal: ${err.message}`);
    }
}

/* ------------------------------------------------------------------ results */

function showResults(data) {
    R.renderResults(data);
    sourceFilter = { lane: '', text: '', sort: 'rank' };
    if ($('source-filter')) $('source-filter').value = '';
    if ($('source-sort')) $('source-sort').value = 'rank';
    selectTab('report');
    S.setView('results');
    R.renderReportsList(S.reports, $('history-filter')?.value || '', currentReportFile);
}

function selectTab(name) {
    document.querySelectorAll('.tab').forEach(tab => {
        const on = tab.dataset.tab === name;
        tab.classList.toggle('active', on);
        tab.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('.tabpanel').forEach(panel => { panel.hidden = panel.dataset.panel !== name; });
}

function selectLiveTab(name) {
    document.querySelectorAll('[data-live-tab]').forEach(tab => {
        const on = tab.dataset.liveTab === name;
        tab.classList.toggle('active', on);
        tab.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('[data-live-panel]').forEach(panel => { panel.hidden = panel.dataset.livePanel !== name; });
}

function jumpToSource(n) {
    selectTab('sources');
    sourceFilter = { lane: '', text: '', sort: 'rank' };
    R.renderSources(S.lastResult?.evidence || [], sourceFilter);
    const card = $(`src-${n}`);
    if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('flash');
        setTimeout(() => card.classList.remove('flash'), 1800);
    }
}

function digDeeper(topic) {
    const parent = S.lastResult;
    if (!topic || !parent) return;
    S.parentContext = {
        topic: parent.topic,
        urls: (parent.evidence || []).map(e => e.url).filter(Boolean)
    };
    $('topic').value = topic;
    updateTopicCount();
    showComposeError('');
    S.setView('compose');
    R.toast(`Follow-up dig: skips the ${S.parentContext.urls.length} sources already read.`, 3600);
    updateEstimate();
    $('topic').focus();
}

async function copyReport() {
    const data = S.lastResult || {};
    let text = data.report_markdown || '';
    if (!text && data.report_archive) {
        try {
            text = await window.ApiClient.fetchReportMarkdown(data.report_archive.replace(/\\/g, '/').split('/').pop());
        } catch (err) { text = data.summary || ''; }
    }
    try {
        await navigator.clipboard.writeText(text || data.summary || '');
        R.toast('Report copied');
    } catch (err) {
        R.toast('Copy failed. Use Download instead.');
    }
}

async function openReport(file, hasResult) {
    currentReportFile = file;
    closeRail();
    try {
        let data;
        if (hasResult) {
            data = await window.ApiClient.fetchReportResult(file);
            data.report_archive = data.report_archive || file;
        } else {
            const md = await window.ApiClient.fetchReportMarkdown(file);
            const title = (md.match(/^# Research Report:\s*(.+)$/m) || [])[1] || file;
            const body = md.replace(/^# Research Report:.*$/m, '').replace(/^>.*$/m, '');
            data = { topic: title, summary: body, evidence: [], report_archive: file, status: 'success', report_markdown: md };
        }
        const report = S.reports.find(r => r.filename === file);
        data.when = report ? report.modified : '';
        S.setResult(data);
        showResults(data);
    } catch (err) {
        R.toast(err.message);
    }
}

/* ------------------------------------------------------------------ loaders */

async function loadSettings() {
    try {
        S.updateSettings(await window.ApiClient.fetchSettings());
    } catch (err) {
        console.warn('Could not load settings', err);
    }
}

async function loadModels() {
    try {
        const data = await window.ApiClient.fetchModels();
        R.renderModelOptions(data.models || []);
    } catch (err) {
        console.warn('Could not load models', err);
    }
}

async function loadPresets() {
    try {
        const data = await window.ApiClient.fetchPresets();
        S.presets = data.presets || {};
        S.allLanes = data.all_lanes || R.LANE_ORDER;
        S.lanes = [...(data.default_lanes || [])];
        S.preset = data.default || 'standard';
    } catch (err) {
        S.presets = {};
        S.allLanes = R.LANE_ORDER;
        S.lanes = ['academic', 'gov', 'reference', 'community', 'video', 'expert', 'news', 'web'];
    }
    R.renderPresets(S.presets, S.preset);
    R.renderLaneChips(S.allLanes, S.lanes);
    applyPreset(S.preset, { silent: true });
}

async function loadReports() {
    try {
        const data = await window.ApiClient.fetchReports();
        S.setReports(data.reports || []);
    } catch (err) {
        console.warn('Could not load reports', err);
    }
}

async function loadRuns() {
    try {
        const data = await window.ApiClient.fetchRuns();
        const active = R.renderActiveRuns(data.runs || [], S.runId);
        const banner = $('reattach-banner');
        const other = active.filter(r => r.run_id !== S.runId || !S.isRunning);
        if (banner && other.length && !S.isRunning) {
            banner.hidden = false;
            $('reattach-text').textContent = `Still running: ${other[0].topic}`;
            $('reattach-btn').onclick = () => attachRun(other[0].run_id, other[0].topic);
        } else if (banner) {
            banner.hidden = true;
        }
    } catch (err) {
        console.warn('Could not load runs', err);
    }
}

async function saveSettings() {
    const payload = {
        searxng_url: $('searxng-url').value.trim(),
        local_llm_url: $('local-llm-url').value.trim()
    };
    [['openai-key', 'openai_key'], ['brave-key', 'brave_key'], ['s2-key', 's2_key']].forEach(([id, key]) => {
        const v = $(id).value.trim();
        if (v && !v.startsWith('***')) payload[key] = v;
    });
    const msg = $('settings-status-msg');
    try {
        await window.ApiClient.saveSettings(payload);
        ['openai-key', 'brave-key', 's2-key'].forEach(id => { $(id).value = ''; });
        msg.textContent = 'Saved';
        setTimeout(() => { msg.textContent = ''; }, 2500);
        await loadSettings();
        updateEstimate();
    } catch (err) {
        msg.textContent = `Could not save: ${err.message}`;
    }
}

/* ------------------------------------------------------------------ misc UI */

function updateTopicCount() {
    const n = ($('topic').value || '').trim().length;
    $('topic-count').textContent = n ? `${n} characters` : '';
}

function openRail() {
    $('rail').classList.add('open');
    $('rail-toggle').setAttribute('aria-expanded', 'true');
}

function closeRail() {
    $('rail').classList.remove('open');
    $('rail-toggle').setAttribute('aria-expanded', 'false');
}

function openSettings() {
    const dlg = $('settings-dialog');
    const s = S.settings;
    $('openai-key').placeholder = s.hasOpenAI ? `Saved (${s.openaiPreview})` : 'sk-…';
    $('brave-key').placeholder = s.hasBrave ? `Saved (${s.bravePreview})` : 'BSA…';
    $('s2-key').placeholder = s.hasS2 ? 'Saved' : 'optional';
    $('searxng-url').value = s.searxngUrl;
    $('local-llm-url').value = s.localLlmUrl;
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
}

/* ------------------------------------------------------------------ wiring */

S.subscribe((event, value) => {
    if (event === 'view') {
        R.showView(value);
        if (value === 'run') setTimeout(() => R.sounding.relayout(), 50);
    } else if (event === 'settings') {
        R.renderSettingsBadge(value);
    } else if (event === 'reports') {
        R.renderReportsList(value, $('history-filter')?.value || '', currentReportFile);
    } else if (event === 'preview' || event === 'running') {
        syncLaunchEnabled();
    }
});

function wire() {
    $('run-btn').addEventListener('click', executeResearch);
    $('cancel-btn').addEventListener('click', cancelResearch);
    $('nav-new').addEventListener('click', () => {
        if (S.isRunning) {
            R.toast('A search is running. It keeps going in the background — find it under History.');
        }
        S.parentContext = null;
        closeRail();
        S.setView('compose');
        $('topic').focus();
    });
    $('open-settings').addEventListener('click', openSettings);
    $('save-settings').addEventListener('click', saveSettings);
    $('rail-toggle').addEventListener('click', () => ($('rail').classList.contains('open') ? closeRail() : openRail()));
    $('refresh-history').addEventListener('click', () => { loadReports(); loadRuns(); });
    $('history-filter').addEventListener('input', (e) => R.renderReportsList(S.reports, e.target.value, currentReportFile));

    document.addEventListener('click', (e) => {
        if (e.target.closest('[data-open-settings]')) openSettings();
        const preset = e.target.closest('.preset');
        if (preset) applyPreset(preset.dataset.preset);
        const lane = e.target.closest('.lane-chip');
        if (lane) {
            const name = lane.dataset.lane;
            S.lanes = S.lanes.includes(name) ? S.lanes.filter(l => l !== name) : [...S.lanes, name];
            if (!S.lanes.length) S.lanes = [name];
            R.renderLaneChips(S.allLanes, S.lanes);
            updateEstimate();
        }
        const example = e.target.closest('.example');
        if (example) {
            $('topic').value = example.textContent;
            updateTopicCount();
            updateEstimate();
            $('topic').focus();
        }
        const report = e.target.closest('[data-report]');
        if (report) openReport(report.dataset.report, Boolean(report.dataset.hasResult));
        const attach = e.target.closest('[data-attach]');
        if (attach) attachRun(attach.dataset.attach, attach.querySelector('.rail-item-title')?.textContent);
        const tab = e.target.closest('.tab');
        if (tab) selectTab(tab.dataset.tab);
        const liveTab = e.target.closest('[data-live-tab]');
        if (liveTab) selectLiveTab(liveTab.dataset.liveTab);
        const cite = e.target.closest('.cite');
        if (cite) jumpToSource(parseInt(cite.dataset.cite, 10));
        if (!e.target.closest('.cite')) document.querySelectorAll('.cite-pop').forEach(n => n.remove());
        const laneFilter = e.target.closest('[data-lane-filter]');
        if (laneFilter) {
            sourceFilter.lane = laneFilter.dataset.laneFilter;
            document.querySelectorAll('[data-lane-filter]').forEach(c => c.setAttribute('aria-pressed', String(c === laneFilter)));
            R.renderSources(S.lastResult?.evidence || [], { ...sourceFilter, keepChips: true });
        }
        const dig = e.target.closest('[data-dig]');
        if (dig) digDeeper((S.lastResult?.followups || [])[parseInt(dig.dataset.dig, 10)]);
        if (!e.target.closest('#rail') && !e.target.closest('#rail-toggle')) closeRail();
    });

    document.addEventListener('mouseover', (e) => {
        const cite = e.target.closest('.cite');
        if (cite) R.citePopover(cite);
    });
    document.addEventListener('focusin', (e) => {
        if (e.target.classList && e.target.classList.contains('cite')) R.citePopover(e.target);
    });

    $('source-filter').addEventListener('input', (e) => {
        sourceFilter.text = e.target.value;
        R.renderSources(S.lastResult?.evidence || [], { ...sourceFilter, keepChips: true });
    });
    $('source-sort').addEventListener('change', (e) => {
        sourceFilter.sort = e.target.value;
        R.renderSources(S.lastResult?.evidence || [], { ...sourceFilter, keepChips: true });
    });

    $('academic-weight').addEventListener('input', (e) => {
        R.renderMixValue(parseInt(e.target.value, 10));
        updateEstimate();
    });

    $('topic').addEventListener('input', () => { updateTopicCount(); updateEstimate(); showComposeError(''); });
    $('topic').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            executeResearch();
        }
    });

    const watched = ['max-duration-min', 'max-docs', 'max-depth', 'max-gap-rounds', 'breadth', 'queries-per-round',
        'concurrency', 'max-spend', 'follow-leads', 'citation-expansion', 'claim-verification', 'rerank-results',
        'query-rewrite', 'hyde-queries', 'concealer-model', 'deep-model', 'reasoning-effort', 'ai-planning',
        'ai-summary', 'plan-first', 'watchlist', 'blind-watchlist', 'conceal-process', 'decoy-queries', 'confirm-weaker-recall'];
    watched.forEach(id => {
        const node = $(id);
        if (!node) return;
        node.addEventListener('input', updateEstimate);
        node.addEventListener('change', updateEstimate);
    });

    // Plan review
    $('plan-back').addEventListener('click', () => S.setView('compose'));
    $('plan-list').addEventListener('click', onPlanClick);
    $('plan-list').addEventListener('keydown', onPlanKey);
    $('plan-list').addEventListener('change', () => { readPlanFromDom(); R.renderPlan(S.plan, $('topic').value.trim()); updatePlanEstimate(); });
    $('plan-add').addEventListener('click', () => {
        readPlanFromDom();
        S.plan.push({ id: `u${S.plan.length + 1}`, question: '', queries: [], lanes: [], perspective: 'Your question', enabled: true });
        R.renderPlan(S.plan, $('topic').value.trim());
        updatePlanEstimate();
        document.querySelector('#plan-list .plan-item:last-child [data-field="question"]')?.focus();
    });
    $('plan-regenerate').addEventListener('click', draftPlan);
    $('plan-start').addEventListener('click', () => {
        readPlanFromDom();
        const plan = S.plan.filter(q => q.enabled !== false && (q.question || (q.queries || []).length))
            .map(q => ({ ...q, queries: (q.queries || []).length ? q.queries : [q.question] }));
        if (!plan.length) {
            R.toast('Switch on at least one question.');
            return;
        }
        startRun(buildPayload({ plan, breadth: plan.length }));
    });

    // Results actions
    $('copy-report').addEventListener('click', copyReport);
    $('dig-deeper-btn').addEventListener('click', () => {
        selectTab('next');
        $('custom-dig').focus();
    });
    $('custom-dig-btn').addEventListener('click', () => digDeeper($('custom-dig').value.trim()));
    $('custom-dig').addEventListener('keydown', (e) => { if (e.key === 'Enter') digDeeper(e.target.value.trim()); });

    window.addEventListener('resize', () => {
        clearTimeout(window.__relayout);
        window.__relayout = setTimeout(() => R.sounding.relayout(), 150);
    });
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeRail();
            document.querySelectorAll('.cite-pop').forEach(n => n.remove());
        }
    });
}

window.addEventListener('DOMContentLoaded', async () => {
    wire();
    R.renderMixValue(50);
    await Promise.all([loadSettings(), loadModels(), loadPresets(), loadReports()]);
    updateTopicCount();
    updateEstimate();
    loadRuns();
    setInterval(() => { if (!S.isRunning) loadRuns(); }, 20000);
});
