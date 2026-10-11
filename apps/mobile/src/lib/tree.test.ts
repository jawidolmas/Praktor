import { describe, expect, it } from 'vitest';

import { buildTree, mergeByPath, summarize, type FolderNode, type TreeNode } from './tree';

const names = (nodes: TreeNode[]) => nodes.map((n) => (n.kind === 'folder' ? `${n.name}/` : n.name));

describe('buildTree', () => {
  it('nests paths into folders, folders first, then files, naturally sorted', () => {
    const tree = buildTree([
      { path: 'README.md', change: 'M' },
      { path: 'src/b.ts', change: 'A' },
      { path: 'src/a10.ts', change: 'A' },
      { path: 'src/a2.ts', change: 'A' },
      { path: 'docs/guide.md', change: 'A' },
    ]);
    expect(names(tree)).toEqual(['docs/', 'src/', 'README.md']);
    const src = tree[1] as FolderNode;
    expect(names(src.children)).toEqual(['a2.ts', 'a10.ts', 'b.ts']);
    expect(src.count).toBe(3);
  });

  it('compacts single-folder chains like VS Code', () => {
    const tree = buildTree([
      { path: 'apps/mobile/src/lib/a.ts', change: 'A' },
      { path: 'apps/mobile/src/lib/b.ts', change: 'M' },
    ]);
    expect(names(tree)).toEqual(['apps/mobile/src/lib/']);
    expect((tree[0] as FolderNode).path).toBe('apps/mobile/src/lib');
  });

  it('stops compacting where a folder branches', () => {
    const tree = buildTree([
      { path: 'src/app/x.tsx', change: 'A' },
      { path: 'src/lib/y.ts', change: 'A' },
    ]);
    expect(names(tree)).toEqual(['src/']);
    expect(names((tree[0] as FolderNode).children)).toEqual(['app/', 'lib/']);
  });

  it('counts every changed file below a folder', () => {
    const tree = buildTree([
      { path: 'a/b/1.ts', change: 'A' },
      { path: 'a/b/2.ts', change: 'A' },
      { path: 'a/3.ts', change: 'D' },
    ]);
    expect((tree[0] as FolderNode).count).toBe(3);
  });

  it('ignores empty paths', () => {
    expect(buildTree([{ path: '', change: 'A' }, { path: '/', change: 'A' }])).toEqual([]);
  });
});

describe('summarize', () => {
  it('buckets git change letters', () => {
    expect(
      summarize([
        { path: 'a', change: 'A' },
        { path: 'b', change: 'M' },
        { path: 'c', change: 'D' },
        { path: 'd', change: 'R' },
        { path: 'e', change: 'T' },
      ]),
    ).toEqual({ total: 5, added: 1, modified: 2, deleted: 1, renamed: 1 });
  });
});

describe('mergeByPath', () => {
  it('keeps the latest attempt per path', () => {
    const merged = mergeByPath([
      { path: 'x.ts', change: 'A' as const, attempt: 1 },
      { path: 'x.ts', change: 'M' as const, attempt: 2 },
      { path: 'y.ts', change: 'D' as const, attempt: 1 },
    ]);
    expect(merged.find((f) => f.path === 'x.ts')?.change).toBe('M');
    expect(merged).toHaveLength(2);
  });
});
