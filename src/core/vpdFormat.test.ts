import { describe, expect, it } from 'vitest';
import { encodeShiftJis } from './sjis';
import { decodeMmdText, formatVpd, parseVpd } from './vpdFormat';

// MMD で保存した .vpd と同じ書式 (左手系)。右腕を z 軸まわりに 30° (MMD の向き)、センターを z に 2 動かしている
const MMD_SAMPLE = [
  'Vocaloid Pose Data file',
  '',
  'miku.osm;\t\t// 親ファイル名',
  '2;\t\t\t\t// 総ポーズボーン数',
  '',
  'Bone0{センター',
  '  0.000000,1.000000,2.000000;\t\t\t\t// trans x,y,z',
  '  0.000000,0.000000,0.000000,1.000000;\t\t// Quaternion x,y,z,w',
  '}',
  '',
  'Bone1{右腕',
  '  0.000000,0.000000,0.000000;\t\t\t\t// trans x,y,z',
  `  0.000000,0.000000,${Math.sin(Math.PI / 12).toFixed(6)},${Math.cos(Math.PI / 12).toFixed(6)};\t\t// Quaternion x,y,z,w`,
  '}',
  '',
  'Morph0{まばたき',
  '  0.750000;\t\t\t\t// weight',
  '}',
  '',
].join('\r\n');

describe('parseVpd', () => {
  it('MMD の .vpd を読み、左手系から右手系に直す (位置の z を反転、z 軸まわりの回転はそのまま)', () => {
    const pose = parseVpd(MMD_SAMPLE)!;
    expect(pose.bones.map(b => b.name)).toEqual(['センター', '右腕']);
    expect(pose.bones[0].value).toMatchObject({ px: 0, py: 1, pz: -2 });
    expect(pose.bones[1].value.rz).toBeCloseTo(30);
    expect(pose.bones[1].value.rx).toBeCloseTo(0);
    expect(pose.morphs).toEqual([{ name: 'まばたき', weight: 0.75 }]);
  });

  it('.vpd でなければ null', () => {
    expect(parseVpd('hello')).toBeNull();
  });
});

describe('formatVpd', () => {
  it('書き出して読み直すと同じ値に戻る', () => {
    const pose = {
      bones: [
        { name: '左足ＩＫ', value: { rx: 10, ry: -20, rz: 30, px: 0.5, py: -1, pz: 2 } },
        { name: '頭', value: { rx: 0, ry: 45, rz: 0, px: 0, py: 0, pz: 0 } },
      ],
      morphs: [{ name: 'あ', weight: 0.25 }],
    };
    const back = parseVpd(formatVpd('ミク', pose))!;
    expect(back.morphs).toEqual(pose.morphs);
    back.bones.forEach((b, i) => {
      expect(b.name).toBe(pose.bones[i].name);
      for (const k of ['rx', 'ry', 'rz', 'px', 'py', 'pz'] as const) expect(b.value[k]).toBeCloseTo(pose.bones[i].value[k], 3); // ファイルは小数 6 桁
    });
  });

  it('MMD と同じ見出しと、ボーンの数を書く', () => {
    const text = formatVpd('ミク', { bones: [], morphs: [] });
    expect(text.split('\r\n').slice(0, 4)).toEqual(['Vocaloid Pose Data file', '', 'ミク.osm;\t\t// 親ファイル名', '0;\t\t\t\t// 総ポーズボーン数']);
  });
});

describe('decodeMmdText', () => {
  it('Shift-JIS でも UTF-8 でも読める', () => {
    const sjis = encodeShiftJis(MMD_SAMPLE);
    expect(decodeMmdText(sjis.buffer as ArrayBuffer)).toBe(MMD_SAMPLE);
    expect(decodeMmdText(new TextEncoder().encode(MMD_SAMPLE).buffer as ArrayBuffer)).toBe(MMD_SAMPLE);
  });
});
