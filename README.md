# CPL-2 Scheduler

Coil scheduling rulebook and scheduler for the CPL-2 line (HRPO / HRSPO and NGO FP).

- Runs the deck's data-prep steps on an HR stock report (.xls / .xlsx)
- Checks every coil against the one before it using editable rules
- Auto-arranges both schedules (same thickness together)
- Settings, stock file and orders are shared across devices
- In-page and device notifications

## Run locally

```bash
npm install
cp .env.example .env     # optional
npm start                # http://localhost:3000
npm test                 # rules engine tests
```

Without `MONGODB_URI` the app stores data in `data/state.json`.

## Deploy (Render + MongoDB Atlas, free)

1. Create a free M0 cluster on MongoDB Atlas, a database user, and allow `0.0.0.0/0` under Network Access.
2. Push this folder to a GitHub repository.
3. On Render: New > Web Service > connect the repo.
   Build command `npm install`, start command `npm start`, instance type Free.
4. Add environment variables `MONGODB_URI` (Atlas connection string) and `ADMIN_KEY` (any secret).
5. Open the `.onrender.com` link. Enter the editor key in Rules & settings once per device.

## API

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/health` | |
| GET | `/api/state` | |
| PUT | `/api/settings` | settings object |
| PUT | `/api/stock` | `{ name, cols, rows }` |
| PUT | `/api/plan/HR` or `/api/plan/NGO` | `{ ids: [...] }` |

PUT requests need the header `x-admin-key` when `ADMIN_KEY` is set.
