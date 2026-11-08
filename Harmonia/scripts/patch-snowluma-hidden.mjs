import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function patchSnowlumaSource(source) {
  const marker = 'child = spawn(process.execPath, [';
  const start = source.indexOf(marker);
  if (start < 0 || source.indexOf(marker, start + marker.length) >= 0) throw new Error('SnowLuma launcher changed; hidden-child patch needs review');
  const options = source.indexOf('], {', start);
  if (options < 0 || options - start > 1000) throw new Error('SnowLuma child options not found');
  const insertion = options + 4;
  if (/^\s*windowsHide:\s*true,/.test(source.slice(insertion))) return source;
  if (!/^\s*stdio:\s*\[/.test(source.slice(insertion))) throw new Error('Unexpected SnowLuma child options');
  return source.slice(0, insertion) + '\n\t\t\t\t\twindowsHide: true,' + source.slice(insertion);
}
export async function patchSnowlumaHidden(root) {
  const file = path.join(root, 'vendor/snowluma/index.mjs');
  const original = await readFile(file, 'utf8');
  const patched = patchSnowlumaSource(original);
  if (patched !== original) await writeFile(file, patched, 'utf8');
}
