import { create } from 'zustand';
import type { Profile } from '../types';
import { createCore, saver, uid } from './core';
import { createGenerationSlice } from './generation';
import { createGraphSlice } from './graph';
import { createKnowledgeSlice } from './knowledge';
import { createStorageSlice } from './storage';
import type { State } from './types';

export type { State } from './types';

/**
 * 四片拼成一个 store。
 *
 * 拆开之前这里是 1467 行、一个巨大的闭包，四类互不相干的事情（画布结构、
 * 流式生成、持久化、知识库）挤在一起，改任何一处都要在整个文件里翻。
 *
 * 拆的是代码不是运行时：四片仍然共用同一份状态、同一个撤销栈、同一个
 * 防抖存盘器 —— 它们都在 core.ts 里，由这里创建一次再传给每一片。
 *
 * 顺序无所谓：四片的键互不重叠，重叠了 TypeScript 会当场报
 *「specified more than once」，不会让它悄悄覆盖掉。
 */
export const useStore = create<State>((set, get) => {
  const core = createCore(set, get);
  return {
    ...createGraphSlice(set, get, core),
    ...createGenerationSlice(set, get, core),
    ...createKnowledgeSlice(set, get),
    ...createStorageSlice(set, get, core),
  };
});

export const newProfile = (): Profile => ({
  id: uid(),
  name: '新配置',
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0.7,
});

// 关标签页前把没落盘的改动冲掉
window.addEventListener('beforeunload', () => saver.flush());
