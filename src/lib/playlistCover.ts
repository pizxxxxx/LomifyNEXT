import { coverUrlForTrack, type DownloadedCoverCacheState } from '$lib/offlineCovers';

export interface PlaylistWithCover {
  id: string | number;
  title: string;
  customCoverUrl?: string;
  tracks?: any[];
}

export function playlistCoverUrl(playlist: PlaylistWithCover, cache: DownloadedCoverCacheState): string {
  return playlist.customCoverUrl || coverUrlForTrack(playlist.tracks?.[0], cache);
}

/** Store a compact image, not a path that may disappear after the original file moves. */
export async function preparePlaylistCover(file: File): Promise<string> {
  const supportedType = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
  if (!supportedType && (file.type || !/\.(jpe?g|png|webp)$/i.test(file.name))) {
    throw new Error('Выбери изображение JPG, PNG или WebP.');
  }
  if (file.size > 20 * 1024 * 1024) {
    throw new Error('Изображение больше 20 МБ. Выбери файл поменьше.');
  }

  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = url;
    try {
      await image.decode();
    } catch {
      throw new Error('Не удалось открыть изображение. Попробуй другой файл JPG, PNG или WebP.');
    }
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    if (!side) throw new Error('У изображения нет размера. Выбери другой файл.');
    const size = Math.min(768, side);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Не удалось обработать изображение. Попробуй выбрать его ещё раз.');
    context.fillStyle = '#161618';
    context.fillRect(0, 0, size, size);
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.9);
  } finally {
    image.src = '';
    URL.revokeObjectURL(url);
  }
}
