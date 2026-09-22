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

        if (!statusBox) return;

        if (cancelBtn) {
            cancelBtn.style.display = type === 'running' ? 'inline-block' : 'none';
        }

        if (!type) {
            statusBox.className = '';
            statusBox.style.display = 'none';
            statusBox.innerText = '';
            return;
        }

        statusBox.className = type;
        statusBox.style.display = 'block';
        statusBox.innerText = message;
    },

    renderSettingsBadge(settings) {
        const badge = document.getElementById('settings-badge');
        if (!badge) return;

        if (settings.hasBrave && settings.hasOpenAI) {
            badge.innerText = 'Brave & OpenAI Active';
        } else if (settings.hasBrave) {
            badge.innerText = 'Brave Search Active';
        } else if (settings.hasOpenAI) {
            badge.innerText = 'OpenAI Active';
        } else if (settings.searxngActive) {
            badge.innerText = '🟢 SearXNG (DDG+Bing) Active';
        } else {
            badge.innerText = 'Free / Offline Ready';
        }
    },

    renderPreRunEstimate(data) {
        const badge = document.getElementById('estimate-mode-badge');
        const highlight = document.getElementById('estimate-spend-highlight');
        const apiCalls = document.getElementById('est-api-calls');
        const apiCallsSub = document.getElementById('est-api-calls-sub');
        const modelVal = document.getElementById('est-model-val');
        const effortSub = document.getElementById('est-effort-sub');
        const concurrencyVal = document.getElementById('est-concurrency-val');
        const concurrencySub = document.getElementById('est-concurrency-sub');
        const tokensVal = document.getElementById('est-tokens-val');
        const tokensSub = document.getElementById('est-tokens-sub');
        const breakdown = document.getElementById('estimate-steps-breakdown');

        if (!highlight) return;

        if (data.mode === 'deterministic' || data.mode === 'extreme') {
            if (badge) {
                badge.className = 'badge-safe';
                badge.innerText = data.mode === 'extreme'
                    ? '🛡️ Tier 2: Cloaked Stealth (0 Bytes to AI)'
                    : '⚡ Tier 1: Standard Local (0 Bytes to AI)';
            }
            highlight.innerText = '$0.00';
            highlight.style.color = 'var(--success)';
            if (apiCalls) apiCalls.innerText = '0 calls';
            if (apiCallsSub) apiCallsSub.innerText = data.mode === 'extreme' ? 'Max depth + chaffing (Local CPU)' : 'Offline extractive CPU';
            if (modelVal) modelVal.innerText = 'Local CPU';
            if (effortSub) effortSub.innerText = '0 reasoning tokens';
        } else {
            if (badge) {
                badge.className = data.mode === 'expansion' ? 'badge-metric' : 'badge-cost';
                badge.innerText = data.mode === 'expansion'
                    ? '🔍 Tier 3: Smart Discovery (1 AI Call)'
                    : `📝 Tier 4: Full AI Brief (${data.model})`;
            }
            highlight.innerText = data.estimated_cost_display || `$${data.estimated_cost_usd?.toFixed(4) || '0.00'}`;
            highlight.style.color = '#38bdf8';
            if (apiCalls) apiCalls.innerText = `${data.api_calls} call${data.api_calls === 1 ? '' : 's'}`;
            if (apiCallsSub) {
                apiCallsSub.innerText = data.mode === 'expansion' ? '1 Query Expansion' : '1 Expansion + 1 Synthesis';
            }
            if (modelVal) modelVal.innerText = data.model || 'gpt-4o-mini';
            if (effortSub) {
                effortSub.innerText = data.reasoning_effort && data.reasoning_effort !== 'n/a'
                    ? `Reasoning: ${data.reasoning_effort} (~${(data.estimated_reasoning_tokens || 0).toLocaleString()} tokens)`
                    : 'Standard reasoning';
            }
        }

        if (concurrencyVal) {
            concurrencyVal.innerText = `${data.concurrency_workers || 4} workers`;
        }
        if (concurrencySub) {
            concurrencySub.innerText = 'Territory partitioned';
        }

        if (tokensVal) {
            tokensVal.innerText = `~${(data.estimated_total_tokens || 0).toLocaleString()} tokens`;
        }
        if (tokensSub) {
            tokensSub.innerText = `Prompt: ${(data.estimated_prompt_tokens || 0).toLocaleString()} | Output: ${(data.estimated_completion_tokens || 0).toLocaleString()}`;
        }

        if (breakdown && data.call_breakdown) {
            breakdown.innerHTML = data.call_breakdown.map(item => `
                <div class="breakdown-row">
                    <span class="breakdown-title">
                        <span>${item.calls > 0 ? '🤖' : '⚡'}</span>
                        <strong>${this.escapeHtml(item.step)}</strong>
                        <span class="badge-safe" style="font-size:10px; padding:1px 4px;">${item.calls} API call${item.calls === 1 ? '' : 's'}</span>
                    </span>
                    <span class="breakdown-desc">${this.escapeHtml(item.desc)}</span>
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
