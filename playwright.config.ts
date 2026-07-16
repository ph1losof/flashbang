import { defineConfig, devices } from "@playwright/test";

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function resolveE2EPort(): number {
  const fromEnv = Number(process.env.E2E_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv <= 65535) {
    return fromEnv;
  }

  return 40_000 + (hashString(process.cwd()) % 20_000);
}

const PORT = resolveE2EPort();
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: BASE_URL,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      grep: /suggest endpoint|Firefox locks|opensearch endpoint|suggestions include custom|homepage bang finder|compact address-bar setup|default provider labels|settings persist suggest provider none|settings persist custom bang creation|settings reject invalid|warm redirect/,
    },
  ],
  webServer: {
    command: "bun run start",
    env: {
      ...process.env,
      ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS: "true",
      PORT: String(PORT),
    },
    url: `${BASE_URL}/health`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
