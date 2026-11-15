/// <reference types="vite/client" />

interface ThreeGameDiagnostics {
  frame: number;
  elapsed: number;
  mode: string;
  player: {
    position: { x: number; y: number; z: number };
    speed: number;
    slopeDeg: number;
    blocked: boolean;
  };
  renderer: { calls: number; triangles: number; geometries: number; textures: number };
  canvas: { clientWidth: number; clientHeight: number; width: number; height: number; dpr: number };
  [key: string]: unknown;
}

interface Window {
  __THREE_GAME_DIAGNOSTICS__?: ThreeGameDiagnostics;
  __MARS__?: unknown;
}
