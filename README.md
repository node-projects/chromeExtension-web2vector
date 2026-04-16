# Web2Vector — Chrome Extension

A Chrome extension that exports any web page's rendered DOM to **10 output formats** using the [@node-projects/layout2vector](https://github.com/node-projects/layout2vector) library.

<p align="center">
  <img src="src/icons/icon.svg" width="128" alt="Web2Vector icon" />
</p>

## Supported Formats

| Category | Format | Extension | Writer |
|----------|--------|-----------|--------|
| **Vector** | SVG | `.svg` | `SVGWriter` |
| | DXF (Standard) | `.dxf` | `DXFWriter` (via `@tarikjabiri/dxf`) |
| | DXF (AutoCAD) | `.dxf` | `AcadDXFWriter` (via `@node-projects/acad-ts`) |
| | DWG | `.dwg` | `DWGWriter` (via `@node-projects/acad-ts`) |
| | EMF | `.emf` | `EMFWriter` |
| **Document** | PDF | `.pdf` | `PDFWriter` |
| | HTML | `.html` | `HTMLWriter` |
| **Image** | PNG | `.png` | `ImageWriter` |
| | JPEG | `.jpg` | `ImageWriter` |
| | WebP | `.webp` | `ImageWriter` |

## Usage

1. Click the **Web2Vector** icon in the Chrome toolbar.
2. Pick an export format from the popup menu.
3. A **Save As** dialog appears — choose where to save the file.

You can also **right-click** on any page and use the **Web2Vector Export** context menu.

## Lazy Loading

Heavy third-party dependencies are split into separate bundles and only loaded when the user selects a format that needs them:

| Bundle | Loaded when | Dependency |
|--------|-------------|------------|
| `core-lib.js` | Always (first export) | `@node-projects/layout2vector` core + built-in writers |
| `dxf-writer.js` | DXF (Standard) selected | `@tarikjabiri/dxf` |
| `acad-writers.js` | DXF (AutoCAD) or DWG selected | `@node-projects/acad-ts` |

## Development

### Prerequisites

- Node.js ≥ 20
- npm

### Setup

```bash
npm install
```

### Build

```bash
# Generate icon PNGs from SVG source
npm run build:icons

# Bundle the extension into dist/
npm run build

# Or both in one step
npm run build:all
```

### Load in Chrome

1. Navigate to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `dist/` folder

### Test

```bash
npm test
```

### Package for Distribution

```bash
npm run package     # creates web2vector-<version>.zip
```

## Publishing to Chrome Web Store

### Manual

1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Upload the ZIP created by `npm run package`.

### Automated (GitHub Actions)

The **Publish** workflow runs on GitHub Releases or manual dispatch. Configure these repository secrets:

| Secret | Description |
|--------|-------------|
| `CHROME_EXTENSION_ID` | Your extension ID from the CWS dashboard |
| `CHROME_CLIENT_ID` | Google OAuth2 client ID |
| `CHROME_CLIENT_SECRET` | Google OAuth2 client secret |
| `CHROME_REFRESH_TOKEN` | OAuth2 refresh token (see [guide](https://developer.chrome.com/docs/webstore/using-api)) |

Then create a GitHub Release to trigger the publish workflow, or use the manual dispatch.

## Project Structure

```
├── manifest.json               Chrome extension manifest (v3)
├── esbuild.config.mjs          Build configuration
├── src/
│   ├── shared/formats.js       Format definitions (shared by popup + background)
│   ├── popup/                  Extension popup UI
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js
│   ├── background/
│   │   └── service-worker.js   Background service worker
│   ├── content/
│   │   ├── core-lib.js         Core library bundle
│   │   ├── dxf-writer.js       DXF lazy chunk
│   │   ├── acad-writers.js     DWG / AcadDXF lazy chunk
│   │   └── run-export.js       Export orchestration (injected per export)
│   └── icons/
│       └── icon.svg            Source icon
├── scripts/
│   ├── build-icons.mjs         SVG → PNG conversion
│   ├── package-extension.mjs   ZIP packaging
│   └── upload-to-store.mjs     Chrome Web Store upload
├── tests/
│   ├── formats.test.js
│   ├── manifest.test.js
│   └── service-worker.test.js
└── .github/workflows/
    ├── ci.yml                  Build + test on push/PR
    └── publish.yml             Publish to Chrome Web Store
```

## License

MIT
