#!/bin/bash
set -e

TASK_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="${TASK_DIR}/repo"

rm -rf "$REPO"
mkdir -p "$REPO/src"

cat > "$REPO/src/parser.ts" << 'EOF'
export function parseJSON(input: string): any {
  return JSON.stringify(JSON.parse(input));
}
EOF

cat > "$REPO/src/filter.ts" << 'EOF'
import { parseJSON } from './parser';

export function filterActive(items: any[]): number[] {
  return items.filter(item => item.isActive).map(item => item.id);
}
EOF

cat > "$REPO/src/formatter.ts" << 'EOF'
export function formatOutput(ids: number[]): string {
  return `<div>${ids.join(' | ')}</div>`;
}
EOF

cat > "$REPO/src/cascade.test.ts" << 'EOF'
import { parseJSON } from './parser';
import { filterActive } from './filter';
import { formatOutput } from './formatter';

describe('cascading bugs', () => {
  it('parses json correctly', () => {
    expect(parseJSON('[1,2]')).toEqual([1,2]);
  });

  it('filters active items', () => {
    const data = parseJSON('[{"id":1,"active":true},{"id":2,"active":false}]');
    const ids = filterActive(data);
    expect(ids).toEqual([1]);
  });

  it('formats output', () => {
    const data = parseJSON('[{"id":1,"active":true},{"id":2,"active":false},{"id":3,"active":true}]');
    const ids = filterActive(data);
    expect(formatOutput(ids)).toBe('<div>1, 3</div>');
  });
});
EOF

cat > "$REPO/package.json" << 'EOF'
{
  "name": "cascading-fix-001",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^1.0.0"
  }
}
EOF

cat > "$REPO/vitest.config.ts" << 'EOF'
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
  },
});
EOF

cd "$REPO"
git init
git add -A
git commit -m "init: repo with 3 cascading bugs"

echo "Setup complete"
