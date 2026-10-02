/**
 * Deep Search API client.
 * JSON helpers plus a shared server-sent-events reader used both for starting
 * a run (POST /api/research) and re-attaching to one (GET /api/runs/stream).
 */

async function jsonRequest(url, options = {}) {
    const response = await fetch(url, options);
    let data = null;
    try {
        data = await response.json();
    } catch (err) {
        data = null;
    }
    if (!response.ok) {
        const message = (data && data.error) || `Request failed (HTTP ${response.status})`;
        throw new Error(message);
    }
    return data;
}

function postJson(url, body) {
    return jsonRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
    });
}

/**
 * Read an SSE response body. Calls onEvent(event) for every data event and
 * resolves with the final result payload (or rejects on an error event).
 * Pre-streaming browsers fall back to a single JSON body.
 */
async function readEventStream(response, onEvent) {
    if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
            const err = await response.json();
            if (err && err.error) message = err.error;
        } catch (err) { /* non-JSON error body */ }
        throw new Error(message);
    }
    if (!response.body || !window.ReadableStream) {
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        return data;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = null;
    let failure = null;

    const handle = (raw) => {
        const dataLines = raw.split('\n').filter(l => l.startsWith('data:'));
        if (!dataLines.length) return;
        let event;
        try {
            event = JSON.parse(dataLines.map(l => l.slice(5).trim()).join(''));
        } catch (err) {
            return;
        }
        if (event.type === 'result') {
            result = event;
        } else if (event.type === 'error') {
            failure = new Error(event.error || 'Research failed');
        }
        try {
            onEvent && onEvent(event);
        } catch (err) {
            console.error('Event handler failed', err);
        }
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            handle(raw);
        }
    }
    if (buffer.trim()) handle(buffer);
    if (failure) throw failure;
    if (!result) throw new Error('The connection closed before the run finished. It may still be running — check History.');
    const { type, ...data } = result;
    return data;
}

const ApiClient = {
    fetchDefaults: () => jsonRequest('/api/defaults'),
    fetchSettings: () => jsonRequest('/api/settings'),
    fetchModels: () => jsonRequest('/api/models'),
    fetchPresets: () => jsonRequest('/api/presets'),
    fetchReports: () => jsonRequest('/api/reports'),
    fetchRuns: () => jsonRequest('/api/runs'),
    fetchReportResult: (file) => jsonRequest(`/api/reports/result?file=${encodeURIComponent(file)}`),

    async fetchReportMarkdown(file) {
        const response = await fetch(`/api/reports/view?file=${encodeURIComponent(file)}`);
        if (!response.ok) throw new Error(`Could not open report (HTTP ${response.status})`);
        return response.text();
    },

    fetchEstimate: (params) => postJson('/api/estimate', params),
    fetchPlan: (params) => postJson('/api/plan', params),
    saveSettings: (payload) => postJson('/api/settings', payload),
    cancelResearch: (runId) => postJson('/api/cancel', runId ? { run_id: runId } : {}),

    /** Start a run; streams events to onEvent and resolves with the result. */
    async executeResearch(params, onEvent) {
        const response = await fetch('/api/research', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        return readEventStream(response, onEvent);
    },

    /** Re-attach to a run that is already in progress (replays all events). */
    async attachRun(runId, onEvent, from = 0) {
        const response = await fetch(`/api/runs/stream?run_id=${encodeURIComponent(runId)}&from=${from}`);
        return readEventStream(response, onEvent);
    }
};

window.ApiClient = ApiClient;
