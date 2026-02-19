import { defineConfig, presetUno } from "unocss";

export default defineConfig({
  presets: [presetUno()],
  content: {
    filesystem: ["src/ui/**/*.{html,ts}"],
  },
  theme: {
    colors: {
      text: {
        DEFAULT: "#e8e8f0",
        secondary: "#8888a0",
        hover: "#fff",
      },
      bg: {
        DEFAULT: "#0a0a0f",
        secondary: "#14141e",
        hover: "#1e1e2e",
        active: "#2a2a3a",
      },
      border: "#2e2e44",
      danger: "#f15f6d",
      success: "#4ade80",
      chrome: {
        1: "#6e6e8a",
        2: "#9e9ebe",
        3: "#e0e0f0",
        highlight: "rgba(220, 220, 255, 0.25)",
      },
      glow: "rgba(140, 140, 255, 0.1)",
    },
    fontFamily: {
      sans: [
        "system-ui",
        "-apple-system",
        "BlinkMacSystemFont",
        "'Segoe UI'",
        "Roboto",
        "Oxygen",
        "Ubuntu",
        "Cantarell",
        "'Open Sans'",
        "'Helvetica Neue'",
        "sans-serif",
      ],
      mono: [
        "ui-monospace",
        "SFMono-Regular",
        "Menlo",
        "Monaco",
        "Consolas",
        "'Liberation Mono'",
        "'Courier New'",
        "monospace",
      ],
    },
  },
  safelist: ["opacity-100", "visible", "translate-y-0", "rotate-180", "sm:p-8", "sm:grid-cols-2"],
  preflights: [
    // Design tokens & global resets
    {
      getCSS: ({ theme }) => `
        :root {
          font-family: ${theme.fontFamily.sans};
          font-synthesis: none;
          text-rendering: optimizeLegibility;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }

        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
          scrollbar-width: thin;
          scrollbar-color: ${theme.colors.border} transparent;
        }
        *::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }
        *::-webkit-scrollbar-track {
          background: transparent;
        }
        *::-webkit-scrollbar-thumb {
          background-color: ${theme.colors.border};
          border-radius: 3px;
        }
        *::-webkit-scrollbar-thumb:hover {
          background-color: ${theme.colors.text.secondary};
        }
        *:focus-visible {
          outline: 2px solid ${theme.colors.text.secondary};
          outline-offset: 2px;
        }

        body {
          line-height: 1.5;
          font-size: 16px;
          color: ${theme.colors.text.DEFAULT};
          background: ${theme.colors.bg.DEFAULT};
          overflow-x: hidden;
        }
      `,
    },
    // Component styles
    {
      getCSS: ({ theme }) => `
        input, select {
          background: ${theme.colors.bg.hover};
          border: 1px solid ${theme.colors.chrome[1]};
          color: ${theme.colors.text.DEFAULT};
          font: inherit;
        }
        input::placeholder {
          color: ${theme.colors.text.secondary};
          opacity: 1;
        }
        input:focus, select:focus {
          outline: none;
          border-color: ${theme.colors.chrome[2]};
          box-shadow: 0 0 0 2px rgba(136, 136, 160, 0.25);
        }
        select {
          padding-right: 2.25rem;
          appearance: none;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23aaa' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: right 0.75rem center;
        }
        select option {
          background: ${theme.colors.bg.hover};
          color: ${theme.colors.text.DEFAULT};
        }

        a {
          color: ${theme.colors.text.secondary};
          transition: color 0.15s;
        }
        a:hover {
          color: ${theme.colors.text.hover};
        }

        .wordmark {
          position: relative;
          display: inline-block;
        }
        #metal-canvas {
          position: absolute;
          inset: 0;
        }
        .wordmark-text {
          font-size: clamp(4rem, 15vw, 8rem);
          font-weight: 800;
          letter-spacing: -0.02em;
          line-height: 0.75;
          color: ${theme.colors.chrome[2]};
          visibility: hidden;
        }
        .wordmark.ready .wordmark-text {
          visibility: visible;
        }
        .wordmark.has-shader .wordmark-text {
          visibility: hidden;
        }

        .btn {
          background: linear-gradient(135deg, rgba(200, 200, 220, 1), rgba(150, 150, 170, 1));
          color: #1a1a2e;
          box-shadow:
            0 0.05em 0.05em -0.01em rgba(5, 5, 5, 1),
            0 0.01em 0.01em -0.01em rgba(5, 5, 5, 0.5),
            0.15em 0.3em 0.1em -0.01em rgba(5, 5, 5, 0.25),
            inset 0.025em 0.05em 0.1em 0 rgba(255, 255, 255, 1),
            inset 0.12em 0.12em 0.12em rgba(255, 255, 255, 0.25),
            inset -0.075em -0.25em 0.25em 0.1em rgba(5, 5, 5, 0.25);
        }
        .btn:hover {
          background: linear-gradient(135deg, rgba(215, 215, 235, 1), rgba(165, 165, 185, 1));
        }
        .btn:active {
          background: linear-gradient(135deg, rgba(160, 160, 180, 1), rgba(130, 130, 150, 1));
          transform: scale(0.975);
          box-shadow:
            0.1em 0.15em 0.05em 0 inset rgba(5, 5, 5, 0.75),
            -0.025em -0.03em 0.05em 0.025em inset rgba(5, 5, 5, 0.5),
            0.25em 0.25em 0.2em 0 inset rgba(5, 5, 5, 0.5),
            0 0 0.05em 0.5em inset rgba(255, 255, 255, 0.15);
        }

        .btn-primary {
          background: linear-gradient(135deg, rgba(230, 230, 240, 1), rgba(190, 190, 210, 1));
          color: #1a1a2e;
          box-shadow:
            0 0.05em 0.05em -0.01em rgba(5, 5, 5, 1),
            0 0.01em 0.01em -0.01em rgba(5, 5, 5, 0.5),
            0.15em 0.3em 0.1em -0.01em rgba(5, 5, 5, 0.25),
            inset 0.025em 0.05em 0.1em 0 rgba(255, 255, 255, 1),
            inset 0.12em 0.12em 0.12em rgba(255, 255, 255, 0.25),
            inset -0.075em -0.25em 0.25em 0.1em rgba(5, 5, 5, 0.25);
        }
        .btn-primary:hover {
          background: linear-gradient(135deg, rgba(240, 240, 250, 1), rgba(200, 200, 220, 1));
        }
        .btn-primary:active {
          background: linear-gradient(135deg, rgba(190, 190, 200, 1), rgba(160, 160, 180, 1));
          transform: scale(0.975);
          box-shadow:
            0.1em 0.15em 0.05em 0 inset rgba(5, 5, 5, 0.75),
            -0.025em -0.03em 0.05em 0.025em inset rgba(5, 5, 5, 0.5),
            0.25em 0.25em 0.2em 0 inset rgba(5, 5, 5, 0.5),
            0 0 0.05em 0.5em inset rgba(255, 255, 255, 0.15);
        }

        .btn-danger {
          background: linear-gradient(135deg, #f47a86, #d94452);
          color: #fff;
          box-shadow:
            0 0.05em 0.05em -0.01em rgba(5, 5, 5, 1),
            0 0.01em 0.01em -0.01em rgba(5, 5, 5, 0.5),
            0.15em 0.3em 0.1em -0.01em rgba(5, 5, 5, 0.25),
            inset 0.025em 0.05em 0.1em 0 rgba(255, 255, 255, 0.4),
            inset 0.12em 0.12em 0.12em rgba(255, 255, 255, 0.15),
            inset -0.075em -0.25em 0.25em 0.1em rgba(5, 5, 5, 0.25);
        }
        .btn-danger:hover {
          background: linear-gradient(135deg, #f8929c, #e05565);
        }
        .btn-danger:active {
          background: linear-gradient(135deg, #d94452, #c23040);
          transform: scale(0.975);
          box-shadow:
            0.1em 0.15em 0.05em 0 inset rgba(5, 5, 5, 0.75),
            -0.025em -0.03em 0.05em 0.025em inset rgba(5, 5, 5, 0.5),
            0.25em 0.25em 0.2em 0 inset rgba(5, 5, 5, 0.5),
            0 0 0.05em 0.5em inset rgba(255, 255, 255, 0.15);
        }
      `,
    },
    // Animations & transitions
    {
      getCSS: ({ theme }) => `
        @keyframes flash {
          0%, 100% { background-color: ${theme.colors.bg.secondary}; }
          50% { background-color: ${theme.colors.bg.active}; }
        }
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(-4px); }
          75% { transform: translateX(4px); }
        }
        @keyframes flash-burst {
          0% { filter: brightness(1); }
          50% { filter: brightness(2); }
          100% { filter: brightness(1); }
        }
        .flash-anim {
          animation: flash 0.3s ease-out;
        }
        .shake-anim {
          animation: shake 0.2s ease-in-out;
        }
        .flash-burst {
          animation: flash-burst 0.6s ease-out;
        }

        #gear-btn {
          transition: color 0.15s, background-color 0.15s, transform 0.6s ease;
        }

        #settings-modal {
          transition: opacity 0.2s ease, visibility 0.2s;
        }
        #settings-modal .modal-card {
          transition: transform 0.2s ease;
        }
        #settings-modal.open .modal-card {
          transform: translateY(0);
        }

        @media (prefers-reduced-motion: reduce) {
          .flash-anim,
          .shake-anim,
          .flash-burst {
            animation: none;
          }
          #gear-btn {
            transition: color 0.15s, background-color 0.15s;
          }
          #settings-modal,
          #settings-modal .modal-card {
            transition: none;
          }
        }
      `,
    },
  ],
  shortcuts: {
    card: "rounded-xl bg-bg-secondary p-5",
    btn: "px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 cursor-pointer border-none",
    "btn-primary":
      "px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 cursor-pointer border-none",
    "btn-danger":
      "text-xs px-2 py-1 rounded-lg font-medium transition-all duration-200 cursor-pointer border-none",
    "input-field":
      "w-full px-3 py-2.5 rounded-lg text-text text-sm transition-all duration-150",
    "label-text": "text-sm text-text-secondary",
    "section-title":
      "text-base font-semibold tracking-tight mb-3 text-text",
  },
});
