/**
 * Equilibria Swap Tracker - Frontend Application
 * Client-side logic for transparency dashboard
 */

// ============================================
// STATE & CONFIG
// ============================================

const state = {
    currentPage: 'dashboard',
    status: null,
    stats: null,
    transactions: [],
    pagination: { page: 1, limit: 25, total: 0, totalPages: 0 },
    participantData: null,
    txData: null,
    wsConnected: false,
    apiOnline: false,
    lastUpdate: null
};

const API_BASE = '';  // Same origin
const REFRESH_INTERVAL = 60000;  // 60 seconds for auto-refresh
const HEALTH_CHECK_INTERVAL = 15000;  // 15 seconds for health ping
let refreshTimer = null;
let healthTimer = null;
let ws = null;

// Status color map
const STATUS_COLORS = {
    VERIFIED: '#00ff88',
    PAID: '#00d4ff',
    PENDING: '#ffaa00',
    REJECTED: '#ff4757',
    EXPIRED: '#ff4757'
};

// ============================================
// INITIALIZATION
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    // Handle initial route
    handleRoute();

    // Listen for browser navigation
    window.addEventListener('popstate', handleRoute);

    // Start auto-refresh
    startAutoRefresh();

    // Start health check ping
    startHealthCheck();

    // Update "Last Update" display every 30 seconds
    setInterval(updateLastUpdateDisplay, 30000);

    // Try WebSocket connection
    connectWebSocket();

    // Restore sidebar state
    const isCollapsed = localStorage.getItem('xeq_sidebar_collapsed') === 'true';
    if (isCollapsed) {
        document.getElementById('sidebar').classList.add('collapsed');
    }
});

// ============================================
// ROUTING
// ============================================

function handleRoute() {
    const path = window.location.pathname;

    if (path === '/' || path === '') {
        navigateTo('dashboard', false);
    } else if (path === '/ledger') {
        navigateTo('ledger', false);
    } else if (path.startsWith('/participant/')) {
        const address = path.split('/participant/')[1];
        loadParticipant(address);
    } else if (path.startsWith('/tx/')) {
        const txid = path.split('/tx/')[1];
        loadTransaction(txid);
    } else {
        navigateTo('dashboard', false);
    }
}

function navigateTo(page, pushState = true) {
    // Update state
    state.currentPage = page;

    // Update URL
    if (pushState) {
        const url = page === 'dashboard' ? '/' : `/${page}`;
        history.pushState({ page }, '', url);
    }

    // Update nav
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.page === page);
    });

    // Show correct page
    document.querySelectorAll('.page-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(`page-${page}`).classList.add('active');

    // Load page data
    if (page === 'dashboard') {
        loadDashboard();
    } else if (page === 'ledger') {
        loadTransactions();
    }
}

// ============================================
// API CALLS
// ============================================

