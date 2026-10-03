// --- webgl-grid のアドオンの例 ---
// 編集 > プリファレンス… の「ファイルからインストール…」でこのファイルを選ぶと、インストールして有効になります。
// アドオンは、id・名前などと register(api) を持つオブジェクトを export default する ES モジュールです。
// (three.js が要るときは import せずに api.THREE を使ってください。アプリと同じ three.js です)
export default {
  id: 'hello',
  name: 'ハロー',
  version: '1.0.0',
  author: 'webgl-grid',
  category: '例',
  description: 'アドオンの書き方の例: 追加メニュー・自分のタブのパネル・MCP の命令を足します。',

  register(api) {
    const { engine } = api;
    let count = 0;

    // 追加メニュー: 画面の中央の右に、立方体を 5 段積む
    api.addMenuItem({
      menu: 'add',
      label: '立方体の塔 (5 段)',
      enabled: () => !engine.world.full,
      run() {
        const { tx, tz } = engine.camera.cam;
        for (let i = 0; i < 5 && !engine.world.full; i++) {
          const o = engine.world.addShape(0, tx + 2.5, tz, i % 8);
          engine.world.dropIn(o); // 重なったら上に積む
        }
        engine.viewport.requestDraw();
      },
    });

    // サイドバーに「ハロー」のタブを作り、パネルを出す。
    // props はアプリの部品で描く設定の一覧、draw は自分で要素を作る
    api.addPanel({
      title: 'ハロー',
      tab: 'ハロー',
      props: () => [{ type: 'text', text: `置いてある物: ${engine.world.objects.length} 個` }],
      draw(el) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bbtn';
        b.textContent = 'あいさつする';
        b.onclick = () => api.toast(`こんにちは (${++count} 回目)`);
        el.append(b);
      },
    });

    // MCP の命令 (run_command で "hello.greet" として呼べる)
    api.addCommand('greet', {
      description: 'あいさつを返す',
      params: { name: '名前' },
      run: p => `こんにちは、${p.name ?? '世界'}`,
    });

    // 切るときに呼ばれる (足したメニュー・パネル・命令は、アプリが外す)
    return () => {};
  },
};
