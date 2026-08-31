# SPANK PWA

**SPANK — Spectral Produce Analysis via Nondestructive Knocking**

Standalone progressive web app for collecting and analyzing watermelon tap acoustics from an iPhone/iPad/desktop browser.

## What it measures

- 3-tap microphone capture
- Full single-sided FFT spectrum for each detected tap
- Averaged spectrum
- Dominant spectral peak frequency
- T20 acoustic decay time
- Tap-to-tap repeatability
- Optional variety, Brix, ground-truth label, and notes
- Local IndexedDB storage
- CSV export

SPANK does **not** infer ripeness until a calibrated model has been developed from labeled data.

## Repository layout

```text
SPANK-PWA/
├── .github/workflows/pages.yml
├── icons/
├── tests/
├── index.html
├── app.js
├── dsp.js
├── storage.js
├── csv.js
├── styles.css
├── manifest.webmanifest
├── sw.js
├── package.json
└── README.md
```

## Test locally on Windows/Linux

No package install is required beyond Node.js 22+.

```bash
npm test
```

For browser testing, serve the folder locally rather than opening `index.html` as a file:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080` on the computer. Microphone access on an iPhone/iPad requires HTTPS, so use GitHub Pages for device testing.

## Deploy to GitHub Pages

1. Create a **public** GitHub repository named `SPANK-PWA`.
2. Copy the contents of this folder directly into the repository root. Do not place this folder inside another `SPANK-PWA` folder.
3. Push to `main`.
4. In GitHub, open **Settings → Pages** and set **Source** to **GitHub Actions**.
5. Open **Actions → Deploy SPANK PWA** and confirm the deployment is green.
6. Open the URL shown in **Settings → Pages**.

For the GitHub account `whyskygngr` and repository `SPANK-PWA`, the expected URL is:

```text
https://whyskygngr.github.io/SPANK-PWA/
```

## Install on iPhone/iPad

Open the GitHub Pages URL in Safari, grant microphone access, then use **Share → Add to Home Screen**.

## Privacy

Measurements remain in browser-local IndexedDB until exported or browser/site data is cleared. Raw audio is discarded after analysis by the current implementation.