async function fetchAPI(endpoint) {
    try {
        const response = await fetch(`${API_BASE}${endpoint}`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        setApiStatus(true);
        return data;
    } catch (err) {
        setApiStatus(false);
        return null;
    }
}

function setApiStatus(online) {
    state.apiOnline = online;
    const indicator = document.getElementById('liveIndicator');

    if (online) {
        indicator.className = 'live-indicator online';
        indicator.innerHTML = '<span class="live-dot"></span><span class="status-text">ONLINE</span>';
        // Update last update time on successful connection
        document.getElementById('lastUpdate').textContent = 'Just now';
        state.lastUpdate = new Date();
    } else {
        indicator.className = 'live-indicator offline';
        indicator.innerHTML = '<span class="live-dot"></span><span class="status-text">OFFLINE</span>';
    }
}

// Health check ping - runs every 15 seconds
async function healthCheck() {
    try {
        const response = await fetch(`${API_BASE}/api/health`);
        if (response.ok) {
            setApiStatus(true);
        } else {
            setApiStatus(false);
        }
    } catch (err) {
        setApiStatus(false);
    }
}

function startHealthCheck() {
    // Initial check
    healthCheck();
    // Then check every 15 seconds
    healthTimer = setInterval(healthCheck, HEALTH_CHECK_INTERVAL);
}

// Update the "Last Update" display with relative time
function updateLastUpdateDisplay() {
    if (!state.lastUpdate) return;

    const now = new Date();
    const diff = now - state.lastUpdate;

    if (diff < 60000) {
        document.getElementById('lastUpdate').textContent = 'Just now';
    } else if (diff < 3600000) {
        const mins = Math.floor(diff / 60000);
        document.getElementById('lastUpdate').textContent = `${mins}m ago`;
    } else {
        const hours = Math.floor(diff / 3600000);
        document.getElementById('lastUpdate').textContent = `${hours}h ago`;
    }
}

// ============================================
// DASHBOARD
// ============================================

async function loadDashboard() {
    // Load status and stats in parallel
    const [status, stats] = await Promise.all([
        fetchAPI('/api/status'),
        fetchAPI('/api/stats')
    ]);

    if (status) {
        state.status = status;
        renderStatus(status);
    }

    if (stats) {
        state.stats = stats;
        renderStats(stats);
        renderHoldersChart(stats.holdersDistribution);
        renderTopContributors(stats.topContributors);
    }
}

function renderStatus(status) {
    if (!status) return;

    const badge = document.getElementById('statusBadge');
    const dot = document.getElementById('statusDot');

    // Update badge
    const swapStatus = status.swapStatus || 'LOADING';
    badge.className = 'status-badge ' + swapStatus.toLowerCase();
    badge.querySelector('.status-text').textContent = swapStatus.replace('_', ' ');

    // Update status dot
    dot.className = 'network-status-dot';
    if (swapStatus === 'OPEN') {
        // green (default)
    } else if (swapStatus === 'NOT_STARTED') {
        dot.classList.add('warning');
    } else {
        dot.classList.add('closed');
    }

    // Update details
    document.getElementById('windowStartBlock').textContent = formatNumber(status.startHeight);
    document.getElementById('snapshotBlock').textContent = formatNumber(status.snapshotBlockHeight);
    document.getElementById('currentHeight').textContent = formatNumber(status.currentHeight);
    document.getElementById('blocksRemaining').textContent = status.blocksRemaining > 0
        ? formatNumber(status.blocksRemaining)
        : 'N/A';

    // Estimated time remaining (assuming ~2 min per block)
    if (status.blocksRemaining > 0) {
        const minutes = status.blocksRemaining * 2;
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        if (days > 0) {
            document.getElementById('timeRemaining').textContent = `~${days}d ${hours % 24}h`;
        } else if (hours > 0) {
            document.getElementById('timeRemaining').textContent = `~${hours}h ${minutes % 60}m`;
        } else {
            document.getElementById('timeRemaining').textContent = `~${minutes}m`;
        }
    } else {
        document.getElementById('timeRemaining').textContent = 'Ended';
    }

    // Deposit address
    if (status.depositAddress) {
        document.getElementById('depositAddress').textContent = status.depositAddress;
        document.getElementById('depositBanner').style.display = 'flex';
    } else {
        document.getElementById('depositBanner').style.display = 'none';
    }

    // Sidebar stats
    document.getElementById('sidebarHeight').textContent = formatNumber(status.currentHeight);
    // Format swap status as "Swap Open", "Swap Closed", etc.
    const swapStatusText = status.swapStatus === 'OPEN' ? 'Swap Open' :
                           status.swapStatus === 'CLOSED' ? 'Swap Closed' :
                           status.swapStatus === 'NOT_STARTED' ? 'Swap Not Started' : 'Swap Status Unknown';
    document.getElementById('swapStatus').textContent = swapStatusText;
    document.getElementById('networkLabel').textContent = status.network || 'testnet';

    // Show snapshot panel if finalized
    const snapshotPanel = document.getElementById('snapshotPanel');
    if (status.ledgerFinalized) {
        snapshotPanel.style.display = 'block';
        document.getElementById('ledgerHash').textContent = status.ledgerHash || '--';
        document.getElementById('windowStart').textContent = formatNumber(status.startHeight);
        document.getElementById('windowEnd').textContent = formatNumber(status.endHeight);
        document.getElementById('payoutsEnabled').textContent = status.payoutEnabled ? 'Yes' : 'No';
    } else {
        snapshotPanel.style.display = 'none';
    }
}

function renderStats(stats) {
    document.getElementById('totalVerifiedXEQ').textContent = formatXEQ(stats.totalVerifiedXEQ);
    document.getElementById('totalVerifiedCount').textContent = `${formatNumber(stats.totalVerifiedCount)} transactions`;

    document.getElementById('totalPaidXEQ').textContent = formatXEQ(stats.totalPaidXEQ);
    document.getElementById('totalPaidCount').textContent = `${formatNumber(stats.totalPaidCount)} transactions`;

    document.getElementById('uniqueContributors').textContent = formatNumber(stats.uniqueContributors);

    // Total submissions
    const totalSwaps = stats.totalVerifiedCount + stats.totalPaidCount + stats.pendingCount + stats.rejectedCount;
    document.getElementById('totalSubmissions').textContent = formatNumber(totalSwaps);

    // Sidebar
    document.getElementById('sidebarSwaps').textContent = formatNumber(totalSwaps);
}

// Color palette for holders chart - visually distinct colors
const HOLDER_COLORS = [
    '#00d4ff', // Cyan (primary)
    '#00ff88', // Green
    '#ff6b9d', // Pink
    '#ffa726', // Orange
    '#ab47bc', // Purple
    '#42a5f5', // Blue
    '#26c6da', // Teal
    '#d4e157', // Lime
    '#ff7043', // Deep Orange
    '#8d6e63', // Brown
    '#78909c', // Blue Grey
    '#5c6bc0', // Indigo
];

function renderHoldersChart(holders) {
    const svg = document.getElementById('holdersDonut');
    const legend = document.getElementById('holdersLegend');

    if (!holders || holders.length === 0) {
        document.getElementById('donutTotal').textContent = '0';
        legend.innerHTML = '<div class="legend-row"><span class="legend-label">No holders yet</span></div>';
        return;
    }

    // Total number of wallets
    const totalWallets = holders.reduce((sum, h) => {
        return sum + (h.isOthers ? h.txCount : 1);
    }, 0);
    document.getElementById('donutTotal').textContent = formatNumber(totalWallets);

    // Clear existing segments
    svg.querySelectorAll('.donut-segment').forEach(s => s.remove());

    const circumference = 2 * Math.PI * 60;
    let offset = 0;
    let legendHTML = '';

    // Limit legend to top entries + others to keep it readable
    const MAX_LEGEND_ENTRIES = 8;
    let displayedHolders = holders;

    // If we have many holders, consolidate smaller ones for the legend
    if (holders.length > MAX_LEGEND_ENTRIES) {
        const topHolders = holders.slice(0, MAX_LEGEND_ENTRIES - 1);
        const remainingHolders = holders.slice(MAX_LEGEND_ENTRIES - 1);

        // Check if last item is already "others"
        const hasOthers = remainingHolders.some(h => h.isOthers);

        if (remainingHolders.length > 0) {
            const othersTotal = remainingHolders.reduce((sum, h) => sum + parseFloat(h.totalXEQ), 0);
            const othersPct = remainingHolders.reduce((sum, h) => sum + parseFloat(h.percentage), 0);
            const othersWallets = remainingHolders.reduce((sum, h) => sum + (h.isOthers ? h.txCount : 1), 0);

            displayedHolders = [
                ...topHolders,
                {
                    address: 'others',
                    label: `Others (${othersWallets} wallets)`,
                    totalXEQ: othersTotal.toFixed(4),
                    percentage: othersPct.toFixed(2),
                    isOthers: true
                }
            ];
        }
    }

    displayedHolders.forEach((holder, index) => {
        const pct = parseFloat(holder.percentage) / 100;
        if (pct <= 0) return;

        const dash = pct * circumference;
        const color = holder.isOthers ? '#6b7280' : HOLDER_COLORS[index % HOLDER_COLORS.length];

        // Create segment
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.classList.add('donut-segment');
        circle.setAttribute('cx', '80');
        circle.setAttribute('cy', '80');
        circle.setAttribute('r', '60');
        circle.setAttribute('stroke', color);
        circle.setAttribute('stroke-dasharray', `${dash} ${circumference - dash}`);
        circle.setAttribute('stroke-dashoffset', -offset);

        // Add hover effect data
        circle.setAttribute('data-address', holder.address);
        circle.setAttribute('data-amount', holder.totalXEQ);
        circle.setAttribute('data-pct', holder.percentage);

        svg.appendChild(circle);
        offset += dash;

        // Legend row
        const displayLabel = holder.isOthers
            ? holder.label
            : maskAddress(holder.address);

        const clickHandler = holder.isOthers
            ? ''
            : `onclick="loadParticipant('${holder.address}')" style="cursor: pointer;"`;

        legendHTML += `
            <div class="legend-row" ${clickHandler}>
                <span class="legend-color" style="background: ${color}"></span>
                <span class="legend-label">${displayLabel}</span>
                <span class="legend-value">${formatXEQ(holder.totalXEQ)}</span>
                <span class="legend-pct">${holder.percentage}%</span>
            </div>
        `;
    });

    legend.innerHTML = legendHTML;
}

function renderTopContributors(contributors) {
    const container = document.getElementById('topContributors');

    if (!contributors || contributors.length === 0) {
        container.innerHTML = '<div class="table-empty"><p>No contributors yet</p></div>';
        return;
    }

    container.innerHTML = contributors.map((c, i) => {
        let rankClass = '';
        if (i === 0) rankClass = 'gold';
        else if (i === 1) rankClass = 'silver';
        else if (i === 2) rankClass = 'bronze';

        return `
            <div class="contributor-row" onclick="loadParticipant('${c.address}')">
                <span class="contributor-rank ${rankClass}">${i + 1}</span>
                <span class="contributor-address">${maskAddress(c.address)}</span>
                <span class="contributor-amount">${formatXEQ(c.totalXEQ)} XEQ</span>
                <span class="contributor-txcount">${c.txCount} tx</span>
            </div>
        `;
    }).join('');
}

// ============================================
// TRANSACTION LEDGER
// ============================================

async function loadTransactions() {
    const status = document.getElementById('statusFilter').value;
    const sort = document.getElementById('sortFilter').value;
    const address = document.getElementById('addressFilter').value.trim();

    const params = new URLSearchParams({
        page: state.pagination.page,
        limit: state.pagination.limit,
        status,
        sort,
        order: 'desc'
    });

    if (address) params.set('address', address);

    const data = await fetchAPI(`/api/txs?${params}`);

    if (data) {
        state.transactions = data.transactions;
        state.pagination = data.pagination;
        renderTransactions(data.transactions);
        renderPagination(data.pagination);
    }
}

function renderTransactions(txs) {
    const tbody = document.getElementById('ledgerBody');
    const empty = document.getElementById('ledgerEmpty');

    if (!txs || txs.length === 0) {
        tbody.innerHTML = '';
        empty.style.display = 'flex';
        return;
    }

    empty.style.display = 'none';

    tbody.innerHTML = txs.map(tx => {
        const payoutXEQ = tx.newAmountXEQ && parseFloat(tx.newAmountXEQ) > 0
            ? formatXEQ(tx.newAmountXEQ)
            : '--';
        return `
        <tr onclick="loadTransaction('${tx.txid}')" style="cursor: pointer;">
            <td class="mono hash" title="${tx.txid}">${tx.txid.slice(0, 8)}...${tx.txid.slice(-8)}</td>
            <td class="amount">${formatXEQ(tx.amountXEQ)}</td>
            <td class="amount">${payoutXEQ}</td>
            <td><span class="badge ${tx.status.toLowerCase()}">${tx.status}</span></td>
            <td class="mono">${tx.confirmations || '--'}</td>
            <td class="mono">${tx.height ? formatNumber(tx.height) : '--'}</td>
            <td class="mono hash" title="${tx.newAddress}">${maskAddress(tx.newAddress)}</td>
            <td>${formatTime(tx.createdAt)}</td>
        </tr>
    `}).join('');
}

function renderPagination(pagination) {
    const container = document.getElementById('pagination');
    const { page, totalPages } = pagination;

    if (totalPages <= 1) {
        container.innerHTML = '';
        return;
    }

    let html = '';

    // Previous button
    html += `<button class="pagination-btn" ${page <= 1 ? 'disabled' : ''} onclick="goToPage(${page - 1})">Prev</button>`;

    // Page numbers
    const range = 2;
    const start = Math.max(1, page - range);
    const end = Math.min(totalPages, page + range);

    if (start > 1) {
        html += `<button class="pagination-btn" onclick="goToPage(1)">1</button>`;
        if (start > 2) html += `<span style="color: var(--text-muted)">...</span>`;
    }

    for (let i = start; i <= end; i++) {
        html += `<button class="pagination-btn ${i === page ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`;
    }

    if (end < totalPages) {
        if (end < totalPages - 1) html += `<span style="color: var(--text-muted)">...</span>`;
        html += `<button class="pagination-btn" onclick="goToPage(${totalPages})">${totalPages}</button>`;
    }

    // Next button
    html += `<button class="pagination-btn" ${page >= totalPages ? 'disabled' : ''} onclick="goToPage(${page + 1})">Next</button>`;

    container.innerHTML = html;
}

function filterTransactions() {
    state.pagination.page = 1;
    loadTransactions();
}

function goToPage(page) {
    state.pagination.page = page;
    loadTransactions();
}

// ============================================
// PARTICIPANT PAGE
// ============================================

async function loadParticipant(address) {
    // Update URL
    history.pushState({ page: 'participant', address }, '', `/participant/${address}`);

    // Show page
    document.querySelectorAll('.page-content').forEach(c => c.classList.remove('active'));
    document.getElementById('page-participant').classList.add('active');

    // Update nav
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));

    // Load data
    const data = await fetchAPI(`/api/address/${encodeURIComponent(address)}`);

    if (!data) {
        document.getElementById('participantAddress').textContent = 'Not found';
        return;
    }

    state.participantData = data;

    // Render
    document.getElementById('participantAddress').textContent = address;
    document.getElementById('participantTotal').textContent = `${formatXEQ(data.verifiedTotalXEQ)} XEQ`;
    document.getElementById('participantTxCount').textContent = `${data.verifiedCount} verified transactions`;
    document.getElementById('participantFirstSeen').textContent = formatTime(data.firstSeen);
    document.getElementById('participantLastSeen').textContent = formatTime(data.lastSeen);

    // Render transactions
    const tbody = document.getElementById('participantTxBody');
    tbody.innerHTML = data.transactions.map(tx => `
        <tr onclick="loadTransaction('${tx.txid}')" style="cursor: pointer;">
            <td class="mono hash" title="${tx.txid}">${tx.txid.slice(0, 8)}...${tx.txid.slice(-8)}</td>
            <td class="amount">${formatXEQ(tx.newAmountXEQ || tx.amountXEQ)}</td>
            <td><span class="badge ${tx.status.toLowerCase()}">${tx.status}</span></td>
            <td class="mono">${tx.height ? formatNumber(tx.height) : '--'}</td>
            <td>${formatTime(tx.createdAt)}</td>
        </tr>
    `).join('');
}

