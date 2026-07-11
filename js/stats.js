import { fetchStatsData } from './api.js';
import { showToast } from './ui.js';
import { escapeHtml } from './utils.js';

// Constants for Prefixes
const PREFIX_FOOD = 'ESF26-FOOD-';
const PREFIX_NONFOOD = 'ESF26-NONFOOD-';
const PREFIX_DEV = 'ESF26-DEV-';

let statusChartInstance = null;
let instanceChartInstance = null;
let categoryChartInstance = null;

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

    // Calculate stats
    const statusCounts = {
        Confirmed: 0,
        Pending: 0,
        'On Hold': 0,
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
        } else if (s === 'HCC Checks') {
            statusCounts['HCC Checks']++;
        } else if (s === 'On Hold') {
            statusCounts['On Hold']++;
        } else {
            statusCounts.Pending++;
        }

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
                        '#6366f1', // On Hold - indigo
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

    // 2. Food vs General Chart (Pie)
    const instanceCtx = document.getElementById('instanceChart');
    if (instanceCtx) {
        if (instanceChartInstance) instanceChartInstance.destroy();
        instanceChartInstance = new Chart(instanceCtx, {
            type: 'pie',
            data: {
                labels: ['Food & Drink', 'General/Non-Food'],
                datasets: [{
                    data: [foodData.length, nonFoodData.length],
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

    // 4. Revenue Progress Bars
    const confirmedRevenue = calculateRevenue(combinedData.filter(r => r.status === 'Confirmed'));
    const pendingRevenue = calculateRevenue(combinedData.filter(r => r.status === 'Pending'));
    const totalCapacity = confirmedRevenue + pendingRevenue;

    setText('revenue-total', `£${confirmedRevenue.toLocaleString()}`);
    setText('revenue-potential', `£${pendingRevenue.toLocaleString()}`);
    setText('revenue-max', `£${totalCapacity.toLocaleString()}`);
    setText('revenue-confirmed', combinedData.filter(r => r.status === 'Confirmed').length);
    setText('revenue-pending', combinedData.filter(r => r.status === 'Pending').length);

    const confirmedPercent = totalCapacity > 0 ? (confirmedRevenue / totalCapacity * 100) : 0;
    const pendingPercent = totalCapacity > 0 ? (pendingRevenue / totalCapacity * 100) : 0;

    setTimeout(() => {
        const revBar = document.getElementById('revenue-bar');
        const potBar = document.getElementById('potential-bar');
        if (revBar) revBar.style.width = `${confirmedPercent}%`;
        if (potBar) potBar.style.width = `${pendingPercent}%`;
    }, 100);
}

function calculateRevenue(bookings) {
    let total = 0;
    bookings.forEach(b => {
        let cost = 0;
        if (b.instance_prefix === PREFIX_FOOD) {
            cost = 50;
        } else if (b.instance_prefix === PREFIX_NONFOOD) {
            cost = 25;
        }

        const isCharity = b.is_charity === 'Charity' || b.is_charity === 'Not for profit';
        if (!isCharity) {
            total += cost;
        }
    });
    return total;
}

function renderPanel(containerId, data, title, headerClass, borderClass) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.classList.remove('hidden');
    container.innerHTML = '';

    // CALCULATE METRICS
    const statusCounts = { Pending: 0, Confirmed: 0, Rejected: 0, Cancelled: 0, OnHold: 0, HCCChecks: 0 };
    const conf = { rows: [], power: 0, charity: 0, resident: 0, cats: {} };
    const pend = { rows: [], power: 0, charity: 0, resident: 0, cats: {} };

    data.forEach(r => {
        const s = r.status || 'Pending';
        if (s === 'On Hold') statusCounts.OnHold++;
        else if (s === 'HCC Checks') statusCounts.HCCChecks++;
        else if (statusCounts.hasOwnProperty(s)) statusCounts[s]++;
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
            <div class="px-6 py-4 ${headerClass} flex justify-between items-center">
                <h2 class="text-lg font-bold tracking-wide">${title}</h2>
                <span class="bg-white bg-opacity-20 px-3 py-1 rounded text-xs font-mono font-medium text-white opacity-90">${data.length} Records</span>
            </div>
            <div class="p-6 space-y-8">
                <div>
                    <h3 class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">Booking Status Breakdown</h3>
                    <div class="grid grid-cols-2 md:grid-cols-6 gap-4">
                        ${statBox('Confirmed', statusCounts.Confirmed, 'text-green-800 bg-green-50 border-green-100')}
                        ${statBox('Pending', statusCounts.Pending, 'text-yellow-800 bg-yellow-50 border-yellow-100')}
                        ${statBox('On Hold', statusCounts.OnHold, 'text-indigo-800 bg-indigo-50 border-indigo-100')}
                        ${statBox('HCC Checks', statusCounts.HCCChecks, 'text-orange-800 bg-orange-50 border-orange-100')}
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
function checkBool(val) {
    if (val === true || val === 'true' || val === 'Yes' || val === 'yes') return true;
    if (typeof val === 'string') {
        const lower = val.toLowerCase();
        // Strict match for power requirement as requested
        if (val === "Electricity supplied by fest organisors") return true;
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
