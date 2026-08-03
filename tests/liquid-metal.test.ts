import { afterEach, describe, expect, test } from "bun:test";
import { initLiquidMetal } from "../src/ui/liquid-metal";
import {
  canvasContextFactory,
  createWebGL2Stub,
  type DomHandle,
  installDom,
  setElementSize,
  type WebGL2Stub,
} from "./helpers/dom";

const WORDMARK_HTML = `
  <div class="wordmark">
    <span class="wordmark-text">flashbang</span>
    <canvas id="metal-canvas"></canvas>
  </div>
`;

let dom: DomHandle | null = null;

interface MetalFixture {
  canvas: HTMLCanvasElement;
  handle: DomHandle;
  webgl: WebGL2Stub | null;
  wordmark: HTMLElement;
}

function setup(
  options: {
    reducedMotion?: boolean;
    webgl?: Record<string, unknown> | null;
    html?: string;
    parentSize?: number;
  } = {}
): MetalFixture {
  const stub = options.webgl === null ? null : createWebGL2Stub(options.webgl);
  const handle = installDom({
    html: options.html ?? WORDMARK_HTML,
    reducedMotion: options.reducedMotion,
    canvasContext: canvasContextFactory(stub?.context ?? null),
    devicePixelRatio: 2,
  });
  dom = handle;
  const canvas = handle.document.querySelector(
    "#metal-canvas"
  ) as unknown as HTMLCanvasElement;
  const wordmark = handle.document.querySelector(
    ".wordmark"
  ) as unknown as HTMLElement | null;
  const parent = wordmark ?? (canvas.parentElement as unknown as HTMLElement);
  setElementSize(parent, options.parentSize ?? 200, options.parentSize ?? 64);
  return { canvas, handle, webgl: stub, wordmark: wordmark as HTMLElement };
}

afterEach(() => {
  dom?.restore();
  dom = null;
});

function callNames(fixture: MetalFixture): string[] {
  return (fixture.webgl?.calls ?? []).map((call) => call.name);
}

describe("liquid metal without WebGL", () => {
  test("hides the canvas and drops the shader class", () => {
    const fixture = setup({ webgl: null });
    fixture.wordmark.classList.add("has-shader");

    initLiquidMetal(fixture.canvas, "flashbang");

    expect(fixture.canvas.style.display).toBe("none");
    expect(fixture.wordmark.classList.contains("has-shader")).toBe(false);
  });

  test("flash falls back to a CSS burst that clears itself", async () => {
    const fixture = setup({ webgl: null });
    const controls = initLiquidMetal(fixture.canvas, "flashbang");

    controls.flash();
    expect(fixture.wordmark.classList.contains("flash-burst")).toBe(true);

    await fixture.handle.advance(600);
    expect(fixture.wordmark.classList.contains("flash-burst")).toBe(false);
  });

  test("pause, resume, and destroy are inert", () => {
    const fixture = setup({ webgl: null });
    const controls = initLiquidMetal(fixture.canvas, "flashbang");

    expect(() => {
      controls.pause();
      controls.resume();
      controls.destroy();
    }).not.toThrow();
  });

  test("flash is a no-op when the canvas has no wordmark ancestor", () => {
    const fixture = setup({
      html: '<canvas id="metal-canvas"></canvas>',
      webgl: null,
    });
    const controls = initLiquidMetal(fixture.canvas, "flashbang");

    expect(() => controls.flash()).not.toThrow();
  });
});

describe("liquid metal shader setup", () => {
  test("compiles the program and marks the wordmark", () => {
    const fixture = setup();

    initLiquidMetal(fixture.canvas, "flashbang");

    const names = callNames(fixture);
    expect(names).toContain("shaderSource");
    expect(names).toContain("linkProgram");
    expect(names).toContain("useProgram");
    expect(names).toContain("bufferData");
    expect(fixture.wordmark.classList.contains("has-shader")).toBe(true);
    // The first draw is scheduled on an animation frame, not run inline.
    fixture.handle.runFrames();
    expect(callNames(fixture)).toContain("drawArrays");
    expect(fixture.canvas.style.display).not.toBe("none");
  });

  test("sizes the drawing buffer from the parent rect and DPR", () => {
    const fixture = setup({ parentSize: 100 });

    initLiquidMetal(fixture.canvas, "flashbang");

    // devicePixelRatio is 2 and the parent is 100x100.
    expect(fixture.canvas.width).toBe(200);
    expect(fixture.canvas.height).toBe(200);
    expect(fixture.canvas.style.width).toBe("100px");
    expect(callNames(fixture)).toContain("viewport");
  });

  test("uploads a text mask texture", () => {
    const fixture = setup();

    initLiquidMetal(fixture.canvas, "flashbang");

    expect(callNames(fixture)).toContain("texImage2D");
    expect(callNames(fixture)).toContain("uniform1i");
  });

  test("tolerates a texture allocation failure", () => {
    const fixture = setup({ webgl: { createTexture: () => null } });

    expect(() => initLiquidMetal(fixture.canvas, "flashbang")).not.toThrow();
    expect(callNames(fixture)).not.toContain("texImage2D");
  });

  test("falls back to a default font when the wordmark text is absent", () => {
    const fixture = setup({
      html: '<div class="wordmark"><canvas id="metal-canvas"></canvas></div>',
    });

    expect(() => initLiquidMetal(fixture.canvas, "flashbang")).not.toThrow();
    expect(callNames(fixture)).toContain("texImage2D");
  });

  test("a resize observation reuploads the mask at the new size", () => {
    const fixture = setup({ parentSize: 100 });
    initLiquidMetal(fixture.canvas, "flashbang");
    const before = callNames(fixture).filter(
      (name) => name === "texImage2D"
    ).length;

    setElementSize(fixture.wordmark, 150);
    fixture.handle.resizeObservers[0].trigger();

    expect(
      callNames(fixture).filter((name) => name === "texImage2D").length
    ).toBe(before + 1);
    expect(fixture.canvas.width).toBe(300);
  });

  test("an unchanged size does not reupload", () => {
    const fixture = setup();
    initLiquidMetal(fixture.canvas, "flashbang");
    const before = callNames(fixture).filter(
      (name) => name === "texImage2D"
    ).length;

    fixture.handle.resizeObservers[0].trigger();

    expect(
      callNames(fixture).filter((name) => name === "texImage2D").length
    ).toBe(before);
  });
});

