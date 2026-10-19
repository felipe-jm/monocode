import { resolveWorkspaceFileReference } from "../../../shared/lib/paths";

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  children?: MarkdownNode[];
};

// Agents announce a picture they made as `<image: /tmp/shot.png>`. Markdown
// sees no tag or autolink there, so the marker would stay literal text.
const IMAGE_MARKER = /<image:\s*([^<>\n]+?)\s*>/g;

/**
 * Turn `<image: path>` markers in prose into image nodes, so the reply shows
 * the file like any other local image. Code keeps the marker literal. A
 * marker names a file on purpose, so a relative one resolves against `cwd`;
 * plain relative Markdown images stay dropped.
 */
export function remarkImageMarkers({ cwd }: { cwd?: string } = {}) {
  function visit(node: MarkdownNode) {
    const children = node.children;
    if (!children) return;
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      const parts =
        child.type === "text" && child.value?.includes("<image:")
          ? splitImageMarkers(child.value, cwd)
          : undefined;
      if (!parts) {
        visit(child);
        continue;
      }
      children.splice(index, 1, ...parts);
      index += parts.length - 1;
    }
  }
  return visit;
}

function splitImageMarkers(
  text: string,
  cwd: string | undefined,
): MarkdownNode[] | undefined {
  const parts: MarkdownNode[] = [];
  let last = 0;
  for (const match of text.matchAll(IMAGE_MARKER)) {
    const start = match.index ?? 0;
    if (start > last) {
      parts.push({ type: "text", value: text.slice(last, start) });
    }
    const path = match[1];
    const file = resolveWorkspaceFileReference(path, cwd);
    parts.push({
      type: "image",
      url: file?.path ?? path,
      alt: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
    });
    last = start + match[0].length;
  }
  if (parts.length === 0) return undefined;
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  return parts;
}
