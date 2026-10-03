import { describe, expect, it } from 'vitest';
import { isDefaultModel, startMotion, type FolderFileEntry, type ModelFolderEntry } from './models';

const model = (pmx: string, folder: string): ModelFolderEntry => ({ name: pmx.replace(/\.pmx$/, ''), folder, pmx: folder ? `${folder}/${pmx}` : pmx, files: [], size: 0 });
const vmd = (path: string): FolderFileEntry => ({ name: path.split('/').pop()!.replace(/\.vmd$/, ''), folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', path, size: 0 });

describe('models フォルダ', () => {
  it('起動したときに読み込むモデルは、ファイル名で見分ける (フォルダはどこでも)', () => {
    expect(isDefaultModel(model('げのげ式初音ミク.pmx', 'げのげ式初音ミク'))).toBe(true);
    expect(isDefaultModel(model('げのげ式初音ミク.pmx'.normalize('NFD'), 'a'))).toBe(true); // (macOS のファイル名の濁点)
    expect(isDefaultModel(model('ほかの人.pmx', 'げのげ式初音ミク'))).toBe(false);
  });
  it('起動したときのモーション: モデルのフォルダの中が先、なければ最初のもの、なければなし', () => {
    const miku = model('げのげ式初音ミク.pmx', 'ミク');
    expect(startMotion([vmd('モーション/歩く.vmd'), vmd('ミク/dance/踊り.vmd')], miku)?.path).toBe('ミク/dance/踊り.vmd');
    expect(startMotion([vmd('モーション/歩く.vmd'), vmd('ミクさん/踊り.vmd')], miku)?.path).toBe('モーション/歩く.vmd'); // (名前が似ているだけのフォルダは別)
    expect(startMotion([vmd('踊り.vmd')], model('a.pmx', ''))?.path).toBe('踊り.vmd');
    expect(startMotion([], miku)).toBeNull();
  });
});
