// 型チェック・単体テスト・e2e テストを同時に動かし、どれかが失敗したら失敗にする。
// それぞれの出力は、終わったものから順にまとめて表示する (混ざらないように)
import { spawn } from 'node:child_process';

const jobs = [
  ['型チェック', 'npx', ['tsc', '-b']],
  ['単体テスト', 'npx', ['vitest', 'run']],
  ['e2e テスト', 'npx', ['playwright', 'test']],
];
const started = performance.now();
const results = await Promise.all(jobs.map(([label, cmd, args]) => new Promise(resolve => {
  const t0 = performance.now();
  const child = spawn(cmd, args, { env: { ...process.env, FORCE_COLOR: '1' } });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.on('close', code => {
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`\n=== ${label} (${sec} 秒) ${code === 0 ? '成功' : '失敗'} ===\n${out.trimEnd()}`);
    resolve(code === 0);
  });
})));
const ok = results.every(Boolean);
console.log(`\n${ok ? 'すべて成功' : '失敗あり'} (全体 ${((performance.now() - started) / 1000).toFixed(1)} 秒)`);
process.exit(ok ? 0 : 1);
