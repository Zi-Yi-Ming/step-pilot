import { spawn } from 'child_process';

const child = spawn('npx', ['vitest', 'run'], {
  cwd: 'D:/桌面/step-cli-pi/benchmark/tasks/single-file-bug/001-off-by-one/repo',
  shell: true,
  stdio: 'inherit'
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
