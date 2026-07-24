import { fetchStatsData, STATS_CAP } from './api.js';
import { getStallCost } from './config.js';
import { showToast, notifyIfTruncated } from './ui.js';
import { escapeHtml } from './utils.js';

// Constants for Prefixes
const PREFIX_FOOD = 'ESF26-FOOD-';
const PREFIX_NONFOOD = 'ESF26-NONFOOD-';
const PREFIX_DEV = 'ESF26-DEV-';

let statusChartInstance = null;
let instanceChartInstance = null;
let categoryChartInstance = null;

// Collapsible per-instance panels (mobile: keeps the page from being one long
// scroll through four near-identical breakdowns). Delegated since renderPanel()
// rebuilds these headers via innerHTML on every refresh.
document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="toggle-panel"]');
    if (btn) togglePanel(btn);
});
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const btn = e.target.closest('[data-action="toggle-panel"]');
    if (!btn) return;
    e.preventDefault();
    togglePanel(btn);
});

function togglePanel(btn) {
    const body = document.getElementById(btn.dataset.target);
    if (!body) return;
    const collapsed = body.classList.toggle('hidden');
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.querySelector('svg')?.classList.toggle('rotate-180', !collapsed);
}

// Refresh without a full page reload; loadGlobalStats() already destroys and
// rebuilds the charts, so re-running it is safe. Disabled while in flight so
// a double-click can't race two loads.
document.getElementById('btn-refresh')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.querySelector('svg')?.classList.add('animate-spin');
    try {
        await loadGlobalStats();
    } finally {
        btn.disabled = false;
        btn.querySelector('svg')?.classList.remove('animate-spin');
    }
});

// Ensure Chart.js is available or wait for it? 
// It is loaded via CDN in stats.html. We assume it's global 'Chart'.

export async function loadGlobalStats() {
    const loadingEl = document.getElementById('loading');
    if (loadingEl) loadingEl.classList.remove('hidden');

    ['panel-combined', 'panel-food', 'panel-nonfood', 'panel-others'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });

    try {
        const allRows = await fetchStatsData();
        notifyIfTruncated(allRows, STATS_CAP, 'bookings — charts and totals only reflect these');

        // 2. Segment Data
        const foodData = allRows.filter(r => r.instance_prefix === PREFIX_FOOD);
        const nonFoodData = allRows.filter(r => r.instance_prefix === PREFIX_NONFOOD);
        const combinedData = [...foodData, ...nonFoodData];

        // Attractions / Others
        const otherData = allRows.filter(r =>
            r.instance_prefix !== PREFIX_FOOD &&
            r.instance_prefix !== PREFIX_NONFOOD &&
            r.instance_prefix !== PREFIX_DEV
        );

        // 3. Render Charts
        renderCharts(allRows, combinedData, foodData, nonFoodData);

        // 4. Render Panels 
        renderPanel('panel-combined', combinedData, 'Total Festival Figures (Combined)', 'bg-gray-800 text-white', 'border-gray-300');
        renderPanel('panel-food', foodData, 'Food & Drink Instance', 'bg-red-800 text-white', 'border-red-200');
        renderPanel('panel-nonfood', nonFoodData, 'Non-Food / General Instance', 'bg-blue-800 text-white', 'border-blue-200');
        renderPanel('panel-others', otherData, 'Misc', 'bg-indigo-800 text-white', 'border-indigo-200');

    } catch (err) {
        console.error(err);
        showToast("Error loading stats: " + (err.message || err), "error");
    } finally {
        if (loadingEl) loadingEl.classList.add('hidden');
    }
}

