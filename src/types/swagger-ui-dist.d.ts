// Minimal ambient typings for `swagger-ui-dist` (the package ships no types).
// We only need the absolute path of the bundled static assets; the browser-side
// bundles (swagger-ui-bundle.js / swagger-ui-standalone-preset.js) are served
// verbatim to the client and never imported from Node code.
declare module 'swagger-ui-dist' {
  /** Absolute path of the directory containing the swagger-ui static assets. */
  export function getAbsoluteFSPath(): string;
}
