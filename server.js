/**
 * Equilibria Horizon Swap Transparency Tracker
 * Read-only API server for community transparency dashboard
 *
 * Reads from the Swap API and serves community dashboard
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const http = require('http');
const path = require('path');
const fs = require('fs');

const SwapApiClient = require('./api-client');

// Load configuration from environment variables or config.json
let config;
if (process.env.SWAP_API_URL && process.env.SWAP_API_KEY) {
    config = {
        swapApi: {
            baseUrl: process.env.SWAP_API_URL,
            apiKey: process.env.SWAP_API_KEY,
            timeout: parseInt(process.env.SWAP_API_TIMEOUT) || 30000
        },
        server: {
            port: parseInt(process.env.PORT) || 3100,
            host: process.env.HOST || '0.0.0.0'
        },
        swap: {
            network: process.env.SWAP_NETWORK || 'mainnet',
            depositAddress: process.env.SWAP_DEPOSIT_ADDRESS || '',
            atomicUnits: parseInt(process.env.SWAP_ATOMIC_UNITS) || 1000000000
        },
        refresh: {
            intervalMs: parseInt(process.env.REFRESH_INTERVAL_MS) || 60000
        }
    };
} else {
    try {
        config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
    } catch (err) {
        console.error('No config found. Set environment variables or create config.json from config.example.json');
        process.exit(1);
    }
}

// Initialize API client
const swapApi = new SwapApiClient({
    apiBaseUrl: config.swapApi.baseUrl,
    apiKey: config.swapApi.apiKey,
    timeout: config.swapApi.timeout || 30000
});

const app = express();
const server = http.createServer(app);

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            scriptSrcAttr: ["'unsafe-inline'"],
            imgSrc: ["'self'", "data:"],
        }
    }
}));
app.use(cors());
app.use(compression());
app.use(express.json());

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Cache for data (refreshed periodically)
let cachedSummary = null;
let cachedSummaryTime = 0;
let cachedSwaps = null;
let cachedSwapsTime = 0;
let lastSync = null;

// Status constants matching swap portal
const STATUS = {
    SUBMITTED: 0,
    VERIFIED: 1,
    PAID: 2,
    FAILED: 3,
    EXPIRED: 4
};

const STATUS_LABELS = {
    0: 'PENDING',
    1: 'VERIFIED',
    2: 'PAID',
    3: 'REJECTED',
    4: 'EXPIRED'
};

// ============================================
// HELPER: Refresh cached data from API
// ============================================

async function refreshCache() {
    try {
        const summary = await swapApi.getDashboardSummary();
        if (summary.ok) {
            cachedSummary = summary;
            cachedSummaryTime = Date.now();
        }

        const swapsResult = await swapApi.getSwaps(500, 0);
        if (swapsResult.ok && swapsResult.rows) {
            cachedSwaps = swapsResult.rows;
            cachedSwapsTime = Date.now();
        }

        lastSync = new Date().toISOString();
        console.log(`Cache refreshed: ${cachedSwaps?.length || 0} swaps loaded`);
    } catch (err) {
        console.error('Failed to refresh cache:', err.message);
    }
}

// Initial cache load
refreshCache();

// Refresh cache periodically
setInterval(refreshCache, config.refresh.intervalMs || 60000);

// ============================================
// API ROUTES - READ ONLY
// ============================================

/**
 * GET /api/status
 * Swap window status, snapshot info, last sync
 */
app.get('/api/status', async (req, res) => {
    try {
        // Try fresh data, fall back to cache
        let data = cachedSummary;
        try {
            const fresh = await swapApi.getPublicStatus();
            if (fresh) data = { ...data, ...fresh };
        } catch (err) {
            console.error('Failed to fetch fresh status:', err.message);
        }

        if (!data) {
            return res.status(503).json({ error: 'Data not available yet' });
        }

        const swapWindow = data.swapWindow || {};
        const startHeight = parseInt(swapWindow.startHeight || 0);
        const endHeight = parseInt(swapWindow.endHeight || 0);
        const currentHeight = parseInt(data.legacyHeight || 0);

        let swapStatus = 'CLOSED';
        let blocksRemaining = 0;

        if (currentHeight > 0 && startHeight > 0 && endHeight > 0) {
            if (currentHeight < startHeight) {
                swapStatus = 'NOT_STARTED';
                blocksRemaining = startHeight - currentHeight;
            } else if (currentHeight <= endHeight) {
                swapStatus = 'OPEN';
                blocksRemaining = endHeight - currentHeight;
            } else {
                swapStatus = 'CLOSED';
                blocksRemaining = 0;
            }
        }

        res.json({
            swapStatus,
            snapshotBlockHeight: endHeight,
            currentHeight,
            blocksRemaining,
            startHeight,
            endHeight,
            depositAddress: swapWindow.depositAddress || config.swap.depositAddress,
            payoutEnabled: data.payoutEnabled || false,
            ledgerFinalized: !!data.ledgerHash,
            ledgerHash: data.ledgerHash || null,
            lastDbSync: lastSync,
            serverTime: data.serverTime,
            network: config.swap.network
        });
    } catch (err) {
        console.error('Error fetching status:', err);
        res.status(500).json({ error: 'Failed to fetch status' });
    }
});

