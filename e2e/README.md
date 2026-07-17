# Browser end-to-end suite

Driven-browser checks for the flows unit tests cannot see: the share room as a
client uses it, the presentation room, annotations, attachments, and the
settings surfaces. Every check asserts observable behaviour (a video that
plays, an image that decodes, a drag that moved something), never mere element
presence - a green check that proves markup converts "I didn't test this" into
"I tested this and it works".

## Running

The suite runs against a live instance with Firefox (the bundled Playwright
Chromium has no H.264, so footage checks would fail there for the wrong
reason). It seeds its own share and revokes it afterwards; it needs an
existing project holding at least two transcoded video assets.

In CI the Integration workflow runs it automatically: the integration
exercise writes the id of the project it created and transcoded to
ONELIGHT_E2E_STATE_FILE, and the suite runs from the Playwright container
against that project, reaching the stack on the runner's LAN address so
the origin is non-localhost.

```
docker run --rm --network host \
  -v "$PWD/e2e:/e2e" -w /e2e \
  -e BASE_URL=http://192.168.1.52:3000 \
  -e E2E_EMAIL=admin@example.com \
  -e E2E_PASSWORD=... \
  -e E2E_PROJECT_ID=01KX... \
  mcr.microsoft.com/playwright:v1.56.1-noble \
  sh -c 'npm i --silent --no-save playwright@1.56.1 >/dev/null 2>&1 && node share-flows.e2e.mjs && node settings.e2e.mjs'
```

Environment:

- `BASE_URL` - the instance under test. Use the LAN address, never
  localhost: localhost is always a secure context and hides the class of bug
  where a secure-context API is missing in production.
- `E2E_EMAIL`, `E2E_PASSWORD` - an admin account on that instance.
- `E2E_PROJECT_ID` - a project with at least two transcoded video assets.

Checks that need real playback skip loudly (not silently) when the media is
not ready. Exit code is non-zero on any failure.
