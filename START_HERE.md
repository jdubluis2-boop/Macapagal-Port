# Start here

This folder contains the complete local development project, not an installed executable. It includes all source, migrations, seed/demo scripts, tests and setup documentation. No private `.env`, database dump, login password, dependency cache or uploaded reference PDF is included in the download.

1. Install Node.js 24 and Docker Desktop/Engine with Compose.
2. Open a terminal in this folder and run `./scripts/setup.sh` (Bash; Windows users can use WSL2).
3. Optionally run `npm run db:demo` to add clearly labelled future demonstration sailings.
4. Run `npm run dev:api` and `npm run dev:web` in separate terminals.
5. Register a passenger account. Find its email verification code in the local Mailpit inbox on port 8025.
6. Search a demo sailing, select seats, enter passenger details, and confirm the hold. Choose a payment method. The development simulator can settle success/failure without moving money.
7. View the issued QR/PDF ticket, request a refund, and track its worker-driven status.
8. To use the staff console, verify your account and grant its role with `npm run staff:create -- --email=your-address --role=PORT_ADMIN`. Sign in again.

All detailed commands, environment settings, testing instructions and limitations are in [README.md](README.md). For real deployment, review [production readiness](docs/production-readiness.md); the default payment, email and demo timetable settings are for development.
