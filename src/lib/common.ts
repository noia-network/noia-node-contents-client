export function filterContentProps(metadata: any) {
  return {
    infoHash: metadata.infoHash,
    pieces: metadata.pieces
  }
}
