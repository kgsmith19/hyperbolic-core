/**
 * Deep Search UI Renderer
 * Renders executive summaries, evidence cards, metrics bar, cancel buttons, and report archives.
 */

const UiRenderer = {
    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.innerText = String(text);
        return div.innerHTML;
    },

    renderStatus(type, message) {
        const statusBox = document.getElementById('status-box');
        const cancelBtn = document.getElementById('cancel-btn');
        const progress = document.getElementById('live-progress');
        const detail = document.getElementById('progress-detail');

        if (!statusBox) return;

        if (cancelBtn) {
            cancelBtn.style.display = type === 'running' ? 'inline-block' : 'none';
        }

        if (!type) {
            if (progress) progress.hidden = true;
            statusBox.className = '';
            statusBox.style.display = 'none';
            statusBox.innerText = '';
            return;
        }

        if (progress) {
            progress.hidden = type !== 'running';
            const lower = String(message).toLowerCase();
            const stage = lower.includes('report') || lower.includes('summary') ? 'report' : lower.includes('rank') || lower.includes('rerank') || lower.includes('coverage') ? 'evaluate' : lower.includes('reading') || lower.includes('retriev') ? 'read' : lower.includes('search') || lower.includes('frontier') ? 'discover' : 'prepare';
            progress.querySelectorAll('.progress-stage').forEach(item => item.classList.toggle('active', item.dataset.stage === stage));
            if (detail) detail.innerText = message;
        }
        statusBox.className = type;
        statusBox.style.display = type === 'error' || type === 'cancelled' ? 'block' : 'none';
        statusBox.innerText = message;
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
        const badge = document.getElementById('estimate-mode-badge');
        const highlight = document.getElementById('estimate-spend-highlight');
        const hops = document.getElementById('est-hops');
        const hopsSub = document.getElementById('est-hops-sub');
        const sources = document.getElementById('est-sources');
        const sourcesSub = document.getElementById('est-sources-sub');
        const duration = document.getElementById('est-duration');
        const durationSub = document.getElementById('est-duration-sub');
        const spend = document.getElementById('est-spend');
        const spendSub = document.getElementById('est-spend-sub');
        const breakdown = document.getElementById('estimate-steps-breakdown');

        if (!highlight) return;

        const costDisplay = data.expected_cost_display || '$0.00';
        highlight.innerText = costDisplay;
        highlight.style.color = data.requires_confirm ? 'var(--warning)' : 'var(--success)';
        if (badge) {
            badge.className = data.requires_confirm ? 'badge-cost' : 'badge-safe';
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
        if (spend) spend.innerText = costDisplay;
        if (spendSub) spendSub.innerText = data.requires_confirm ? 'privacy tradeoff on' : 'declared spend';

        if (breakdown) {
            const warnings = data.warnings || [];
            breakdown.innerHTML = warnings.map(w => `
                <div class="breakdown-row">
                    <span class="breakdown-desc">${this.escapeHtml(w)}</span>
                </div>
            `).join('');
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

        bar.innerHTML = `
            <span class="badge-metric">⏱️ Duration: ${duration}</span>
            <span class="badge-metric">📄 Sources: ${docCount}</span>
            <span class="badge-cost">💰 Estimated Spend: ${costStr}</span>
            <span class="badge-metric">🔢 Tokens: ${totalTokens}</span>
            <span class="badge-metric">🤖 Model: ${this.escapeHtml(model)}</span>
        `;
    },

    renderReportsList(reports) {
        const list = document.getElementById('reports-list');
        const badge = document.getElementById('reports-count-badge');

        if (badge) {
            badge.innerText = `${reports.length} report${reports.length === 1 ? '' : 's'}`;
        }

        if (!list) return;

        if (!reports || reports.length === 0) {
            list.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">No archived reports found yet.</p>';
            return;
        }

        list.innerHTML = '';
        reports.forEach(r => {
            const item = document.createElement('div');
            item.className = 'report-item';
            item.innerHTML = `
                <div>
                    <a href="/api/reports/view?file=${encodeURIComponent(r.filename)}" target="_blank">${this.escapeHtml(r.filename)}</a>
                    <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">${this.escapeHtml(r.modified)} (${Math.round(r.size_bytes / 1024)} KB)</div>
                </div>
                <a href="/api/reports/view?file=${encodeURIComponent(r.filename)}" target="_blank" class="btn-secondary" style="font-size:11px; padding:4px 8px; text-decoration:none;">View</a>
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
                statusBadge.className = 'badge-extreme';
                statusBadge.innerText = 'Cancelled (Partial Results)';
            } else {
                statusBadge.className = 'badge-safe';
                statusBadge.innerText = 'Complete';
            }
        }

        // Render metrics bar
        this.renderMetricsBar(data);

        if (data.warnings && data.warnings.length) {
            const warnBox = document.createElement('div');
            warnBox.className = 'run-warnings';
            warnBox.innerHTML = data.warnings.map(w =>
                `<div class="run-warning">${this.escapeHtml(w)}</div>`
            ).join('');
            queriesContainer.appendChild(warnBox);
        }

        // Render multi-angle query tags
        if (data.queries && data.queries.length > 1) {
            const tagBox = document.createElement('div');
            tagBox.className = 'queries-box';
            data.queries.forEach(q => {
                const tag = document.createElement('span');
                tag.className = 'query-tag';
                tag.innerText = '🔍 ' + q;
                tagBox.appendChild(tag);
            });
            queriesContainer.appendChild(tagBox);
        }

        // Render executive summary
        if (data.summary) {
            summaryContainer.innerHTML = `
                <div class="summary-box">
                    <h3 style="margin-bottom:8px; color:var(--primary)">Executive Summary</h3>
                    <p style="white-space:pre-wrap;">${this.escapeHtml(data.summary)}</p>
                </div>
            `;
        }

        // Render evidence sources
        if (!data.evidence || data.evidence.length === 0) {
            evidenceContainer.innerHTML = '<p style="color:var(--text-muted)">No public sources retrieved.</p>';
        } else {
            data.evidence.forEach((item, idx) => {
                const card = document.createElement('div');
                card.className = 'result-card';
                card.innerHTML = `
                    <div class="result-header">
                        <a href="${this.escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="result-title">
                            ${idx + 1}. ${this.escapeHtml(item.title || 'Untitled Source')}
                        </a>
                        <span class="result-score">RRF Score: ${item.score || 50}%</span>
                    </div>
                    <div class="result-url">${this.escapeHtml(item.url)} ${item.doi ? ' | DOI: ' + this.escapeHtml(item.doi) : ''}</div>
                    ${item.snippet ? `<div class="result-snippet">${this.escapeHtml(item.snippet)}</div>` : ''}
                    ${item.excerpt ? `<div class="result-excerpt">${this.escapeHtml(item.excerpt)}</div>` : ''}
                `;
                evidenceContainer.appendChild(card);
            });
        }

        // Render archive link
        if (linkContainer && data.report_archive) {
            const relPath = data.report_archive.replace(/\\/g, '/');
            const filename = relPath.split('/').pop();
            linkContainer.innerHTML = `
                <div class="report-link-box">
                    <div>
                        <span style="color:var(--text-muted); font-size:12px;">Archived Report:</span>
                        <div>📁 <a href="/api/reports/view?file=${encodeURIComponent(filename)}" target="_blank">${this.escapeHtml(filename)}</a></div>
                    </div>
                    <a href="/api/reports/view?file=${encodeURIComponent(filename)}" target="_blank" class="btn-secondary">Open Report</a>
                </div>
            `;
        }

        resultsSection.style.display = 'block';
    }
};

window.UiRenderer = UiRenderer;
