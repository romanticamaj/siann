// The e button of a track strip and of the Inspector (m5b-ui-editor-channel;
// UI redesign 3.4, 10.11): Cubase's Edit Channel Settings, which in SIANN is
// the Channel zone. It is lit while the zone is shown and shows this track
// (the app's primary selected track); pressed lit, it hides the zone; pressed
// otherwise, it selects the track (alone) and shows the zone. It needs no
// engine method, so it is never absent on a track strip. Pure.

export interface ChannelEdit {
  // The strip's track, or the Inspector's selected track (null: none).
  readonly trackId: string | null;
  // The primary selected track, which the Channel zone shows.
  readonly selectedTrackId: string | null;
  readonly channelVisible: boolean;
}

export function channelLit({ trackId, selectedTrackId, channelVisible }: ChannelEdit): boolean {
  return trackId !== null && channelVisible && selectedTrackId === trackId;
}

// What a press does: the track to select (null: the selection stays) and
// whether the zone is shown or hidden; null when there is no track.
export function editChannel(edit: ChannelEdit): { readonly select: string | null; readonly zone: 'show' | 'hide' } | null {
  if (edit.trackId === null) return null;
  if (channelLit(edit)) return { select: null, zone: 'hide' };
  return { select: edit.trackId, zone: 'show' };
}
