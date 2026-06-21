/** 解码图片尺寸。background（service worker）内 createImageBitmap 可用。 */
export async function imageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}
