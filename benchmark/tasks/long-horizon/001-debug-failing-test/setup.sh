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
  "name": "bench-long-horizon-001",
  "version": "1.0.0",
  "private": true,
  "type": "module"
}
JSON
cat > src/checkout.ts << 'TS'
export function total(items: { price: number; qty: number }[]): number {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}
export function discountTotal(items: { price: number; qty: number }[], discount: number): number {
  const raw = total(items);
  return raw - discount;
}
TS
cat > vitest.config.ts << 'TS'
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { globals: true } });
TS
cat > src/__tests__/checkout.test.ts << 'TS'
import { total, discountTotal } from "../checkout";
describe("checkout", () => {
  it("totals items", () => {
    expect(total([{ price: 10, qty: 2 }])).toBe(20);
  });
  it("applies discount", () => {
    expect(discountTotal([{ price: 10, qty: 2 }], 5)).toBe(15);
  });
  it("does not apply discount above total", () => {
    expect(discountTotal([{ price: 10, qty: 2 }], 30)).toBe(0);
  });
});
TS
git add -A
git commit -m "init: repo with failing checkout test"
