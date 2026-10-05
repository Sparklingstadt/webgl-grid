import { describe, expect, it } from 'vitest';
import { encodeShiftJis } from '../sjis.ts';
import { decodeEmm, encodeEmm, matchFxPath, parseEmm, writeEmm, type EmmDoc } from './emm.ts';

// 自作の .emm (MME の書式: docs/superpowers/notes/2026-10-05-emm-format.md)。Main とオフスクリーン 1 つ、物 3 つ
// (モデル・アクセサリ・場面にないモデル)、材質ごとの割り当て、非表示、Windows の絶対パス
const SAMPLE = [
  '[Info]',
  'Version = 3',
  '',
  '[Object]',
  'Pmd1 = C:\\MMD\\UserFile\\Model\\初音ミク.pmx',
  'Acs2 = C:\\MMD\\ray-mmd-1.5.2\\ray.x',
  'Pmd3 = D:\\Models\\Absent.pmx',
  '',
  '[Effect]',
  'Default = none',
  'Pmd1 = C:\\MMD\\ray-mmd-1.5.2\\Main\\main.fx',
  'Pmd1[2] = none',
  'Pmd1[3].show = false',
  'Acs2 = C:\\MMD\\ray-mmd-1.5.2\\ray.fx',
  'Pmd3 = none',
  'Pmd3.show = false',
  '',
  '[Effect@MaterialMap]',
  'Owner = Acs2',
  'Acs2.show = false',
  'Pmd1 = C:\\MMD\\ray-mmd-1.5.2\\Materials\\material_2.0.fx',
  'Pmd1[0] = C:\\MMD\\ray-mmd-1.5.2\\Materials\\Skin\\material_skin.fx',
  'Pmd1.show = true',
  'Pmd3 = C:\\MMD\\ray-mmd-1.5.2\\Materials\\material_2.0.fx',
  '',
].join('\r\n');

