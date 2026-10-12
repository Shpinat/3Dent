import * as cornerstone from '@cornerstonejs/core';
import * as dicomImageLoader from '@cornerstonejs/dicom-image-loader';
import * as cornerstoneTools from '@cornerstonejs/tools';

let initialization: Promise<void> | undefined;

export function initializeCornerstone(): Promise<void> {
  if (!initialization) {
    initialization = Promise.resolve().then(() => {
      cornerstone.init();
      cornerstoneTools.init();
      dicomImageLoader.init({ useLegacyMetadataProvider: true });

      // Register a fallback metadata provider to inject default values for missing local DICOM fields
      cornerstone.metaData.addProvider((type, imageId) => {
        if (!imageId || typeof imageId !== 'string' || !imageId.startsWith('dicomfile:')) return undefined;

        if (type === 'generalSeriesModule') {
           return { modality: 'CT', seriesInstanceUID: '1.2.3.4.5.6.7' };
        }

        if (type === 'imagePlaneModule') {
           return {
               imageOrientationPatient: [1, 0, 0, 0, 1, 0],
               pixelSpacing: [1, 1],
               frameOfReferenceUID: '1.2.3.4.5.6.7',
               columns: 512,
               rows: 512,
               imagePositionPatient: [0, 0, 0],
               rowCosines: [1, 0, 0],
               columnCosines: [0, 1, 0]
           };
        }

        if (type === 'imagePixelModule') {
           return {
               pixelRepresentation: 0,
               bitsAllocated: 16,
               bitsStored: 16,
               highBit: 15,
               photometricInterpretation: 'MONOCHROME2',
               samplesPerPixel: 1
           };
        }

        if (type === 'voiLutModule') {
            return {
                windowWidth: 400,
                windowCenter: 40
            };
        }
        return undefined;
      }, -100);

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
