# Smart Production Monitoring

TF2 production dashboard with:
- realtime operator dashboard
- monitor mode
- Google Sheet scan logging
- Firebase Realtime DB sync for live state/commands
- Firebase Cloud Functions scheduled clock update

## Project Structure

- `index.html` - UI layout
- `style.css` - styles
- `script.js` - dashboard logic
- `netlify.toml` - Netlify static hosting config
- `firebase.json` - Firebase Functions config
- `functions/` - Cloud Functions backend worker

## Quick Start (Local)

Open `index.html` in browser.

To use Firebase, ensure `FIREBASE_CONFIG` in `script.js` is filled including `databaseURL`.

## Deploy

See `DEPLOY.md` for full deployment steps:
- Netlify (frontend)
- Firebase Functions (backend scheduler)
