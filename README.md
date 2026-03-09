# jam-stats

Static frontend for browsing itch.io jam entries, plus a small Node API that resolves jam ids and proxies `entries.json`.

## Deployment shape

- GitHub Pages hosts the static files: `index.html`, `app.js`, `logo.png`
- `server.js` is a separate API service and no longer serves the frontend
- the frontend expects the API at `/api/entries` by default

## GitHub Pages setup

Set the API origin in `index.html` before publishing:

```html
<meta name="jam-stats-api-base" content="https://your-api-host.example.com">
```

If you leave that value empty, the frontend will call the current origin. That works for local same-origin setups, but not for a GitHub Pages site unless you proxy the API through the same domain.

## API setup

Run the API locally:

```powershell
npm start
```

Environment variables:

- `PORT` defaults to `3000`
- `HOST` defaults to `0.0.0.0`
- `CORS_ORIGIN` defaults to `*`

The API exposes:

- `GET /api/entries?input=<jam-url-or-slug-or-id>`

## Local development

Use any static server for the frontend and point `jam-stats-api-base` at your API origin if needed.
