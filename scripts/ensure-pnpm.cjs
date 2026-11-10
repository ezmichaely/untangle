#!/usr/bin/env node
const ua = process.env.npm_config_user_agent || "";
if (!ua.includes("pnpm")) {
  console.error(
    "\nThis repository uses pnpm only.\n\n  corepack enable\n  pnpm install\n",
  );
  process.exit(1);
}
