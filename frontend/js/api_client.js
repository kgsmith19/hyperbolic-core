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
     */
    async executeResearch(params) {
        const response = await fetch('/api/research', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        const data = await response.json();
        if (!response.ok || data.error) {
            throw new Error(data.error || `HTTP ${response.status}`);
        }
        return data;
    }
};

window.ApiClient = ApiClient;
