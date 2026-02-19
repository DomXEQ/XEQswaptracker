# Equilibria Swap Transparency Tracker

A public transparency dashboard for the Equilibria legacy token swap. Displays real-time, auditable swap participation metrics so the community can independently verify swap activity.

## Features

### Dashboard
- **Swap Status**: Live indicator showing whether the swap window is OPEN, CLOSED, or NOT YET STARTED
- **Countdown**: Blocks remaining and estimated time until the swap window closes
- **Global Stats**: Total verified XEQ, unique contributors, pending/rejected counts
- **Holders Distribution**: Visual breakdown of swap participation by wallet
- **Top Contributors**: Ranked leaderboard by verified swap amount

### Transaction Ledger
- Full list of every swap transaction
- Filterable by status (Verified, Pending, Rejected, Paid)
- Sortable by time, amount, or block height
- Click any transaction for full details

### Participant Lookup
- Search by transaction ID or wallet address
- View total verified amount per participant
- Transaction history with timestamps
- Shareable links for individual participants

### Data Exports
- Download the current swap ledger as CSV or JSON
- SHA256 hash verification for data integrity

## Security

- **Read-only**: The tracker only displays data, it cannot modify anything
- **No credentials exposed**: All sensitive configuration is kept server-side and excluded from this repository
- **Address masking**: Wallet addresses are partially masked in the UI by default

## License

MIT
