// A clip's title (m5-ui-port-arrange-canvas; UI redesign 3.0 and 10.7): the
// name of its media (media.name, in the document since
// m5b-engine-project-media), or the media id when the media has none or its
// entity is missing. The event display draws it in the clip's title strip;
// m5-ui-port-toolbar's info line reuses it. Framework-free.

import type { ClipEntity, MediaEntity } from '../model/document';
import type { Snapshot } from '../model/read-model';

export function clipTitle(snapshot: Snapshot, clip: Pick<ClipEntity, 'mediaId'>): string {
  const media = snapshot.entities[`media:${clip.mediaId}`] as MediaEntity | undefined;
  const name = media?.schema === 'siann.entity.media.v1' ? media.name : undefined;
  return name ? name : clip.mediaId;
}
