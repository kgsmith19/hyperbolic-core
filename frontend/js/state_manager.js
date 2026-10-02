/**
 * Deep Search UI state: one store, explicit events.
 */

class StateManager {
    constructor() {
        this.view = 'compose';           // compose | plan | run | results
        this.preset = 'standard';
        this.presets = {};
        this.allLanes = [];
        this.lanes = [];
        this.isRunning = false;
        this.runId = null;
        this.run = this.freshRun();
        this.plan = null;                // editable plan (list of questions)
        this.lastPreview = null;
        this.lastResult = null;
        this.parentContext = null;       // dig-deeper context
        this.reports = [];
        this.settings = {
            hasBrave: false, bravePreview: '', hasOpenAI: false, openaiPreview: '', hasS2: false,
            searxngUrl: 'http://127.0.0.1:8080', searxngActive: false,
            localLlmUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'gpt-4o-mini'
        };
        this.listeners = [];
    }

    freshRun() {
        return {
            topic: '', startedAt: 0, stage: 'plan', stats: {}, sources: [], learnings: [],
            log: [], plan: null, round: 0, maxRounds: 0, timeBudget: 0, maxDocs: 0
        };
    }

    setView(view) {
        this.view = view;
        this.notify('view', view);
    }

    setRunning(running) {
        this.isRunning = running;
        this.notify('running', running);
    }

    updateSettings(data) {
        this.settings = {
            hasBrave: Boolean(data.has_brave),
            bravePreview: data.brave_preview || '',
            hasOpenAI: Boolean(data.has_openai),
            openaiPreview: data.openai_preview || '',
            hasS2: Boolean(data.has_s2),
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
