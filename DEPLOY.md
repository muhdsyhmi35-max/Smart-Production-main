# Deployment Guide

This project has 2 deploy targets:
- Frontend static site -> Netlify
- Background clock worker -> Firebase Cloud Functions

Both are needed for best behavior when browser is closed.

## 1) Netlify Deploy (Frontend)

### Option A: Deploy from Git
1. Push this folder to a Git repo.
2. In Netlify, create new site from Git.
3. Use settings:
   - Base directory: `Smart-Production-main` (if repo root is parent folder)
   - Build command: empty (or auto from `netlify.toml`)
   - Publish directory: `.`
4. Deploy.

### Option B: Drag & Drop
1. Zip contents of `Smart-Production-main`.
2. Drop into Netlify manual deploy.

`netlify.toml` already exists with:
- no build step
- SPA fallback redirect to `index.html`

## 2) Firebase Functions Deploy (Backend Clock Worker)

Prerequisites:
- Firebase project exists (`monitoring-system-61d36`)
- Blaze plan enabled (for Scheduler)
- Firebase CLI installed

### Install tools
```bash
npm i -g firebase-tools
firebase login
```

### Install function dependencies
From project root:
```bash
cd functions
npm install
cd ..
```

### Deploy functions
```bash
firebase deploy --only functions
```

## 3) Firebase Realtime Database Rules (Basic Starter)

For initial testing:
```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

Harden this for production after validation.

## 4) Required Frontend Config

In `script.js`, ensure `FIREBASE_CONFIG` has valid values:
- `apiKey`
- `authDomain`
- `databaseURL`
- `projectId`
- `storageBucket`
- `messagingSenderId`
- `appId`

`databaseURL` is required for Realtime DB.

## 5) Validation Checklist

1. Open operator screen and monitor screen.
2. Verify Start/Stop/Reset syncs across screens.
3. Verify cycle time/daily plan/lot syncs.
4. Verify countdown and downtime catch up after refresh/reopen.
5. Close all browsers for a few minutes, reopen, and confirm state progressed from backend timestamps.

## 6) Troubleshooting

- Functions not updating:
  - check deploy success in Firebase console
  - check scheduler job status
  - check logs:
    ```bash
    firebase functions:log
    ```
- Frontend not connecting:
  - verify `databaseURL`
  - verify browser console errors
  - verify Realtime Database rules allow access