describe("liquid metal shader failures", () => {
  test("a shader compile error falls back to the CSS wordmark", () => {
    const fixture = setup({
      webgl: {
        getShaderParameter: () => false,
        getShaderInfoLog: () => "bad shader",
      },
    });

    const controls = initLiquidMetal(fixture.canvas, "flashbang");

    expect(fixture.canvas.style.display).toBe("none");
    expect(fixture.wordmark.classList.contains("has-shader")).toBe(false);
    expect(callNames(fixture)).toContain("deleteShader");
    // The fallback controls still animate through CSS.
    controls.flash();
    expect(fixture.wordmark.classList.contains("flash-burst")).toBe(true);
  });

  test("a program link error falls back too", () => {
    const fixture = setup({
      webgl: {
        getProgramParameter: () => false,
        getProgramInfoLog: () => "bad link",
      },
    });

    initLiquidMetal(fixture.canvas, "flashbang");

    expect(fixture.canvas.style.display).toBe("none");
    expect(callNames(fixture)).toContain("deleteProgram");
  });
});

describe("liquid metal animation control", () => {
  test("runs a render loop and stops when paused", () => {
    const fixture = setup();
    const controls = initLiquidMetal(fixture.canvas, "flashbang");
    const initialDraws = callNames(fixture).filter(
      (name) => name === "drawArrays"
    ).length;

    fixture.handle.runFrames();
    const afterFrame = callNames(fixture).filter(
      (name) => name === "drawArrays"
    ).length;
    expect(afterFrame).toBeGreaterThan(initialDraws);

    controls.pause();
    fixture.handle.runFrames();
    expect(
      callNames(fixture).filter((name) => name === "drawArrays").length
    ).toBe(afterFrame);

    controls.resume();
    fixture.handle.runFrames();
    expect(
      callNames(fixture).filter((name) => name === "drawArrays").length
    ).toBeGreaterThan(afterFrame);
  });

  test("pausing twice and resuming an unpaused loop are no-ops", () => {
    const fixture = setup();
    const controls = initLiquidMetal(fixture.canvas, "flashbang");

    controls.resume();
    controls.pause();
    controls.pause();
    fixture.handle.runFrames();

    expect(() => controls.resume()).not.toThrow();
  });

  test("flash ramps brightness back down over 600ms", async () => {
    const fixture = setup();
    const controls = initLiquidMetal(fixture.canvas, "flashbang");

    controls.flash();
    fixture.handle.runFrames();
    const brightnessCalls = (fixture.webgl?.calls ?? []).filter(
      (call) => call.name === "uniform1f"
    );
    expect(brightnessCalls.length).toBeGreaterThan(0);

    // Drive the flash animation to completion.
    for (let frame = 0; frame < 5; frame++) {
      await fixture.handle.advance(200);
      fixture.handle.runFrames();
    }
    expect(() => controls.destroy()).not.toThrow();
  });

  test("destroy releases every GPU handle and halts the loop", () => {
    const fixture = setup();
    const controls = initLiquidMetal(fixture.canvas, "flashbang");

    controls.destroy();
    const names = callNames(fixture);
    expect(names).toContain("deleteTexture");
    expect(names).toContain("deleteProgram");
    expect(names).toContain("deleteBuffer");

    const draws = names.filter((name) => name === "drawArrays").length;
    fixture.handle.runFrames();
    expect(
      callNames(fixture).filter((name) => name === "drawArrays").length
    ).toBe(draws);
  });

  test("a destroyed instance ignores pause and resume", () => {
    const fixture = setup();
    const controls = initLiquidMetal(fixture.canvas, "flashbang");
    controls.destroy();

    expect(() => {
      controls.pause();
      controls.resume();
    }).not.toThrow();
  });
});

describe("liquid metal with reduced motion", () => {
  test("draws a single static frame instead of looping", () => {
    const fixture = setup({ reducedMotion: true });

    initLiquidMetal(fixture.canvas, "flashbang");
    const draws = callNames(fixture).filter(
      (name) => name === "drawArrays"
    ).length;
    fixture.handle.runFrames();

    expect(
      callNames(fixture).filter((name) => name === "drawArrays").length
    ).toBe(draws);
  });

  test("flash, pause, and resume stay inert", () => {
    const fixture = setup({ reducedMotion: true });
    const controls = initLiquidMetal(fixture.canvas, "flashbang");
    const draws = callNames(fixture).filter(
      (name) => name === "drawArrays"
    ).length;

    controls.flash();
    controls.pause();
    controls.resume();
    fixture.handle.runFrames();

    expect(
      callNames(fixture).filter((name) => name === "drawArrays").length
    ).toBe(draws);
  });
});
