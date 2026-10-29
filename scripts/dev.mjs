// Runs the API server (with reload) and the web dev server together.
// Open http://localhost:5173. Data goes in ./data unless LARDER_DATA_DIR is set.
import { spawn } from 'node:child_process';

const env = { ...process.env, LARDER_AUTH: process.env.LARDER_AUTH ?? 'none', LARDER_LOG_LEVEL: process.env.LARDER_LOG_LEVEL ?? 'info' };
const procs = [
  spawn('npx', ['tsx', 'watch', '--clear-screen=false', 'src/server/main.ts'], { stdio: 'inherit', env: { ...env, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' } }),
  spawn('npx', ['vite', '--config', 'src/web/vite.config.ts'], { stdio: 'inherit', env }),
];
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => { if (code) { stop(); process.exit(code); } }));
