import * as cornerstone from '@cornerstonejs/core';
import * as dicomImageLoader from '@cornerstonejs/dicom-image-loader';
import * as cornerstoneTools from '@cornerstonejs/tools';

let initialization: Promise<void> | undefined;

export function initializeCornerstone(): Promise<void> {
  if (!initialization) {
    initialization = Promise.resolve().then(() => {
      cornerstone.init();
      cornerstoneTools.init();
      dicomImageLoader.init();
      cornerstone.registerImageLoader('local', (imageId) => {
        const image = cornerstone.cache.getImage(imageId);
        if (!image) {
          return {
            promise: Promise.reject(new Error(`Локальный срез ${imageId} отсутствует в кэше Cornerstone.`)),
          };
        }
        return { promise: Promise.resolve(image) };
      });
    });
  }
  return initialization;
}
