# Steady

Steady is a self-hosted personal budgeting and planning app. It includes a Node.js HTTP server, SQLite persistence, local account authentication, CSV and text-PDF statement ingestion, category rules learned from corrections, recurring-payment detection, goal and budget planning, monthly reports, a scenario model, subscription feature tiers, and light/dark appearance.

The account registration form defaults the account name to **Shashank Kumar**. Change it before registration if the account owner is someone else.

The sign-in screen includes **Explore the sample Bengaluru household**, which opens an illustrative INR workspace with four months of sample activity, common household commitments, recurring services, and two savings goals. It is synthetic data; it is not connected to a bank account. Signing out removes that demo workspace.

## Run it locally

Requirements: Node.js 24 or later, Python 3.10 or later, and PyMuPDF for PDF imports.

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
npm start
```

Open `http://localhost:3000`. Create an account with an email address and a password of at least 10 characters. SQLite data is written to `data/steady.sqlite` by default. Set `DATA_DIR` to a persistent volume path when running in a container or on a hosting service.

## Container deployment

Build from this directory with `docker build -t steady .`, then run it with port 3000 exposed and a persistent volume mounted at `/data`. Configure `NODE_ENV=production`, a durable `DATA_DIR=/data`, and terminate TLS at a trusted reverse proxy or hosting platform. Back up the SQLite volume. The image installs PyMuPDF for text extraction from PDFs.

### Render Blueprint

`render.yaml` defines a free Docker web service in Singapore with a `/api/health` check. Free service filesystems are temporary, so user and sample data may be lost when the service restarts or redeploys. The app deliberately does not configure paid compute or paid storage.

## What the financial model does

- Categorizes income and expenses with transparent merchant-name patterns. When a user corrects a category, Steady stores an account-specific normalized-merchant rule and applies it to later imports.
- Identifies recurring payments after two transactions from the same merchant with a 5–40 day interval. It flags a payment amount difference greater than $3 or 5%.
- Calculates a monthly safe-to-spend estimate from observed income (or the profile), fixed costs, planned essentials, goal contributions, and month-to-date flexible spending.
- Calculates emergency-fund runway as the profile balance divided by monthly fixed costs.
- Models dining reductions from the current month’s observed dining total, rent changes from the profile’s rent/mortgage amount, and income changes from the profile or current income.
- Builds a monthly review from imported activity and the profile, showing spending mix, goal progress, recurring patterns, and an explainable planning prompt.

These are deterministic planning calculations. They are not a guarantee, credit decision, investment recommendation, or substitute for reviewing transactions and assumptions. Steady does not recommend specific securities, buy or sell investments, move money, pay bills, cancel subscriptions, or contact merchants.

## Plans

| Plan | Indicative price | Imports/month | Active goals | What-if runs/month | History shown |
| --- | ---: | ---: | ---: | ---: | ---: |
| Steady | Free | 100 | 2 | 2 | 3 months |
| Steady Plus | $5/month | 2,500 | 8 | 30 | 24 months |
| Steady Complete | $10/month | 10,000 | 25 | 100 | 60 months |

The tier picker enforces local feature entitlements. Appearance controls, privacy settings, profile access, financial guardrails, and data export are available on every tier. The prices are illustrative; no payment provider or recurring billing is wired in. Do not charge customers until a payment processor, verified webhook handling, cancellation/refund flows, tax treatment, and customer support are integrated.

## Statement format support

- CSV: comma, semicolon, or tab delimited; a recognizable description/merchant column and an amount column, or debit and credit columns. Common date, posted date, payee, memo, details, withdrawal, and deposit headers are recognized.
- PDF: text-based PDFs with transaction rows similar to `date description amount`. PyMuPDF extracts text in reading order. PDF bank statement layouts vary; this parser will not understand every institution-specific layout.
- Scanned/image-only PDFs: OCR is not included. Extraction errors are shown to the user. Add a reviewed OCR and bank-layout adapter before relying on scanned statements.
- SMS: users can paste a transaction alert. The app extracts an amount and merchant when the message uses a simple “$amount at merchant” pattern.

Uploaded statement files are parsed in memory and not retained. The resulting transaction rows, category corrections, profile, goals, and settings are stored in SQLite.

## Security and production boundary

This is a deployable starter, not a bank-certified production service. It includes scrypt password hashes, HTTP-only SameSite cookies, account-scoped SQL queries, login throttling, request size limits, basic per-IP throttling, same-origin checks, upload type/size checks, and safe static file headers. Sessions are held in memory and users must sign in again when the server restarts.

Before public or financial-institution deployment, add a reviewed authentication/session system, email verification and recovery, CSRF testing, encrypted storage and backups, centralized secrets, security monitoring, migrations, database concurrency strategy, privacy/retention controls, accessibility and penetration testing, and the institution’s required security/compliance approval. A direct JPMorgan Chase integration requires an approved banking API/data-sharing program, credentials, and consent flow; none is assumed by this app. The app runs on user-provided statements until that authorized integration exists.

## Source files

- `server.mjs` — API, authentication, financial model, SQLite storage, statement routing, and static server.
- `public/index.html` — responsive application UI and client flows.
- `pdf_extract.py` — bounded text extraction from PDF input using PyMuPDF.
- `Dockerfile` — Node/Python container image for deployment.
