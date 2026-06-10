// render3d.ts imports Three.js from a CDN URL (so Vite leaves it external instead of
// bundling it). Map that URL module to the installed `three` types so the 3D code stays
// fully typed. Keep the version here in sync with the URL in render3d.ts.
declare module 'https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.module.js' {
  export * from 'three';
}
