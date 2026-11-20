/** Inspect track metadata only after the browser cannot decode the audio. Unknown files stay unknown. */
type AudioTrackPresence = 'present' | 'absent' | 'unknown';

interface ElementBounds<T> {
  type: T;
  start: number;
  end: number;
}

const MAX_MP4_HEADERS = 64;
const MAX_ELEMENT_CHILDREN = 256;
const MAX_MOVIE_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_WEBM_METADATA_BYTES = 512 * 1024;

function mp4Box(view: DataView, offset: number, limit: number): ElementBounds<string> | undefined {
  if (offset + 8 > Math.min(view.byteLength, limit)) return;
  const shortSize = view.getUint32(offset);
  const type = String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset + 4, 4));
  const headerSize = shortSize === 1 ? 16 : 8;
  if (offset + headerSize > Math.min(view.byteLength, limit)) return;
  const size = shortSize === 1 ? Number(view.getBigUint64(offset + 8)) : shortSize || limit - offset;
  if (!Number.isSafeInteger(size) || size < headerSize || size > limit - offset) return;
  return { type, start: offset + headerSize, end: offset + size };
}

function readChildren<T>(start: number, end: number, read: (offset: number, limit: number) => ElementBounds<T> | undefined) {
  const children: ElementBounds<T>[] = [];
  for (let offset = start; offset < end;) {
    if (children.length >= MAX_ELEMENT_CHILDREN) return;
    const child = read(offset, end);
    if (!child) return;
    children.push(child);
    offset = child.end;
  }
  return children;
}

// QuickTime and ISO BMFF store the track handler in moov/trak/mdia/hdlr.
function mp4TrackPresence(view: DataView): AudioTrackPresence {
  const children = (start: number, end: number) => readChildren(start, end, (offset, limit) => mp4Box(view, offset, limit));
  const tracks = children(0, view.byteLength)?.filter(({ type }) => type === 'trak');
  if (!tracks?.length) return 'unknown';
  let hasVideo = false;
  for (const track of tracks) {
    const media = children(track.start, track.end)?.find(({ type }) => type === 'mdia');
    if (!media) return 'unknown';
    const handler = children(media.start, media.end)?.find(({ type }) => type === 'hdlr');
    if (!handler || handler.end - handler.start < 12) return 'unknown';
    const handlerType = view.getUint32(handler.start + 8);
    if (handlerType === 0x736f756e) return 'present'; // soun
    if (handlerType === 0x76696465) {
      hasVideo = true; // vide
    } else if (![0x74657874, 0x7362746c, 0x73756274, 0x746d6364, 0x6d657461].includes(handlerType)) {
      // text, sbtl, subt, tmcd, meta do not carry an audio track.
      return 'unknown';
    }
  }
  return hasVideo ? 'absent' : 'unknown';
}

function ebmlNumber(bytes: Uint8Array, offset: number, removeMarker: boolean) {
  const first = bytes[offset];
  if (!first) return;
  const length = Math.clz32(first) - 23;
  const end = offset + length;
  if (end > bytes.length || (!removeMarker && length > 4)) return;
  const dataMask = 0xff >> length;
  let value = removeMarker ? first & dataMask : first;
  let unknown = removeMarker && value === dataMask;
  for (let index = offset + 1; index < end; index += 1) {
    const byte = bytes[index]!;
    value = value * 256 + byte;
    unknown &&= byte === 0xff;
  }
  if (!unknown && !Number.isSafeInteger(value)) return;
  return { value, end, unknown };
}

function ebmlElement(bytes: Uint8Array, offset: number, limit: number): ElementBounds<number> | undefined {
  const type = ebmlNumber(bytes, offset, false);
  const size = type && ebmlNumber(bytes, type.end, true);
  if (!type || !size || size.end > limit || (!size.unknown && size.value > limit - size.end)) return;
  if (size.unknown && type.value !== 0x18538067) return; // Only accept an open-ended Segment.
  return { type: type.value, start: size.end, end: size.unknown ? limit : size.end + size.value };
}

// RFC 9559: Segment/Tracks/TrackEntry/TrackType. Only a complete Tracks element can establish absence.
function webmTrackPresence(bytes: Uint8Array, fileSize: number): AudioTrackPresence {
  const header = ebmlElement(bytes, 0, fileSize);
  if (!header || header.type !== 0x1a45dfa3) return 'unknown';
  const segment = ebmlElement(bytes, header.end, fileSize);
  if (!segment || segment.type !== 0x18538067) return 'unknown';
  for (let offset = segment.start; offset < Math.min(segment.end, bytes.length);) {
    const element = ebmlElement(bytes, offset, segment.end);
    if (!element) return 'unknown';
    if (element.type === 0x1654ae6b && element.end <= bytes.length) {
      const children = (start: number, end: number) => readChildren(start, end, (position, limit) => ebmlElement(bytes, position, limit));
      const entries = children(element.start, element.end)?.filter(({ type }) => type === 0xae);
      if (!entries?.length) return 'unknown';
      let hasVideo = false;
      for (const entry of entries) {
        const kind = children(entry.start, entry.end)?.find(({ type }) => type === 0x83);
        if (!kind || kind.end - kind.start !== 1) return 'unknown';
        if (bytes[kind.start] === 2) return 'present';
        if (bytes[kind.start] === 1) hasVideo = true;
        else if (bytes[kind.start] !== 17) return 'unknown';
      }
      return hasVideo ? 'absent' : 'unknown';
    }
    offset = element.end;
  }
  return 'unknown';
}

export async function audioTrackPresence(file: Blob, signal?: AbortSignal): Promise<AudioTrackPresence> {
  let offset = 0;
  for (let index = 0; index < MAX_MP4_HEADERS && offset + 8 <= file.size; index += 1) {
    signal?.throwIfAborted();
    const view = new DataView(await file.slice(offset, offset + 16).arrayBuffer());
    if (index === 0 && view.getUint32(0) === 0x1a45dfa3) {
      const prefix = await file.slice(0, MAX_WEBM_METADATA_BYTES).arrayBuffer();
      return webmTrackPresence(new Uint8Array(prefix), file.size);
    }
    const box = mp4Box(view, 0, file.size - offset);
    if (!box) break;
    if (box.type === 'moov' && box.end - box.start <= MAX_MOVIE_METADATA_BYTES) {
      const metadata = await file.slice(offset + box.start, offset + box.end).arrayBuffer();
      return mp4TrackPresence(new DataView(metadata));
    }
    offset += box.end;
  }
  return 'unknown';
}