function shareParticipant() {
    const url = window.location.href;
    copyToClipboard(url);
    showToast('Link copied to clipboard!');
}

// ============================================
// TRANSACTION DETAIL PAGE
// ============================================

async function loadTransaction(txid) {
    // Update URL
    history.pushState({ page: 'tx', txid }, '', `/tx/${txid}`);

    // Show page
    document.querySelectorAll('.page-content').forEach(c => c.classList.remove('active'));
    document.getElementById('page-tx').classList.add('active');

    // Update nav
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));

    // Load data
    const data = await fetchAPI(`/api/tx/${txid}`);

    if (!data) {
        document.getElementById('txDetails').innerHTML = '<div class="table-empty"><h3>Transaction not found</h3></div>';
        return;
    }

    state.txData = data;

    // Update badge
    const badge = document.getElementById('txStatusBadge');
    badge.className = 'panel-badge ' + (data.status === 'VERIFIED' || data.status === 'PAID' ? 'success' : data.status.toLowerCase());
    badge.textContent = data.status;

    // Derive proof validity from status - if VERIFIED or PAID, proof was valid
    const isProofValid = data.proofValid || data.status === 'VERIFIED' || data.status === 'PAID';

    // Use newAmountXEQ as the swap amount (this is the actual amount being swapped)
    const displayAmount = data.newAmountXEQ || data.amountXEQ;

    // Render details
    const details = document.getElementById('txDetails');
    details.innerHTML = `
        <div class="tx-row">
            <span class="tx-label">Transaction ID</span>
            <span class="tx-value accent">${data.txid}</span>
            <button class="copy-btn" onclick="copyToClipboard('${data.txid}')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
            </button>
        </div>
        <div class="tx-row">
            <span class="tx-label">Amount</span>
            <span class="tx-value accent">${formatXEQ(displayAmount)} XEQ</span>
        </div>
        <div class="tx-row">
            <span class="tx-label">Status</span>
            <span class="tx-value"><span class="badge ${data.status.toLowerCase()}">${data.status}</span></span>
        </div>
        <div class="tx-row">
            <span class="tx-label">Proof Valid</span>
            <span class="tx-value">${isProofValid ? '<span class="badge success">Yes</span>' : '<span class="badge danger">No</span>'}</span>
        </div>
        <div class="tx-row">
            <span class="tx-label">Confirmations</span>
            <span class="tx-value">${data.confirmations || '--'}</span>
        </div>
        <div class="tx-row">
            <span class="tx-label">Block Height</span>
            <span class="tx-value">${data.height ? formatNumber(data.height) : '--'}</span>
        </div>
        <div class="tx-row">
            <span class="tx-label">Destination Address</span>
            <span class="tx-value">${data.newAddress || '--'}</span>
            ${data.newAddress ? `<button class="copy-btn" onclick="copyToClipboard('${data.newAddress}')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
            </button>` : ''}
        </div>
        ${data.newTxid ? `
        <div class="tx-row">
            <span class="tx-label">Payout TXID</span>
            <span class="tx-value accent">${data.newTxid}</span>
            <button class="copy-btn" onclick="copyToClipboard('${data.newTxid}')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
            </button>
        </div>
        ` : ''}
        ${data.status === 'PAID' && data.newAmountXEQ ? `
        <div class="tx-row">
            <span class="tx-label">Payout Amount</span>
            <span class="tx-value accent">${formatXEQ(data.newAmountXEQ)} XEQ</span>
        </div>
        ` : ''}
        ${data.error ? `
        <div class="tx-row">
            <span class="tx-label">Error</span>
            <span class="tx-value error">${data.error}</span>
        </div>
        ` : ''}
        <div class="tx-row">
            <span class="tx-label">Double Spend</span>
            <span class="tx-value">${data.doubleSpendSeen ? '<span class="badge danger">Detected</span>' : '<span class="badge success">None</span>'}</span>
        </div>
        <div class="tx-row">
            <span class="tx-label">Submitted</span>
            <span class="tx-value">${formatTime(data.createdAt)}</span>
        </div>
        <div class="tx-row">
            <span class="tx-label">Last Updated</span>
            <span class="tx-value">${formatTime(data.updatedAt)}</span>
        </div>
    `;
}

