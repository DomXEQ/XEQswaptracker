/**
 * XEQ Swap API Client
 * Wrapper for the swap dashboard API endpoints
 */

const https = require('https');
const http = require('http');

class SwapApiClient {
    constructor(config) {
        this.baseUrl = config.apiBaseUrl;
        this.apiKey = config.apiKey;
        this.timeout = config.timeout || 30000;

        // Parse base URL
        const url = new URL(this.baseUrl);
        this.protocol = url.protocol === 'https:' ? https : http;
        this.hostname = url.hostname;
        this.port = url.port || (url.protocol === 'https:' ? 443 : 80);
        this.basePath = url.pathname.replace(/\/$/, '');
    }

    /**
     * Make HTTP request to the swap API
     */
    async request(path, requiresAuth = true) {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: this.hostname,
                port: this.port,
                path: this.basePath + path,
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'XEQ-Swap-Tracker/1.0'
                },
                timeout: this.timeout
            };

            if (requiresAuth && this.apiKey) {
                options.headers['X-API-Key'] = this.apiKey;
            }

            const req = this.protocol.request(options, (res) => {
                let data = '';

                res.on('data', chunk => {
                    data += chunk;
                });

                res.on('end', () => {
                    if (res.statusCode === 401 || res.statusCode === 403) {
                        reject(new Error(`Authentication failed (${res.statusCode}): Check API key and IP whitelist`));
                        return;
                    }

                    if (res.statusCode >= 400) {
                        reject(new Error(`API error ${res.statusCode}: ${data.substring(0, 200)}`));
                        return;
                    }

                    try {
                        const json = JSON.parse(data);
                        resolve(json);
                    } catch (err) {
                        reject(new Error(`Invalid JSON response: ${data.substring(0, 200)}`));
                    }
                });
            });

            req.on('error', (err) => {
                reject(new Error(`Request failed: ${err.message}`));
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.end();
        });
    }

    /**
     * GET /api/public
     * Public status - no auth required
     */
    async getPublicStatus() {
        return this.request('/api/public', false);
    }

    /**
     * GET /api/dashboard/summary
     * Aggregate counts and totals
     */
    async getDashboardSummary() {
        return this.request('/api/dashboard/summary', true);
    }

    /**
     * GET /api/dashboard/swaps
     * Paged list of swap rows
     */
    async getSwaps(limit = 50, offset = 0) {
        return this.request(`/api/dashboard/swaps?limit=${limit}&offset=${offset}`, true);
    }

    /**
     * Fetch all swaps (paginated)
     */
    async getAllSwaps() {
        const allRows = [];
        let offset = 0;
        const limit = 100;

        while (true) {
            const result = await this.getSwaps(limit, offset);
            if (!result.ok || !result.rows || result.rows.length === 0) {
                break;
            }
            allRows.push(...result.rows);
            offset += limit;

            // Safety limit
            if (offset > 10000) break;
        }

        return allRows;
    }
}

module.exports = SwapApiClient;
