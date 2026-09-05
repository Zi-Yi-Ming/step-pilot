#!/bin/bash
set -e

TASK_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="${TASK_DIR}/repo"

rm -rf "$REPO"
mkdir -p "$REPO/src/__tests__"

cat > "$REPO/package.json" << 'EOF'
{
  "name": "feature-spec-001",
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

cat > "$REPO/tsconfig.json" << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
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

cat > "$REPO/src/users.ts" << 'EOF'
// User storage and lookup.
// Partially implemented: findById and create exist.
// Missing: validateExists helper; create does not guard duplicate IDs.

const users = new Map<string, { id: string; name: string; role: 'user' | 'admin' }>();

export function findById(id: string) {
  return users.get(id) ?? null;
}

export function create(user: { id: string; name: string; role: 'user' | 'admin' }) {
  users.set(user.id, user);
  return user;
}

export function clear() {
  users.clear();
}
EOF

cat > "$REPO/src/tasks.ts" << 'EOF'
// Task CRUD and status transitions.
// Partially implemented: basic storage and CRUD methods exist.
// Missing/buggy: no input validation, no user existence check,
// no status machine, no permission checks, no cache/audit integration.

import { findById } from './users.js';

export type Task = {
  id: string;
  title: string;
  description: string;
  status: 'open' | 'in_progress' | 'done';
  createdBy: string;
  assignee: string;
  createdAt: number;
};

class TaskManager {
  private tasks = new Map<string, Task>();

  create(input: Omit<Task, 'id' | 'createdAt'>): Task {
    const task: Task = {
      ...input,
      id: Math.random().toString(36).slice(2),
      createdAt: Date.now(),
    };
    this.tasks.set(task.id, task);
    return task;
  }

  getTask(id: string): Task | null {
    return this.tasks.get(id) ?? null;
  }

  updateStatus(id: string, status: Task['status']): Task | null {
    const task = this.tasks.get(id);
    if (task) {
      task.status = status;
    }
    return task ?? null;
  }

  delete(id: string): boolean {
    return this.tasks.delete(id);
  }

  listByUser(userId: string): Task[] {
    return Array.from(this.tasks.values()).filter(
      (t) => t.assignee === userId || t.createdBy === userId,
    );
  }

  clear() {
    this.tasks.clear();
  }
}

export const taskManager = new TaskManager();
EOF

cat > "$REPO/src/permissions.ts" << 'EOF'
// Permission checks.
// Stub: all checks currently return true.
// Must be implemented to distinguish owner/admin/non-owner.

import { findById } from './users.js';

export function canDelete(task: { createdBy: string }, userId: string): boolean {
  // TODO: implement owner/admin check
  return true;
}

export function canExport(userId: string): boolean {
  // TODO: implement role check
  return true;
}
EOF

cat > "$REPO/src/cache.ts" << 'EOF'
// In-memory cache with TTL.
// Buggy: get() returns undefined on miss instead of null.
// Missing: invalidate method.

type CacheEntry<T> = { value: T; expiresAt: number };

export class Cache {
  private store = new Map<string, CacheEntry<unknown>>();

  set<T>(key: string, value: T, ttlMs: number) {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  invalidate(key: string) {
    // TODO: implement
  }
}
EOF

cat > "$REPO/src/audit.ts" << 'EOF'
// Audit log.
// Stub: record does nothing, list always returns [].
// Must track create, status_change, delete events.

export type AuditEntry = {
  action: 'create' | 'status_change' | 'delete' | 'export';
  userId: string;
  taskId?: string;
  details?: string;
  timestamp: number;
};

const entries: AuditEntry[] = [];

export function record(entry: AuditEntry) {
  // TODO: implement
}

export function list(): AuditEntry[] {
  return entries;
}

export function clear() {
  entries.length = 0;
}
EOF

cat > "$REPO/src/exporter.ts" << 'EOF'
// CSV exporter.
// Stub: returns empty string.
// Missing: permission check, field selection, CSV escaping.

import { taskManager } from './tasks.js';
import { canExport } from './permissions.js';
import { record } from './audit.js';

export function exportTasks(userId: string): string {
  // TODO: check permission, build CSV
  return '';
}
EOF

cat > "$REPO/src/index.ts" << 'EOF'
export { taskManager } from './tasks.js';
export { findById, create as createUser, clear as clearUsers } from './users.js';
export { canDelete, canExport } from './permissions.js';
export { Cache } from './cache.js';
export { record, list, clear as clearAudit } from './audit.js';
export { exportTasks } from './exporter.js';
EOF

cat > "$REPO/src/__tests__/integration.test.ts" << 'EOF'
import { describe, it, expect, beforeEach } from 'vitest';
import {
  taskManager,
  findById,
  create as createUser,
  clearUsers,
  canDelete,
  canExport,
  Cache,
  record,
  list,
  clearAudit,
  exportTasks,
} from '../index.js';

const alice = { id: 'u1', name: 'Alice', role: 'user' as const };
const bob = { id: 'u2', name: 'Bob', role: 'user' as const };
const admin = { id: 'u3', name: 'Admin', role: 'admin' as const };

beforeEach(() => {
  clearUsers();
  taskManager.clear();
  clearAudit();
});

describe('feature-spec-001 integration', () => {
  it('creates task with valid user', () => {
    createUser(alice);
    const task = taskManager.create({
      title: 'Fix bug',
      description: 'desc',
      status: 'open',
      createdBy: alice.id,
      assignee: alice.id,
    });
    expect(task.id).toBeDefined();
    expect(task.title).toBe('Fix bug');
  });

  it('rejects invalid assignee', () => {
    expect(() =>
      taskManager.create({
        title: 'Fix bug',
        description: 'desc',
        status: 'open',
        createdBy: 'u99',
        assignee: 'u99',
      }),
    ).toThrow();
  });

  it('rejects empty title', () => {
    createUser(alice);
    expect(() =>
      taskManager.create({
        title: '',
        description: 'desc',
        status: 'open',
        createdBy: alice.id,
        assignee: alice.id,
      }),
    ).toThrow();
  });

  it('enforces status transition open -> in_progress -> done', () => {
    createUser(alice);
    const task = taskManager.create({
      title: 'Task',
      description: 'desc',
      status: 'open',
      createdBy: alice.id,
      assignee: alice.id,
    });
    taskManager.updateStatus(task.id, 'in_progress');
    taskManager.updateStatus(task.id, 'done');
    expect(() => taskManager.updateStatus(task.id, 'done')).toThrow();
  });

  it('allows admin to delete any task', () => {
    createUser(alice);
    createUser(admin);
    const task = taskManager.create({
      title: 'Task',
      description: 'desc',
      status: 'open',
      createdBy: alice.id,
      assignee: alice.id,
    });
    expect(taskManager.delete(task.id, admin.id)).toBe(true);
  });

  it('denies non-owner non-admin delete', () => {
    createUser(alice);
    createUser(bob);
    const task = taskManager.create({
      title: 'Task',
      description: 'desc',
      status: 'open',
      createdBy: alice.id,
      assignee: alice.id,
    });
    expect(taskManager.delete(task.id, bob.id)).toBe(false);
  });

  it('cache miss returns null', () => {
    const cache = new Cache();
    expect(cache.get('missing')).toBeNull();
  });

  it('invalidates cache on status change', () => {
    createUser(alice);
    const task = taskManager.create({
      title: 'Task',
      description: 'desc',
      status: 'open',
      createdBy: alice.id,
      assignee: alice.id,
    });
    const cache = new Cache();
    cache.set(task.id, task, 60000);
    taskManager.updateStatus(task.id, 'in_progress');
    expect(cache.get(task.id)).toBeNull();
  });

  it('records audit on create', () => {
    createUser(alice);
    taskManager.create({
      title: 'Task',
      description: 'desc',
      status: 'open',
      createdBy: alice.id,
      assignee: alice.id,
    });
    const entries = list();
    expect(entries.filter((e) => e.action === 'create')).toHaveLength(1);
  });

  it('records audit on status change', () => {
    createUser(alice);
    const task = taskManager.create({
      title: 'Task',
      description: 'desc',
      status: 'open',
      createdBy: alice.id,
      assignee: alice.id,
    });
    taskManager.updateStatus(task.id, 'in_progress');
    const entries = list();
    expect(entries.filter((e) => e.action === 'status_change')).toHaveLength(1);
  });

  it('export requires permission', () => {
    createUser(alice);
    createUser(bob);
    const task = taskManager.create({
      title: 'Task',
      description: 'desc',
      status: 'open',
      createdBy: alice.id,
      assignee: alice.id,
    });
    expect(() => exportTasks(bob.id)).toThrow();
  });

  it('exports valid CSV', () => {
    createUser(alice);
    createUser(admin);
    const task = taskManager.create({
      title: 'Fix bug',
      description: 'desc',
      status: 'open',
      createdBy: alice.id,
      assignee: alice.id,
    });
    const csv = exportTasks(admin.id);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('id,title,status,assignee,createdAt');
    expect(lines[1]).toContain(task.id);
    expect(lines[1]).toContain('Fix bug');
  });
});
EOF

cd "$REPO"
git init
git add -A
git commit -m "init: buggy repo for feature-spec-001"

echo "Setup complete"