describe('parseEmm', () => {
  it('節・物・タブの割り当て (値と .show をまとめる)・Owner を読む', () => {
    const { doc, warnings } = parseEmm(SAMPLE);
    expect(warnings).toEqual([]);
    expect(doc.objects).toEqual([
      { index: 1, file: 'C:\\MMD\\UserFile\\Model\\初音ミク.pmx' },
      { index: 2, file: 'C:\\MMD\\ray-mmd-1.5.2\\ray.x' },
      { index: 3, file: 'D:\\Models\\Absent.pmx' },
    ]);
    expect(doc.tabs).toEqual({
      Main: [
        { object: 1, material: null, value: 'C:\\MMD\\ray-mmd-1.5.2\\Main\\main.fx' },
        { object: 1, material: 2, value: 'none' },
        { object: 1, material: 3, value: 'none', show: false },
        { object: 2, material: null, value: 'C:\\MMD\\ray-mmd-1.5.2\\ray.fx' },
        { object: 3, material: null, value: 'none', show: false },
      ],
      MaterialMap: [
        { object: 1, material: null, value: 'C:\\MMD\\ray-mmd-1.5.2\\Materials\\material_2.0.fx', show: true },
        { object: 1, material: 0, value: 'C:\\MMD\\ray-mmd-1.5.2\\Materials\\Skin\\material_skin.fx' },
        { object: 2, material: null, value: 'none', show: false },
        { object: 3, material: null, value: 'C:\\MMD\\ray-mmd-1.5.2\\Materials\\material_2.0.fx' },
      ],
    });
    expect(doc.owners).toEqual({ MaterialMap: { object: 2 } });
  });

  it('自作の .emm も読めるように緩く読む: 大文字小文字・空白・/・引用符・コメント・Obj・値の hide', () => {
    const text = [
      '; 自作',
      '  [INFO]  ',
      'version=3',
      '[object]',
      '# コメント',
      'obj1   =   "models/a.pmx"  ',
      'ACS2=b.x',
      '[EFFECT]',
      'OBJ1 [ 1 ] = fx/x.fx',
      'obj1 [1] . SHOW = FALSE',
      'acs2=HIDE',
      '[effect@ShadowMap]',
      'owner = pmd1@Main',
      'Obj1 = NONE',
    ].join('\n');
    const { doc, warnings } = parseEmm(text);
    expect(warnings).toEqual([]);
    expect(doc.objects).toEqual([{ index: 1, file: 'models/a.pmx' }, { index: 2, file: 'b.x' }]);
    expect(doc.tabs).toEqual({
      Main: [{ object: 1, material: 1, value: 'fx/x.fx', show: false }, { object: 2, material: null, value: 'hide' }],
      ShadowMap: [{ object: 1, material: null, value: 'none' }],
    });
    expect(doc.owners).toEqual({ ShadowMap: { object: 1 } }); // (@Main は Main で宣言したもの = @ なし)
  });

  it('同じ名前のオフスクリーンの 2 つめ以降 (名前(k)) は同じタブにまとめ、同じ物・材質は先の節のものを使う', () => {
    const text = [
      '[Object]', 'Pmd1 = a.pmx', 'Pmd2 = b.pmx',
      '[Effect@VolumetricMap]', 'Owner = Pmd1', 'Pmd1 = first.fx',
      '[Effect@VolumetricMap(1)]', 'Owner = Pmd2', 'Pmd1 = second.fx', 'Pmd2 = other.fx',
    ].join('\r\n');
    const { doc, warnings } = parseEmm(text);
    expect(warnings).toEqual([]);
    expect(doc.tabs).toEqual({ VolumetricMap: [{ object: 1, material: null, value: 'first.fx' }, { object: 2, material: null, value: 'other.fx' }] });
    expect(doc.owners).toEqual({ VolumetricMap: { object: 1 } });
  });

  it('読めない行・知らない Version・[Object] にない物の割り当ては警告にまとめ、残りは読む', () => {
    const text = [
      '[Info]', 'Version = 4',
      'stray line',
      '[Object]', 'Pmd1 = a.pmx', 'Pmd1 = again.pmx', 'Model = c.pmx',
      '[Effect]', 'Pmd1 = a.fx', 'Pmd9 = ghost.fx', 'Pmd1.show = maybe', 'Pmd1[x] = bad.fx',
    ].join('\n');
    const { doc, warnings } = parseEmm(text);
    expect(doc.objects).toEqual([{ index: 1, file: 'a.pmx' }]);
    expect(doc.tabs).toEqual({ Main: [{ object: 1, material: null, value: 'a.fx' }] });
    expect(warnings).toEqual([
      '.emm の Version 4 は知らない版です (3 として読みます)',
      '.emm の 3・6・7・11・12 行目は読めないので飛ばしました',
      '.emm の [Object] にない物 9 の割り当てを飛ばしました',
    ]);
  });

  it('空の文字・[Object] だけの .emm も読める', () => {
    expect(parseEmm('')).toEqual({ doc: { objects: [], tabs: {} }, warnings: [] });
    expect(parseEmm('[Info]\r\nVersion = 3\r\n\r\n[Object]\r\n\r\n[Effect]\r\nDefault = none\r\n\r\n').doc).toEqual({ objects: [], tabs: {} });
  });
});

