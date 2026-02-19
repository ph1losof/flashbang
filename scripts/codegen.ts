import { $ } from 'bun';

console.log('=== Fetch bang sources ===');
await $`mkdir -p data`;
await $`curl -sfo data/kagi.json https://raw.githubusercontent.com/kagisearch/bangs/main/data/bangs.json`;
await $`curl -sfo data/ddg.json https://duckduckgo.com/bang.js`;

console.log('=== Rust: merge + generate ===');
await $`mkdir -p src/generated`;
await $`cargo run --manifest-path build/Cargo.toml --release -- --kagi data/kagi.json --ddg data/ddg.json --custom config/custom.toml --out src/generated`;
