import { resolveWorkspaceFileReference } from "../../../shared/lib/paths";
import { isImagePath } from "../../files/model/filePreview";
import { isNoteImagePath } from "../../notes";

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
 * Turn `<image: path>` markers into image nodes and point local image paths
 * at absolute files. URL hardening drops relative image URLs, so `~/` and
 * cwd-relative paths must be resolved before it runs.
 */
export function remarkLocalImages({ cwd }: { cwd?: string }) {
  function visit(node: MarkdownNode) {
    if (node.type === "image" && node.url && !isNoteImagePath(node.url)) {
      const file = resolveWorkspaceFileReference(node.url, cwd);
      if (file && isImagePath(file.path)) {
        const path = file.path.startsWith("/") ? file.path : `/${file.path}`;
        node.url = path.split("/").map(encodeURIComponent).join("/");
      }
    }
    const children = node.children;
    if (!children) return;
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      const parts =
        child.type === "text" && child.value?.includes("<image:")
          ? splitImageMarkers(child.value)
          : undefined;
      if (!parts) {
        visit(child);
        continue;
      }
      for (const part of parts) visit(part);
      children.splice(index, 1, ...parts);
      index += parts.length - 1;
    }
  }
  return visit;
}

function splitImageMarkers(text: string): MarkdownNode[] | undefined {
  const parts: MarkdownNode[] = [];
  let last = 0;
  for (const match of text.matchAll(IMAGE_MARKER)) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ type: "text", value: text.slice(last, start) });
    const path = match[1];
    parts.push({
      type: "image",
      url: path,
      alt: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
    });
    last = start + match[0].length;
  }
  if (parts.length === 0) return undefined;
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  return parts;
}
