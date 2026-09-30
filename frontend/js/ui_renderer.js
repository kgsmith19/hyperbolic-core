/**
 * Deep Search UI Renderer
 * Renders status/progress, pre-run estimates, evidence cards, metrics, and report archives.
 * All classes referenced here are defined in frontend/css.
 */

const STAGE_ORDER = ['prepare', 'discover', 'read', 'evaluate', 'report'];
const STAGE_WIDTH = { prepare: 12, discover: 34, read: 62, evaluate: 82, report: 94 };

const UiRenderer = {
    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.innerText = String(text);
        return div.innerHTML;
    },

    _stageFromMessage(message) {
        const lower = String(message).toLowerCase();
        if (/(report|summary|writing|rank|rerank|coverage|claim|independence)/.test(lower)) return 'report';
        if (lower.includes('report')) return 'report';
        if (/(rank|rerank|coverage|claim|independence|summar)/.test(lower)) return 'evaluate';
        if (/(reading|read\b|retriev|kept)/.test(lower)) return 'read';
        if (/(search|frontier|citation|angle|queries)/.test(lower)) return 'discover';
        return 'prepare';
    },

    renderStatus(type, message) {
        const statusBox = document.getElementById('status-box');
        const cancelBtn = document.getElementById('cancel-btn');
        const progress = document.getElementById('live-progress');
        const detail = document.getElementById('progress-detail');
        const fill = document.getElementById('progress-bar-fill');

        if (!statusBox) return;

        if (cancelBtn) cancelBtn.hidden = type !== 'running';

        if (!type) {
            if (progress) progress.hidden = true;
            statusBox.className = '';
            statusBox.style.display = 'none';
            statusBox.innerText = '';
            return;
        }

        if (progress) {
            progress.hidden = type !== 'running';
            if (type === 'running') {
                const stage = this._stageFromMessage(message);
                const idx = STAGE_ORDER.indexOf(stage);
                progress.querySelectorAll('.progress-stage').forEach(item => {
                    const stageIdx = STAGE_ORDER.indexOf(item.dataset.stage);
                    item.classList.toggle('active', stageIdx === idx);
                    item.classList.toggle('done', stageIdx < idx);
                });
                if (fill) {
                    fill.classList.remove('indeterminate');
                    fill.style.width = `${STAGE_WIDTH[stage]}%`;
                }
            }
            if (detail) detail.innerText = message;
        }

        statusBox.className = type;
        statusBox.style.display = type === 'error' || type === 'cancelled' ? 'block' : 'none';
        statusBox.innerText = message;
    },

    /** Track live source counts out of streamed progress messages. */
    renderSourceCount(message) {
        const el = document.getElementById('progress-sources');
        if (!el) return;
        const kept = String(message).match(/(\d+)\s*\/\s*(\d+)\s+kept/i);
        if (kept) {
            el.innerText = `${kept[1]} of ${kept[2]} sources`;
            el.hidden = false;
            return;
        }
        const loose = String(message).match(/\b(\d+)\s+(?:sources?|documents?|docs?|pages?)\b/i);
        if (loose) {
            el.innerText = `${loose[1]} sources`;
            el.hidden = false;
        }
    },

    renderSettingsBadge(settings) {
        const badge = document.getElementById('settings-badge');
        if (!badge) return;

        if (settings.hasBrave && settings.hasOpenAI) {
            badge.innerText = 'OpenAI and Brave saved';
        } else if (settings.hasBrave) {
            badge.innerText = 'Brave saved';
        } else if (settings.hasOpenAI) {
            badge.innerText = 'OpenAI saved';
        } else {
            badge.innerText = 'Not required';
        }
    },

    renderPreRunEstimate(data) {
        const strip = document.getElementById('pre-run-estimate-card');
        const badge = document.getElementById('estimate-mode-badge');
        const hops = document.getElementById('est-hops');
        const hopsSub = document.getElementById('est-hops-sub');
        const sources = document.getElementById('est-sources');
        const sourcesSub = document.getElementById('est-sources-sub');
        const duration = document.getElementById('est-duration');
        const durationSub = document.getElementById('est-duration-sub');
        const spend = document.getElementById('est-spend');
        const spendSub = document.getElementById('est-spend-sub');
        const breakdown = document.getElementById('estimate-steps-breakdown');

        if (!spend || !strip) return;

        const costDisplay = data.expected_cost_display || '$0.00';
        strip.classList.toggle('needs-ok', Boolean(data.requires_confirm));
        spend.classList.toggle('needs-ok', Boolean(data.requires_confirm));
        spend.innerText = costDisplay;
        if (badge) {
            badge.className = data.requires_confirm ? 'badge badge-cost' : 'badge badge-safe';
            badge.innerText = data.requires_confirm ? 'Needs your OK' : 'Ready';
        }
        if (hops) hops.innerText = String(data.expected_hops ?? 4);
        if (hopsSub) hopsSub.innerText = `stops at hop ${data.expected_hops ?? 4}`;
        if (sources) sources.innerText = String(data.expected_sources ?? 40);
        if (sourcesSub) sourcesSub.innerText = 'corpus cap';
        if (duration) {
            const secs = data.expected_duration_sec ?? 900;
            duration.innerText = secs >= 120 ? `${(secs / 60).toFixed(secs % 60 ? 1 : 0)}m` : `${Math.round(secs)}s`;
        }
        if (durationSub) durationSub.innerText = 'unfinished hops drop';
        if (spendSub) spendSub.innerText = data.requires_confirm ? 'privacy tradeoff on' : 'declared spend';

        if (breakdown) {
            const warnings = data.warnings || [];
            breakdown.innerHTML = warnings.map(w =>
                `<p class="estimate-warning">${this.escapeHtml(w)}</p>`
            ).join('');
        }
    },

    renderMetricsBar(data) {
        const bar = document.getElementById('metrics-bar');
        if (!bar) return;

        const duration = data.duration_seconds ? `${data.duration_seconds}s` : '0s';
        const docCount = data.evidence ? data.evidence.length : 0;
        const spend = data.spend_report || {};
        const costStr = spend.estimated_cost_usd ? `$${spend.estimated_cost_usd.toFixed(4)}` : '$0.0000';
        const totalTokens = spend.total_tokens ? spend.total_tokens.toLocaleString() : '0';
        const model = spend.model || 'local-cpu';

        const chips = [
            ['Duration', duration],
            ['Sources', String(docCount)],
            ['Spend', costStr],
            ['Tokens', totalTokens],
            ['Model', model]
        ];
        bar.innerHTML = chips.map(([label, value]) =>
            `<span class="metric-chip"><span class="metric-label">${this.escapeHtml(label)}</span><span class="metric-value">${this.escapeHtml(value)}</span></span>`
        ).join('');
    },

    renderReportsList(reports) {
        const list = document.getElementById('reports-list');
        const badge = document.getElementById('reports-count-badge');

        if (badge) {
            badge.innerText = `${reports.length} report${reports.length === 1 ? '' : 's'}`;
        }

        if (!list) return;

        if (!reports || reports.length === 0) {
            list.innerHTML = '<p class="empty-note">No archived reports found yet.</p>';
            return;
        }

        list.innerHTML = '';
        reports.forEach(r => {
            const item = document.createElement('div');
            item.className = 'report-item';
            item.innerHTML = `
                <div>
                    <a href="/api/reports/view?file=${encodeURIComponent(r.filename)}" target="_blank">${this.escapeHtml(r.filename)}</a>
                    <div style="font-size:11px; color:var(--ink-faint); margin-top:2px;">${this.escapeHtml(r.modified)} (${Math.round(r.size_bytes / 1024)} KB)</div>
                </div>
                <a href="/api/reports/view?file=${encodeURIComponent(r.filename)}" target="_blank" class="btn-secondary" style="font-size:11px; padding:4px 8px;">View</a>
            `;
            list.appendChild(item);
        });
    },

    renderResults(data) {
        const resultsSection = document.getElementById('results-section');
        const summaryContainer = document.getElementById('summary-container');
        const evidenceContainer = document.getElementById('evidence-container');
        const queriesContainer = document.getElementById('queries-container');
        const linkContainer = document.getElementById('report-link-container');
        const statusBadge = document.getElementById('result-status-badge');

        if (!resultsSection || !summaryContainer || !evidenceContainer || !queriesContainer) return;

        summaryContainer.innerHTML = '';
        evidenceContainer.innerHTML = '';
        queriesContainer.innerHTML = '';
        if (linkContainer) linkContainer.innerHTML = '';

        if (statusBadge) {
            if (data.status === 'cancelled') {
                statusBadge.className = 'badge badge-extreme';
                statusBadge.innerText = 'Cancelled — partial results';
            } else {
                statusBadge.className = 'badge badge-safe';
                statusBadge.innerText = 'Complete';
            }
        }

        this.renderMetricsBar(data);

        if (data.warnings && data.warnings.length) {
            const warnBox = document.createElement('div');
            warnBox.className = 'run-warnings';
            warnBox.innerHTML = data.warnings.map(w =>
                `<div class="run-warning">${this.escapeHtml(w)}</div>`
            ).join('');
            queriesContainer.appendChild(warnBox);
        }

        if (data.queries && data.queries.length > 1) {
            const tagBox = document.createElement('div');
            tagBox.className = 'queries-box';
            data.queries.forEach(q => {
                const tag = document.createElement('span');
                tag.className = 'query-tag';
                tag.innerText = q;
                tagBox.appendChild(tag);
            });
            queriesContainer.appendChild(tagBox);
        }

        if (data.summary) {
            summaryContainer.innerHTML = `
                <div class="summary-box">
                    <h3>Executive summary</h3>
                    <p>${this.escapeHtml(data.summary)}</p>
                </div>
            `;
        }

        if (!data.evidence || data.evidence.length === 0) {
            evidenceContainer.innerHTML = '<p class="empty-note">No public sources retrieved.</p>';
        } else {
            data.evidence.forEach((item, idx) => {
                const card = document.createElement('div');
                card.className = 'result-card';
                card.innerHTML = `
                    <div class="result-header">
                        <a href="${this.escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="result-title">
                            ${idx + 1}. ${this.escapeHtml(item.title || 'Untitled Source')}
                        </a>
                        <span class="result-score">Score ${item.score || 50}%</span>
                    </div>
                    <div class="result-url">${this.escapeHtml(item.url)}${item.doi ? ' | DOI: ' + this.escapeHtml(item.doi) : ''}</div>
                    ${item.snippet ? `<div class="result-snippet">${this.escapeHtml(item.snippet)}</div>` : ''}
                    ${item.excerpt ? `<div class="result-excerpt">${this.escapeHtml(item.excerpt)}</div>` : ''}
                `;
                evidenceContainer.appendChild(card);
            });
        }

        if (linkContainer && data.report_archive) {
            const relPath = data.report_archive.replace(/\\/g, '/');
            const filename = relPath.split('/').pop();
            linkContainer.innerHTML = `
                <div class="report-link-box">
                    <div>
                        <span class="report-label">Archived report</span>
                        <div><a class="report-name" href="/api/reports/view?file=${encodeURIComponent(filename)}" target="_blank">${this.escapeHtml(filename)}</a></div>
                    </div>
                    <a href="/api/reports/view?file=${encodeURIComponent(filename)}" target="_blank" class="btn-secondary">Open report</a>
                </div>
            `;
        }

        resultsSection.style.display = 'block';
    }
};

window.UiRenderer = UiRenderer;