// ============================================
// SEARCH
// ============================================

async function handleSearchKeypress(event) {
    if (event.key === 'Enter') {
        const query = document.getElementById('searchInput').value.trim();
        if (query.length < 6) {
            showToast('Search query too short');
            return;
        }

        const result = await fetchAPI(`/api/search?q=${encodeURIComponent(query)}`);

        if (!result) {
            showToast('Search failed');
            return;
        }

        if (result.type === 'txid') {
            loadTransaction(result.result);
        } else if (result.type === 'addresses' && result.results.length > 0) {
            loadParticipant(result.results[0]);
        } else {
            showToast('No results found');
        }
    }
}

// ============================================
// EXPORTS
// ============================================

function downloadExport(format) {
    window.location.href = `${API_BASE}/api/export/current?format=${format}`;
}

// ============================================
// WEBSOCKET
// ============================================

function connectWebSocket() {
    // WebSocket is optional - don't retry aggressively if it fails
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    try {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            state.wsConnected = true;
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'stats_update') {
                    state.stats = msg.data;
                    if (state.currentPage === 'dashboard') {
                        renderStats(msg.data);
                        renderHoldersChart(msg.data.holdersDistribution);
                        renderTopContributors(msg.data.topContributors);
                    }
                    setApiStatus(true); // Update status on WebSocket message
                }
            } catch (err) {
                // Silently ignore malformed messages
            }
        };

        ws.onclose = () => {
            state.wsConnected = false;
            // Don't aggressively reconnect - polling fallback will handle updates
        };

        ws.onerror = () => {
            // Silently fail - WebSocket is optional, polling works as fallback
            ws.close();
        };
    } catch (err) {
        // WebSocket not available, that's fine
    }
}