/**
 * GET /api/stats
 * Global aggregates for dashboard
 */
app.get('/api/stats', async (req, res) => {
    try {
        // Use cache if fresh
        const now = Date.now();
        let summary = cachedSummary;

        if (!summary || (now - cachedSummaryTime) > config.refresh.intervalMs) {
            try {
                summary = await swapApi.getDashboardSummary();
                if (summary.ok) {
                    cachedSummary = summary;
                    cachedSummaryTime = now;
                }
            } catch (err) {
                console.error('Failed to fetch fresh summary:', err.message);
            }
        }

        if (!summary || !summary.ok) {
            return res.status(503).json({ error: 'Data not available yet' });
        }

        const counts = summary.counts || {};
        const totals = summary.totals || {};
        const atomicUnits = config.swap.atomicUnits;

        // Calculate contributors and holders distribution from cached swaps
        let topContributors = [];
        let holdersDistribution = [];
        let calculatedCounts = { verified: 0, paid: 0, submitted: 0, failed: 0, expired: 0 };
        let calculatedVerifiedAtomic = 0;
        let calculatedPaidAtomic = 0;

        if (cachedSwaps && cachedSwaps.length > 0) {
            const contributorMap = {};
            cachedSwaps.forEach(swap => {
                // Count by status
                switch (swap.status) {
                    case STATUS.VERIFIED: calculatedCounts.verified++; break;
                    case STATUS.PAID: calculatedCounts.paid++; break;
                    case STATUS.SUBMITTED: calculatedCounts.submitted++; break;
                    case STATUS.FAILED: calculatedCounts.failed++; break;
                    case STATUS.EXPIRED: calculatedCounts.expired++; break;
                }

                // Include verified and paid transactions (trust status, not tx_proof_valid)
                if (swap.status === STATUS.VERIFIED || swap.status === STATUS.PAID) {
                    const addr = swap.new_address;
                    // Use new_amount (new chain amount) as the verified swap amount
                    const amount = parseFloat(swap.new_amount || swap.amount || 0);
                    calculatedVerifiedAtomic += amount;

                    if (!contributorMap[addr]) {
                        contributorMap[addr] = { address: addr, totalAtomic: 0, txCount: 0 };
                    }
                    contributorMap[addr].totalAtomic += amount;
                    contributorMap[addr].txCount++;
                }

                // Only sum paid amounts for transactions actually marked as PAID
                if (swap.status === STATUS.PAID) {
                    calculatedPaidAtomic += parseFloat(swap.new_amount || 0);
                }
            });

            const allContributors = Object.values(contributorMap)
                .sort((a, b) => b.totalAtomic - a.totalAtomic);

            // Top 10 for the leaderboard
            topContributors = allContributors
                .slice(0, 10)
                .map(c => ({
                    address: c.address,
                    totalAtomic: c.totalAtomic.toString(),
                    totalXEQ: (c.totalAtomic / atomicUnits).toFixed(4),
                    txCount: c.txCount
                }));

            // Holders distribution for pie chart
            // Show top holders individually, group small holders into "Others"
            const totalVerified = allContributors.reduce((sum, c) => sum + c.totalAtomic, 0);
            const TOP_HOLDERS_COUNT = 10;
            const MIN_PERCENTAGE_FOR_DISPLAY = 0.5; // Show individually if >= 0.5%

            let othersTotal = 0;
            let othersCount = 0;

            allContributors.forEach((c, index) => {
                const percentage = totalVerified > 0 ? (c.totalAtomic / totalVerified) * 100 : 0;

                // Show top holders or anyone with >= MIN_PERCENTAGE individually
                if (index < TOP_HOLDERS_COUNT || percentage >= MIN_PERCENTAGE_FOR_DISPLAY) {
                    holdersDistribution.push({
                        address: c.address,
                        totalAtomic: c.totalAtomic.toString(),
                        totalXEQ: (c.totalAtomic / atomicUnits).toFixed(4),
                        percentage: percentage.toFixed(2),
                        txCount: c.txCount
                    });
                } else {
                    othersTotal += c.totalAtomic;
                    othersCount++;
                }
            });

            // Add "Others" category if there are small holders
            if (othersCount > 0) {
                const othersPercentage = totalVerified > 0 ? (othersTotal / totalVerified) * 100 : 0;
                holdersDistribution.push({
                    address: 'others',
                    label: `Others (${othersCount} wallets)`,
                    totalAtomic: othersTotal.toString(),
                    totalXEQ: (othersTotal / atomicUnits).toFixed(4),
                    percentage: othersPercentage.toFixed(2),
                    txCount: othersCount,
                    isOthers: true
                });
            }
        }

        // Use calculated totals from actual swaps data, fallback to API summary
        const verifiedTotal = calculatedVerifiedAtomic > 0 ? calculatedVerifiedAtomic : parseFloat(totals.legacyTotalAtomic || 0);
        // Paid total is only from transactions with status=PAID (payouts happen after swap window closes)
        const paidTotal = calculatedPaidAtomic;

        // Calculate unique contributors directly from swaps
        const uniqueAddresses = new Set(
            (cachedSwaps || [])
                .filter(s => s.status === STATUS.VERIFIED || s.status === STATUS.PAID)
                .map(s => s.new_address)
        );

        // Use calculated counts if we have swaps data, otherwise fallback to API counts
        const useCalculated = cachedSwaps && cachedSwaps.length > 0;
        const finalCounts = {
            verified: useCalculated ? calculatedCounts.verified : parseInt(counts.verified || 0),
            paid: useCalculated ? calculatedCounts.paid : parseInt(counts.paid || 0),
            submitted: useCalculated ? calculatedCounts.submitted : parseInt(counts.submitted || 0),
            failed: useCalculated ? calculatedCounts.failed : parseInt(counts.failed || 0),
            expired: useCalculated ? calculatedCounts.expired : parseInt(counts.expired || 0)
        };

        const stats = {
            totalVerifiedAtomic: verifiedTotal.toString(),
            totalVerifiedXEQ: (verifiedTotal / atomicUnits).toFixed(4),
            totalVerifiedCount: finalCounts.verified + finalCounts.paid,

            totalPaidAtomic: paidTotal.toString(),
            totalPaidXEQ: (paidTotal / atomicUnits).toFixed(4),
            totalPaidCount: finalCounts.paid,

            uniqueContributors: uniqueAddresses.size,

            pendingCount: finalCounts.submitted,
            rejectedCount: finalCounts.failed + finalCounts.expired,

            statusBreakdown: {
                VERIFIED: finalCounts.verified,
                PAID: finalCounts.paid,
                PENDING: finalCounts.submitted,
                REJECTED: finalCounts.failed,
                EXPIRED: finalCounts.expired
            },

            topContributors,
            holdersDistribution,
            lastUpdated: new Date().toISOString()
        };

        res.json(stats);
    } catch (err) {
        console.error('Error fetching stats:', err);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

/**
 * GET /api/txs
 * Transaction ledger with pagination and filters
 */
app.get('/api/txs', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
        const status = req.query.status;
        const sort = req.query.sort || 'time';
        const order = req.query.order === 'asc' ? 1 : -1;

        // Use cached swaps or fetch fresh
        let swaps = cachedSwaps;
        if (!swaps) {
            try {
                const result = await swapApi.getSwaps(500, 0);
                if (result.ok && result.rows) {
                    swaps = result.rows;
                    cachedSwaps = swaps;
                    cachedSwapsTime = Date.now();
                }
            } catch (err) {
                console.error('Failed to fetch swaps:', err.message);
            }
        }

        if (!swaps) {
            return res.json({ transactions: [], pagination: { page, limit, total: 0, totalPages: 0 } });
        }

        // Filter by status
        let filtered = [...swaps];
        if (status && status !== 'all') {
            switch (status.toLowerCase()) {
                case 'verified':
                    filtered = filtered.filter(s => s.status === STATUS.VERIFIED);
                    break;
                case 'pending':
                    filtered = filtered.filter(s => s.status === STATUS.SUBMITTED);
                    break;
                case 'rejected':
                    filtered = filtered.filter(s => s.status === STATUS.FAILED || s.status === STATUS.EXPIRED);
                    break;
                case 'paid':
                    filtered = filtered.filter(s => s.status === STATUS.PAID);
                    break;
            }
        }

        // Sort
        filtered.sort((a, b) => {
            let valA, valB;
            if (sort === 'amount') {
                valA = parseFloat(a.amount || 0);
                valB = parseFloat(b.amount || 0);
            } else if (sort === 'height') {
                valA = parseInt(a.height || 0);
                valB = parseInt(b.height || 0);
            } else {
                valA = new Date(a.created_at || 0).getTime();
                valB = new Date(b.created_at || 0).getTime();
            }
            return (valB - valA) * order;
        });

        const total = filtered.length;
        const offset = (page - 1) * limit;
        const txs = filtered.slice(offset, offset + limit);

        const atomicUnits = config.swap.atomicUnits;

        res.json({
            transactions: txs.map(tx => formatTransaction(tx, atomicUnits)),
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (err) {
        console.error('Error fetching transactions:', err);
        res.status(500).json({ error: 'Failed to fetch transactions' });
    }
});

/**
 * GET /api/tx/:txid
 * Single transaction details
 */
app.get('/api/tx/:txid', async (req, res) => {
    try {
        const { txid } = req.params;

        if (!txid || !/^[a-fA-F0-9]{64}$/.test(txid)) {
            return res.status(400).json({ error: 'Invalid txid format' });
        }

        const tx = cachedSwaps?.find(s => s.txid?.toLowerCase() === txid.toLowerCase());

        if (!tx) {
            return res.status(404).json({ error: 'Transaction not found' });
        }

        res.json(formatTransaction(tx, config.swap.atomicUnits));
    } catch (err) {
        console.error('Error fetching transaction:', err);
        res.status(500).json({ error: 'Failed to fetch transaction' });
    }
});

/**
 * GET /api/address/:address
 * Participant drill-down
 */
app.get('/api/address/:address', async (req, res) => {
    try {
        const { address } = req.params;

        if (!address || address.length < 10) {
            return res.status(400).json({ error: 'Invalid address format' });
        }

        const txs = cachedSwaps?.filter(s => s.new_address === address) || [];

        if (txs.length === 0) {
            return res.status(404).json({ error: 'Address not found' });
        }

        const atomicUnits = config.swap.atomicUnits;
        const verifiedTxs = txs.filter(t => t.status === STATUS.VERIFIED || t.status === STATUS.PAID);
        const verifiedTotal = verifiedTxs.reduce((sum, t) => sum + parseFloat(t.new_amount || t.amount || 0), 0);

        const sorted = [...txs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        res.json({
            address,
            verifiedTotalAtomic: verifiedTotal.toString(),
            verifiedTotalXEQ: (verifiedTotal / atomicUnits).toFixed(4),
            verifiedCount: verifiedTxs.length,
            firstSeen: sorted[sorted.length - 1]?.created_at,
            lastSeen: sorted[0]?.created_at,
            transactions: sorted.map(tx => formatTransaction(tx, atomicUnits))
        });
    } catch (err) {
        console.error('Error fetching address:', err);
        res.status(500).json({ error: 'Failed to fetch address' });
    }
});

/**
 * GET /api/export/current
 * Export current ledger as CSV or JSON
 */
app.get('/api/export/current', async (req, res) => {
    try {
        const format = req.query.format === 'json' ? 'json' : 'csv';
        const atomicUnits = config.swap.atomicUnits;

        const verified = (cachedSwaps || [])
            .filter(s => s.status === STATUS.VERIFIED || s.status === STATUS.PAID)
            .sort((a, b) => (parseInt(a.height) || 0) - (parseInt(b.height) || 0));

        if (format === 'json') {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', 'attachment; filename=swap_ledger_current.json');
            res.json({
                exportedAt: new Date().toISOString(),
                recordCount: verified.length,
                records: verified.map(r => ({
                    txid: r.txid,
                    height: r.height,
                    timestamp: r.timestamp,
                    amountXEQ: parseFloat((parseFloat(r.amount || 0) / atomicUnits).toFixed(4)),
                    newAmountXEQ: parseFloat((parseFloat(r.new_amount || 0) / atomicUnits).toFixed(4)),
                    newAddress: r.new_address,
                    newTxid: r.new_txid,
                    status: STATUS_LABELS[r.status]
                }))
            });
        } else {
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=swap_ledger_current.csv');

            let csv = 'txid,height,timestamp,amount_xeq,new_amount_xeq,new_address,new_txid,status\n';
            verified.forEach(r => {
                const amountXEQ = parseFloat((parseFloat(r.amount || 0) / atomicUnits).toFixed(4));
                const newAmountXEQ = parseFloat((parseFloat(r.new_amount || 0) / atomicUnits).toFixed(4));
                csv += `${r.txid},${r.height || ''},${r.timestamp || ''},${amountXEQ},${newAmountXEQ},${r.new_address},${r.new_txid || ''},${STATUS_LABELS[r.status]}\n`;
            });
            res.send(csv);
        }
    } catch (err) {
        console.error('Error exporting ledger:', err);
        res.status(500).json({ error: 'Failed to export ledger' });
    }
});

/**
 * GET /api/search
 * Search by txid or address
 */
app.get('/api/search', async (req, res) => {
    try {
        const { q } = req.query;

        if (!q || q.length < 6) {
            return res.status(400).json({ error: 'Search query too short' });
        }

        // Check if it's a txid (64 hex chars)
        if (/^[a-fA-F0-9]{64}$/.test(q)) {
            const tx = cachedSwaps?.find(s => s.txid?.toLowerCase() === q.toLowerCase());
            if (tx) {
                return res.json({ type: 'txid', result: tx.txid });
            }
            return res.json({ type: 'not_found', query: q });
        }

        // Search by address
        const addresses = [...new Set(
            (cachedSwaps || [])
                .filter(s => s.new_address?.toLowerCase().includes(q.toLowerCase()))
                .map(s => s.new_address)
        )].slice(0, 10);

        if (addresses.length > 0) {
            return res.json({ type: 'addresses', results: addresses });
        }

        res.json({ type: 'not_found', query: q });
    } catch (err) {
        console.error('Error searching:', err);
        res.status(500).json({ error: 'Search failed' });
    }
});

/**
 * GET /api/health
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        cacheStatus: {
            summaryAge: cachedSummaryTime ? Date.now() - cachedSummaryTime : null,
            swapsCount: cachedSwaps?.length || 0,
            lastSync
        }
    });
});

// ============================================
// HELPER FUNCTIONS
// ============================================

function formatTransaction(tx, atomicUnits) {
    return {
        txid: tx.txid,
        amountAtomic: tx.amount?.toString() || '0',
        amountXEQ: (parseFloat(tx.amount || 0) / atomicUnits).toFixed(4),
        confirmations: parseInt(tx.confirmations || 0),
        height: tx.height,
        timestamp: tx.timestamp,
        newAddress: tx.new_address,
        newAmountAtomic: tx.new_amount?.toString(),
        newAmountXEQ: tx.new_amount ? (parseFloat(tx.new_amount) / atomicUnits).toFixed(4) : null,
        newTxid: tx.new_txid,
        status: STATUS_LABELS[tx.status] || 'UNKNOWN',
        statusCode: tx.status,
        proofValid: tx.tx_proof_valid === 1,
        doubleSpendSeen: tx.double_spend_seen === 1,
        error: tx.last_error,
        inPool: tx.in_pool === 1,
        fee: tx.fee,
        createdAt: tx.created_at,
        updatedAt: tx.updated_at
    };
}

// ============================================
// FRONTEND ROUTES
// ============================================

// Serve index.html for all frontend routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/ledger', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/participant/:address', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/tx/:txid', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// START SERVER
// ============================================

const PORT = config.server.port || 3100;
const HOST = config.server.host || '0.0.0.0';

server.listen(PORT, HOST, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║   Equilibria Swap Transparency Tracker                    ║
║   Server running at http://${HOST}:${PORT}                   ║
║   Network: ${config.swap.network.toUpperCase().padEnd(46)}║
║   API Source: ${config.swapApi.baseUrl.substring(0, 40).padEnd(43)}║
╚═══════════════════════════════════════════════════════════╝
    `);
});