describe('writeEmm', () => {
  const doc: EmmDoc = {
    objects: [{ index: 1, file: 'miku.pmx' }, { index: 2, file: 'ray.x' }, { index: 3, file: 'stage.pmx' }],
    tabs: {
      Main: [
        { object: 1, material: null, value: 'ray-mmd\\Main\\main.fx' },
        { object: 1, material: 4, value: 'none', show: false },
        { object: 2, material: null, value: 'ray-mmd\\ray.fx' },
        { object: 3, material: null, value: 'none' },
      ],
      MaterialMap: [{ object: 1, material: 0, value: 'ray-mmd\\Materials\\material_skin.fx' }, { object: 3, material: null, value: 'none', show: false }],
      Lonely: [{ object: 1, material: null, value: 'x.fx' }],
    },
    owners: { MaterialMap: { object: 2 }, Lonely: { object: 1, tab: 'MaterialMap' } },
  };

  it('MME の書式 (CRLF・キー = 値・Pmd と Acs の通し番号・Owner・最後に空行) で書く', () => {
    expect(writeEmm(doc)).toBe([
      '[Info]', 'Version = 3', '',
      '[Object]', 'Pmd1 = miku.pmx', 'Acs2 = ray.x', 'Pmd3 = stage.pmx', '',
      '[Effect]', 'Default = none',
      'Pmd1 = ray-mmd\\Main\\main.fx', 'Pmd1[4] = none', 'Pmd1[4].show = false', 'Acs2 = ray-mmd\\ray.fx', 'Pmd3 = none', '',
      '[Effect@MaterialMap]', 'Owner = Acs2', 'Pmd1[0] = ray-mmd\\Materials\\material_skin.fx', 'Pmd3 = none', 'Pmd3.show = false', '',
      '[Effect@Lonely]', 'Owner = Pmd1@MaterialMap', 'Pmd1 = x.fx', '',
      '',
    ].join('\r\n'));
  });

  it('書いたものを読むと同じ', () => {
    expect(parseEmm(writeEmm(doc))).toEqual({ doc, warnings: [] });
  });

  it('Shift_JIS で書き、Shift_JIS でも UTF-8 でも読める', () => {
    const text = writeEmm({ objects: [{ index: 1, file: '初音ミク.pmx' }], tabs: {} });
    const bytes = encodeEmm(text);
    expect(bytes).toEqual(encodeShiftJis(text));
    expect(decodeEmm(bytes)).toBe(text.replace(/\r\n/g, '\n'));
    expect(parseEmm(decodeEmm(bytes)).doc.objects).toEqual([{ index: 1, file: '初音ミク.pmx' }]);
    expect(parseEmm(decodeEmm(new TextEncoder().encode(text))).doc.objects).toEqual([{ index: 1, file: '初音ミク.pmx' }]);
  });
});

describe('matchFxPath', () => {
  const folders = [
    { id: 'f1', name: 'other', files: ['material_2.0.fx', 'Main/main.fx'] },
    { id: 'f2', name: 'ray-mmd-1.5.2', files: ['ray.fx', 'Main/main.fx', 'Materials/material_2.0.fx', 'Materials/Skin/material_skin.fx'] },
  ];

  it('パスの後ろの部分 (フォルダの名前/フォルダの中のパス) が区切りの単位でいちばん長く合うもの', () => {
    expect(matchFxPath('C:\\MMD\\ray-mmd-1.5.2\\Materials\\material_2.0.fx', folders)).toEqual({ folder: 'f2', path: 'Materials/material_2.0.fx' });
    expect(matchFxPath('UserFile\\Effect\\rui_cg\\RAY-MMD-1.5.2\\materials\\Skin\\MATERIAL_SKIN.FX', folders)).toEqual({ folder: 'f2', path: 'Materials/Skin/material_skin.fx' });
    expect(matchFxPath('x/ray-mmd-1.5.2/ray.fx', folders)).toEqual({ folder: 'f2', path: 'ray.fx' });
  });

  it('同じ長さなら先のフォルダ', () => {
    expect(matchFxPath('D:\\elsewhere\\Main\\main.fx', folders)).toEqual({ folder: 'f1', path: 'Main/main.fx' });
    expect(matchFxPath('material_2.0.fx', folders)).toEqual({ folder: 'f1', path: 'material_2.0.fx' });
  });

  it('ファイル名が合わなければ null (区切りの途中では合わせない)', () => {
    expect(matchFxPath('C:\\MMD\\xmain.fx', folders)).toBeNull();
    expect(matchFxPath('C:\\MMD\\Main', folders)).toBeNull();
    expect(matchFxPath('', folders)).toBeNull();
    expect(matchFxPath('a.fx', [])).toBeNull();
  });
});
