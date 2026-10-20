import dicomParser from 'dicom-parser';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
// @ts-ignore
import cornerstoneDICOMImageLoader from '@cornerstonejs/dicom-image-loader';

let initialized = false;

export async function initCornerstone() {
  if (initialized) return;

  // @ts-ignore
  window.cornerstone = cornerstone;
  // @ts-ignore
  window.cornerstoneTools = cornerstoneTools;

  // @ts-ignore
  cornerstoneDICOMImageLoader.external.cornerstone = cornerstone;
  // @ts-ignore
  cornerstoneDICOMImageLoader.external.dicomParser = dicomParser;

  // @ts-ignore
  cornerstoneDICOMImageLoader.configure({
    useWebWorkers: true,
    decodeConfig: {
      convertFloatPixelDataToInt: false,
    },
  });

  const config = {
    maxWebWorkers: navigator.hardwareConcurrency || 1,
    startWebWorkersOnDemand: true,
    taskConfiguration: {
      decodeTask: {
        initializeCodecsOnStartup: false,
        usePDFJS: false,
        strict: false,
      },
    },
  };

  // @ts-ignore
  cornerstoneDICOMImageLoader.webWorkerManager.initialize(config);

  await cornerstone.init();
  await cornerstoneTools.init();

  initialized = true;
}
