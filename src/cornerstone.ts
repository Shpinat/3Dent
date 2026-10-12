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

      // Workaround for color images (which omit pixelRepresentation tag 0028,0103).
      // We monkey-patch cornerstone.metaData.get so that every time a module is retrieved,
      // the property is checked and injected before being returned to Cornerstone3D internals.
      const metaDataAny = cornerstone.metaData as any;
      const originalGet = metaDataAny.get;
      metaDataAny.get = function(type: string, ...queries: any[]) {
        let result;
        if (queries.length === 1) {
            result = originalGet.call(this, type, queries[0]);
        } else {
            result = originalGet.call(this, type, ...queries);
        }

        if (result && type === 'imagePixelModule') {
           if (result.pixelRepresentation === undefined) {
               result.pixelRepresentation = 0;
           }
        }

        return result;
      };

      // Register a fallback metadata provider for completely missing modules (e.g., secondary captures)
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

        // This is only triggered if the module doesn't exist AT ALL.
        if (type === 'imagePixelModule') {
           return {
               pixelRepresentation: 0,
               bitsAllocated: 8,
               bitsStored: 8,
               highBit: 7,
               photometricInterpretation: 'RGB',
               samplesPerPixel: 3
           };
        }

        if (type === 'voiLutModule') {
            return { windowWidth: 255, windowCenter: 128 };
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
