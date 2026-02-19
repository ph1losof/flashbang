// 2D simplex noise: Stefan Gustavson, public domain

const VERT = /*glsl*/ `#version 300 es
precision highp float;in vec2 a_pos;out vec2 V;void main(){V=vec2(a_pos.x*.5+.5,1.-(a_pos.y*.5+.5));gl_Position=vec4(a_pos,0.,1.);}`;

const FRAG = /*glsl*/ `#version 300 es
precision highp float;uniform sampler2D u_mask;uniform float u_time;uniform float u_brightness;uniform vec2 u_resolution;in vec2 V;out vec4 O;vec3 M(vec3 x){return x-floor(x*(1./289.))*289.;}vec2 M(vec2 x){return x-floor(x*(1./289.))*289.;}vec3 P(vec3 x){return M(((x*34.)+10.)*x);}float N(vec2 v){const vec4 C=vec4(.211324865405187,.366025403784439,-.577350269189626,.024390243902439);vec2 i=floor(v+dot(v,C.yy));vec2 x0=v-i+dot(i,C.xx);vec2 i1=(x0.x>x0.y)?vec2(1.,0.):vec2(0.,1.);vec4 x12=x0.xyxy+C.xxzz;x12.xy-=i1;i=M(i);vec3 p=P(P(i.y+vec3(0.,i1.y,1.))+i.x+vec3(0.,i1.x,1.));vec3 m=max(.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.);m=m*m;m=m*m;vec3 x_=2.*fract(p*C.www)-1.;vec3 h=abs(x_)-.5;vec3 ox=floor(x_+.5);vec3 a0=x_-ox;m*=1.79284291400159-.85373472095314*(a0*a0+h*h);vec3 g;g.x=a0.x*x0.x+h.x*x0.y;g.yz=a0.yz*x12.xz+h.yz*x12.yw;return 130.*dot(m,g);}float S(vec2 uv,float a,float d,float s,float di,float e,float t){float c=cos(a),si=sin(a);vec2 r=vec2(uv.x*c-uv.y*si,uv.x*si+uv.y*c);float n=N(uv*3.+t*.15)*di;n+=e*.3*N(uv*5.-t*.1);float st=r.x*d+n;float p=smoothstep(.5-s,.5+s,fract(st));float f=smoothstep(.4,.6,fract(st*2.7+.3));p=mix(p,f,.15);return p;}vec3 B(vec3 b,vec3 l){return vec3(l.r>0.?1.-min(1.,(1.-b.r)/l.r):0.,l.g>0.?1.-min(1.,(1.-b.g)/l.g):0.,l.b>0.?1.-min(1.,(1.-b.b)/l.b):0.);}void main(){vec2 uv=V;vec4 mk=texture(u_mask,uv);float e=mk.r;float a=mk.g;if(a<.01){O=vec4(0.);return;}float t=u_time;float st=S(uv,.785,3.,.3,.15,e,t);float mb=mix(.3,.95,st);float sh=.012;float es=sh+e*.008;float sR=S(uv+vec2(es,es*.5),.785,3.,.3,.15,e,t);float sB=S(uv-vec2(es,es*.5),.785,3.,.3,.15,e,t);vec3 m=vec3(mix(.35,1.,sR),mb,mix(.35,1.,sB));vec3 ti=vec3(.4,.4,.6);vec3 bu=B(m,ti);m=mix(m,bu,.3);vec2 ce=uv-.5;float bp=1.-pow(length(ce)*1.6,1.2);bp=clamp(bp,0.,1.);m*=.85+.15*bp;float eh=smoothstep(.15,.5,e)*(1.-smoothstep(.5,.85,e));m+=eh*.12;float sp=fract(t*.08);float sw=smoothstep(-.3,0.,uv.x-sp)*(1.-smoothstep(0.,.3,uv.x-sp));m+=sw*.2;m*=u_brightness;float d=(fract(sin(dot(uv*u_resolution,vec2(12.9898,78.233)))*43758.5453)-.5)/255.;m+=d;O=vec4(m*a,a);}`;

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
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.font = font;
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, width / 2, height / 2);
  const sharp = ctx.getImageData(0, 0, width, height);

  ctx.filter = "blur(6px)";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#fff";
  ctx.fillText(text, width / 2, height / 2);
  ctx.filter = "none";
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
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    packed,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return tex;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
): WebGLShader {
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

function createProgram(
  gl: WebGL2RenderingContext,
  vert: string,
  frag: string,
): WebGLProgram {
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

function getWordmarkFont(canvas: HTMLCanvasElement): string {
  const wordmarkText = canvas.parentElement?.querySelector(
    ".wordmark-text",
  ) as HTMLElement | null;
  if (wordmarkText) {
    const style = getComputedStyle(wordmarkText);
    return `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  }
  return '800 128px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
}

export function initLiquidMetal(
  canvas: HTMLCanvasElement,
  text: string,
): LiquidMetalControls {
  const maybeGl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: false,
  });
  if (!maybeGl) return fallback(canvas);
  const gl: WebGL2RenderingContext = maybeGl;

  const program = createProgram(gl, VERT, FRAG);
  gl.useProgram(program);

  const buf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const aPos = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const uTime = gl.getUniformLocation(program, "u_time");
  const uBrightness = gl.getUniformLocation(program, "u_brightness");
  const uResolution = gl.getUniformLocation(program, "u_resolution");
  const uMask = gl.getUniformLocation(program, "u_mask");

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
      canvas.style.width = rect.width + "px";
      canvas.style.height = rect.height + "px";
      gl.viewport(0, 0, w, h);

      const tex = createTextMaskTexture(
        gl,
        text,
        getWordmarkFont(canvas),
        w,
        h,
      );
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

  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

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
  canvas.style.display = "none";
  return {
    destroy() {},
    flash() {
      const wm = canvas.closest(".wordmark");
      if (wm) {
        wm.classList.remove("flash-burst");
        void (wm as HTMLElement).offsetWidth;
        wm.classList.add("flash-burst");
        setTimeout(() => wm.classList.remove("flash-burst"), 600);
      }
    },
  };
}
