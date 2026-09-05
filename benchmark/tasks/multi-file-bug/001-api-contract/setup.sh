#!/bin/bash
set -euo pipefail
TASK_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$TASK_DIR/repo"
if [ -d "$REPO/.git" ]; then find "$REPO" -mindepth 1 -maxdepth 1 -exec rm -rf {} +; else rm -rf "$REPO"; fi
mkdir -p "$REPO/src" "$REPO/src/__tests__"
cd "$REPO"
git init
git config user.email "bench@example.com"
git config user.name "Bench"
cat > package.json << 'JSON'
{
  "name": "bench-multi-file-bug-001",
  "version": "1.0.0",
  "private": true,
  "type": "module"
}
JSON
cat > src/server.ts << 'TS'
export type UserResponse = {
  id: string;
  fullName: string;
  email: string;
};
export function formatUser(user: { id: string; first: string; last: string; email: string }): UserResponse {
  return {
    id: user.id,
    fullName: `${user.first} ${user.last}`,
    email: user.email,
  };
}
TS
cat > src/client.ts << 'TS'
import { formatUser } from "./server";
export function renderProfile(user: { id: string; first: string; last: string; email: string }) {
  const data = formatUser(user);
  return `# ${data.name}\n${data.email}`;
}
TS
cat > vitest.config.ts << 'TS'
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { globals: true } });
TS
cat > src/__tests__/client.test.ts << 'TS'
import { renderProfile } from "../client";
describe("renderProfile", () => {
  it("renders profile", () => {
    expect(renderProfile({ id: "1", first: "A", last: "B", email: "a@b" })).toBe("# A B\na@b");
  });
});
TS
git add -A
git commit -m "init: repo with API contract mismatch"
