// 2D simplex noise: Stefan Gustavson, public domain

const VERT = /*glsl*/ `#version 300 es
precision highp float;
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 1.0 - (a_pos.y * 0.5 + 0.5));
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = /*glsl*/ `#version 300 es
precision highp float;

uniform sampler2D u_mask;
uniform float u_time;
uniform float u_brightness;
uniform vec2 u_resolution;

in vec2 v_uv;
out vec4 fragColor;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 10.0) * x); }

float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                      -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                            + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy),
                           dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x_ = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x_) - 0.5;
  vec3 ox = floor(x_ + 0.5);
  vec3 a0 = x_ - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float metalStripe(vec2 uv, float angle, float density, float softness, float distort, float edge, float time) {
  float c = cos(angle), s = sin(angle);
  vec2 rotUV = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c);

  float n = snoise(uv * 3.0 + time * 0.15) * distort;
  n += edge * 0.3 * snoise(uv * 5.0 - time * 0.1);

  float stripe = rotUV.x * density + n;
  float pattern = smoothstep(0.5 - softness, 0.5 + softness, fract(stripe));

  float fine = smoothstep(0.4, 0.6, fract(stripe * 2.7 + 0.3));
  pattern = mix(pattern, fine, 0.15);

  return pattern;
}

vec3 colorBurn(vec3 base, vec3 blend) {
  return vec3(
    blend.r > 0.0 ? 1.0 - min(1.0, (1.0 - base.r) / blend.r) : 0.0,
    blend.g > 0.0 ? 1.0 - min(1.0, (1.0 - base.g) / blend.g) : 0.0,
    blend.b > 0.0 ? 1.0 - min(1.0, (1.0 - base.b) / blend.b) : 0.0
  );
}

void main() {
  vec2 uv = v_uv;

  // R = blurred edge gradient, G = sharp alpha
  vec4 mask = texture(u_mask, uv);
  float edge = mask.r;
  float alpha = mask.g;

  if (alpha < 0.01) {
    fragColor = vec4(0.0);
    return;
  }

  float time = u_time;

  float stripe = metalStripe(uv, 0.785, 3.0, 0.3, 0.15, edge, time);
  float metalBase = mix(0.30, 0.95, stripe);

  float shift = 0.012;
  float edgeShift = shift + edge * 0.008;
  float stripeR = metalStripe(uv + vec2(edgeShift, edgeShift * 0.5), 0.785, 3.0, 0.3, 0.15, edge, time);
  float stripeB = metalStripe(uv - vec2(edgeShift, edgeShift * 0.5), 0.785, 3.0, 0.3, 0.15, edge, time);

  vec3 metal = vec3(
    mix(0.35, 1.0, stripeR),
    metalBase,
    mix(0.35, 1.0, stripeB)
  );

  vec3 tint = vec3(0.4, 0.4, 0.6);
  vec3 burned = colorBurn(metal, tint);
  metal = mix(metal, burned, 0.3);

  vec2 centered = uv - 0.5;
  float bump = 1.0 - pow(length(centered) * 1.6, 1.2);
  bump = clamp(bump, 0.0, 1.0);
  metal *= 0.85 + 0.15 * bump;

  float edgeHighlight = smoothstep(0.15, 0.5, edge) * (1.0 - smoothstep(0.5, 0.85, edge));
  metal += edgeHighlight * 0.12;

  float sweepPos = fract(time * 0.08);
  float sweep = smoothstep(-0.3, 0.0, uv.x - sweepPos) *
                (1.0 - smoothstep(0.0, 0.3, uv.x - sweepPos));
  metal += sweep * 0.2;

  metal *= u_brightness;
  float dither = (fract(sin(dot(uv * u_resolution, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  metal += dither;

  fragColor = vec4(metal * alpha, alpha);
}`;

interface LiquidMetalControls {
  destroy: () => void;
  flash: () => void;
}

function createTextMaskTexture(
  gl: WebGL2RenderingContext,
  text: string,
  font: string,
  width: number,
  height: number,
): WebGLTexture {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.font = font;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, height / 2);
  const sharp = ctx.getImageData(0, 0, width, height);

  ctx.filter = 'blur(6px)';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, width / 2, height / 2);
  ctx.filter = 'none';
  const blurred = ctx.getImageData(0, 0, width, height);

  // Pack channels: R = edge gradient (blurred), G = alpha (sharp)
  const packed = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    packed[i * 4 + 0] = blurred.data[i * 4 + 0];
    packed[i * 4 + 1] = sharp.data[i * 4 + 0];
    packed[i * 4 + 2] = 0;
    packed[i * 4 + 3] = 255;
  }

  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, packed);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return tex;
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`Shader compile error: ${info}`);
  }
  return s;
}

function createProgram(gl: WebGL2RenderingContext, vert: string, frag: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vert));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`Program link error: ${info}`);
  }
  return p;
}

export function initLiquidMetal(
  canvas: HTMLCanvasElement,
  text: string,
  font: string,
): LiquidMetalControls {
  const maybeGl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false });
  if (!maybeGl) return fallback(canvas);
  const gl: WebGL2RenderingContext = maybeGl;

  const program = createProgram(gl, VERT, FRAG);
  gl.useProgram(program);

  const buf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const uTime = gl.getUniformLocation(program, 'u_time');
  const uBrightness = gl.getUniformLocation(program, 'u_brightness');
  const uResolution = gl.getUniformLocation(program, 'u_resolution');
  const uMask = gl.getUniformLocation(program, 'u_mask');

  let brightness = 1.0;
  let rafId = 0;
  let startTime = performance.now();

  function resize() {
    const rect = canvas.parentElement!.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      gl.viewport(0, 0, w, h);

      const tex = createTextMaskTexture(gl, text, font, w, h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(uMask, 0);
      gl.uniform2f(uResolution, w, h);
    }
  }

  const ro = new ResizeObserver(resize);
  ro.observe(canvas.parentElement!);
  resize();

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function render() {
    const t = (performance.now() - startTime) / 1000;
    gl.uniform1f(uTime, t);
    gl.uniform1f(uBrightness, brightness);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (!reducedMotion) {
      rafId = requestAnimationFrame(render);
    }
  }

  if (reducedMotion) {
    gl.uniform1f(uTime, 0);
    gl.uniform1f(uBrightness, 1.0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  } else {
    rafId = requestAnimationFrame(render);
  }

  return {
    destroy() {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      gl.deleteProgram(program);
      gl.deleteBuffer(buf);
    },
    flash() {
      if (reducedMotion) return;
      brightness = 3.0;
      const flashStart = performance.now();
      function animFlash() {
        const elapsed = performance.now() - flashStart;
        const progress = Math.min(elapsed / 600, 1);
        brightness = 1.0 + 2.0 * (1 - progress) * (1 - progress);
        if (progress < 1) requestAnimationFrame(animFlash);
      }
      requestAnimationFrame(animFlash);
    },
  };
}

function fallback(canvas: HTMLCanvasElement): LiquidMetalControls {
  canvas.style.display = 'none';
  return {
    destroy() {},
    flash() {
      const wm = canvas.closest('.wordmark');
      if (wm) {
        wm.classList.remove('flash-burst');
        void (wm as HTMLElement).offsetWidth;
        wm.classList.add('flash-burst');
        setTimeout(() => wm.classList.remove('flash-burst'), 600);
      }
    },
  };
}
