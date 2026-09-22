## Local preview

Because the site fetches local JSON/CSV files, opening `index.html` directly
via `file://` will be blocked by the browser in some setups. Serve it
locally instead:

```bash
cd fungarium
python3 -m http.server 8000
```

Then visit `http://localhost:8000`.
