# StitchForge — project notes

Flask app that turns a photo / shape / typed text into a machine-embroidery
file. `app.py` = routes, `converter.py` = raster→stitch + vectorise pipeline,
`static/app.js` = client UI, `templates/index.html` = markup.

## Deployment

- Hosted on Render (`render.yaml`), which **auto-deploys from the `main`
  branch**. Live URL: https://stitchforge.onrender.com
- Pushing to a feature branch does **not** update the live site — the changes
  must reach `main` for Render to rebuild (a rebuild also reinstalls
  dependencies, so allow ~2–5 min after the push).

## "Go Live" — user shortcut

When the user says **"Go Live"**, promote the current work to production:

1. Fast-forward (or merge, if the branches have diverged) the current working
   branch into `main`.
2. Push `main` to origin — this triggers Render's auto-deploy.
3. Switch back to the working branch to continue.

This is explicit standing permission to push to `main` when "Go Live" is said.
