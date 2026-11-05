/**
 * Deep Search UI renderer. Pure DOM output; no network calls.
 * Every dynamic string goes through esc() or textContent.
 */

const LANES = {
    academic: { label: 'Academic', group: 'evidence', hint: 'Papers, preprints, scholarly indexes' },
    gov: { label: 'Institutional', group: 'evidence', hint: '.gov, .edu, agencies, standards bodies' },
    reference: { label: 'Reference', group: 'evidence', hint: 'Encyclopedias' },
    filings: { label: 'Filings', group: 'evidence', hint: 'SEC and regulatory filings' },
    community: { label: 'Community', group: 'discussion', hint: 'Reddit, forums, Hacker News, Stack Exchange' },
    video: { label: 'Video', group: 'discussion', hint: 'YouTube talks and explainers (transcripts read)' },
    expert: { label: 'Experts & blogs', group: 'discussion', hint: 'Newsletters, expert blogs, podcasts' },
    news: { label: 'News', group: 'neutral', hint: 'Established newsrooms and science journalism' },
    code: { label: 'Code', group: 'neutral', hint: 'GitHub repositories' },
    archive: { label: 'Archive', group: 'neutral', hint: 'Internet Archive collections' },
    web: { label: 'Open web', group: 'neutral', hint: 'General web search' }
};
const LANE_ORDER = ['academic', 'gov', 'reference', 'filings', 'community', 'video', 'expert', 'news', 'code', 'archive', 'web'];
const STAGE_ORDER = ['plan', 'search', 'read', 'reflect', 'synthesize', 'report'];
const STAGE_TITLES = {
    plan: 'Planning the investigation', search: 'Searching', read: 'Reading sources',
    reflect: 'Reflecting on what it found', synthesize: 'Ranking and cross-checking', report: 'Writing the report',
    done: 'Finished'
};

function esc(text) {
    return window.Markdown.escape(text);
}

function el(id) {
    return document.getElementById(id);
}

function fmtClock(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtMinutes(min) {
    const m = Number(min) || 0;
    if (m >= 120) return `${(m / 60).toFixed(m % 60 ? 1 : 0)} h`;
    return `${Math.round(m)} min`;
}

function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (err) { return ''; }
}

function laneLabel(lane) {
    return (LANES[lane] || LANES.web).label;
}

