import { describe, expect, it } from 'vitest';
import {
  backupFilename,
  buildFullBackup,
  buildSettingsBackup,
  mergeProfiles,
  parseBackup,
  stripKeys,
} from './backup';
import type { Graph, Profile, Settings } from '../types';

const profile = (over: Partial<Profile> = {}): Profile => ({
  id: 'p1',
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-secret',
  model: 'deepseek-chat',
  temperature: 0.7,
  ...over,
});

const settings = (profiles = [profile()]): Settings => ({
  profiles,
  activeProfileId: profiles[0]?.id ?? '',
  systemPrompt: '设定',
  contextLimit: 0,
  embedding: {
    baseUrl: 'https://api.jina.ai/v1',
    apiKey: 'jina-secret',
    model: 'jina-embeddings-v3',
    topK: 4,
  },
});

/**
 * 把对象里所有叫 apiKey 的字段挖出来，不管埋多深。
 *
 * 逐个字段写断言防不住「以后又加了一处存 Key 的地方」——
 * 向量服务的 Key 就是这么漏的。这个遍历才是真正的护栏。
 */
function allApiKeys(value: unknown, path = '$'): { path: string; value: unknown }[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => allApiKeys(v, `${path}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    k === 'apiKey' ? [{ path: `${path}.${k}`, value: v }] : allApiKeys(v, `${path}.${k}`),
  );
}

const graph = (id: string): Graph => ({
  id,
  title: id,
  nodes: {},
  createdAt: 0,
  updatedAt: 0,
});

let counter = 0;
const newId = () => `generated-${++counter}`;

describe('stripKeys', () => {
  it('清空所有 Key，其余字段不动', () => {
    const s = stripKeys(settings([profile(), profile({ id: 'p2', apiKey: 'sk-another' })]));
    expect(s.profiles.map((p) => p.apiKey)).toEqual(['', '']);
    expect(s.profiles[0]!.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(s.systemPrompt).toBe('设定');
  });

  it('不修改原对象', () => {
    const original = settings();
    stripKeys(original);
    expect(original.profiles[0]!.apiKey).toBe('sk-secret');
    expect(original.embedding!.apiKey).toBe('jina-secret');
  });

  /** 界面上写的是「不含 Key」，漏一处就是把承诺变成谎话 */
  it('向量服务的 Key 也要清掉', () => {
    expect(stripKeys(settings()).embedding!.apiKey).toBe('');
  });

  it('没配向量服务时不要凭空造一个出来', () => {
    const { embedding: _drop, ...withoutEmbedding } = settings();
    expect(stripKeys(withoutEmbedding as Settings).embedding).toBeUndefined();
  });

  it('设置里任何一处 apiKey 都不剩', () => {
    const left = allApiKeys(stripKeys(settings())).filter((k) => k.value !== '');
    expect(left, `还留着 Key：${left.map((k) => k.path).join(', ')}`).toEqual([]);
  });
});

/** 真正要守住的是导出文件本身：不管 stripKeys 怎么改，落到磁盘的不能有 Key */
describe('导出文件里不能有明文 Key', () => {
  it('设置备份（includeKeys=false）', () => {
    const left = allApiKeys(buildSettingsBackup(settings(), false)).filter((k) => k.value !== '');
    expect(left, `还留着 Key：${left.map((k) => k.path).join(', ')}`).toEqual([]);
  });

  it('全量备份（includeKeys=false）', () => {
    const b = buildFullBackup(settings(), [graph('g1')], false);
    const left = allApiKeys(b).filter((k) => k.value !== '');
    expect(left, `还留着 Key：${left.map((k) => k.path).join(', ')}`).toEqual([]);
  });

  it('显式要求带 Key 时一个都不能少', () => {
    const b = buildFullBackup(settings(), [graph('g1')], true);
    expect(allApiKeys(b).map((k) => k.value).sort()).toEqual(['jina-secret', 'sk-secret']);
  });
});

describe('buildSettingsBackup', () => {
  /** 配置文件最常见的用途是换机器和分享模板，默认带 Key 太容易泄漏 */
  it('默认不带 Key', () => {
    const b = buildSettingsBackup(settings(), false);
    expect(b.keysIncluded).toBe(false);
    expect(b.settings.profiles[0]!.apiKey).toBe('');
  });

  it('显式要求时才带 Key', () => {
    const b = buildSettingsBackup(settings(), true);
    expect(b.keysIncluded).toBe(true);
    expect(b.settings.profiles[0]!.apiKey).toBe('sk-secret');
  });

  it('带上 kind 和版本号，供导入时识别', () => {
    expect(buildSettingsBackup(settings(), false)).toMatchObject({
      kind: 'nexus-settings',
      version: 1,
    });
  });
});

describe('buildFullBackup', () => {
  it('同时包含设置和全部画布', () => {
    const b = buildFullBackup(settings(), [graph('g1'), graph('g2')], false);
    expect(b.kind).toBe('nexus-backup');
    expect(b.graphs.map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(b.settings.profiles[0]!.apiKey).toBe('');
  });
});

describe('parseBackup', () => {
  it('认出设置备份', () => {
    const parsed = parseBackup(buildSettingsBackup(settings(), false));
    expect(parsed.type).toBe('settings');
  });

  it('认出完整备份', () => {
    const parsed = parseBackup(buildFullBackup(settings(), [graph('g')], false));
    expect(parsed.type).toBe('full');
  });

  /** 旧版单画布导出是裸的 Graph，没有 kind，必须继续认 */
  it('认出旧版单画布导出', () => {
    const parsed = parseBackup({ id: 'g', title: 'x', nodes: {}, createdAt: 0, updatedAt: 0 });
    expect(parsed.type).toBe('graph');
  });

  it('认不出的文件报错而不是硬塞', () => {
    expect(() => parseBackup({ foo: 1 })).toThrow('认不出');
    expect(() => parseBackup(null)).toThrow('合法的 JSON');
    expect(() => parseBackup('字符串')).toThrow('合法的 JSON');
  });

  it('结构残缺的备份给出具体原因', () => {
    expect(() => parseBackup({ kind: 'nexus-settings' })).toThrow('settings');
    expect(() => parseBackup({ kind: 'nexus-backup', settings: settings() })).toThrow('graphs');
  });
});

describe('mergeProfiles', () => {
  /**
   * 「导入设置」的语义是拿到别处的配置，不是拿别处的状态盖掉自己的。
   * 之前整体替换 settings 冲掉过用户配好的 Key，这条是防复发。
   */
  it('只追加，绝不动已有配置', () => {
    const mine = profile({ id: 'mine', name: '我的', apiKey: 'sk-mine' });
    const incoming = profile({ id: 'theirs', name: '别人的', baseUrl: 'https://other/v1' });
    const r = mergeProfiles([mine], [incoming], newId);

    expect(r.profiles[0]).toBe(mine); // 原对象引用都没变
    expect(r.profiles).toHaveLength(2);
    expect(r.added).toBe(1);
  });

  it('按名称+baseUrl+模型判重，重复导入不会堆副本', () => {
    const mine = profile();
    const first = mergeProfiles([mine], [profile({ id: 'x' })], newId);
    expect(first.added).toBe(0);
    expect(first.skipped).toBe(1);
    expect(first.profiles).toHaveLength(1);

    const again = mergeProfiles(first.profiles, [profile({ id: 'y' })], newId);
    expect(again.profiles).toHaveLength(1);
  });

  it('同名但 baseUrl 不同视为不同配置', () => {
    const r = mergeProfiles([profile()], [profile({ baseUrl: 'https://mirror/v1' })], newId);
    expect(r.added).toBe(1);
  });

  it('重新分配 id，避免和本地撞车', () => {
    const r = mergeProfiles([profile({ id: 'dup' })], [profile({ id: 'dup', name: '另一个' })], newId);
    const ids = r.profiles.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('一批导入里自身重复的也只进一个', () => {
    const r = mergeProfiles([], [profile({ id: 'a' }), profile({ id: 'b' })], newId);
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it('导入空列表时原样返回', () => {
    const mine = [profile()];
    expect(mergeProfiles(mine, [], newId)).toMatchObject({ added: 0, skipped: 0 });
  });
});

describe('backupFilename', () => {
  it('带前缀和日期，且是 .json', () => {
    const name = backupFilename('nexus-settings');
    expect(name).toMatch(/^nexus-settings-\d{8}-\d{4}\.json$/);
  });
});
