/**
 * Deep Search Frontend API Client
 * Encapsulates all REST communication with the local air-gapped backend server.
 */

const ApiClient = {
    /**
     * Fetch default topic and watchlist loaded from topic.txt / watchlist.txt.
     */
    async fetchDefaults() {
        const response = await fetch('/api/defaults');
        if (!response.ok) {
            throw new Error(`Failed to load defaults: HTTP ${response.status}`);
        }
        return await response.json();
    },

    /**
     * Fetch configured provider status (Brave, OpenAI, SearXNG, Local SLM).
     */
    async fetchSettings() {
        const response = await fetch('/api/settings');
        if (!response.ok) {
            throw new Error(`Failed to load settings: HTTP ${response.status}`);
        }
        return await response.json();
    },

    /**
     * Fetch model choices and pricing.
     */
    async fetchModels() {
        const response = await fetch('/api/models');
        if (!response.ok) {
            throw new Error(`Failed to load models: HTTP ${response.status}`);
        }
        return await response.json();
    },

    /**
     * Fetch past archived reports list.
     */
    async fetchReports() {
        const response = await fetch('/api/reports');
        if (!response.ok) {
            throw new Error(`Failed to load reports: HTTP ${response.status}`);
        }
        return await response.json();
    },

    /**
     * Compute pre-run workload, token counts, and cost estimate.
     */
    async fetchEstimate(params) {
        const response = await fetch('/api/estimate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        if (!response.ok) {
            throw new Error(`Failed to calculate estimate: HTTP ${response.status}`);
        }
        return await response.json();
    },

    /**
     * Persist provider API keys and endpoint updates to .env and active runtime.
     */
    async saveSettings(payload) {
        const response = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${response.status}`);
        }
        return await response.json();
    },

    /**
     * Send cancellation signal to active research run.
     */
    async cancelResearch() {
        const response = await fetch('/api/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        return await response.json();
    },

    /**
     * Submit research request with deep exploration and spend parameters.
     * Streams server-sent progress events and invokes onProgress(message)
     * live while the search runs; resolves with the final result payload.
     */
    async executeResearch(params, onProgress) {
        const response = await fetch('/api/research', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });

        if (!response.ok) {
            let message = `HTTP ${response.status}`;
            try {
                const err = await response.json();
                if (err && err.error) message = err.error;
            } catch (err) { /* non-JSON error body */ }
            throw new Error(message);
        }

        if (!response.body || !window.ReadableStream) {
            // Older browsers: no streaming. Wait for the full payload.
            const data = await response.json();
            if (data.error) throw new Error(data.error);
            return data;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let result = null;

        const handleEvent = (raw) => {
            const line = raw.split('\n').find(l => l.startsWith('data:'));
            if (!line) return;
            let event;
            try {
                event = JSON.parse(line.slice(5).trim());
            } catch (err) {
                return; // ignore malformed partial
            }
            if (event.type === 'progress' && typeof onProgress === 'function') {
                onProgress(event.message);
            } else if (event.type === 'result') {
                result = event;
            } else if (event.type === 'error') {
                throw new Error(event.error || 'Research failed');
            }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                const rawEvent = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                handleEvent(rawEvent);
            }
        }

        if (!result) throw new Error('Research ended without a result.');
        const { type, ...data } = result;
        return data;
    }
};

window.ApiClient = ApiClient;
