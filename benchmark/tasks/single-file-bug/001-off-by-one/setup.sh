#!/bin/bash
set -euo pipefail
TASK_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$TASK_DIR/repo"
mkdir -p "$REPO/src"
# Clean repo contents without removing the directory itself to avoid Windows file locks.
if [ -d "$REPO/.git" ]; then
  find "$REPO" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
else
  if [ -d "$REPO/.git" ]; then find "$REPO" -mindepth 1 -maxdepth 1 -exec rm -rf {} +; else rm -rf "$REPO"; fi
  mkdir -p "$REPO/src"
fi
cd "$REPO"
git init
git config user.email "bench@example.com"
git config user.name "Bench"
mkdir -p src
cat > package.json << 'JSON'
{
  "name": "bench-single-file-bug-001",
  "version": "1.0.0",
  "private": true
}
JSON
cat > src/utils.ts << 'TS'
export function sum(values: number[]): number {
  let total = 0;
  for (let i = 0; i <= values.length; i++) {
    total += values[i];
  }
  return total;
}
TS
cat > vitest.config.ts << 'TS'
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { globals: true } });
TS
cat > src/utils.test.ts << 'TS'
import { sum } from "./utils";
describe("sum", () => {
  it("sums an array", () => {
    expect(sum([1, 2, 3])).toBe(6);
    expect(sum([])).toBe(0);
  });
});
TS
git add -A
git commit -m "init: repo with off-by-one bug"
