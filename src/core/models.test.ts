import { describe, expect, it } from 'vitest';
import { isDefaultModel, startFiles, type FolderFileEntry, type ModelFolderEntry } from './models';

const model = (pmx: string, folder: string): ModelFolderEntry => ({ name: pmx.replace(/\.pmx$/, ''), folder, pmx: folder ? `${folder}/${pmx}` : pmx, files: [], size: 0 });
const vmd = (path: string): FolderFileEntry => ({ name: path.split('/').pop()!.replace(/\.vmd$/, ''), folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', path, size: 0 });

describe('models フォルダ', () => {
  it('起動したときに読み込むモデルは、ファイル名で見分ける (フォルダはどこでも)', () => {
    expect(isDefaultModel(model('げのげ式初音ミク.pmx', 'げのげ式初音ミク'))).toBe(true);
    expect(isDefaultModel(model('げのげ式初音ミク.pmx'.normalize('NFD'), 'a'))).toBe(true); // (macOS のファイル名の濁点)
    expect(isDefaultModel(model('ほかの人.pmx', 'げのげ式初音ミク'))).toBe(false);
  });
  it('起動したときに付けるもの: モーションのあるフォルダ (モデルのフォルダの中が先) の .vmd 全部と、そのフォルダの曲', () => {
    const miku = model('げのげ式初音ミク.pmx', 'ミク');
    const paths = (r: ReturnType<typeof startFiles>) => r && [r.motions.map(m => m.path), r.song?.path ?? null];
    const motions = [vmd('モーション/歩く.vmd'), vmd('ミク/dance/カメラ.vmd'), vmd('ミク/dance/体.vmd'), vmd('ミク/dance/表情.vmd'), vmd('ミク/other/別.vmd')];
    const songs = [vmd('モーション/歩く.wav'), vmd('ミク/dance/曲.mp3'), vmd('ミク/dance/曲2.mp3')];
    expect(paths(startFiles({ motions, songs }, miku))).toEqual([['ミク/dance/カメラ.vmd', 'ミク/dance/体.vmd', 'ミク/dance/表情.vmd'], 'ミク/dance/曲.mp3']);
    // モデルのフォルダになければ、最初のフォルダ (名前が似ているだけのフォルダは別)
    expect(paths(startFiles({ motions: [vmd('モーション/歩く.vmd'), vmd('ミクさん/踊り.vmd')], songs }, miku))).toEqual([['モーション/歩く.vmd'], 'モーション/歩く.wav']);
    expect(paths(startFiles({ motions: [vmd('踊り.vmd')], songs: [] }, model('a.pmx', '')))).toEqual([['踊り.vmd'], null]);
    expect(startFiles({ motions: [], songs }, miku)).toBeNull(); // (曲だけでは付けない)
  });
});