function qualityDots(q) {
    const n = Math.max(1, Math.min(5, Math.round((Number(q) || 0) * 5)));
    return `<span class="quality" title="Source quality ${(Number(q) || 0).toFixed(2)}">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;
}

function metaBits(item) {
    const meta = item.meta || {};
    const bits = [];
    if (meta.venue) bits.push(esc(meta.venue));
    if (meta.year) bits.push(esc(meta.year));
    if (meta.community) bits.push(esc(meta.community));
    if (meta.author && item.lane !== 'academic') bits.push(esc(meta.author));
    if (meta.citations) bits.push(`cited ${Number(meta.citations).toLocaleString()}×`);
    if (meta.score) bits.push(`${Number(meta.score).toLocaleString()} points`);
    if (meta.comments) bits.push(`${Number(meta.comments).toLocaleString()} replies`);
    if (meta.views) bits.push(`${Number(meta.views).toLocaleString()} views`);
    if (meta.renderer === 'abstract') bits.push('abstract only');
    if (meta.renderer === 'wayback') bits.push('via Wayback Machine');
    if (meta.renderer === 'pdf') bits.push('full-text PDF');
    if (meta.has_transcript) bits.push('transcript read');
    return bits;
}

const UiRenderer = {
    LANES, LANE_ORDER,

    toast(message, ms = 2600) {
        const t = el('toast');
        if (!t) return;
        t.textContent = message;
        t.hidden = false;
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => { t.hidden = true; }, ms);
    },

    showView(view) {
        const map = { compose: 'view-compose', plan: 'view-plan', run: 'view-run', results: 'results-section' };
        Object.entries(map).forEach(([key, id]) => {
            const node = el(id);
            if (node) node.hidden = key !== view;
        });
        const main = el('main');
        if (main) main.scrollTop = 0;
        window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    },

    /* ------------------------------------------------------------ composer */

    renderPresets(presets, selected) {
        const host = el('presets');
        if (!host) return;
        const order = ['scout', 'standard', 'deep', 'marathon'];
        const gauge = { scout: '25%', standard: '50%', deep: '75%', marathon: '100%' };
        host.innerHTML = order.filter(k => presets[k]).map(key => {
            const p = presets[key];
            return `<button type="button" class="preset" role="radio" data-preset="${key}" aria-checked="${key === selected}" style="--gauge:${gauge[key]}">
                <span class="preset-name">${esc(p.label)}</span>
                <span class="preset-eta">${esc(p.eta)}</span>
                <span class="preset-blurb">${esc(p.blurb)}</span>
            </button>`;
        }).join('');
    },

    markPreset(selected) {
        document.querySelectorAll('.preset').forEach(btn => {
            btn.setAttribute('aria-checked', String(btn.dataset.preset === selected));
        });
    },

    renderLaneChips(allLanes, enabled) {
        const host = el('lanes');
        if (!host) return;
        host.innerHTML = allLanes.map(lane => {
            const info = LANES[lane] || { label: lane, hint: '' };
            const on = enabled.includes(lane);
            return `<button type="button" class="lane-chip" data-lane="${lane}" aria-pressed="${on}" title="${esc(info.hint)}">
                <span class="lane-dot"></span>${esc(info.label)}</button>`;
        }).join('');
    },

    renderMixValue(weight) {
        const out = el('mix-value');
        const range = el('academic-weight');
        const research = Math.round(weight);
        if (out) out.textContent = `${research} / ${100 - research}`;
        if (range) range.setAttribute('aria-valuetext', `${research}% research, ${100 - research}% community`);
    },

    renderEstimate(estimate, params) {
        const line = el('estimate-line');
        const cost = el('est-spend');
        const list = el('estimate-steps-breakdown');
        if (line) {
            const parts = [
                `Up to ${fmtMinutes(params.max_duration_min)}`,
                `${Number(params.max_documents).toLocaleString()} sources`,
                `${params.breadth} angle${params.breadth === 1 ? '' : 's'}`,
                `${params.max_gap_rounds} round${params.max_gap_rounds === 1 ? '' : 's'}`,
                `${params.max_depth} hop${params.max_depth === 1 ? '' : 's'} deep`
            ];
            line.innerHTML = parts.map(p => `<span>${esc(p)}</span>`).join('');
        }
        if (cost) {
            const paid = Boolean(params.ai_planning || params.ai_summary);
            cost.classList.toggle('paid', paid);
            cost.textContent = paid
                ? `AI spend about ${String(estimate.expected_cost_display || '').replace(/^~/, '').replace(' USD', '')}, capped at $${Number(params.max_spend_usd).toFixed(2)}`
                : 'Free and runs on this computer';
        }
        if (list) {
            list.innerHTML = (estimate.warnings || []).map(w => `<li>${esc(w.charAt(0).toUpperCase() + w.slice(1))}</li>`).join('');
        }
    },

    renderSettingsBadge(settings) {
        const pill = el('engine-pill');
        if (pill) {
            const extras = [];
            if (settings.hasOpenAI) extras.push('OpenAI');
            if (settings.hasBrave) extras.push('Brave');
            pill.textContent = extras.length ? `Local + ${extras.join(' + ')}` : 'Local engines';
            pill.classList.toggle('ai', settings.hasOpenAI);
        }
        const note = el('ai-planning-note');
        ['ai-planning', 'ai-summary'].forEach(id => {
            const box = el(id);
            if (box) box.disabled = !settings.hasOpenAI;
        });
        // The AI report is the default whenever a key exists; without one it cannot run.
        const report = el('ai-summary');
        if (report && !settings.hasOpenAI) report.checked = false;
        if (report && settings.hasOpenAI && !this._aiDefaultApplied) report.checked = true;
        if (settings.hasOpenAI) this._aiDefaultApplied = true;
        if (note && !settings.hasOpenAI) {
            note.innerHTML = 'Needs an OpenAI key. <button type="button" class="link-btn" data-open-settings>Add one in Settings</button>.';
        } else if (note) {
            note.textContent = 'Smarter questions and gap-finding. Sends the topic to OpenAI.';
        }
    },

    renderModelOptions(models) {
        const fill = (id, preferred) => {
            const select = el(id);
            if (!select) return;
            const current = select.value || preferred;
            select.innerHTML = models.map(m => {
                const label = `${m.id} ($${m.input_per_m} / $${m.output_per_m} per M tokens)`;
                return `<option value="${esc(m.id)}" ${m.id === current ? 'selected' : ''}>${esc(label)}</option>`;
            }).join('');
        };
        fill('concealer-model', 'gpt-4o-mini');
        fill('deep-model', 'gpt-4o');
    },

    /* ------------------------------------------------------------ plan */

    renderPlan(plan, topic) {
        const list = el('plan-list');
        if (!list) return;
        const t = el('plan-topic');
        if (t) t.textContent = topic;
        list.innerHTML = '';
        plan.forEach((q, idx) => list.appendChild(this._planItem(q, idx)));
    },

    _planItem(q, idx) {
        const li = document.createElement('li');
        li.className = 'plan-item' + (q.enabled === false ? ' off' : '');
        li.dataset.index = String(idx);
        const lanes = (q.lanes || []).filter(l => LANES[l]);
        li.innerHTML = `
            <span class="plan-num" aria-hidden="true"></span>
            <div class="plan-main">
                ${q.perspective ? `<span class="plan-persp">${esc(q.perspective)}</span>` : ''}
                <label class="visually-hidden" for="pq-${idx}">Question ${idx + 1}</label>
                <input type="text" id="pq-${idx}" class="plan-question" data-field="question" value="${esc(q.question)}">
                <div class="plan-queries">
                    ${(q.queries || []).map((query, qi) => `<span class="q-chip"><span title="${esc(query)}">${esc(query)}</span><button type="button" data-remove-query="${qi}" aria-label="Remove search ${esc(query)}">×</button></span>`).join('')}
                    <input type="text" class="q-add" data-add-query placeholder="Add a search and press Enter" aria-label="Add a search to question ${idx + 1}">
                </div>
            </div>
            <div class="plan-side">
                <label class="check"><input type="checkbox" data-toggle-question ${q.enabled === false ? '' : 'checked'}><span>Include</span></label>
                <div class="plan-lanes" title="Preferred source lanes">${lanes.map(l => `<span class="lane-tag" data-lane="${l}"><span class="lane-dot"></span>${esc(laneLabel(l))}</span>`).join('')}</div>
            </div>`;
        return li;
    },

    /* ------------------------------------------------------------ live run */

    resetRun(topic, opts) {
        el('run-title').textContent = topic;
        el('progress-title').textContent = 'Starting';
        el('view-run').classList.remove('run-done');
        ['live-sources', 'live-learnings', 'live-activity', 'live-questions'].forEach(id => { el(id).innerHTML = ''; });
        el('live-sources').innerHTML = '<li class="feed-empty">Sources will stream in here as they are read.</li>';
        el('live-learnings').innerHTML = '<li class="feed-empty">Findings appear after the first reflection round.</li>';
        el('live-questions').innerHTML = '<li class="feed-empty">The research questions appear once the plan is ready.</li>';
        ['c-searches', 'c-candidates', 'c-fetched', 'c-failed', 'c-queue', 'c-learnings'].forEach(id => { el(id).textContent = '0'; });
        el('lt-sources-count').textContent = '0';
        el('lt-learnings-count').textContent = '0';
        el('m-sources').textContent = `0 / ${opts.max_documents || 0}`;
        el('m-round').textContent = opts.max_gap_rounds ? `0 of ${opts.max_gap_rounds}` : 'None';
        ['m-sources-bar', 'm-time-bar', 'm-round-bar'].forEach(id => { el(id).style.width = '0%'; });
        el('status-box').textContent = '';
        el('status-box').className = 'now';
        el('mixbar').innerHTML = '';
        el('lane-legend').innerHTML = '';
        el('mix-actual').textContent = '';
        this.renderStage('plan');
        this.sounding.reset(opts.max_depth || 2, (opts.max_duration_min || 15) * 60);
    },

    renderStage(stage) {
        const idx = STAGE_ORDER.indexOf(stage);
        document.querySelectorAll('.progress-stage').forEach(item => {
            const i = STAGE_ORDER.indexOf(item.dataset.stage);
            item.classList.toggle('active', stage !== 'done' && i === idx);
            item.classList.toggle('done', stage === 'done' || i < idx);
        });
        const title = el('progress-title');
        if (title && STAGE_TITLES[stage]) title.textContent = STAGE_TITLES[stage];
        if (stage === 'done') el('view-run').classList.add('run-done');
    },

    renderStatus(type, message) {
        const box = el('status-box');
        const cancelBtn = el('cancel-btn');
        if (cancelBtn) cancelBtn.hidden = type !== 'running';
        if (!box) return;
        box.className = 'now' + (type === 'error' ? ' error' : '');
        box.textContent = message || '';
        const detail = el('progress-detail');
        if (detail) detail.textContent = message || '';
    },

    renderStats(stats, run) {
        const set = (id, v) => { const n = el(id); if (n) n.textContent = Number(v || 0).toLocaleString(); };
        set('c-searches', stats.searches);
        set('c-candidates', stats.candidates);
        set('c-fetched', stats.fetched);
        set('c-failed', stats.failed);
        set('c-queue', stats.queue);
        set('c-learnings', stats.learnings);
        const maxDocs = stats.max_documents || run.maxDocs || 0;
        const kept = stats.kept || 0;
        el('m-sources').textContent = `${kept.toLocaleString()} / ${Number(maxDocs).toLocaleString()}`;
        el('m-sources-bar').style.width = `${maxDocs ? Math.min(100, (kept / maxDocs) * 100) : 0}%`;
        if (stats.max_rounds !== undefined) run.maxRounds = stats.max_rounds;
        if (stats.round !== undefined) run.round = stats.round;
        this.renderRound(run.round, run.maxRounds);
        if (stats.time_budget_sec) run.timeBudget = stats.time_budget_sec;
        this.renderLaneMix(stats.lanes || {}, stats.lane_targets || {});
    },

    renderRound(round, maxRounds) {
        const label = el('m-round');
        if (!label) return;
        label.textContent = maxRounds ? `${round} of ${maxRounds}` : 'None';
        el('m-round-bar').style.width = `${maxRounds ? Math.min(100, (round / maxRounds) * 100) : 0}%`;
    },

    renderClock(elapsed, budget) {
        el('progress-elapsed').textContent = budget ? `${fmtClock(elapsed)} of ${fmtClock(budget)}` : fmtClock(elapsed);
        el('m-time-bar').style.width = `${budget ? Math.min(100, (elapsed / budget) * 100) : 0}%`;
        this.sounding.tick(elapsed);
    },

    renderLaneMix(counts, targets) {
        const bar = el('mixbar');
        const legend = el('lane-legend');
        if (!bar || !legend) return;
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        const lanes = LANE_ORDER.filter(l => counts[l]);
        bar.innerHTML = lanes.map(l => `<span data-lane="${l}" style="width:${(counts[l] / total) * 100}%" title="${esc(laneLabel(l))}: ${counts[l]}"></span>`).join('');
        const evidenceTarget = Object.entries(targets).filter(([l]) => (LANES[l] || {}).group === 'evidence').reduce((a, [, v]) => a + v, 0);
        if (evidenceTarget > 0) {
            bar.insertAdjacentHTML('beforeend', `<i class="target" style="left:${evidenceTarget * 100}%" title="Target research share"></i>`);
        }
        legend.innerHTML = lanes.map(l => `<li data-lane="${l}"><span class="lane-dot"></span>${esc(laneLabel(l))} ${counts[l]}</li>`).join('');
        const research = lanes.filter(l => LANES[l].group === 'evidence').reduce((a, l) => a + counts[l], 0);
        const discussion = lanes.filter(l => LANES[l].group === 'discussion').reduce((a, l) => a + counts[l], 0);
        const actual = el('mix-actual');
        if (actual && total) actual.textContent = `${Math.round((research / total) * 100)}% research, ${Math.round((discussion / total) * 100)}% community`;
    },

    pushSource(event, count) {
        const list = el('live-sources');
        if (!list) return;
        list.querySelector('.feed-empty')?.remove();
        const li = document.createElement('li');
        li.className = 'feed-source fresh';
        li.innerHTML = `<a href="${esc(event.url)}" target="_blank" rel="noopener noreferrer" title="${esc(event.title)}">${esc(event.title || event.url)}</a>
            <div class="feed-meta"><span class="lane-tag" data-lane="${esc(event.lane)}"><span class="lane-dot"></span>${esc(laneLabel(event.lane))}</span>
            <span>${esc(hostOf(event.url))}</span><span>hop ${Number(event.depth) || 0}</span>${qualityDots(event.quality)}</div>`;
        list.prepend(li);
        while (list.children.length > 150) list.lastElementChild.remove();
        el('lt-sources-count').textContent = String(count);
        this.sounding.add(event);
    },

    pushLearning(event, count) {
        const list = el('live-learnings');
        if (!list) return;
        list.querySelector('.feed-empty')?.remove();
        const li = document.createElement('li');
        li.className = 'feed-learning fresh';
        li.innerHTML = `<p>${esc(event.text)}</p><div class="feed-meta"><span class="lane-tag" data-lane="${esc(event.lane || 'web')}"><span class="lane-dot"></span>${esc(laneLabel(event.lane || 'web'))}</span>
            ${event.url ? `<a href="${esc(event.url)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(event.url))}</a>` : ''}</div>`;
        list.prepend(li);
        el('lt-learnings-count').textContent = String(count);
    },

    pushLog(message, elapsed, kind = '') {
        const list = el('live-activity');
        if (!list) return;
        const li = document.createElement('li');
        if (kind) li.className = kind;
        li.innerHTML = `<time>${fmtClock(elapsed)}</time><span>${esc(message)}</span>`;
        list.prepend(li);
        while (list.children.length > 400) list.lastElementChild.remove();
    },

    renderQuestions(plan, coverage) {
        const list = el('live-questions');
        if (!list || !plan || !plan.sub_questions) return;
        const max = Math.max(4, ...Object.values(coverage || {}));
        list.innerHTML = plan.sub_questions.map(sq => {
            const n = (coverage || {})[sq.id] || 0;
            return `<li class="qcov"><div><strong>${esc(sq.perspective || sq.id)}</strong><small>${esc(sq.question)}</small></div>
                <div><div class="bar"><div class="bar-fill" style="width:${Math.min(100, (n / max) * 100)}%"></div></div><small>${n} source${n === 1 ? '' : 's'}</small></div></li>`;
        }).join('');
    },

    /* Sounding: SVG depth chart. x = time, y = hop depth, dot = source. */
    sounding: {
        host: null, svg: null, maxDepth: 2, budget: 900, dots: [], elapsed: 0,
        reset(maxDepth, budget) {
            this.host = el('sounding');
            this.maxDepth = Math.max(1, maxDepth);
            this.budget = Math.max(60, budget);
            this.dots = [];
            this.elapsed = 0;
            if (!this.host) return;
            this.host.innerHTML = '<div class="sounding-empty">Waiting for the first source…</div>';
            this.svg = null;
        },
        _ensure() {
            if (this.svg || !this.host) return;
            this.host.innerHTML = '';
            const ns = 'http://www.w3.org/2000/svg';
            this.svg = document.createElementNS(ns, 'svg');
            this.svg.setAttribute('preserveAspectRatio', 'none');
            this.host.appendChild(this.svg);
            this.layer = document.createElementNS(ns, 'g');
            this.svg.appendChild(this.layer);
            this._drawBands();
        },
        _size() {
            const r = this.host.getBoundingClientRect();
            return { w: Math.max(200, r.width), h: Math.max(160, r.height) };
        },
        _y(depth, h) {
            const pad = 28;
            return pad + (Math.min(depth, this.maxDepth) / this.maxDepth) * (h - pad * 2);
        },
        _x(t, w) {
            const span = Math.max(this.budget, this.elapsed * 1.05, 60);
            return 54 + (t / span) * (w - 70);
        },
        _drawBands() {
            const ns = 'http://www.w3.org/2000/svg';
            const { w, h } = this._size();
            this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
            this.svg.querySelectorAll('.band').forEach(n => n.remove());
            for (let d = 0; d <= this.maxDepth; d++) {
                const y = this._y(d, h);
                const g = document.createElementNS(ns, 'g');
                g.setAttribute('class', 'band');
                const line = document.createElementNS(ns, 'line');
                line.setAttribute('x1', '50'); line.setAttribute('x2', String(w - 8));
                line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y));
                line.setAttribute('class', 'band-line');
                const label = document.createElementNS(ns, 'text');
                label.setAttribute('x', '8'); label.setAttribute('y', String(y + 4));
                label.setAttribute('class', 'band-label');
                label.textContent = d === 0 ? 'Search' : `Hop ${d}`;
                g.appendChild(line); g.appendChild(label);
                this.svg.insertBefore(g, this.layer);
            }
            let sweep = this.svg.querySelector('.sweep');
            if (!sweep) {
                sweep = document.createElementNS(ns, 'line');
                sweep.setAttribute('class', 'sweep');
                this.svg.appendChild(sweep);
            }
            sweep.setAttribute('y1', '10'); sweep.setAttribute('y2', String(h - 10));
        },
        add(event) {
            if (!this.host) return;
            this._ensure();
            const ns = 'http://www.w3.org/2000/svg';
            const t = typeof event.t === 'number' ? event.t : this.elapsed;
            const c = document.createElementNS(ns, 'circle');
            c.setAttribute('data-lane', event.lane || 'web');
            c.setAttribute('class', 'fresh');
            const title = document.createElementNS(ns, 'title');
            title.textContent = `${event.title || event.url} (${laneLabel(event.lane)}, hop ${event.depth || 0})`;
            c.appendChild(title);
            const jitter = (Math.random() - 0.5) * 18;
            const dot = { c, t, depth: Number(event.depth) || 0, jitter, q: Number(event.quality) || 0.4 };
            this.dots.push(dot);
            this.layer.appendChild(c);
            this._place(dot);
            setTimeout(() => c.classList.remove('fresh'), 900);
        },
        _place(dot) {
            const { w, h } = this._size();
            dot.c.setAttribute('cx', String(this._x(dot.t, w)));
            dot.c.setAttribute('cy', String(this._y(dot.depth, h) + dot.jitter));
            dot.c.setAttribute('r', String(3 + dot.q * 4));
        },
        tick(elapsed) {
            this.elapsed = elapsed;
            if (!this.svg) return;
            const { w } = this._size();
            const sweep = this.svg.querySelector('.sweep');
            const x = this._x(elapsed, w);
            if (sweep) { sweep.setAttribute('x1', String(x)); sweep.setAttribute('x2', String(x)); }
            if (elapsed > this.budget) this.dots.forEach(d => this._place(d));
        },
        relayout() {
            if (!this.svg) return;
            this._drawBands();
            this.dots.forEach(d => this._place(d));
            this.tick(this.elapsed);
        }
    },

    /* ------------------------------------------------------------ results */

    renderResults(data) {
        const isPartial = data.status === 'cancelled';
        const badge = el('result-status-badge');
        badge.className = 'status' + (isPartial ? ' partial' : '');
        badge.textContent = isPartial ? 'Stopped early — partial results' : 'Complete';
        el('results-title').textContent = data.topic || 'Research report';
        el('result-when').textContent = data.when || '';

        this.renderMetricsBar(data);
        this.renderWarnings(data.warnings || []);
        this.renderReport(data);
        this.renderSources(data.evidence || []);
        this.renderLearnings(data.learnings || []);
        this.renderFollowups(data.followups || []);
        this.renderMethod(data);

        const file = (data.report_archive || '').replace(/\\/g, '/').split('/').pop();
        const dl = el('download-report');
        if (dl) {
            dl.hidden = !file;
            if (file) { dl.href = `/api/reports/view?file=${encodeURIComponent(file)}`; dl.setAttribute('download', file); }
        }
        el('tab-sources-count').textContent = String((data.evidence || []).length);
        el('tab-learnings-count').textContent = String((data.learnings || []).length);
        el('tab-next-count').textContent = String((data.followups || []).length);
    },

    renderMetricsBar(data) {
        const bar = el('metrics-bar');
        if (!bar) return;
        const stats = data.stats || {};
        const spend = data.spend_report || {};
        const lanes = stats.lane_counts || {};
        const research = Object.entries(lanes).filter(([l]) => (LANES[l] || {}).group === 'evidence').reduce((a, [, v]) => a + v, 0);
        const discussion = Object.entries(lanes).filter(([l]) => (LANES[l] || {}).group === 'discussion').reduce((a, [, v]) => a + v, 0);
        const items = [
            ['Sources', (data.evidence || []).length.toLocaleString()],
            ['Time', fmtClock(data.duration_seconds || 0)],
            ['Searches', Number(stats.searches || (data.queries || []).length).toLocaleString()],
            ['Pages read', Number(stats.fetched || 0).toLocaleString()],
            ['Rounds', String(stats.round || 0)],
            ['Mix', research + discussion ? `${research} research, ${discussion} community` : '—'],
            ['AI spend', spend.estimated_cost_usd ? `$${Number(spend.estimated_cost_usd).toFixed(3)}` : '$0']
        ];
        bar.innerHTML = items.map(([k, v]) => `<div class="metric"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');
    },

    renderWarnings(warnings) {
        const box = el('run-warnings');
        if (!box) return;
        box.hidden = !warnings.length;
        box.innerHTML = warnings.length ? `<ul>${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : '';
    },

    renderReport(data) {
        const container = el('summary-container');
        const toc = el('report-toc');
        if (!container) return;
        let md = data.summary || '';
        if (!md.trim()) md = '_No summary was produced._';
        container.innerHTML = window.Markdown.render(md, { citations: true });
        if (toc) {
            const heads = [...container.querySelectorAll('h2, h3')];
            toc.innerHTML = heads.length > 2
                ? heads.map(h => `<a href="#${h.id}" class="${h.tagName === 'H3' ? 'sub' : ''}">${esc(h.textContent)}</a>`).join('')
                : '';
        }
        this._evidence = data.evidence || [];
    },

    citePopover(button) {
        document.querySelectorAll('.cite-pop').forEach(n => n.remove());
        const n = parseInt(button.dataset.cite, 10);
        const item = (this._evidence || [])[n - 1];
        if (!item) return;
        const pop = document.createElement('div');
        pop.className = 'cite-pop';
        pop.setAttribute('role', 'tooltip');
        pop.innerHTML = `<strong>[${n}] ${esc(item.title)}</strong>
            <div class="feed-meta"><span class="lane-tag" data-lane="${esc(item.lane || 'web')}"><span class="lane-dot"></span>${esc(laneLabel(item.lane || 'web'))}</span><span>${esc(hostOf(item.url))}</span></div>
            <p class="muted">${esc((item.snippet || '').slice(0, 220))}</p>`;
        document.body.appendChild(pop);
        const r = button.getBoundingClientRect();
        const left = Math.min(window.scrollX + r.left, window.scrollX + window.innerWidth - pop.offsetWidth - 16);
        pop.style.left = `${Math.max(8, left)}px`;
        pop.style.top = `${window.scrollY + r.bottom + 6}px`;
    },

    renderSources(evidence, filter = {}) {
        const list = el('evidence-container');
        const chips = el('source-lane-filter');
        if (!list) return;
        if (chips && !filter.keepChips) {
            const counts = {};
            evidence.forEach(e => { const l = e.lane || 'web'; counts[l] = (counts[l] || 0) + 1; });
            chips.innerHTML = `<button type="button" class="chip" data-lane-filter="" aria-pressed="true">All ${evidence.length}</button>` +
                LANE_ORDER.filter(l => counts[l]).map(l => `<button type="button" class="chip" data-lane="${l}" data-lane-filter="${l}" aria-pressed="false"><span class="lane-dot"></span>${esc(laneLabel(l))} ${counts[l]}</button>`).join('');
        }
        let items = evidence.map((e, i) => ({ e, i }));
        if (filter.lane) items = items.filter(({ e }) => (e.lane || 'web') === filter.lane);
        if (filter.text) {
            const q = filter.text.toLowerCase();
            items = items.filter(({ e }) => `${e.title} ${e.url} ${e.snippet} ${e.excerpt}`.toLowerCase().includes(q));
        }
        if (filter.sort === 'quality') items.sort((a, b) => (b.e.quality || 0) - (a.e.quality || 0));
        if (filter.sort === 'depth') items.sort((a, b) => (b.e.depth || 0) - (a.e.depth || 0));
        if (!items.length) {
            list.innerHTML = '<li class="rail-empty">No sources match.</li>';
            return;
        }
        list.innerHTML = items.map(({ e, i }) => {
            const lane = e.lane || 'web';
            const bits = metaBits(e);
            return `<li class="source-card" id="src-${i + 1}">
                <span class="source-rank">${i + 1}</span>
                <div>
                    <a class="source-title" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.title || 'Untitled source')}</a>
                    <div class="source-meta">
                        <span class="lane-tag" data-lane="${lane}"><span class="lane-dot"></span>${esc(laneLabel(lane))}</span>
                        <span>${esc(hostOf(e.url))}</span>
                        ${e.quality ? qualityDots(e.quality) : ''}
                        <span>hop ${Number(e.depth) || 0}</span>
                        ${bits.map(b => `<span>${b}</span>`).join('')}
                    </div>
                    ${e.snippet ? `<p class="source-snippet">${esc(e.snippet)}</p>` : ''}
                    ${e.excerpt ? `<details><summary>Read the passage used</summary><div class="source-excerpt">${esc(e.excerpt)}</div></details>` : ''}
                </div>
            </li>`;
        }).join('');
    },

    renderLearnings(learnings) {
        const list = el('learnings-container');
        if (!list) return;
        if (!learnings.length) {
            list.innerHTML = '<li class="rail-empty">No round-by-round learnings were recorded for this run.</li>';
            return;
        }
        let lastRound = null;
        const out = [];
        learnings.forEach(item => {
            if (item.round !== lastRound) {
                lastRound = item.round;
                out.push(`<li class="log-round">Round ${esc(item.round ?? '?')}</li>`);
            }
            out.push(`<li class="log-item" data-lane="${esc(item.lane || 'web')}"><p>${esc(item.text)}</p>
                ${item.url ? `<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.title || hostOf(item.url))}</a>` : ''}</li>`);
        });
        list.innerHTML = out.join('');
    },

    renderFollowups(followups) {
        const list = el('followups-container');
        if (!list) return;
        list.innerHTML = followups.length
            ? followups.map((f, i) => `<li class="next-item"><span>${esc(f)}</span><button type="button" class="btn btn-small" data-dig="${i}">Dig into this</button></li>`).join('')
            : '<li class="rail-empty">No obvious leads left. Try a narrower question below.</li>';
    },

    renderMethod(data) {
        const host = el('queries-container');
        if (!host) return;
        const stats = data.stats || {};
        const opts = data.options || {};
        const plan = data.plan || {};
        const blocks = [];
        blocks.push(`<div class="method-block"><h3>Run</h3><dl class="kv">
            <dt>Stop reason</dt><dd>${esc(({ completed: 'Finished its rounds', document_budget: 'Reached the source limit', time_budget: 'Reached the time limit', cancelled: 'Stopped by you', low_information_gain: 'Stopped finding new information' })[data.stop_reason] || data.stop_reason || '—')}</dd>
            <dt>Depth</dt><dd>${esc(opts.max_depth ?? '—')} hops, ${esc(opts.max_gap_rounds ?? '—')} rounds, ${esc(opts.breadth ?? '—')} angles</dd>
            <dt>Mix target</dt><dd>${opts.academic_weight !== undefined && opts.academic_weight !== null ? `${Math.round(opts.academic_weight * 100)}% research, ${Math.round((1 - opts.academic_weight) * 100)}% community` : '—'}</dd>
            <dt>Lanes</dt><dd>${esc((opts.source_lanes || []).map(laneLabel).join(', ') || 'Classic connector set')}</dd>
            <dt>Blocked or off-topic</dt><dd>${Number(stats.failed || 0).toLocaleString()} pages skipped</dd>
            <dt>AI</dt><dd>${opts.ai_planning ? 'Planning on' : 'Planning off'}, ${opts.ai_summary ? 'AI report' : 'local report'}${opts.llm_process === 'hide' ? ', process concealed' : ''}</dd>
            <dt>Run ID</dt><dd>${esc(data.run_id || '—')}</dd>
        </dl></div>`);
        if (plan.sub_questions && plan.sub_questions.length > 1) {
            blocks.push(`<div class="method-block"><h3>Research questions</h3><ol class="prose" style="font-size:15px">${plan.sub_questions.map(sq => `<li><strong>${esc(sq.perspective || '')}</strong> ${esc(sq.question)}</li>`).join('')}</ol></div>`);
        }
        if ((data.queries || []).length) {
            blocks.push(`<div class="method-block"><h3>Opening searches (${data.queries.length})</h3><ul class="query-list">${data.queries.map(q => `<li>${esc(q)}</li>`).join('')}</ul></div>`);
        }
        host.innerHTML = blocks.join('');
        const link = el('report-link-container');
        const file = (data.report_archive || '').replace(/\\/g, '/').split('/').pop();
        if (link) link.innerHTML = file ? `<p class="hint">Archived as <a href="/api/reports/view?file=${encodeURIComponent(file)}" target="_blank">${esc(file)}</a>.</p>` : '';
    },

    /* ------------------------------------------------------------ rail */

    renderReportsList(reports, filterText = '', currentFile = '') {
        const list = el('reports-list');
        const badge = el('reports-count-badge');
        if (badge) badge.textContent = String(reports.length);
        if (!list) return;
        const q = filterText.trim().toLowerCase();
        const items = q ? reports.filter(r => `${r.title} ${r.filename}`.toLowerCase().includes(q)) : reports;
        if (!items.length) {
            list.innerHTML = `<li class="rail-empty">${reports.length ? 'No reports match.' : 'Finished searches appear here.'}</li>`;
            return;
        }
        list.innerHTML = items.slice(0, 200).map(r => {
            const when = (r.modified || '').slice(0, 16);
            return `<li><button type="button" class="rail-item ${r.filename === currentFile ? 'current' : ''}" data-report="${esc(r.filename)}" data-has-result="${r.has_result ? '1' : ''}">
                <span class="rail-item-title">${esc(r.title || r.filename)}</span>
                <span class="rail-item-meta">${esc(when)}${r.has_result ? '' : ', report only'}</span></button></li>`;
        }).join('');
    },

    renderActiveRuns(runs, currentRunId) {
        const wrap = el('active-runs');
        const list = el('active-runs-list');
        const active = runs.filter(r => r.status === 'running');
        if (wrap) wrap.hidden = !active.length;
        if (list) {
            list.innerHTML = active.map(r => `<li><button type="button" class="rail-item ${r.run_id === currentRunId ? 'current' : ''}" data-attach="${esc(r.run_id)}">
                <span class="rail-item-title">${esc(r.topic)}</span>
                <span class="rail-item-meta">${fmtClock(r.elapsed_sec)} elapsed, ${Number((r.stats || {}).kept || 0)} sources</span></button></li>`).join('');
        }
        return active;
    }
};

window.UiRenderer = UiRenderer;
