/**
 * Deep Search UI State Manager
 * Tracks execution status, options, settings, and reports.
 */

class StateManager {
    constructor() {
        this.options = {
            blindWatchlist: false,
            decoyQueries: 0,
            aiPlanning: false,
            aiSummary: false
        };
        this.isRunning = false;
        this.isSettingsOpen = false;
        this.isParamsOpen = false;
        this.isReportsOpen = false;
        this.lastResult = null;
        this.lastPreview = null;
        this.reports = [];
        this.settings = {
            hasBrave: false,
            bravePreview: '',
            hasOpenAI: false,
            openaiPreview: '',
            searxngUrl: 'http://127.0.0.1:8080',
            searxngActive: false,
            localLlmUrl: 'http://127.0.0.1:11434/v1',
            defaultModel: 'gpt-4o-mini'
        };
        this.listeners = [];
    }

    setOptions(partial) {
        this.options = { ...this.options, ...partial };
        this.notify('options', this.options);
    }

    setRunning(running) {
        this.isRunning = running;
        this.notify('running', running);
    }

    toggleSettings() {
        this.isSettingsOpen = !this.isSettingsOpen;
        this.notify('settingsOpen', this.isSettingsOpen);
    }

    toggleParams() {
        this.isParamsOpen = !this.isParamsOpen;
        this.notify('paramsOpen', this.isParamsOpen);
    }

    toggleReports() {
        this.isReportsOpen = !this.isReportsOpen;
        this.notify('reportsOpen', this.isReportsOpen);
    }

    updateSettings(data) {
        this.settings = {
            hasBrave: Boolean(data.has_brave),
            bravePreview: data.brave_preview || '',
            hasOpenAI: Boolean(data.has_openai),
            openaiPreview: data.openai_preview || '',
            searxngUrl: data.searxng_url || 'http://127.0.0.1:8080',
            searxngActive: Boolean(data.searxng_active),
            localLlmUrl: data.local_llm_url || 'http://127.0.0.1:11434/v1',
            defaultModel: data.default_model || 'gpt-4o-mini'
        };
        this.notify('settings', this.settings);
    }

    setReports(reports) {
        this.reports = reports || [];
        this.notify('reports', this.reports);
    }

    setResult(result) {
        this.lastResult = result;
        this.notify('result', result);
    }

    setPreview(preview) {
        this.lastPreview = preview;
        this.notify('preview', preview);
    }

    subscribe(callback) {
        this.listeners.push(callback);
    }

    notify(event, value) {
        for (const listener of this.listeners) {
            try {
                listener(event, value);
            } catch (err) {
                console.error('State listener error:', err);
            }
        }
    }
}

window.appState = new StateManager();
