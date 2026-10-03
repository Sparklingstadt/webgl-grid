import type { AddonModule } from '../engine/addons/Addons';

interface Settings { enabled: boolean; degPerSec: number }

// --- ターンテーブル: 再生中とアニメーションのレンダリング中に、カメラを注視点のまわりで回す ---
// (場面の値・シーンのタブのパネル・MCP の命令を使う例)
const turntable: AddonModule = {
  id: 'turntable',
  name: 'ターンテーブル',
  version: '1.0.0',
  author: 'webgl-grid',
  category: 'カメラ',
  description: '再生中とアニメーションのレンダリング中に、カメラを注視点のまわりで回します。設定はサイドバーの「シーン」にあります。',
  register(api) {
    const { engine } = api;
    const settings = api.addSceneData<Settings>({
      key: 'settings', label: 'ターンテーブル', default: { enabled: false, degPerSec: 30 },
      normalize: raw => {
        const r = (raw ?? {}) as Partial<Settings>;
        return { enabled: !!r.enabled, degPerSec: Number.isFinite(r.degPerSec) ? Number(r.degPerSec) : 30 };
      },
    });
    const patch = (p: Partial<Settings>) => settings.set({ ...settings.get(), ...p });
    // タイムラインの時刻が進んだぶんだけ回す (動画のレンダリングでも、1 フレームずつ回る)
    let last: number | null = null;
    api.onBeforeRender(() => {
      const s = settings.get(), t = engine.clock.t;
      const moving = s.enabled && (engine.clock.playing || engine.output.active) && !engine.camera.override;
      if (moving && last !== null && Math.abs(t - last) < 0.5) {
        engine.camera.cam.yaw += (t - last) * s.degPerSec * Math.PI / 180;
        engine.camera.update();
      }
      last = moving ? t : null;
    });
    api.addPanel({
      title: 'ターンテーブル', tab: 'scene',
      props: () => [
        { type: 'boolean', label: 'カメラを回す', get: () => settings.get().enabled, set: enabled => patch({ enabled }) },
        { type: 'number', label: '速さ', unit: '°/秒', min: -180, max: 180, step: 1, digits: 0, get: () => settings.get().degPerSec, set: degPerSec => patch({ degPerSec }) },
        { type: 'text', text: '再生中とアニメーションのレンダリング中に回ります (カメラモーションがあるときは回しません)。' },
      ],
    });
    api.addCommand('set', {
      description: 'ターンテーブルの設定を変える (渡したところだけ)',
      params: { enabled: '回すか (true / false)', degPerSec: '1 秒に回す角度 (度。マイナスで逆回り)' },
      run: p => {
        patch({
          ...(p.enabled !== undefined ? { enabled: !!p.enabled } : {}),
          ...(p.degPerSec !== undefined ? { degPerSec: Number(p.degPerSec) } : {}),
        });
        return settings.get();
      },
    });
  },
};
export default turntable;
