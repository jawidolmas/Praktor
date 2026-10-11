/**
 * Turns the flat list of changed paths an agent left behind into a folder
 * tree to browse. Pure, so it's unit-tested apart from any rendering.
 */

export type Change = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X';

export interface FileEntry {
  path: string;
  change: Change;
  oldPath?: string | null;
}

export interface FileNode {
  kind: 'file';
  name: string;
  path: string;
  change: Change;
  oldPath?: string | null;
}

export interface FolderNode {
  kind: 'folder';
  /** Display name; compacted chains read like "src/lib". */
  name: string;
  path: string;
  children: TreeNode[];
  /** Changed files anywhere below this folder. */
  count: number;
}

export type TreeNode = FileNode | FolderNode;

export interface ChangeSummary {
  total: number;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

/** VS Code-style compact folders: a folder whose only child is a folder is
 *  merged into it ("src" → "lib" becomes "src/lib"), so deep paths don't
 *  cost a tap per level. */
function compact(node: FolderNode): FolderNode {
  let current = node;
  while (current.children.length === 1 && current.children[0]!.kind === 'folder') {
    const only = current.children[0] as FolderNode;
    current = { ...only, name: current.name ? `${current.name}/${only.name}` : only.name };
  }
  return {
    ...current,
    children: sortNodes(current.children.map((c) => (c.kind === 'folder' ? compact(c) : c))),
  };
}

export function buildTree(files: FileEntry[]): TreeNode[] {
  const root: FolderNode = { kind: 'folder', name: '', path: '', children: [], count: 0 };
  const folders = new Map<string, FolderNode>([['', root]]);

  for (const file of files) {
    const parts = file.path.split('/').filter((p) => p.length > 0);
    if (parts.length === 0) continue;
    let parent = root;
    parent.count += 1;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/');
      let folder = folders.get(path);
      if (!folder) {
        folder = { kind: 'folder', name: parts[i]!, path, children: [], count: 0 };
        folders.set(path, folder);
        parent.children.push(folder);
      }
      folder.count += 1;
      parent = folder;
    }
    parent.children.push({
      kind: 'file',
      name: parts[parts.length - 1]!,
      path: parts.join('/'),
      change: file.change,
      oldPath: file.oldPath ?? null,
    });
  }

  // Compact top-level chains too, but never merge the invisible root itself.
  return sortNodes(root.children.map((c) => (c.kind === 'folder' ? compact(c) : c)));
}

export function summarize(files: FileEntry[]): ChangeSummary {
  const s: ChangeSummary = { total: files.length, added: 0, modified: 0, deleted: 0, renamed: 0 };
  for (const f of files) {
    if (f.change === 'A' || f.change === 'C') s.added += 1;
    else if (f.change === 'D') s.deleted += 1;
    else if (f.change === 'R') s.renamed += 1;
    else s.modified += 1;
  }
  return s;
}

/** One entry per path. When several tasks touched the same file, the
 *  latest attempt's view of it wins. */
export function mergeByPath<T extends FileEntry & { attempt: number }>(files: T[]): T[] {
  const byPath = new Map<string, T>();
  for (const f of files) {
    const seen = byPath.get(f.path);
    if (!seen || f.attempt >= seen.attempt) byPath.set(f.path, f);
  }
  return [...byPath.values()];
}