function renderCharts(allRows, combinedData, foodData, nonFoodData) {
    const chartsSection = document.getElementById('charts-section');
    if (chartsSection) chartsSection.classList.remove('hidden');

    // Calculate stats. All six statuses the bookings_status_check constraint
    // allows get their own bucket — 'Payment Requested' used to fall through
    // a catch-all into Pending, which hid mid-checkout bookings inside the
    // Pending slice and made the doughnut disagree with the revenue card's
    // pending count.
    const statusCounts = {
        Confirmed: 0,
        Pending: 0,
        'Payment Requested': 0,
        'HCC Checks': 0,
        Rejected: 0,
        Cancelled: 0
    };

    let powerCount = 0;
    let residentCount = 0;
    const categoryCounts = {};

    combinedData.forEach(r => {
        const s = r.status || 'Pending';
        if (statusCounts.hasOwnProperty(s)) {
            statusCounts[s]++;
        } else {
            statusCounts.Pending++;
        }

        // Power/resident cards and the category tallies are operational
        // "what does the festival need to plan for" numbers, so a stall
        // that cancelled or was rejected shouldn't keep contributing to
        // them forever. The status doughnut above deliberately still
        // counts every row — dead bookings are exactly what it exists
        // to show.
        if (!isActiveBooking(r)) return;

        if (checkBool(r.power_required)) powerCount++;
        if (checkBool(r.is_resident)) residentCount++;

        // Tally categories
        const cat = r.category || 'Other';
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    });

    // Update quick stats cards
    setText('stat-confirmed', statusCounts.Confirmed);
    setText('stat-pending', statusCounts.Pending);
    setText('stat-power', powerCount);
    setText('stat-resident', residentCount);

    if (typeof Chart === 'undefined') return;

    // 1. Status Overview Chart (Doughnut)
    const statusCtx = document.getElementById('statusChart');
    if (statusCtx) {
        if (statusChartInstance) statusChartInstance.destroy();
        statusChartInstance = new Chart(statusCtx, {
            type: 'doughnut',
            data: {
                labels: Object.keys(statusCounts),
                datasets: [{
                    data: Object.values(statusCounts),
                    backgroundColor: [
                        '#10b981', // Confirmed - green
                        '#f59e0b', // Pending - yellow
                        '#3b82f6', // Payment Requested - blue (matches the Awaiting Payment bar)
                        '#f97316', // HCC Checks - orange
                        '#ef4444', // Rejected - red
                        '#6b7280'  // Cancelled - gray
                    ],
                    borderWidth: 2,
                    borderColor: '#fff'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { position: 'bottom', labels: { padding: 15, font: { size: 11 } } },
                    tooltip: {
                        callbacks: {
                            label: function (context) {
                                const label = context.label || '';
                                const value = context.parsed || 0;
                                const total = context.dataset.data.reduce((a, b) => a + b, 0);
                                const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                                return label + ': ' + value + ' (' + percentage + '%)';
                            }
                        }
                    },
                    datalabels: {
                        display: true,
                        color: '#fff',
                        font: { weight: 'bold', size: 14 },
                        formatter: function (value, context) {
                            if (value === 0) return '';
                            const total = context.dataset.data.reduce((a, b) => a + b, 0);
                            const percentage = total > 0 ? ((value / total) * 100).toFixed(0) : 0;
                            return value + '\n(' + percentage + '%)';
                        }
                    }
                }
            },
            plugins: [ChartDataLabels]
        });
    }

    // 2. Food vs General Chart (Pie) — active bookings only. Raw row counts
    // meant a stall that cancelled in March still boosted its instance's
    // slice forever, which isn't what "Food vs General" is read as.
    const activeFood = foodData.filter(isActiveBooking).length;
    const activeNonFood = nonFoodData.filter(isActiveBooking).length;
    const instanceCtx = document.getElementById('instanceChart');
    if (instanceCtx) {
        if (instanceChartInstance) instanceChartInstance.destroy();
        instanceChartInstance = new Chart(instanceCtx, {
            type: 'pie',
            data: {
                labels: ['Food & Drink', 'General/Non-Food'],
                datasets: [{
                    data: [activeFood, activeNonFood],
                    backgroundColor: ['#ef4444', '#3b82f6'],
                    borderWidth: 2,
                    borderColor: '#fff'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { position: 'bottom', labels: { padding: 15, font: { size: 11 } } },
                    tooltip: {
                        callbacks: {
                            label: function (context) {
                                const label = context.label || '';
                                const value = context.parsed || 0;
                                const total = context.dataset.data.reduce((a, b) => a + b, 0);
                                const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                                return label + ': ' + value + ' (' + percentage + '%)';
                            }
                        }
                    },
                    datalabels: {
                        display: true,
                        color: '#fff',
                        font: { weight: 'bold', size: 14 },
                        formatter: function (value, context) {
                            if (value === 0) return '';
                            const total = context.dataset.data.reduce((a, b) => a + b, 0);
                            const percentage = total > 0 ? ((value / total) * 100).toFixed(0) : 0;
                            return value + '\n(' + percentage + '%)';
                        }
                    }
                }
            },
            plugins: [ChartDataLabels]
        });
    }

    // 3. Top Categories Chart (Horizontal Bar)
    const topCategories = Object.entries(categoryCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);

    const categoryCtx = document.getElementById('categoryChart');
    if (categoryCtx) {
        if (categoryChartInstance) categoryChartInstance.destroy();
        categoryChartInstance = new Chart(categoryCtx, {
            type: 'bar',
            data: {
                labels: topCategories.map(c => c[0]),
                datasets: [{
                    label: 'Bookings',
                    data: topCategories.map(c => c[1]),
                    backgroundColor: '#3b82f6',
                    borderRadius: 4
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: true,
                plugins: { legend: { display: false } },
                scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } } }
            }
        });
    }

    // Replace the static "a chart exists" aria-labels with the actual data
    // each render — a canvas is otherwise a black hole to a screen reader.
    statusCtx?.setAttribute('aria-label', 'Bookings by status: ' +
        Object.entries(statusCounts).map(([k, v]) => `${k} ${v}`).join(', '));
    instanceCtx?.setAttribute('aria-label',
        `Active bookings by instance: Food & Drink ${activeFood}, General/Non-Food ${activeNonFood}`);
    categoryCtx?.setAttribute('aria-label', 'Top categories among active bookings: ' +
        (topCategories.map(([name, count]) => `${name} ${count}`).join(', ') || 'none yet'));

    // 4. Revenue Progress Bars. 'Payment Requested' gets its own figure:
    // it used to be counted in NEITHER the confirmed nor the pending bar,
    // so a booking mid-Stripe-checkout — the money most likely to arrive —
    // silently vanished from the forecast and from Total Capacity.
    const confirmedRows = combinedData.filter(r => r.status === 'Confirmed');
    const pendingRows = combinedData.filter(r => r.status === 'Pending');
    const awaitingRows = combinedData.filter(r => r.status === 'Payment Requested');
    const confirmedRevenue = calculateRevenue(confirmedRows);
    const pendingRevenue = calculateRevenue(pendingRows);
    const awaitingRevenue = calculateRevenue(awaitingRows);
    const totalCapacity = confirmedRevenue + pendingRevenue + awaitingRevenue;

    setText('revenue-total', fmtGBP(confirmedRevenue));
    setText('revenue-potential', fmtGBP(pendingRevenue));
    setText('revenue-max', fmtGBP(totalCapacity));
    setText('revenue-confirmed', confirmedRows.length);
    setText('revenue-pending', pendingRows.length);

    // Hidden when nothing is mid-checkout, same convention as Refunded:
    // Payment Requested is a transient state and an always-there £0 row
    // would just be noise.
    setText('revenue-awaiting', fmtGBP(awaitingRevenue));
    setText('revenue-awaiting-count', awaitingRows.length);
    const awaitingWrap = document.getElementById('revenue-awaiting-wrap');
    if (awaitingWrap) awaitingWrap.classList.toggle('hidden', awaitingRows.length === 0);

    // Refunds are real money that went back out, not forecast — so unlike the
    // confirmed/pending bars above (FOOD+NONFOOD only), this counts every live
    // instance, matching the scope of the Payments page totals it must agree
    // with. Deliberately NOT netted out of the confirmed bar: a refunded
    // cancellation has status Cancelled and is already outside that forecast,
    // so netting would double-count the deduction.
    const refundedRows = allRows.filter(r =>
        r.instance_prefix !== PREFIX_DEV && getRefundAmount(r) > 0);
    const refundedTotal = refundedRows.reduce((sum, r) => sum + getRefundAmount(r), 0);
    setText('revenue-refunded', fmtGBP(refundedTotal));
    setText('revenue-refunded-count', refundedRows.length);
    const refundedWrap = document.getElementById('revenue-refunded-wrap');
    if (refundedWrap) refundedWrap.classList.toggle('hidden', refundedTotal === 0);

    const confirmedPercent = totalCapacity > 0 ? (confirmedRevenue / totalCapacity * 100) : 0;
    const pendingPercent = totalCapacity > 0 ? (pendingRevenue / totalCapacity * 100) : 0;
    const awaitingPercent = totalCapacity > 0 ? (awaitingRevenue / totalCapacity * 100) : 0;
    // Same scale as the other bars so lengths compare honestly. Capped:
    // refunds span all live instances while capacity is FOOD+NONFOOD only,
    // so exceeding 100% is possible in theory, if never in practice.
    const refundedPercent = totalCapacity > 0 ? Math.min(100, refundedTotal / totalCapacity * 100) : 0;

    setTimeout(() => {
        const revBar = document.getElementById('revenue-bar');
        const potBar = document.getElementById('potential-bar');
        const awaitBar = document.getElementById('awaiting-bar');
        const refBar = document.getElementById('refunded-bar');
        if (revBar) revBar.style.width = `${confirmedPercent}%`;
        if (potBar) potBar.style.width = `${pendingPercent}%`;
        if (awaitBar) awaitBar.style.width = `${awaitingPercent}%`;
        if (refBar) refBar.style.width = `${refundedPercent}%`;
    }, 100);
}

/**
 * Sums what a set of bookings is worth.
 *
 * This used to hardcode £50 food / £25 non-food, which silently ignored the
 * stall costs configured in Settings: changing a price there left this page
 * reporting the old one indefinitely, with nothing on screen to suggest the
 * figures had stopped matching what traders were actually being charged.
 *
 * Prefers the booking's OWN `stall_cost` - the amount genuinely agreed for
 * that booking, and the same field the Payments dashboard bills and
 * reconciles against, so the two pages can't disagree about a booking they
 * both know the price of. Falls back to the configured price for the
 * instance when a booking hasn't been priced yet: `stall_cost` is only set
 * when payment is requested, so Pending bookings legitimately have none and
 * the configured price is the right estimate for them.
 *
 * That split also means a price change in Settings moves the *potential*
 * revenue figure without retroactively rewriting what already-priced
 * bookings were agreed at, which is the behaviour you want from a forecast.
 *
 * Calling getStallCost() here is safe: initAdminPage awaits requireAuth,
 * which awaits loadStallCosts, before this page's callback ever runs.
 */
function calculateRevenue(bookings) {
    let total = 0;
    bookings.forEach(b => {
        // Charities aren't charged, whatever the booking or the settings say.
        const isCharity = b.is_charity === 'Charity' || b.is_charity === 'Not for profit';
        if (isCharity) return;

        const agreed = parseFloat(b.stall_cost);
        total += Number.isFinite(agreed) ? agreed : getStallCost(b.instance_prefix);
    });
    return total;
}

function renderPanel(containerId, data, title, headerClass, borderClass) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.classList.remove('hidden');
    container.innerHTML = '';

    // CALCULATE METRICS. Keys are the literal status strings from the
    // bookings_status_check constraint, same as renderCharts — no more
    // respelled variants ('HCCChecks') needing their own match branches.
    const statusCounts = { Pending: 0, 'Payment Requested': 0, Confirmed: 0, Rejected: 0, Cancelled: 0, 'HCC Checks': 0 };
    const conf = { rows: [], power: 0, charity: 0, resident: 0, cats: {} };
    const pend = { rows: [], power: 0, charity: 0, resident: 0, cats: {} };

    data.forEach(r => {
        const s = r.status || 'Pending';
        if (statusCounts.hasOwnProperty(s)) statusCounts[s]++;
        else statusCounts.Pending++;

        if (s === 'Confirmed') {
            conf.rows.push(r);
            if (checkBool(r.power_required)) conf.power++;
            if (checkBool(r.is_charity)) conf.charity++;
            if (checkBool(r.is_resident)) conf.resident++;
            tallyCategory(conf.cats, r.category);
        }
        else if (s === 'Pending') {
            pend.rows.push(r);
            if (checkBool(r.power_required)) pend.power++;
            if (checkBool(r.is_charity)) pend.charity++;
            if (checkBool(r.is_resident)) pend.resident++;
            tallyCategory(pend.cats, r.category);
        }
    });

    const html = `
        <div class="bg-white rounded-xl shadow-sm border ${borderClass} overflow-hidden mb-8">
            <div class="px-6 py-4 ${headerClass} flex justify-between items-center cursor-pointer select-none"
                data-action="toggle-panel" data-target="${containerId}-body" role="button" tabindex="0"
                aria-expanded="true" aria-controls="${containerId}-body">
                <h2 class="text-lg font-bold tracking-wide">${title}</h2>
                <div class="flex items-center gap-3">
                    <span class="bg-white/20 px-3 py-1 rounded text-xs font-mono font-medium text-white opacity-90">${data.length} Records</span>
                    <svg class="w-5 h-5 transition-transform duration-200 rotate-180 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                    </svg>
                </div>
            </div>
            <div class="p-6 space-y-8" id="${containerId}-body">
                <div>
                    <h3 class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">Booking Status Breakdown</h3>
                    <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                        ${statBox('Confirmed', statusCounts.Confirmed, 'text-green-800 bg-green-50 border-green-100')}
                        ${statBox('Pending', statusCounts.Pending, 'text-yellow-800 bg-yellow-50 border-yellow-100')}
                        ${statBox('Awaiting Payment', statusCounts['Payment Requested'], 'text-blue-800 bg-blue-50 border-blue-100')}
                        ${statBox('HCC Checks', statusCounts['HCC Checks'], 'text-orange-800 bg-orange-50 border-orange-100')}
                        ${statBox('Rejected', statusCounts.Rejected, 'text-red-800 bg-red-50 border-red-100')}
                        ${statBox('Cancelled', statusCounts.Cancelled, 'text-gray-600 bg-gray-100 border-gray-200')}
                    </div>
                </div>
                <hr class="border-gray-100">
                <div>
                    <div class="flex items-center mb-3">
                        <span class="w-2 h-2 rounded-full bg-green-600 mr-2"></span>
                        <h3 class="text-xs font-bold text-gray-400 uppercase tracking-wider">Confirmed Stalls Analysis</h3>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                        ${metricCard('Power Required', conf.power, '\u26A1', 'border-yellow-100 bg-yellow-50 text-yellow-900')}
                        ${metricCard('Charity / Community', conf.charity, '\u2764', 'border-red-100 bg-red-50 text-red-900')}
                        ${metricCard('Residents', conf.resident, '\uD83C\uDFE0', 'border-blue-100 bg-blue-50 text-blue-900')}
                    </div>
                </div>
                <div>
                     <div class="flex items-center mb-3">
                        <span class="w-2 h-2 rounded-full bg-yellow-500 mr-2"></span>
                        <h3 class="text-xs font-bold text-gray-400 uppercase tracking-wider">Pending Stalls Analysis</h3>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                        ${metricCard('Power Requested', pend.power, '\u26A1', 'border-gray-100 bg-gray-50 text-gray-600 opacity-90')}
                        ${metricCard('Charity Apps', pend.charity, '\u2764', 'border-gray-100 bg-gray-50 text-gray-600 opacity-90')}
                        ${metricCard('Resident Apps', pend.resident, '\uD83C\uDFE0', 'border-gray-100 bg-gray-50 text-gray-600 opacity-90')}
                    </div>
                </div>
                <hr class="border-gray-100">
                <div>
                    <h3 class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">Category Breakdown</h3>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div class="bg-yellow-50 rounded-lg p-4 border border-yellow-100">
                            <h4 class="font-bold text-yellow-900 text-sm mb-3 flex justify-between">
                                <span>Pending Categories</span>
                                <span class="text-xs opacity-75">${pend.rows.length} Stalls</span>
                            </h4>
                            <div class="space-y-2">
                                ${renderCategoryList(pend.cats, pend.rows.length, 'bg-yellow-200')}
                            </div>
                        </div>
                        <div class="bg-green-50 rounded-lg p-4 border border-green-100">
                            <h4 class="font-bold text-green-900 text-sm mb-3 flex justify-between">
                                <span>Confirmed Categories</span>
                                <span class="text-xs opacity-75">${conf.rows.length} Stalls</span>
                            </h4>
                            <div class="space-y-2">
                                ${renderCategoryList(conf.cats, conf.rows.length, 'bg-green-200')}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    container.innerHTML = html;
}

// Helpers

// One format for every money figure on the page. Always pence: partial
// refunds make whole-pound rounding lossy, and mixing £425 with £275.00
// in the same card looked accidental.
function fmtGBP(n) {
    return `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * A booking that still exists as far as festival planning is concerned.
 * Cancelled/Rejected rows are kept in the status breakdowns (that's what
 * those exist to show) but excluded from operational tallies — power,
 * residents, categories, the Food-vs-General split.
 */
function isActiveBooking(r) {
    return r.status !== 'Cancelled' && r.status !== 'Rejected';
}

/**
 * Reads the embedded payments refund off a stats row. The one-to-one embed
 * normally arrives as an object (payments' PK is booking_id), but PostgREST
 * returns an array if it ever fails to detect the o2o relationship, so both
 * shapes are tolerated rather than trusting the server version.
 */
function getRefundAmount(r) {
    const p = Array.isArray(r.payments) ? r.payments[0] : r.payments;
    const amt = parseFloat(p?.refund_amount);
    return Number.isFinite(amt) ? amt : 0;
}

function checkBool(val) {
    if (val === true || val === 'true' || val === 'Yes' || val === 'yes') return true;
    if (typeof val === 'string') {
        const lower = val.toLowerCase();
        // Strict match for power requirement as requested: only festival-
        // supplied electricity counts (generator/gas self-supply doesn't).
        // Both spellings are load-bearing - PR #89 (v7.12.0) fixed the
        // form's "organisors" typo, but bookings stored before that fix
        // keep the old spelling and were never migrated.
        if (val === "Electricity supplied by fest organisors" ||
            val === "Electricity supplied by fest organisers") return true;
        // Keep lax match for legacy/charity fields
        if (lower.includes('charity') || lower.includes('not for profit')) return true;
    }
    return false;
}

function tallyCategory(map, cat) {
    const c = escapeHtml(cat) || 'Uncategorized';
    map[c] = (map[c] || 0) + 1;
}

function statBox(label, count, colorClasses) {
    return `
        <div class="p-3 rounded-lg border text-center stat-card ${colorClasses}">
            <div class="text-2xl font-bold">${count}</div>
            <div class="text-[10px] uppercase font-bold opacity-70 mt-1">${label}</div>
        </div>
    `;
}

function metricCard(label, count, icon, classes) {
    return `
        <div class="flex items-center justify-between p-3 rounded-lg border ${classes}">
            <div class="flex items-center">
                <span class="text-sm font-bold opacity-90">${label}</span>
            </div>
            <span class="text-xl font-bold">${count}</span>
        </div>
    `;
}

function renderCategoryList(catMap, total, barColorClass) {
    if (total === 0) return '<div class="text-xs text-gray-400 italic">No data</div>';

    const sorted = Object.entries(catMap).sort((a, b) => b[1] - a[1]);

    return sorted.map(([name, count]) => {
        const pct = Math.round((count / total) * 100);
        return `
            <div class="flex items-center text-xs">
                <div class="w-24 truncate font-medium text-gray-600" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
                <div class="flex-grow mx-2 bg-white rounded-full h-2 overflow-hidden border border-white/50">
                    <div class="h-full ${barColorClass} opacity-80" style="width: ${pct}%"></div>
                </div>
                <div class="w-8 text-right font-bold text-gray-700">${count}</div>
            </div>
        `;
    }).join('');
}


function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}
