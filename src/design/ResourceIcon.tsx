import { File, FileImage, FileJson, FileStack, FileText, Video } from 'lucide-react';
import type { Kind } from '../../shared/domain';

/** One file-type icon language for tree rows, tabs and pickers. */
export function ResourceIcon({ kind, size = 16 }: { kind: Kind | undefined; size?: number }) {
  if (kind === 'video') return <Video size={size} className="resource-icon resource-icon-video" />;
  const Icon =
    kind === 'artifact'
      ? FileStack
      : kind === 'image'
        ? FileImage
        : kind === 'text'
          ? FileJson
          : kind === 'pdf' || kind === 'markdown'
            ? FileText
            : File;
  return <Icon size={size} className="resource-icon" />;
}
