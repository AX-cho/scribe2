# Scribe — browser edition

Live English captions with inline speaker labels. React, shadcn components, Atkinson Hyperlegible, ONNX Runtime Web, and locally imported Nemotron models. No inference backend, audio uploads, recording, or transcript storage. Refresh clears the conversation and imported file references.

## Use

Open the HTTPS site in a browser with WebGPU support. Select **Import models** and choose your `browser-models` folder containing `asr/` and `diar/`. Click **Load local models**, choose your microphone, then **Start captions**. Each device needs its own copy of the approved models. Import verifies exact sizes and hashes before inference. Unrelated files are ignored; missing, duplicate, or changed required files are rejected. Files are not uploaded or cached by the app.

Existing local installations can copy their `browser-models` folder to another device. The approved repositories, immutable revisions, filenames, and integrity hashes are in `config/browser-models.json`. This site does not download models automatically. Models are approximately 912 MB; verification and inference need additional RAM. Smaller devices may not keep up.

WebGPU runs speech encoding and speaker detection in separate workers; they still share GPU resources. Token decoding runs on CPU. CPU-only mode is available, but GitHub Pages does not provide our local server's cross-origin isolation headers, so WASM uses one thread. Speaker assignments and word boundaries are approximate. If speaker detection falls over 15 seconds behind it stops, while captions continue with a visible warning.

## Build and publish

Node 24 or newer. Install with `npm ci --ignore-scripts`, run `npm audit`, `npm test`, and `npm run build`. Serve `browser-dist` using HTTPS (localhost is also usable for development). Do not open HTML directly with `file://`.

Publishing is not enabled by this source-only push. Add a GitHub Pages build/deploy workflow with appropriate GitHub permissions, then choose **GitHub Actions** in repository Settings → Pages. The workflow should run the install, audit, test, and build commands above and publish `browser-dist`. Both the root and browser.html open the same app. The production bundle includes runtime and font assets, but no models or native backend.

## Privacy and security

The website and source are public. GitHub receives ordinary site/asset requests. Microphone samples and captions stay in browser memory; no analytics or telemetry is added. HTTPS and browser microphone permission are required. Imported models must match the bundled pinned manifest; this is an integrity check, not a guarantee that an ML runtime has no vulnerabilities. Dependencies are locked; run `npm audit --audit-level=high` before each deployment.

The page uses a restrictive CSP; inference workers restrict fetch to local imported models and same-origin runtime assets. Pages cannot reproduce all the custom security headers of the original local server. Do not put secrets in this repository. The JavaScript argmax uses the original joint graph, so users do not need a locally generated graph.

Third-party source licenses and provenance are in `vendor/` and `src/browser/ASR-LICENSE`. Model licenses remain those of their respective publishers; model binaries are not redistributed here.