// ============================================
// AUTO-REFRESH
// ============================================

function startAutoRefresh() {
    refreshTimer = setInterval(() => {
        if (!state.wsConnected) {
            // Fallback to polling if WebSocket not connected
            if (state.currentPage === 'dashboard') {
                loadDashboard();
            } else if (state.currentPage === 'ledger') {
                loadTransactions();
            }
        }
    }, REFRESH_INTERVAL);
}

// ============================================
// SIDEBAR
// ============================================

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.querySelector('.sidebar-overlay');

    // On mobile, toggle open class
    if (window.innerWidth <= 1024) {
        sidebar.classList.toggle('open');
        overlay.classList.toggle('show');
    } else {
        // On desktop, toggle collapsed class
        sidebar.classList.toggle('collapsed');
        localStorage.setItem('xeq_sidebar_collapsed', sidebar.classList.contains('collapsed'));
    }
}

// ============================================
// UTILITIES
// ============================================

function formatNumber(num) {
    if (num === null || num === undefined) return '--';
    return Number(num).toLocaleString();
}

function formatXEQ(amount) {
    if (amount === null || amount === undefined) return '--';
    const num = parseFloat(amount);
    if (isNaN(num)) return '--';
    return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function formatTime(timestamp) {
    if (!timestamp) return '--';
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return '--';

    const now = new Date();
    const diff = now - date;

    // Less than 1 minute
    if (diff < 60000) {
        return 'Just now';
    }
    // Less than 1 hour
    if (diff < 3600000) {
        const mins = Math.floor(diff / 60000);
        return `${mins}m ago`;
    }
    // Less than 24 hours
    if (diff < 86400000) {
        const hours = Math.floor(diff / 3600000);
        return `${hours}h ago`;
    }
    // Show date
    return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function maskAddress(address) {
    if (!address) return '--';
    if (address.length <= 16) return address;
    return `${address.slice(0, 8)}...${address.slice(-8)}`;
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showToast('Copied to clipboard!');
    }).catch(() => {
        showToast('Copy failed');
    });
}

function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}
